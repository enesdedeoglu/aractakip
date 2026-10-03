#!/bin/zsh
# Site şifresini (ARACTAKIP_DATA_KEY) tek seferde üç yere yazar:
#   1) Mac: ~/.aractakip/env   2) GitHub secret   3) tablet (USB ile bağlıysa): Termux ~/.aractakip/env
# Şifre ekranda görünmez ve hiçbir dosyaya bu betik dışında yazılmaz.
set -e
REPO="enesdedeoglu/aractakip"
ENV="$HOME/.aractakip/env"
ADB="$HOME/Library/Android/sdk/platform-tools/adb"

read -s "p1?Yeni site şifresi: "; echo
read -s "p2?Tekrar: "; echo
if [[ "$p1" != "$p2" ]]; then echo "Şifreler aynı değil."; exit 1; fi
if (( ${#p1} < 10 )); then echo "En az 10 karakter olmalı."; exit 1; fi
if [[ "$p1" == *$'\n'* || "$p1" == " "* || "$p1" == *" " ]]; then echo "Başta/sonda boşluk veya satır sonu olamaz."; exit 1; fi

# 1) Mac
mkdir -p "$HOME/.aractakip"; touch "$ENV"; chmod 600 "$ENV"
grep -v '^ARACTAKIP_DATA_KEY=' "$ENV" > "$ENV.tmp" || true
printf 'ARACTAKIP_DATA_KEY=%s\n' "$p1" >> "$ENV.tmp" && mv "$ENV.tmp" "$ENV" && chmod 600 "$ENV"
echo "✓ Mac'e kaydedildi"

# 2) GitHub secret (stdin'den okunur, komut satırında görünmez)
printf '%s' "$p1" | gh secret set ARACTAKIP_DATA_KEY --repo "$REPO" >/dev/null && echo "✓ GitHub'a kaydedildi"

# 3) Tablet (USB + Termux)
if [[ -x "$ADB" ]] && "$ADB" devices | grep -q 'device$'; then
  printf 'ARACTAKIP_DATA_KEY=%s\n' "$p1" | "$ADB" shell "run-as com.termux sh -c 'f=files/home/.aractakip/env; grep -v ^ARACTAKIP_DATA_KEY= \$f > \$f.tmp 2>/dev/null; cat >> \$f.tmp; mv \$f.tmp \$f; chmod 600 \$f'" \
    && echo "✓ Tablete kaydedildi" \
    && "$ADB" shell "run-as com.termux pkill -f 'node src/agent.js'" >/dev/null 2>&1 || true
else
  echo "! Tablet USB'ye bağlı değil: tablette Termux'ta şunu çalıştır:"
  echo '  read -s -p "Site şifresi: " p && echo "ARACTAKIP_DATA_KEY=$p" >> ~/.aractakip/env && unset p && pkill -f agent.js; echo tamam'
fi
unset p1 p2

launchctl kickstart -k "gui/$(id -u)/com.aractakip.agent" 2>/dev/null && echo "✓ Mac ajanı yeniden başlatıldı"
echo "Bitti."
