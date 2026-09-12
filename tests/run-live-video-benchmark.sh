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

normalize_public_ai_video() {
  local name="$1"
  local url="$2"
  local original="$VID/$name-original.mp4"
  local normalized="$VID/$name.mp4"

  curl -L --fail --retry 3 --retry-delay 2 --silent --show-error "$url" -o "$original"
  ffprobe -v error -show_entries stream=codec_name,codec_type,width,height,pix_fmt -show_entries format=format_name,duration,size -of json "$original" > "$OUT/$name-source-ffprobe.json"
  ffmpeg -hide_banner -loglevel error -y -i "$original" -t 12 -an     -vf "scale='if(gt(iw,720),720,iw)':-2"     -c:v libx264 -preset veryfast -crf 24 -pix_fmt yuv420p -movflags +faststart "$normalized"
  ffprobe -v error -show_entries stream=codec_name,codec_type,width,height,pix_fmt -show_entries format=format_name,duration,size -of json "$normalized" > "$OUT/$name-ffprobe.json"
}

# Public Veo 3 generations curated in jashankish/veo3-video-examples.
# Audio is intentionally removed so ForgeDirector must verify the visual facts.
normalize_public_ai_video "veo-standup" "https://github.com/user-attachments/assets/94932749-cf4c-4b8c-a6f5-4b0165aac0be"
normalize_public_ai_video "veo-dachshund" "https://github.com/user-attachments/assets/571ce7d9-28b1-475c-8a4b-a725a10dfa83"
normalize_public_ai_video "veo-dinosaur-guitar" "https://github.com/user-attachments/assets/15742a7b-2b50-4d4d-b99d-63e75e8fc086"
normalize_public_ai_video "veo-pythagoras" "https://github.com/user-attachments/assets/fc1a76f9-6d43-44c9-a458-69489a1b1bbe"
normalize_public_ai_video "veo-muffins" "https://github.com/user-attachments/assets/3bd64177-c3ca-4fc4-aaf6-b04449ce7479"
normalize_public_ai_video "veo-runner-replicate" "https://github.com/user-attachments/assets/499d3a54-dfa1-41db-a089-93b842844c4c"
normalize_public_ai_video "veo-opera" "https://github.com/user-attachments/assets/58274824-a51a-4f35-b176-1d766defeaaf"
normalize_public_ai_video "veo-giraffe-bike" "https://github.com/user-attachments/assets/8641851e-9a97-447c-9196-22ca25b57a51"
normalize_public_ai_video "veo-asmr-keyboard" "https://github.com/user-attachments/assets/4a054607-7a43-4c4f-93f8-e52d11f35fed"
normalize_public_ai_video "veo-professor-class" "https://github.com/user-attachments/assets/ce389508-3aea-4f3f-81af-295649af6509"
normalize_public_ai_video "veo-koala-dance" "https://github.com/user-attachments/assets/fbdb0cc3-38d2-4a7d-8577-50c737b213e9"
normalize_public_ai_video "veo-rap-battle" "https://github.com/user-attachments/assets/a7971f81-cce6-41bc-83c3-0591443ef40f"

# Real generated commercial product videos from coleam00/ai-content-factory.
# The repository documents these as generated UGC/product ads and commits the MP4s.
normalize_public_ai_video "camber-tumbler-ugc" "https://raw.githubusercontent.com/coleam00/ai-content-factory/main/sample-videos/camber-tumbler-ugc-10s.mp4"
normalize_public_ai_video "camber-mug-ugc" "https://raw.githubusercontent.com/coleam00/ai-content-factory/main/sample-videos/camber-mug-ugc-10s.mp4"
normalize_public_ai_video "camber-grinder-ugc" "https://raw.githubusercontent.com/coleam00/ai-content-factory/main/sample-videos/camber-grinder-ugc-10s.mp4"
normalize_public_ai_video "camber-kettle-ugc" "https://raw.githubusercontent.com/coleam00/ai-content-factory/main/sample-videos/camber-kettle-ugc-10s.mp4"
normalize_public_ai_video "camber-tumbler-pan" "https://raw.githubusercontent.com/coleam00/ai-content-factory/main/sample-videos/camber-tumbler-pan-10s.mp4"

# Real Veo-rendered shot from arjungithu53/zeroshot_studio. Its committed
# shotlist describes a cosmetic-balm jar reveal ending on three premium jars.
normalize_public_ai_video "veo-cosmetic-jars" "https://raw.githubusercontent.com/arjungithu53/zeroshot_studio/main/sample-output/shot_3.3.1_sample_clip.mp4"

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
    },
    {
      "name": "veo-standup",
      "checks": [
        {"type": "mustShow", "rule": "person performing stand-up comedy on a stage or in a small venue", "status": "pass"},
        {"type": "mustNotShow", "rule": "dog", "status": "pass"}
      ],
      "expectNoSpeechHallucination": true
    },
    {
      "name": "veo-dachshund",
      "checks": [
        {"type": "mustShow", "rule": "dachshund dog", "status": "pass"},
        {"type": "mustNotShow", "rule": "giraffe", "status": "pass"}
      ],
      "expectNoSpeechHallucination": true
    },
    {
      "name": "veo-dinosaur-guitar",
      "checks": [
        {"type": "mustShow", "rule": "dinosaur", "status": "pass"},
        {"type": "mustShow", "rule": "acoustic guitar", "status": "pass"}
      ],
      "expectNoSpeechHallucination": true
    },
    {
      "name": "veo-pythagoras",
      "checks": [
        {"type": "mustShow", "rule": "person in an ancient Greek setting", "status": "pass"},
        {"type": "mustNotShow", "rule": "motorcycle", "status": "pass"}
      ],
      "expectNoSpeechHallucination": true
    },
    {
      "name": "veo-muffins",
      "checks": [
        {"type": "mustShow", "rule": "two muffins", "status": "pass"},
        {"type": "mustNotShow", "rule": "dog", "status": "pass"}
      ],
      "expectNoSpeechHallucination": true
    },
    {
      "name": "veo-runner-replicate",
      "checks": [
        {"type": "mustShow", "rule": "person running outdoors", "status": "pass"},
        {"type": "mustIncludeText", "rule": "Replicate", "status": "pass"}
      ],
      "expectNoSpeechHallucination": true
    },
    {
      "name": "veo-opera",
      "checks": [
        {"type": "mustShow", "rule": "opera singer on a stage", "status": "pass"},
        {"type": "mustNotShow", "rule": "motorcycle", "status": "pass"}
      ],
      "expectNoSpeechHallucination": true
    },
    {
      "name": "veo-giraffe-bike",
      "checks": [
        {"type": "mustShow", "rule": "giraffe", "status": "pass"},
        {"type": "mustShow", "rule": "motorcycle or dirt bike", "status": "pass"}
      ],
      "expectNoSpeechHallucination": true
    },
    {
      "name": "veo-asmr-keyboard",
      "checks": [
        {"type": "mustShow", "rule": "person using a keyboard", "status": "pass"},
        {"type": "mustNotShow", "rule": "giraffe", "status": "pass"}
      ],
      "expectNoSpeechHallucination": true
    },
    {
      "name": "veo-professor-class",
      "checks": [
        {"type": "mustShow", "rule": "teacher or professor in a classroom", "status": "pass"},
        {"type": "mustNotShow", "rule": "motorcycle", "status": "pass"}
      ],
      "expectNoSpeechHallucination": true
    },
    {
      "name": "veo-koala-dance",
      "checks": [
        {"type": "mustShow", "rule": "two koalas", "status": "pass"},
        {"type": "mustShow", "rule": "dance stage or dance battle", "status": "pass"}
      ],
      "expectNoSpeechHallucination": true
    },
    {
      "name": "veo-rap-battle",
      "checks": [
        {"type": "mustShow", "rule": "two people performing on a stage", "status": "pass"},
        {"type": "mustShow", "rule": "scientific equations or science-themed stage graphics", "status": "pass"}
      ],
      "expectNoSpeechHallucination": true
    },
    {
      "name": "camber-tumbler-ugc",
      "checks": [
        {"type": "mustShow", "rule": "black insulated travel tumbler or coffee tumbler", "status": "pass"},
        {"type": "mustShow", "rule": "person presenting or reviewing the product", "status": "pass"}
      ],
      "expectNoSpeechHallucination": true
    },
    {
      "name": "camber-mug-ugc",
      "checks": [
        {"type": "mustShow", "rule": "ceramic coffee mug", "status": "pass"},
        {"type": "mustShow", "rule": "person presenting or reviewing the product", "status": "pass"}
      ],
      "expectNoSpeechHallucination": true
    },
    {
      "name": "camber-grinder-ugc",
      "checks": [
        {"type": "mustShow", "rule": "manual hand coffee grinder", "status": "pass"},
        {"type": "mustShow", "rule": "person presenting or reviewing the product", "status": "pass"}
      ],
      "expectNoSpeechHallucination": true
    },
    {
      "name": "camber-kettle-ugc",
      "checks": [
        {"type": "mustShow", "rule": "gooseneck pour-over kettle", "status": "pass"},
        {"type": "mustShow", "rule": "person presenting or reviewing the product", "status": "pass"}
      ],
      "expectNoSpeechHallucination": true
    },
    {
      "name": "camber-tumbler-pan",
      "checks": [
        {"type": "mustShow", "rule": "black insulated travel tumbler or coffee tumbler", "status": "pass"},
        {"type": "mustNotShow", "rule": "giraffe", "status": "pass"}
      ],
      "expectNoSpeechHallucination": true
    },
    {
      "name": "veo-cosmetic-jars",
      "checks": [
        {"type": "mustShow", "rule": "cosmetic balm jar or cosmetic jars", "status": "pass"},
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

  local request_body result http measured_duration
  measured_duration=$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$file")
  request_body=$(printf '%s' "$payload" | jq \
    --arg assetId "$asset_id" \
    --argjson measuredDuration "$measured_duration" \
    '. + {assetId:$assetId} | if has("durationSeconds") then . else . + {durationSeconds:$measuredDuration} end')
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
analyze_case "veo-standup" "$VID/veo-standup.mp4" '{"platform":"General","objective":"awareness","context":"Public AI-generated Veo 3 sample. Verify only what is visibly present; audio has been removed.","requirements":{"mustShow":["person performing stand-up comedy on a stage or in a small venue"],"mustNotShow":["dog"]}}'
analyze_case "veo-dachshund" "$VID/veo-dachshund.mp4" '{"platform":"General","objective":"awareness","context":"Public AI-generated Veo 3 sample. Verify only visible facts; audio has been removed.","requirements":{"mustShow":["dachshund dog"],"mustNotShow":["giraffe"]}}'
analyze_case "veo-dinosaur-guitar" "$VID/veo-dinosaur-guitar.mp4" '{"platform":"General","objective":"awareness","context":"Public AI-generated Veo 3 sample. Verify only visible facts; audio has been removed.","requirements":{"mustShow":["dinosaur","acoustic guitar"]}}'
analyze_case "veo-pythagoras" "$VID/veo-pythagoras.mp4" '{"platform":"General","objective":"education","context":"Public AI-generated Veo 3 sample. Verify only visible facts; audio has been removed.","requirements":{"mustShow":["person in an ancient Greek setting"],"mustNotShow":["motorcycle"]}}'
analyze_case "veo-muffins" "$VID/veo-muffins.mp4" '{"platform":"General","objective":"engagement","context":"Public AI-generated Veo 3 sample. Verify only visible facts; audio has been removed.","requirements":{"mustShow":["two muffins"],"mustNotShow":["dog"]}}'
analyze_case "veo-runner-replicate" "$VID/veo-runner-replicate.mp4" '{"platform":"General","objective":"awareness","context":"Public AI-generated Veo 3 sample. Verify only visible facts and on-screen text; audio has been removed.","requirements":{"mustShow":["person running outdoors"],"mustIncludeText":["Replicate"]}}'
analyze_case "veo-opera" "$VID/veo-opera.mp4" '{"platform":"General","objective":"awareness","context":"Public AI-generated Veo 3 sample. Verify only visible facts; audio has been removed.","requirements":{"mustShow":["opera singer on a stage"],"mustNotShow":["motorcycle"]}}'
analyze_case "veo-giraffe-bike" "$VID/veo-giraffe-bike.mp4" '{"platform":"General","objective":"engagement","context":"Public AI-generated Veo 3 sample. Verify only visible facts; audio has been removed.","requirements":{"mustShow":["giraffe","motorcycle or dirt bike"]}}'
analyze_case "veo-asmr-keyboard" "$VID/veo-asmr-keyboard.mp4" '{"platform":"General","objective":"awareness","context":"Public AI-generated Veo 3 sample. Verify only visible facts; audio has been removed.","requirements":{"mustShow":["person using a keyboard"],"mustNotShow":["giraffe"]}}'
analyze_case "veo-professor-class" "$VID/veo-professor-class.mp4" '{"platform":"General","objective":"education","context":"Public AI-generated Veo 3 sample. Verify only visible facts; audio has been removed.","requirements":{"mustShow":["teacher or professor in a classroom"],"mustNotShow":["motorcycle"]}}'
analyze_case "veo-koala-dance" "$VID/veo-koala-dance.mp4" '{"platform":"General","objective":"engagement","context":"Public AI-generated Veo 3 sample. Verify only visible facts; audio has been removed.","requirements":{"mustShow":["two koalas","dance stage or dance battle"]}}'
analyze_case "veo-rap-battle" "$VID/veo-rap-battle.mp4" '{"platform":"General","objective":"engagement","context":"Public AI-generated Veo 3 sample. Verify only visible facts; audio has been removed.","requirements":{"mustShow":["two people performing on a stage","scientific equations or science-themed stage graphics"]}}'
analyze_case "camber-tumbler-ugc" "$VID/camber-tumbler-ugc.mp4" '{"platform":"Instagram Reels","objective":"conversion","context":"Real generated UGC product ad from coleam00/ai-content-factory. Repository metadata describes a person reviewing a matte-black insulated coffee tumbler. Audio has been removed; verify visual facts only.","requirements":{"mustShow":["black insulated travel tumbler or coffee tumbler","person presenting or reviewing the product"]}}'
analyze_case "camber-mug-ugc" "$VID/camber-mug-ugc.mp4" '{"platform":"Instagram Reels","objective":"conversion","context":"Real generated UGC product ad from coleam00/ai-content-factory. Repository metadata describes a person reviewing a warm oat-cream ceramic coffee mug. Audio has been removed; verify visual facts only.","requirements":{"mustShow":["ceramic coffee mug","person presenting or reviewing the product"]}}'
analyze_case "camber-grinder-ugc" "$VID/camber-grinder-ugc.mp4" '{"platform":"Instagram Reels","objective":"conversion","context":"Real generated UGC product ad from coleam00/ai-content-factory. Repository metadata describes a person reviewing a dark-grey manual hand coffee grinder. Audio has been removed; verify visual facts only.","requirements":{"mustShow":["manual hand coffee grinder","person presenting or reviewing the product"]}}'
analyze_case "camber-kettle-ugc" "$VID/camber-kettle-ugc.mp4" '{"platform":"Instagram Reels","objective":"conversion","context":"Real generated UGC product ad from coleam00/ai-content-factory. Repository metadata describes a person reviewing a matte-black gooseneck pour-over kettle. Audio has been removed; verify visual facts only.","requirements":{"mustShow":["gooseneck pour-over kettle","person presenting or reviewing the product"]}}'
analyze_case "camber-tumbler-pan" "$VID/camber-tumbler-pan.mp4" '{"platform":"Instagram Reels","objective":"awareness","context":"Real generated product-pan ad from coleam00/ai-content-factory. Repository metadata describes a cinematic push-in over a Camber tumbler. Audio has been removed; verify visual facts only.","requirements":{"mustShow":["black insulated travel tumbler or coffee tumbler"],"mustNotShow":["giraffe"]}}'
analyze_case "veo-cosmetic-jars" "$VID/veo-cosmetic-jars.mp4" '{"platform":"General","objective":"awareness","context":"Real Veo-rendered commercial shot from arjungithu53/zeroshot_studio. The committed shotlist describes a cosmetic balm jar reveal ending on multiple premium jars. Audio has been removed; verify visual facts only.","requirements":{"mustShow":["cosmetic balm jar or cosmetic jars"],"mustNotShow":["motorcycle"]}}'

python3 tests/grade-live-video-benchmark.py "$OUT"
