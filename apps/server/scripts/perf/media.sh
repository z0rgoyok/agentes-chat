#!/bin/bash
# The pictures and clips of the bench's workspace (seed.ts), made with ffmpeg: 140 pictures of eight sizes up to
# 4000x3000 (a seventh of them PNG) with photo-like noise, so they weigh what photos weigh, and 12 six-second clips.
#   bash apps/server/scripts/perf/media.sh <folder>
set -euo pipefail
mkdir -p "$1"
cd "$1"
srcs=("mandelbrot=s=WxH" "testsrc2=s=WxH" "smptehdbars=s=WxH" "cellauto=s=WxH:rule=110" "life=s=WxH:mold=10:r=1:ratio=0.1" "gradients=s=WxH:n=6")
sizes=("1600x1200" "1200x1600" "1920x1080" "2400x1600" "1080x1920" "1280x960" "4000x3000" "800x800")
for n in $(seq 1 140); do
  s=${sizes[$((n % ${#sizes[@]}))]}
  src=${srcs[$((n % ${#srcs[@]}))]}
  src=${src//WxH/$s}
  ext=jpg
  [ $((n % 7)) -eq 0 ] && ext=png
  ffmpeg -loglevel error -y -f lavfi -i "$src" -vf "noise=alls=$((10 + n % 30)):allf=t,hue=h=$((n * 37 % 360))" \
    -frames:v 1 -q:v 3 "img-$(printf %03d "$n").$ext"
done
for n in $(seq 1 12); do
  ffmpeg -loglevel error -y -f lavfi -i "testsrc2=s=1280x720:d=6" -f lavfi -i "sine=f=$((200 + n * 40)):d=6" \
    -vf "noise=alls=12:allf=t,hue=h=$((n * 53 % 360))" -c:v libx264 -preset veryfast -crf 26 -pix_fmt yuv420p \
    -c:a aac -shortest "clip-$(printf %02d "$n").mp4"
done
