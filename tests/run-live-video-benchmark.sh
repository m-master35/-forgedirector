#!/usr/bin/env bash
set -euo pipefail

: "${API_URL:?API_URL is required}"
: "${RAPIDAPI_PROXY_SECRET:?RAPIDAPI_PROXY_SECRET is required}"

OUT="${1:-benchmark-results}"
VID="$OUT/videos"
mkdir -p "$VID"

FONT="/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
if [ ! -f "$FONT" ]; then
  FONT="/usr/share/fonts/truetype/freefont/FreeSansBold.ttf"
fi

make_text_video() {
  local out="$1"
  local bg="$2"
  local line1="$3"
  local line2="$4"
  ffmpeg -hide_banner -loglevel error -y     -f lavfi -i "color=c=$bg:s=720x1280:d=6:r=24"     -vf "drawtext=fontfile='$FONT':text='$line1':fontcolor=white:fontsize=66:x=(w-text_w)/2:y=360,drawtext=fontfile='$FONT':text='$line2':fontcolor=white:fontsize=58:x=(w-text_w)/2:y=720"     -c:v libx264 -preset veryfast -pix_fmt yuv420p "$out"
}

make_text_video "$VID/cta-present.mp4" "0x0B1020" "FORGE FLOW" "START FREE"
make_text_video "$VID/cta-missing.mp4" "0x0B1020" "FORGE FLOW" "SMARTER VIDEO"
make_text_video "$VID/forbidden-present.mp4" "0x241014" "FORGE FLOW" "RIVAL"
make_text_video "$VID/required-text-missing.mp4" "0x102414" "FORGE FLOW" "TRY TODAY"
make_text_video "$VID/forbidden-absent.mp4" "0x102414" "FORGE FLOW" "START FREE"
make_text_video "$VID/weak-static.mp4" "0x777777" "A VIDEO" "HELLO"

ffmpeg -hide_banner -loglevel error -y   -f lavfi -i "color=c=0x101828:s=720x1280:d=3:r=24"   -f lavfi -i "color=c=0x281010:s=720x1280:d=3:r=24"   -filter_complex "[0:v]drawtext=fontfile='$FONT':text='LEAD CHARACTER':fontcolor=white:fontsize=56:x=(w-text_w)/2:y=250,drawbox=x=210:y=470:w=300:h=420:color=blue@1:t=fill,drawtext=fontfile='$FONT':text='BLUE SHIRT':fontcolor=white:fontsize=50:x=(w-text_w)/2:y=950[v0];[1:v]drawtext=fontfile='$FONT':text='LEAD CHARACTER':fontcolor=white:fontsize=56:x=(w-text_w)/2:y=250,drawbox=x=210:y=470:w=300:h=420:color=red@1:t=fill,drawtext=fontfile='$FONT':text='RED SHIRT':fontcolor=white:fontsize=50:x=(w-text_w)/2:y=950[v1];[v0][v1]concat=n=2:v=1:a=0[v]"   -map "[v]" -c:v libx264 -preset veryfast -pix_fmt yuv420p "$VID/continuity-break.mp4"

curl -L --fail --silent --show-error "https://raw.githubusercontent.com/tryAGI/Runway.Cli.Examples/main/examples/short-video/sample-output/assets/short-video.mp4" -o "$VID/real-motorcycle-original.mp4"
curl -L --fail --silent --show-error "https://raw.githubusercontent.com/tryAGI/Runway.Cli.Examples/main/examples/wine-label/sample-output/assets/05-hero.mp4" -o "$VID/real-wine.mp4"

ffprobe -v error -show_entries stream=codec_name,codec_type,width,height,pix_fmt,profile -show_entries format=format_name,duration,size,bit_rate -of json "$VID/real-motorcycle-original.mp4" > "$OUT/real-motorcycle-ffprobe.json"

ffmpeg -hide_banner -loglevel error -y -i "$VID/real-motorcycle-original.mp4" -an -c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p -movflags +faststart "$VID/real-motorcycle.mp4"

ffprobe -v error -show_entries stream=codec_name,codec_type,width,height,pix_fmt,profile -show_entries format=format_name,duration,size,bit_rate -of json "$VID/real-motorcycle.mp4" > "$OUT/real-motorcycle-normalized-ffprobe.json"

cat > "$OUT/expectations.json" <<'JSON'
{
  "cases": [
    {
      "name": "cta-present",
      "checks": [
        {"type": "mustIncludeText", "rule": "START FREE", "status": "pass"},
        {"type": "ctaRequired", "rule": "CTA is required", "status": "pass"}
      ],
      "expectNoSpeechHallucination": true
    },
    {
      "name": "cta-missing",
      "checks": [
        {"type": "ctaRequired", "rule": "CTA is required", "status": "fail"}
      ],
      "expectNoSpeechHallucination": true
    },
    {
      "name": "forbidden-present",
      "checks": [
        {"type": "mustNotShow", "rule": "RIVAL", "status": "fail"}
      ],
      "expectNoSpeechHallucination": true
    },
    {
      "name": "required-text-missing",
      "checks": [
        {"type": "mustIncludeText", "rule": "START FREE", "status": "fail"}
      ],
      "expectNoSpeechHallucination": true
    },
    {
      "name": "forbidden-absent",
      "checks": [
        {"type": "mustNotShow", "rule": "RIVAL", "status": "pass"},
        {"type": "mustIncludeText", "rule": "START FREE", "status": "pass"}
      ],
      "expectNoSpeechHallucination": true
    },
    {
      "name": "continuity-break",
      "checks": [
        {"type": "continuityRule", "rule": "The lead character must keep the same shirt color throughout", "status": "fail"}
      ],
      "expectNoSpeechHallucination": true
    },
    {
      "name": "weak-static",
      "checks": [],
      "gate": "not_accept",
      "expectNoSpeechHallucination": true
    },
    {
      "name": "real-motorcycle",
      "checks": [
        {"type": "mustShow", "rule": "motorcycle", "status": "pass"},
        {"type": "mustNotShow", "rule": "wine bottle", "status": "pass"}
      ],
      "expectNoSpeechHallucination": true
    },
    {
      "name": "real-wine",
      "checks": [
        {"type": "mustShow", "rule": "wine bottle", "status": "pass"},
        {"type": "mustNotShow", "rule": "motorcycle", "status": "pass"}
      ],
      "expectNoSpeechHallucination": true
    }
  ],
  "relational": [
    {"higher": "real-motorcycle", "lower": "weak-static", "metric": "overall", "minMargin": 10},
    {"higher": "real-motorcycle", "lower": "weak-static", "metric": "hook", "minMargin": 10}
  ]
}
JSON

analyze_case() {
  local name="$1"
  local file="$2"
  local payload="$3"
  local size
  size=$(stat -c%s "$file")

  local upload status upload_url asset_id
  upload=$(curl -sS -w '\n%{http_code}' -X POST     -H 'content-type: application/json'     -H "x-rapidapi-proxy-secret: $RAPIDAPI_PROXY_SECRET"     --data "{\"contentType\":\"video/mp4\",\"sizeBytes\":$size}"     "$API_URL/v1/uploads")
  status=$(printf '%s\n' "$upload" | tail -n1)
  upload=$(printf '%s\n' "$upload" | sed '$d')
  if [ "$status" != "200" ]; then
    jq -n --argjson s "$status" --arg e "upload failed" '{_httpStatus:$s,error:$e}' > "$OUT/$name.json"
    return
  fi

  upload_url=$(printf '%s' "$upload" | jq -r '.upload.uploadUrl')
  asset_id=$(printf '%s' "$upload" | jq -r '.upload.assetId')

  curl -sS --fail -X PUT -H 'content-type: video/mp4' --upload-file "$file" "$upload_url" >/dev/null

  local request_body result http
  request_body=$(printf '%s' "$payload" | jq --arg assetId "$asset_id" '. + {assetId:$assetId}')
  result=$(curl -sS -w '\n%{http_code}' -X POST     -H 'content-type: application/json'     -H "x-rapidapi-proxy-secret: $RAPIDAPI_PROXY_SECRET"     --data "$request_body"     "$API_URL/v1/analyze")
  http=$(printf '%s\n' "$result" | tail -n1)
  result=$(printf '%s\n' "$result" | sed '$d')
  if printf '%s' "$result" | jq . >/dev/null 2>&1; then
    printf '%s' "$result" | jq --argjson status "$http" '. + {_httpStatus:$status}' > "$OUT/$name.json"
  else
    jq -n --argjson s "$http" --arg e "$result" '{_httpStatus:$s,error:$e}' > "$OUT/$name.json"
  fi
}

analyze_case "cta-present" "$VID/cta-present.mp4" '{"platform":"TikTok","objective":"conversion","durationSeconds":6,"context":"Synthetic product-ad QA control. Visible text is intentional.","requirements":{"mustIncludeText":["START FREE"],"ctaRequired":true}}'
analyze_case "cta-missing" "$VID/cta-missing.mp4" '{"platform":"TikTok","objective":"conversion","durationSeconds":6,"context":"Synthetic product-ad QA control.","requirements":{"ctaRequired":true}}'
analyze_case "forbidden-present" "$VID/forbidden-present.mp4" '{"platform":"General","objective":"awareness","durationSeconds":6,"context":"Synthetic brand-compliance QA control.","requirements":{"mustNotShow":["RIVAL"]}}'
analyze_case "required-text-missing" "$VID/required-text-missing.mp4" '{"platform":"General","objective":"awareness","durationSeconds":6,"context":"Synthetic text-compliance QA control.","requirements":{"mustIncludeText":["START FREE"]}}'
analyze_case "forbidden-absent" "$VID/forbidden-absent.mp4" '{"platform":"General","objective":"awareness","durationSeconds":6,"context":"Synthetic brand-compliance QA control.","requirements":{"mustNotShow":["RIVAL"],"mustIncludeText":["START FREE"]}}'
analyze_case "continuity-break" "$VID/continuity-break.mp4" '{"platform":"General","objective":"awareness","durationSeconds":6,"context":"Synthetic continuity QA control. The same illustrated lead is intended across both halves.","requirements":{"continuityRules":["The lead character must keep the same shirt color throughout"]}}'
analyze_case "weak-static" "$VID/weak-static.mp4" '{"platform":"TikTok","objective":"engagement","durationSeconds":6,"context":"Synthetic weak-opening control."}'
analyze_case "real-motorcycle" "$VID/real-motorcycle.mp4" '{"platform":"General","objective":"awareness","durationSeconds":18,"context":"Real AI-generated sample from tryAGI Runway.Cli.Examples: a lone 1950s cafe racer on a foggy mountain pass at sunrise; cinematic, coherent continuity, no captions intended.","requirements":{"mustShow":["motorcycle"],"mustNotShow":["wine bottle"]}}'
analyze_case "real-wine" "$VID/real-wine.mp4" '{"platform":"General","objective":"awareness","context":"Real AI-generated sample from tryAGI Runway.Cli.Examples: a hero video built around a Stellar Vines wine bottle / label concept, with shattered bottle imagery suspended in mid-air.","requirements":{"mustShow":["wine bottle"],"mustNotShow":["motorcycle"]}}'

python3 tests/grade-live-video-benchmark.py "$OUT"
