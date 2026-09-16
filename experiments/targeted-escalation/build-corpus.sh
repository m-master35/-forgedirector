#!/usr/bin/env bash
set -euo pipefail

OUT="${1:-targeted-escalation-corpus}"
mkdir -p "$OUT"

FONT="/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
if [ ! -f "$FONT" ]; then
  FONT="/usr/share/fonts/truetype/freefont/FreeSansBold.ttf"
fi

make_base() {
  local out="$1"
  local duration="$2"
  ffmpeg -hide_banner -loglevel error -y     -f lavfi -i "color=c=0x101828:s=720x1280:d=${duration}:r=24"     -vf "drawtext=fontfile='$FONT':text='FORGE FLOW':fontcolor=white:fontsize=64:x=(w-text_w)/2:y=250"     -an -c:v libx264 -preset veryfast -crf 18 -pix_fmt yuv420p -movflags +faststart "$out"
}

# Localized forbidden-content control: exact defect window 8-10s.
ffmpeg -hide_banner -loglevel error -y   -f lavfi -i "color=c=0x101828:s=720x1280:d=20:r=24"   -vf "drawtext=fontfile='$FONT':text='FORGE FLOW':fontcolor=white:fontsize=64:x=(w-text_w)/2:y=250,drawtext=fontfile='$FONT':text='RIVAL':fontcolor=red:fontsize=96:x=(w-text_w)/2:y=650:enable='between(t,8,10)'"   -an -c:v libx264 -preset veryfast -crf 18 -pix_fmt yuv420p -movflags +faststart   "$OUT/localized-forbidden.mp4"

# Visible-text defect: intended CTA is correct except for a known 8-10s misspelling.
ffmpeg -hide_banner -loglevel error -y   -f lavfi -i "color=c=0x102414:s=720x1280:d=20:r=24"   -vf "drawtext=fontfile='$FONT':text='START FREE':fontcolor=white:fontsize=72:x=(w-text_w)/2:y=640:enable='not(between(t,8,10))',drawtext=fontfile='$FONT':text='STATR FREE':fontcolor=yellow:fontsize=72:x=(w-text_w)/2:y=640:enable='between(t,8,10)'"   -an -c:v libx264 -preset veryfast -crf 18 -pix_fmt yuv420p -movflags +faststart   "$OUT/visible-text-defect.mp4"

# Product/object mismatch: one product label changes only in 9-11s.
ffmpeg -hide_banner -loglevel error -y   -f lavfi -i "color=c=0x161622:s=720x1280:d=20:r=24"   -vf "drawbox=x=210:y=400:w=300:h=520:color=red@1:t=fill,drawtext=fontfile='$FONT':text='PRODUCT A':fontcolor=white:fontsize=54:x=(w-text_w)/2:y=620:enable='not(between(t,9,11))',drawtext=fontfile='$FONT':text='PRODUCT B':fontcolor=white:fontsize=54:x=(w-text_w)/2:y=620:enable='between(t,9,11)'"   -an -c:v libx264 -preset veryfast -crf 18 -pix_fmt yuv420p -movflags +faststart   "$OUT/object-mismatch.mp4"

# Localized visual artifact: severe noise/warping-like corruption only from 8-10s.
ffmpeg -hide_banner -loglevel error -y   -f lavfi -i "testsrc2=size=720x1280:rate=24:duration=20"   -vf "noise=alls=70:allf=t+u:enable='between(t,8,10)'"   -an -c:v libx264 -preset veryfast -crf 18 -pix_fmt yuv420p -movflags +faststart   "$OUT/localized-artifact.mp4"

# Transition defect: brief black flash at 9.75-10.25s.
ffmpeg -hide_banner -loglevel error -y   -f lavfi -i "testsrc2=size=720x1280:rate=24:duration=20"   -vf "drawbox=x=0:y=0:w=iw:h=ih:color=black@1:t=fill:enable='between(t,9.75,10.25)'"   -an -c:v libx264 -preset veryfast -crf 18 -pix_fmt yuv420p -movflags +faststart   "$OUT/transition-flash.mp4"

# Global/context-sensitive control: product changes from red to blue halfway through.
ffmpeg -hide_banner -loglevel error -y   -f lavfi -i "color=c=0x101828:s=720x1280:d=10:r=24"   -f lavfi -i "color=c=0x101828:s=720x1280:d=10:r=24"   -filter_complex "[0:v]drawbox=x=210:y=400:w=300:h=520:color=red@1:t=fill,drawtext=fontfile='$FONT':text='SAME PRODUCT':fontcolor=white:fontsize=48:x=(w-text_w)/2:y=620[v0];[1:v]drawbox=x=210:y=400:w=300:h=520:color=blue@1:t=fill,drawtext=fontfile='$FONT':text='SAME PRODUCT':fontcolor=white:fontsize=48:x=(w-text_w)/2:y=620[v1];[v0][v1]concat=n=2:v=1:a=0[v]"   -map "[v]" -an -c:v libx264 -preset veryfast -crf 18 -pix_fmt yuv420p -movflags +faststart   "$OUT/global-continuity.mp4"

# Global pacing control: intentionally static for full duration.
make_base "$OUT/global-pacing.mp4" 20

# Clean localized control.
ffmpeg -hide_banner -loglevel error -y   -f lavfi -i "testsrc2=size=720x1280:rate=24:duration=20"   -vf "drawtext=fontfile='$FONT':text='START FREE':fontcolor=white:fontsize=64:x=(w-text_w)/2:y=1000"   -an -c:v libx264 -preset veryfast -crf 18 -pix_fmt yuv420p -movflags +faststart   "$OUT/no-defect.mp4"

normalize_real() {
  local name="$1"
  local url="$2"
  local raw="$OUT/${name}-raw.mp4"
  local normalized="$OUT/${name}.mp4"
  curl -L --fail --retry 3 --retry-delay 2 --silent --show-error "$url" -o "$raw"
  ffmpeg -hide_banner -loglevel error -y -i "$raw" -t 12 -an     -vf "scale='if(gt(iw,720),720,iw)':-2"     -c:v libx264 -preset veryfast -crf 24 -pix_fmt yuv420p -movflags +faststart "$normalized"
  rm -f "$raw"
}

# Reuse public real-video sources already used by ForgeDirector's current live benchmark.
normalize_real "real-motorcycle" "https://raw.githubusercontent.com/tryAGI/Runway.Cli.Examples/main/examples/short-video/sample-output/assets/short-video.mp4"
normalize_real "camber-tumbler-ugc" "https://raw.githubusercontent.com/coleam00/ai-content-factory/main/sample-videos/camber-tumbler-ugc-10s.mp4"

echo "Built targeted escalation corpus in $OUT"
