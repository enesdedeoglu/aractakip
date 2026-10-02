#!/bin/sh
# Eklentinin Firefox (Android dahil) paketini üretir: dist/aractakip-firefox.xpi
# Kullanım: scripts/build-firefox.sh [çıktı-dosyası]
set -e
DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$DIR/dist/aractakip-firefox.xpi}"
TMP="$(mktemp -d)"
cp "$DIR"/extension/bg.js "$DIR"/extension/content.js "$DIR"/extension/popup.html "$DIR"/extension/popup.js "$TMP"/
cp "$DIR"/extension/manifest.firefox.json "$TMP"/manifest.json
mkdir -p "$(dirname "$OUT")"
rm -f "$OUT"
(cd "$TMP" && zip -q -r "$OUT" .)
rm -rf "$TMP"
echo "Firefox eklentisi: $OUT"
