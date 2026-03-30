#!/bin/bash
# Resize gallery images to max 400px (longest side) with 80% JPEG quality.
# Requires: brew install imagemagick  (or apt-get install imagemagick)
#
# Usage: bash resize-gallery.sh

set -e

DIR="$(cd "$(dirname "$0")" && pwd)/gallery"

if ! command -v magick &>/dev/null && ! command -v convert &>/dev/null; then
  echo "Error: ImageMagick not found. Install with: brew install imagemagick"
  exit 1
fi

# pick the right command (IM7 uses 'magick', IM6 uses 'convert')
if command -v magick &>/dev/null; then
  CONVERT="magick"
else
  CONVERT="convert"
fi

count=0
for f in "$DIR"/*.JPG "$DIR"/*.jpeg "$DIR"/*.jpg "$DIR"/*.png; do
  [ -f "$f" ] || continue
  before=$(wc -c < "$f" | tr -d ' ')
  $CONVERT "$f" -resize 400x400\> -quality 80 "$f"
  after=$(wc -c < "$f" | tr -d ' ')
  printf "%-40s %6sKB → %6sKB\n" "$(basename "$f")" "$((before/1024))" "$((after/1024))"
  count=$((count + 1))
done

echo ""
echo "Done — resized $count images."
