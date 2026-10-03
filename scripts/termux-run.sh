#!/data/data/com.termux/files/usr/bin/sh
# Termux'ta ajanı çalışır tutar: çökerse 30 sn sonra yeniden başlatır, her başlangıçta kodu günceller.
APP="$(cd "$(dirname "$0")/.." && pwd)"
LOG="$HOME/.aractakip/agent.log"
mkdir -p "$HOME/.aractakip"
cd "$APP" || exit 1
# Zaten çalışıyorsa ikinci kopyayı başlatma (açılış betiği + elle başlatma)
if pgrep -f "termux-run.sh" | grep -qv "^$$\$"; then echo "zaten çalışıyor"; exit 0; fi
while true; do
  git pull -q --ff-only >/dev/null 2>&1 && npm install --omit=optional --no-audit --no-fund >/dev/null 2>&1
  ARACTAKIP_AUTOUPDATE=1 node src/agent.js >> "$LOG" 2>&1
  sleep 10
done
