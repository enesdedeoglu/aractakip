# Tesla İlan Takip

sahibinden.com, arabam.com, Otokoç 2. El ve Borusan Next'teki **tüm Tesla ilanlarını** takip eder.
İlanları kategorilere ayırır (model / nesil / versiyon / km / satıcı), piyasa fiyatını tahmin eder,
her ilana puan ve tavsiye verir. Yeni ilan, fiyat değişimi ve kalkan ilanları **e-posta** ile bildirir.

## Nasıl çalışır?

| Parça | Ne zaman çalışır | Kaynaklar |
|---|---|---|
| **Bulut** (GitHub Actions, 10 dk'da bir) | Bilgisayar kapalıyken de | arabam.com, Otokoç (Borusan Next denenir) |
| **Yerel ajan** (gerçek Chrome, 3–6 dk'da bir) | Bilgisayar açıkken | sahibinden, arabam.com (km + hasar detayı), Otokoç, Borusan Next |
| **Web arayüzü** (GitHub Pages) | Her zaman | Ortak veri: `data/db.json` |

İki taraf da aynı `data/db.json` dosyasına GitHub API ile yazar (çakışmada yeniden birleştirir).
Bir ilanı hangisi önce görürse o bildirir; aynı ilan iki kez bildirilmez.

### Sitelerin koruma durumu (Ekim 2026)
- **arabam.com:** liste araması düz HTTP ile açık. Detay sayfaları ve km'li "otomobil" görünümü yalnızca tarayıcıya açık; bunlar yerel ajanda Chrome ile çekilir. Bulutta km ilan başlığından tahmin edilir.
- **Otokoç:** düz HTTP ile açık (şu an Tesla ilanı yok; gelince yakalanır).
- **Borusan Next:** Cloudflare korumalı; gerçek Chrome otomatik geçiyor (yerel ajan). Bulutta engellenirse yerel ajan tarar.
- **sahibinden:** "Tarayıcınızı kontrol ediyoruz – Devam Et" doğrulaması var. Program bunu **atlatmaya çalışmaz**: açılan Chrome penceresinde doğrulamayı sen tamamlarsın, oturum çerezi kalıcı profilde (`~/.aractakip/chrome-profile`) saklanır. Bu yüzden sahibinden yalnızca bilgisayar açıkken taranır.

> Sitelerin kullanım koşulları otomatik veri toplamayı kısıtlayabilir. Uygulama kişisel kullanım içindir ve istekleri seyrek tutar.

## Kurulum

```bash
npm install
```

### 1) E-posta bildirimi (Gmail)
1. Google hesabında 2 adımlı doğrulamayı aç → <https://myaccount.google.com/apppasswords> → "Uygulama şifresi" oluştur.
2. Şifreyi **GitHub Secrets**'a kendin gir (değer terminalde sorulur, kimse görmez):

```bash
gh secret set MAIL_TO --repo enesdedeoglu/aractakip
gh secret set SMTP_USER --repo enesdedeoglu/aractakip
gh secret set SMTP_PASS --repo enesdedeoglu/aractakip
```

3. Yerel ajan da e-posta atabilsin diye aynı değerleri `~/.aractakip/env` dosyasına yaz:

```
MAIL_TO=senin@gmail.com
SMTP_USER=senin@gmail.com
SMTP_PASS=uygulama-sifresi
```

İsteğe bağlı telefon bildirimi: `NTFY_TOPIC` (ntfy uygulaması) veya `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`.

Test: `node scripts/test-notify.js` (ayarlıysa örnek e-posta gönderir, değilse `data/mail-preview.html` üretir).

### 2) Yerel ajan (bilgisayar açıkken otomatik)
```bash
scripts/install-agent.sh            # oturum açılışında otomatik başlar
scripts/install-agent.sh --uninstall
tail -f ~/.aractakip/agent.log
```
Ajan bir Chrome penceresi açar; sahibinden doğrulama isterse macOS bildirimi gelir, pencerede "Devam Et"e basman yeter.

### 3) Ayarlar — `config/settings.json`
- `alerts`: hangi ilanlar için bildirim gelsin (`models: ["Model Y"]`, `maxPrice`, `maxKm`, `minYear`, `onlyLabels: ["Fırsat","İyi fiyat"]`, `notifyPriceDrops`, `notifyRemoved`).
- `agent.intervalMinutes`, `agent.minIntervals`: tarama sıklığı.
- `cloud.sources`: bulutta taranacak kaynaklar.

## Komutlar
```bash
npm run scan            # tek tarama (auto: saatte bir tam, arada hızlı)
npm run scan:full       # tam tarama
npm run agent           # ajanı ön planda çalıştır
npm run web             # arayüz: http://localhost:5173 (yerel data/db.json)
STORE=fs npm run scan   # GitHub yerine yerel dosyaya yaz (geliştirme)
```

## Puanlama
- **Beklenen fiyat:** tüm aktif ilanlarda `log(fiyat) ~ model + nesil + versiyon + yıl + km` ridge regresyonu (aykırılar atılır).
- **Puan (0–100):** fiyat sapması + tramer/boya/değişen/ağır hasar + satıcı tipi + km/yıl + fiyat düşüşleri + ilanda kalma süresi.
- **Etiketler:** 🔥 Fırsat · 👍 İyi fiyat · ⚖️ Piyasa · 💸 Pahalı · ⚠️ Şüpheli (piyasanın %25+ altında, bireysel) · Veri az.

Tahminler istatistikseldir; almadan önce ekspertiz ve batarya SOH testi yaptırın.
