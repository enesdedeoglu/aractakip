# Tesla İlan Takip

sahibinden.com, arabam.com, Otokoç 2. El ve Borusan Next'teki **tüm Tesla ilanlarını** takip eder.
İlanları kategorilere ayırır (model / nesil / versiyon / km / satıcı), piyasa fiyatını tahmin eder,
her ilana puan ve tavsiye verir. Yeni ilan, fiyat değişimi ve kalkan ilanları **e-posta** ile bildirir.

## Nasıl çalışır?

| Parça | Ne zaman çalışır | Kaynaklar |
|---|---|---|
| **Yerel ajan** (arka planda, pencere açmaz) | Bilgisayar açıkken | Otokoç (doğrudan) + eklentiden gelen sayfalar |
| **Chrome eklentisi** (kendi Chrome'unda tek sabitlenmiş sekme) | Chrome açıkken | sahibinden, arabam.com (km + hasar detayı), Borusan Next |
| **Android tablet** (Termux + Firefox Nightly) | Tablet açıkken (7/24) | Yukarıdakilerin hepsi |
| **Web arayüzü** (GitHub Pages) | Her zaman | <https://enesdedeoglu.github.io/aractakip/> (yerelde: <http://127.0.0.1:5173>) |
| **GitHub Actions** | **Kapalı** (depo ayarlarında devre dışı) | Hiçbir iş onda çalışmıyor |

Eklenti, ajandan sıradaki adresi alır ve kendi sabitlenmiş sekmesinde açar (arabam 3 dk, sahibinden ve Borusan 5 dk;
saatte bir arabam, 6 saatte bir sahibinden tam tarama). Sayfalar arasında en az ~25 sn beklenir.
sahibinden ilan detay sayfaları (Ağır Hasar Kayıtlı, çekiş, boya/değişen, açıklama) yalnızca son 2 günde gelen ilanlar ile
Fırsat/Şüpheli ilanlar için, en sık 6 dakikada bir ve günde en fazla 80 sayfa okunur (`agent.extension.sahibindenDetail*`).
Detay okuma eklentinin 2.2.0 sürümüyle gelir; ajan eski eklentiye detay sayfası açtırmaz.
Ayrı bir otomasyon penceresi açılmaz; sitelere senin normal tarayıcın gibi görünür.

Ajan veriyi GitHub'daki `data/db.enc.json` dosyasına (şifreli) yazar. Siteyi de ajan yayınlar (`src/publish.js`):
`web/`, şifreli veri ve Firefox eklentisi `gh-pages` dalına yazılır, GitHub Pages bu daldan sunar
(Pages ayarı: *Deploy from a branch* → `gh-pages` / root). Daldan yayında saatte ~10 yayın sınırı olduğu için
site en sık 6 dakikada bir güncellenir.
Mail bildirimleri, değişikliği bulan ajan tarafından gönderilir. Siteden mail durdur/devam: düğme başlığı hazır bir
GitHub issue'su açar (`mail durdur 1 gün` / `mail devam`); ajan 2 dakika içinde uygulayıp issue'yu kapatır.

### Bulut taramasını tekrar açmak
Önce depo ayarlarında Actions'ı açın (Settings → Actions → General). Sonra `.github/workflows/scrape.yml`
içindeki `schedule` ve `cron` satırlarının başındaki `#` işaretlerini kaldırıp gönderin. Elle tek seferlik tarama:
```bash
gh workflow run scrape.yml --repo enesdedeoglu/aractakip -f mode=full
```

### Sitelerin koruma durumu (Ekim 2026)
- **arabam.com:** liste araması düz HTTP ile açık (bulut). Detay sayfaları ve km'li "otomobil" görünümü yalnızca gerçek tarayıcıya açık → eklenti. Bulutta km ilan başlığından tahmin edilir.
- **Otokoç:** bilgisayardan düz HTTP ile açık, GitHub sunucularına kapalı (şu an Tesla ilanı yok; gelince yakalanır).
- **Borusan Next / sahibinden:** otomasyonla açılan ve görünmez tarayıcıları engelliyor. Program bunu **atlatmaya çalışmaz**; eklenti senin normal Chrome oturumunda okur. Doğrulama çıkarsa (eklenti rozeti "!") sabitlenmiş sekmede kendin tamamlarsın.

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
Ajan kendini günceller: 30 dakikada bir GitHub'daki `main`'e bakar, yeni kod varsa çekip yeniden başlar
(depo `main` dalında ve yerel değişiklik yoksa; kapatmak için `ARACTAKIP_AUTOUPDATE=0`). Chrome eklentisi
dosyaları da çekilir ama Chrome onları tarayıcı yeniden açılınca ya da `chrome://extensions`'ta yenileyince yükler.

### 3) Chrome eklentisi
`chrome://extensions` → sağ üstte **Geliştirici modu** → **Paketlenmemiş öğe yükle** → `extension` klasörü.
Eklenti ilk dakikada sabitlenmiş bir sekme açar ve sırayla sayfaları okur. Durumu eklenti simgesinden görebilir, takibi kapatabilirsin.

### Android tablette çalıştırma (isteğe bağlı, 7/24)
Boş bir Android tablet, bilgisayar kapalıyken de tüm siteleri tarayabilir. Mac ve tablet aynı anda çalışabilir:
bir site başka bir ajan tarafından az önce tarandıysa diğeri o turu atlar.

1. Kur: [Termux](https://github.com/termux/termux-app/releases), [Termux:Boot](https://github.com/termux/termux-boot/releases),
   [Termux:API](https://github.com/termux/termux-api/releases) (GitHub sürümleri) ve **Firefox Nightly**.
2. Termux'ta: `curl -fsSL https://raw.githubusercontent.com/enesdedeoglu/aractakip/main/scripts/termux-setup.sh | sh`
   (GitHub girişi ve Gmail uygulama şifresini sorar).
3. Firefox Nightly: `about:config` → `xpinstall.signatures.required` = **false**; Ayarlar → Firefox Nightly hakkında →
   logoya 5 kez dokun; sonra <https://enesdedeoglu.github.io/aractakip/aractakip-firefox.xpi> adresini açıp indir ve
   Ayarlar → **Dosyadan eklenti yükle** ile kur. Sonraki sürümler otomatik güncellenir.
4. Termux:Boot'u bir kez aç; Termux ve Firefox Nightly için pil optimizasyonunu kapat; Geliştirici seçenekleri →
   **Uyanık kal**. Tableti şarjda, Firefox önde açık bırak (Android'de eklenti sayfaları öndeki sekmede açar).

Kayıtlar: Termux'ta `tail -f ~/.aractakip/agent.log`.

### Site şifresi (yalnızca sen gör)
Veriler `ARACTAKIP_DATA_KEY` şifresiyle şifrelenip `data/db.enc.json` olarak saklanır (AES-256-GCM, PBKDF2).
Site ilk açılışta bu şifreyi sorar ve o cihazda "Çıkış" diyene kadar hatırlar. Şifre üç yerde olmalı:
- Mac ve tablet: `~/.aractakip/env` içinde `ARACTAKIP_DATA_KEY=...`
- GitHub (mail işlemi için): `gh secret set ARACTAKIP_DATA_KEY --repo enesdedeoglu/aractakip`

Şifresi olmayan ajan şifreli veriyi okumaz ve yazmaz. Şifreyi unutursan veriler çözülemez (ilanlar yeniden taranır, geçmiş kaybolur).

### 4) Ayarlar — `config/settings.json`
- `alerts`: hangi ilanlar için bildirim gelsin (`models: ["Model Y"]`, `versions: ["Juniper Standart"]`, `maxPrice`, `maxKm`, `minYear`, `onlyLabels: ["Fırsat","İyi fiyat"]`, `notifyPriceDrops`, `notifyRemoved`).
  `watches`: hedef fiyatlı takip, ör. `{ "version": "Juniper Standart", "maxPrice": 2300000, "maxKm": 40000, "noHeavyDamage": true }`.
  Kurala uyan yeni ilan ya da fiyat düşüşü genel filtreden bağımsız bildirilir; mail başlığı 🎯 ile başlar.
- `newPrices`: satıştaki versiyonların güncel sıfır fiyatları (ÖTV+KDV dahil). Fiyat modeli az ilanlı versiyonlarda bunlara
  dayanır, kartta "sıfırın %93'ü" görünür. **Tesla zam yaptıkça güncelleyin.**
- `agent.extension`: eklenti sekmesinin site başına açma aralıkları (dakika).
- `cloud.sources`: bulutta taranacak kaynaklar.

## Komutlar
```bash
npm run scan            # tek tarama (auto: saatte bir tam, arada hızlı)
npm run scan:full       # tam tarama
npm run agent           # ajanı ön planda çalıştır
npm run web             # geliştirme önizlemesi: http://localhost:5190 (yerel data/db.json)
STORE=fs npm run scan   # GitHub yerine yerel dosyaya yaz (geliştirme)
```

## Puanlama
- **Versiyonlar:** Juniper Model Y'de Türkiye'deki satış adları ayrı versiyondur: **Standart** (Kasım 2025'te gelen sade
  donanımlı arkadan itiş), **Premium** (2025'te satılan tam donanımlı arkadan itiş), **Long Range RWD / AWD**
  (Premium Long Range) ve **Performance**. Legacy'de Standart RWD, Long Range AWD, Performance. Sitenin kategori alanı
  ve detaydaki çekiş/batarya bilgisi önce, başlık sonra kullanılır; yalnızca "RWD" yazan Juniper'de versiyon yıla göre
  tahmin edilir ve ilanda uyarı çıkar.
- **Versiyon düzeltmeleri:** 2025 Juniper'de kategori "Standart" ama başlıkta cam tavan, arka ekran, premium, koltuk soğutma,
  tavan perdesi geçiyorsa araç eski tam donanımlı arkadan itiştir (Premium). "Standart menzil / Standart Range / SR" iki anlamda
  kullanıldığı için Premium varsayılır ve fiyatla teyit edilir. Versiyonu yazmayan ilanlar fiyatına en uyan versiyona atanır,
  kartta uyarı çıkar. 2024 ve öncesi Model Y her zaman Legacy; 2026 "Premium" arkadan itiş Premium Long Range RWD'dir.
- **Beklenen fiyat:** tüm aktif ilanlarda `log(fiyat) ~ model + nesil + versiyon + nesil×versiyon + versiyon×yıl + yıl + km +
  ağır hasar + değişen + boya + tramer` hiyerarşik ridge regresyonu (aykırılar atılır). Satıştaki versiyonların sıfır fiyatı
  (`newPrices`) modele sıfıra yakın ilan olarak girer. Az ilanlı versiyonlar üst seviyelere ve sıfır fiyatına yaslanır; her
  ilanın tahmini o ilan modelden çıkarılarak hesaplanır (kendi fiyatını "piyasa" göstermez).
- **Aralık:** her versiyonun tipik hatası bu leave-one-out tahminlerinden ölçülür. Kartta "beklenen ≈ 2,35 M (2,25–2,45 M
  arası)": benzer ilanların ~%80'i bu aralıktadır; az ilanlı versiyonda ve ağır hasarlıda geniştir.
- **Hasar durumuna göre fiyat:** ağır hasar, değişen/boyalı parça sayısı ve tramer tutarının etkisi ilanlardan öğrenilir
  (Ekim 2026: ağır hasar ≈ −%24, değişen parça başına ≈ −%3, boyalı parça ≈ −%1, 100 bin TL tramer ≈ −%2,4). Hasarlı aracın
  beklenen fiyatı buna göre düşürülür, hasarsız eşdeğeri ayrıca gösterilir.
- **Ağır hasar:** arabam ve sahibinden detayı (Ağır Hasarlı / Ağır Hasar Kayıtlı: Evet/Hayır), sahibinden "Ağır Hasar Kayıtlı" filtreli liste ve ilan metni
  ("ağır hasar", "pert", "çekme belgeli"; Türkçe karaktersiz yazımlar dahil, "ağır hasar kaydı yok" gibi olumsuzlar hariç).
  Aynı aracın bir sitesinde (kalkmış olsa da) ya da önceki ilanında ağır hasar yazıyorsa diğer ilandaki "yok" bilgisi bunu
  ezmez. Tramer aracın değerinin dörtte birini geçiyorsa uyarı çıkar.
- **İlan açıklaması:** sahibinden detayından okunan açıklamadan tramer tutarı ("tramer 85 bin"), FSD/EAP, PPF, Quicksilver,
  beyaz iç, 20" jant gibi opsiyonlar çıkarılır. Opsiyonların fiyat etkisi modelde öğrenilir ve beklenen fiyata eklenir.
  "Ağır hasar sorgusu yapılabilir" gibi kalıp cümleler hasar sayılmaz; ilanın Ağır Hasar Kayıtlı alanı "Hayır" iken
  açıklamada ağır hasar geçerse yalnızca uyarı çıkar.
- **Satış sinyali ve teklif:** kısa sürede (≤21 gün) kalkan ilanlar büyük ihtimalle satıldı; fiyatları kalkış zamanına göre
  düzeltilerek gerçekçi satış oranı (≈ ilan fiyatının %98'i) ve piyasanın aylık kayması ölçülür. Kartta "önerilen teklif",
  bu satış seviyesiyle ilan fiyatından pazarlık payı (ilanda kalma süresi ve fiyat düşüşleriyle artar) düşülmüş değerin küçüğüdür.
- **Trend:** piyasa sekmesinde her versiyonun son 3-4 haftadaki fiyat seviyesi değişimi (yalnızca yeni yayına giren ilanların
  giriş fiyatı, yıl/km/hasara göre düzeltilmiş).
- **Puan (0–100):** fiyatın aralıktaki yeri + tramer/boya/değişen/ağır hasar + satıcı tipi + km/yıl + fiyat düşüşleri + ilanda kalma süresi.
- **Etiketler:** 🔥 Fırsat (aralığın altında; versiyon kesin, ağır hasarsız, sıfır fiyatının altında) · 👍 İyi fiyat ·
  ⚖️ Piyasa (aralıkta) · 💸 Pahalı (aralığın üstünde) · ⚠️ Şüpheli (aralığın çok altında: gizli ağır hasar, yanlış versiyon,
  hatalı fiyat ya da dolandırıcılık olabilir) · Veri az.

Tahminler istatistikseldir; almadan önce ekspertiz ve batarya SOH testi yaptırın.
