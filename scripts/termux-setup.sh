#!/data/data/com.termux/files/usr/bin/sh
# Android tablette (Termux) Tesla İlan Takip ajanını kurar.
#   curl -fsSL https://raw.githubusercontent.com/enesdedeoglu/aractakip/main/scripts/termux-setup.sh | sh
set -e
REPO="https://github.com/enesdedeoglu/aractakip"
APP="$HOME/aractakip"
CFG="$HOME/.aractakip"

echo "==> Paketler"
pkg update -y >/dev/null
pkg install -y nodejs-lts git gh zip termux-api >/dev/null

echo "==> Kod"
if [ -d "$APP/.git" ]; then git -C "$APP" pull -q --ff-only; else git clone -q "$REPO" "$APP"; fi
cd "$APP"
npm install --omit=optional --no-audit --no-fund >/dev/null

echo "==> Ayarlar ($CFG/env)"
mkdir -p "$CFG"
if [ ! -f "$CFG/env" ]; then
  cat > "$CFG/env" <<'ENV'
MAIL_TO=nsdedeoglu@gmail.com
SMTP_USER=nsdedeoglu@gmail.com
SITE_URL=https://enesdedeoglu.github.io/aractakip/
ENV
fi
if ! grep -q '^SMTP_PASS=.' "$CFG/env"; then
  printf "Gmail uygulama şifresi (yazarken görünmez, boş geçmek için Enter): "
  stty -echo; read -r PASS; stty echo; echo
  PASS=$(printf %s "$PASS" | tr -d ' ')
  [ -n "$PASS" ] && echo "SMTP_PASS=$PASS" >> "$CFG/env"
fi
chmod 600 "$CFG/env"

echo "==> GitHub oturumu"
if ! gh auth status >/dev/null 2>&1; then
  echo "GitHub'a giriş yapın (verileri kaydetmek için gerekli):"
  gh auth login -h github.com -p https -w
fi

echo "==> Açılışta otomatik başlatma (Termux:Boot uygulaması gerekir)"
mkdir -p "$HOME/.termux/boot"
cat > "$HOME/.termux/boot/aractakip.sh" <<BOOT
#!/data/data/com.termux/files/usr/bin/sh
termux-wake-lock
sh "$APP/scripts/termux-run.sh"
BOOT
chmod +x "$HOME/.termux/boot/aractakip.sh"

echo "==> Firefox eklentisi"
[ -d "$HOME/storage/downloads" ] || termux-setup-storage
sleep 2
sh scripts/build-firefox.sh "$HOME/storage/downloads/aractakip-firefox.xpi" || sh scripts/build-firefox.sh

echo "==> Ajan başlatılıyor"
termux-wake-lock || true
nohup sh scripts/termux-run.sh >/dev/null 2>&1 &
sleep 5
tail -3 "$CFG/agent.log" 2>/dev/null || true
echo
echo "Tamam. Kayıtlar: tail -f $CFG/agent.log"
