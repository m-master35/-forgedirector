#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-focus-corpus}"
mkdir -p "$ROOT"

FONT="/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
if [ ! -f "$FONT" ]; then
  FONT="/usr/share/fonts/truetype/freefont/FreeSansBold.ttf"
fi
if [ ! -f "$FONT" ]; then
  echo "No supported test font found" >&2
  exit 2
fi

COMMON=(-hide_banner -loglevel error -y -f lavfi -i "color=c=0x101828:s=720x1280:d=30:r=24")

ffmpeg "${COMMON[@]}" \
  -vf "drawtext=fontfile='$FONT':text='FORGE PRODUCT':fontcolor=white:fontsize=60:x=(w-text_w)/2:y=220,drawbox=x=190:y=470:w=340:h=420:color=0x2457A6@1:t=fill,drawtext=fontfile='$FONT':text='PRODUCT':fontcolor=white:fontsize=52:x=(w-text_w)/2:y=950,drawbox=x=0:y=0:w=iw:h=ih:color=black@1:t=fill:enable='between(t,14,15)'" \
  -an -c:v libx264 -preset veryfast -pix_fmt yuv420p "$ROOT/black-middle.mp4"

ffmpeg "${COMMON[@]}" \
  -vf "drawtext=fontfile='$FONT':text='FORGE PRODUCT':fontcolor=white:fontsize=60:x=(w-text_w)/2:y=220,drawbox=x=190:y=470:w=340:h=420:color=0x2457A6@1:t=fill,drawtext=fontfile='$FONT':text='PRODUCT':fontcolor=white:fontsize=52:x=(w-text_w)/2:y=950" \
  -an -c:v libx264 -preset veryfast -pix_fmt yuv420p "$ROOT/no-black.mp4"

ffmpeg "${COMMON[@]}" \
  -vf "drawtext=fontfile='$FONT':text='FORGE PRODUCT':fontcolor=white:fontsize=60:x=(w-text_w)/2:y=220,drawtext=fontfile='$FONT':text='RIVAL':fontcolor=red:fontsize=96:x=(w-text_w)/2:y=620:enable='between(t,17,18.5)'" \
  -an -c:v libx264 -preset veryfast -pix_fmt yuv420p "$ROOT/forbidden-brief.mp4"

ffmpeg "${COMMON[@]}" \
  -vf "drawtext=fontfile='$FONT':text='FORGE PRODUCT':fontcolor=white:fontsize=60:x=(w-text_w)/2:y=220" \
  -an -c:v libx264 -preset veryfast -pix_fmt yuv420p "$ROOT/forbidden-absent.mp4"

ffmpeg "${COMMON[@]}" \
  -vf "drawtext=fontfile='$FONT':text='FORGE PRODUCT':fontcolor=white:fontsize=60:x=(w-text_w)/2:y=220,drawtext=fontfile='$FONT':text='START FREE':fontcolor=white:fontsize=86:x=(w-text_w)/2:y=680:enable='between(t,27,29.5)'" \
  -an -c:v libx264 -preset veryfast -pix_fmt yuv420p "$ROOT/required-text-late.mp4"

ffmpeg "${COMMON[@]}" \
  -vf "drawtext=fontfile='$FONT':text='FORGE PRODUCT':fontcolor=white:fontsize=60:x=(w-text_w)/2:y=220,drawtext=fontfile='$FONT':text='LEARN MORE':fontcolor=white:fontsize=86:x=(w-text_w)/2:y=680:enable='between(t,27,29.5)'" \
  -an -c:v libx264 -preset veryfast -pix_fmt yuv420p "$ROOT/required-text-missing.mp4"

ffmpeg "${COMMON[@]}" \
  -vf "drawtext=fontfile='$FONT':text='LEAD CHARACTER':fontcolor=white:fontsize=58:x=(w-text_w)/2:y=220,drawbox=x=205:y=430:w=310:h=470:color=blue@1:t=fill:enable='lt(t,15)',drawbox=x=205:y=430:w=310:h=470:color=red@1:t=fill:enable='gte(t,15)',drawtext=fontfile='$FONT':text='SHIRT':fontcolor=white:fontsize=58:x=(w-text_w)/2:y=970" \
  -an -c:v libx264 -preset veryfast -pix_fmt yuv420p "$ROOT/continuity-break.mp4"

ffmpeg "${COMMON[@]}" \
  -vf "drawtext=fontfile='$FONT':text='LEAD CHARACTER':fontcolor=white:fontsize=58:x=(w-text_w)/2:y=220,drawbox=x=205:y=430:w=310:h=470:color=blue@1:t=fill,drawtext=fontfile='$FONT':text='SHIRT':fontcolor=white:fontsize=58:x=(w-text_w)/2:y=970" \
  -an -c:v libx264 -preset veryfast -pix_fmt yuv420p "$ROOT/continuity-stable.mp4"

ffmpeg "${COMMON[@]}" \
  -vf "drawtext=fontfile='$FONT':text='PRODUCT BOX':fontcolor=white:fontsize=58:x=(w-text_w)/2:y=220,drawbox=x=180:y=430:w=360:h=500:color=green@1:t=fill:enable='lt(t,15)',drawbox=x=180:y=430:w=360:h=500:color=orange@1:t=fill:enable='gte(t,15)',drawtext=fontfile='$FONT':text='SAME PRODUCT':fontcolor=white:fontsize=48:x=(w-text_w)/2:y=1000" \
  -an -c:v libx264 -preset veryfast -pix_fmt yuv420p "$ROOT/product-change.mp4"

ffmpeg "${COMMON[@]}" \
  -vf "drawtext=fontfile='$FONT':text='PRODUCT BOX':fontcolor=white:fontsize=58:x=(w-text_w)/2:y=220,drawbox=x=180:y=430:w=360:h=500:color=green@1:t=fill,drawtext=fontfile='$FONT':text='SAME PRODUCT':fontcolor=white:fontsize=48:x=(w-text_w)/2:y=1000" \
  -an -c:v libx264 -preset veryfast -pix_fmt yuv420p "$ROOT/product-stable.mp4"

ffmpeg "${COMMON[@]}" \
  -vf "drawtext=fontfile='$FONT':text='CLEAN SCENE':fontcolor=white:fontsize=68:x=(w-text_w)/2:y=570,drawbox=x=0:y=0:w=iw:h=ih:color=magenta@1:t=fill:enable='between(t,20,21)'" \
  -an -c:v libx264 -preset veryfast -pix_fmt yuv420p "$ROOT/transition-glitch.mp4"

ffmpeg "${COMMON[@]}" \
  -vf "drawtext=fontfile='$FONT':text='CLEAN SCENE':fontcolor=white:fontsize=68:x=(w-text_w)/2:y=570" \
  -an -c:v libx264 -preset veryfast -pix_fmt yuv420p "$ROOT/transition-clean.mp4"

download_and_normalize() {
  local name="$1"
  local url="$2"
  local src="$ROOT/$name-source.mp4"
  curl -L --fail --retry 3 --retry-delay 2 --silent --show-error "$url" -o "$src"
  ffmpeg -hide_banner -loglevel error -y -i "$src" -t 30 -an \
    -vf "scale='if(gt(iw,720),720,iw)':-2" \
    -c:v libx264 -preset veryfast -crf 24 -pix_fmt yuv420p -movflags +faststart \
    "$ROOT/$name.mp4"
  rm -f "$src"
}

download_and_normalize "real-motorcycle" \
  "https://raw.githubusercontent.com/tryAGI/Runway.Cli.Examples/main/examples/short-video/sample-output/assets/short-video.mp4"
download_and_normalize "real-wine" \
  "https://raw.githubusercontent.com/tryAGI/Runway.Cli.Examples/main/examples/wine-label/sample-output/assets/05-hero.mp4"

for video in "$ROOT"/*.mp4; do
  base="$(basename "$video" .mp4)"
  ffprobe -v error \
    -show_entries stream=codec_name,codec_type,width,height,pix_fmt \
    -show_entries format=duration,size,bit_rate \
    -of json "$video" > "$ROOT/$base.ffprobe.json"
done

echo "FOCUS benchmark corpus built in $ROOT"
