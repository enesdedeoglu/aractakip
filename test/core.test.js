import test from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../src/classify.js';
import { parseDescription } from '../src/describe.js';
import { kmFromTitle } from '../src/sources/arabam.js';
import { normalize } from '../src/sources/sahibinden.js';
import { mergeScans } from '../src/merge.js';
import { emptyDb } from '../src/store.js';

test('model / nesil / versiyon', () => {
  const c = classify({ modelRaw: 'Tesla Model Y Premium (Juniper)', year: 2025 });
  assert.equal(c.model, 'Model Y');
  assert.equal(c.generation, 'Juniper');
  assert.equal(c.trim, 'Premium');
  assert.equal(classify({ modelRaw: 'Tesla Model S P100D', year: 2017 }).trim, 'Performance');
  assert.equal(classify({ modelRaw: 'Tesla Model Y RWD (Legacy) 218 BG', year: 2025 }).generation, 'Legacy');
});

test('Juniper versiyonları: Standart, Premium, Long Range ayrı', () => {
  const trim = (l) => classify(l).trim;
  assert.equal(trim({ modelRaw: 'Tesla Model Y Standart (Juniper)', year: 2026 }), 'Standart');
  assert.equal(trim({ modelRaw: 'Tesla Model Y Premium (Juniper)', year: 2025, specs: { drive: 'Arkadan İtiş' } }), 'Premium');
  assert.equal(trim({ modelRaw: 'Tesla Model Y Long Range (Juniper)', year: 2025 }), 'Long Range AWD');
  // Sitede "Premium" seçilmiş ama detayda dört çeker / büyük batarya: Premium Long Range
  assert.equal(trim({ modelRaw: 'Tesla Model Y Premium (Juniper)', year: 2026, specs: { drive: 'Dört Çeker (4x4)' } }), 'Long Range AWD');
  assert.equal(trim({ modelRaw: 'Tesla Model Y Premium (Juniper)', year: 2026, specs: { drive: 'Arkadan İtiş', batteryKwh: 79 } }), 'Long Range RWD');
  // Kategori yalnızca "RWD" diyorsa başlık belirler; o da yoksa yıla göre tahmin edilir
  assert.equal(trim({ modelRaw: 'Tesla Model Y RWD', title: 'JUNIPER STANDART HATASIZ', year: 2026 }), 'Standart');
  assert.equal(trim({ modelRaw: 'Tesla Model Y RWD', title: 'JUNIPER PREMIUM HATASIZ', year: 2025 }), 'Premium');
  const g = classify({ modelRaw: 'Tesla Model Y RWD', title: 'TESLA MODEL Y', year: 2025 });
  assert.equal(g.trim, 'Premium');
  assert.equal(g.trimGuessed, true);
  // Legacy: Premium diye bir versiyon yok; Long Range her zaman dört çeker
  assert.equal(trim({ modelRaw: 'Tesla Model Y Long Range (Legacy)', year: 2023 }), 'Long Range AWD');
  assert.equal(trim({ modelRaw: 'Tesla Model Y RWD (Legacy)', year: 2023 }), 'Standart RWD');
});

test('2025 "Standart (Juniper)" kategorisindeki tam donanımlı arkadan itiş Premium sayılır', () => {
  const trim = (title, year = 2025, modelRaw = 'Tesla Model Y Standart (Juniper)') => classify({ modelRaw, title, year }).trim;
  for (const t of ['2025 TESLA CAM TAVAN ARKA EKRAN', 'MODEL Y STANDART MENZİL HATASIZ', 'Model Y Standart Range 2025 Model',
    'TESLA MODEL Y PREMIUM JUNIPER', 'C.TAVAN BOYASIZ', 'KOLTUK ISITMA SOĞUTMA 19 JANT', 'TAVAN PERDELİ PPF']) {
    assert.equal(trim(t), 'Premium', t);
  }
  // sahibinden kategorisi ("Tesla Model Y Standart") ve "Standart Range" yazımı da
  assert.equal(trim('2025 MODEL Y STANDART RANGE 62.000KM', 2025, 'Tesla Model Y RWD'), 'Premium');
  assert.deepEqual(classify({ modelRaw: 'Tesla Model Y RWD', title: 'STANDART RANGE', year: 2025 }).trimAlt, ['Premium', 'Standart'], 'standart menzil fiyatla teyit edilir');
  assert.equal(trim('ARKA EKRAN', 2025, 'Tesla Model Y Standart'), 'Premium');
  // Gerçek Standart: başlıkta donanım yok
  assert.equal(trim('HATASIZ BOYASIZ STANDART JUNİPER'), 'Standart');
  assert.equal(trim('HATASIZ & SORUNSUZ ÇİFT CAMLI 2026 MAYIS ÇIKIŞLI'), 'Standart');
  // 2026'da Standart dışındaki arkadan itiş Premium Long Range'dir
  assert.equal(trim('ARKA EKRAN', 2026), 'Standart', '2026 Standart başlığı kuralı uygulanmaz');
  assert.equal(trim('LG5M BATARYA', 2026, 'Tesla Model Y Premium (Juniper)'), 'Long Range RWD');
});

test('versiyonu belirsiz Juniper için fiyatla seçilecek alternatifler', () => {
  const c = (o) => classify({ modelRaw: 'Tesla Model Y Standart (Juniper)', year: 2025, ...o });
  assert.deepEqual(c({ title: 'satılık 2025 model Y' }).trimAlt, ['Standart', 'Premium']);
  assert.equal(c({ title: 'TESLA STANDART JUNİPER' }).trimAlt, undefined, 'başlık Standart diyorsa kesin');
  // 2026'da trafiğe çıkan 2025 model arkadan itiş Standart'tır; "cam tvn" kısaltması Premium
  const g = classify({ modelRaw: 'Tesla Model Y RWD', title: 'HATASIZ 2026 4. AY ÇIKIŞLI', year: 2025 });
  assert.deepEqual([g.trim, !!g.trimGuessed, g.trimAlt], ['Standart', false, undefined]);
  assert.equal(classify({ modelRaw: 'Tesla Model Y RWD', title: 'CAM TVN 4KLTK ISITMA', year: 2025 }).trim, 'Premium');
  assert.deepEqual(classify({ modelRaw: 'Tesla Model Y RWD', title: 'TESLA', year: 2025 }).trimAlt, ['Premium', 'Standart']);
  assert.deepEqual(classify({ modelRaw: 'Tesla Model Y RWD', title: 'TESLA', year: 2026 }).trimAlt, ['Standart', 'Long Range RWD']);
  assert.equal(classify({ modelRaw: 'Tesla Model Y Premium (Juniper)', title: 'TESLA', year: 2025 }).trimAlt, undefined);
});

test('nesil: 2024 ve öncesi Legacy; başlıktaki nesil kategoriden önce gelir', () => {
  const gen = (o) => classify({ modelRaw: 'Tesla Model Y Standart (Juniper)', ...o }).generation;
  assert.equal(gen({ year: 2024, title: 'Tesla Model Y Standart Range 2024 Model' }), 'Legacy');
  assert.equal(gen({ year: 2024, modelRaw: 'Tesla Model Y RWD', title: 'Juniper pahalı, en mantıklısı 2024' }), 'Legacy');
  assert.equal(gen({ year: 2025, title: 'Tesla Model Y Standart (RWD Legasy) 2025 Model' }), 'Legacy');
  assert.equal(gen({ year: 2025, title: 'Tesla Model Y Standart' }), 'Juniper');
  assert.equal(gen({ year: 2025, modelRaw: 'Tesla Model Y RWD (Legacy)', title: 'JUNIPER RWD' }), 'Juniper');
});

test('olumsuz hasar ifadeleri uyarı üretmez', () => {
  const w = (title) => classify({ modelRaw: 'Tesla Model Y', title }).warnings;
  assert.deepEqual(w('ağır hasar kaydı yok, hasarlı değil'), []);
  assert.deepEqual(w('AĞIR HASAR KAYDI: HAYIR'), []);
  assert.deepEqual(w('ağır hasar ve tramer kaydı yoktur'), []);
  assert.deepEqual(w('AĞIR HASARSIZ BOYASIZ'), [], '"hasarsız" ağır hasar sayılmamalı');
  assert.deepEqual(w('pert değil, ekspertiz raporlu'), []);
  assert.ok(w('ağır hasarlı').includes('Ağır hasar kayıtlı'));
});

test('ağır hasar ifadeleri Türkçe karaktersiz ve ardında başka "yok" olsa da yakalanır', () => {
  const heavy = (title) => classify({ modelRaw: 'Tesla Model Y', title }).warnings.includes('Ağır hasar kayıtlı');
  assert.ok(heavy('AGIR HASAR KAYITLI'));
  assert.ok(heavy('agir hasarli tesla'));
  assert.ok(heavy('AĞIR HASAR KAYITLI DEĞİŞEN YOK'), 'sonraki "yok" değişen için');
  assert.ok(heavy('AGIR HASARLI TRAMER YOK'));
  assert.ok(heavy('PERT KAYITLI'));
  assert.ok(heavy('ÇEKME BELGELİ'));
  assert.ok(!heavy('pertsiz garantili'));
});

test('açıklama: tramer tutarı farklı yazımlarla okunur, sayı olmayan ifadeler karışmaz', () => {
  const tr = (t) => parseDescription(t).tramer;
  assert.equal(tr('Tramer 85 bin, boya yok'), 85000);
  assert.equal(tr('aracın 12.500 TL tramer kaydı vardır'), 12500);
  assert.equal(tr('TRAMER KAYDI: 145.000 TL'), 145000);
  assert.equal(tr('2 parça boya 40 bin tramer'), 40000);
  assert.equal(tr('85k tramerli'), 85000);
  assert.equal(tr('Tramer: 1,2 milyon'), 1200000);
  assert.equal(tr('tramersiz hatasız'), 0);
  assert.equal(tr('45.000 km, tramer kaydı yoktur'), 0);
  assert.equal(tr('2024 tramer sorgusu yapılabilir'), null);
  assert.equal(tr('Kaporta 3 parça değişen tramer 2 parça'), null);
  assert.equal(tr(''), null);
});

test('açıklama: opsiyon etiketleri ve kalıp cümleler ağır hasar sayılmaz', () => {
  const c = (description, o = {}) => classify({ modelRaw: 'Tesla Model Y Premium (Juniper)', year: 2025, title: 'TESLA', description, ...o });
  assert.deepEqual(c('Ağır hasar sorgusu yapılabilir. Tramer ve hasar kaydı kontrol edilebilir.').warnings, []);
  assert.deepEqual(c('Hasarlı parçası yoktur, ekspertiz raporu mevcut').warnings, []);
  assert.ok(c('Araç ağır hasar kayıtlıdır, onarımı yapıldı').warnings.includes('Ağır hasar kayıtlı'));
  const tags = c('Geliştirilmiş oto pilot, Quicksilver renk, 20 inç jant, komple PPF, beyaz iç').tags;
  for (const t of ['EAP', 'Quicksilver', '20" jant', 'PPF', 'Beyaz iç']) assert.ok(tags.includes(t), t);
  // Yapılandırılmış alan "Hayır" diyorsa açıklamadaki "ağır hasar" yalnızca not
  const n = c('ağır hasar kayıtlı', { damage: { heavy: false } });
  assert.deepEqual(n.warnings, []);
  assert.match(n.notes[0], /Ağır Hasar Kayıtlı alanı "Hayır"/);
});

test('başlıktan km', () => {
  assert.equal(kmFromTitle('HATASIZ 49bin km'), 49000);
  assert.equal(kmFromTitle('2025 TESLA 18.500KM'), 18500);
  assert.equal(kmFromTitle('Tesla Model Y'), null);
});

test('sahibinden satırı', () => {
  const heads = ['', 'Seri', 'Model', 'İlan Başlığı', 'Yıl', 'KM', 'Renk', 'Fiyat', 'İlan Tarihi', 'İl / İlçe', ''];
  const vals = ['', 'Model Y', 'Performance (Legacy)', 'TESLA', '2023', '33.233', 'Beyaz', '2.400.000 TL', '02 Ekim\n2026', 'İstanbul\nBağcılar', ''];
  const [l] = normalize([{ url: 'https://www.sahibinden.com/tesla', heads, rows: [{ id: '1315099562', cells: vals.map((text) => ({ cls: '', text })) }] }]);
  assert.equal(l.year, 2023);
  assert.equal(l.km, 33233);
  assert.equal(l.price, 2400000);
  assert.equal(l.city, 'İstanbul');
  assert.equal(l.district, 'Bağcılar');
});

test('birleştirme: yeni, fiyat değişimi, kalkan ilan', () => {
  const db = emptyDb();
  const base = { source: 'otokoc', sourceId: '1', title: 'Tesla Model Y', modelRaw: 'Tesla Model Y', year: 2023, km: 30000, price: 2000000 };
  const t0 = new Date('2026-10-01T00:00:00Z');
  let c = mergeScans(db, [{ source: 'otokoc', ok: true, complete: true, listings: [base], runner: 'cloud' }], t0);
  assert.deepEqual(c.added, ['otokoc:1']);
  c = mergeScans(db, [{ source: 'otokoc', ok: true, complete: true, listings: [{ ...base, price: 1900000, km: null }], runner: 'cloud' }], new Date('2026-10-01T01:00:00Z'));
  assert.equal(c.priceChanged[0].to, 1900000);
  assert.equal(db.listings['otokoc:1'].km, 30000, 'boş km eski değeri ezmemeli');
  mergeScans(db, [{ source: 'otokoc', ok: true, complete: true, listings: [], runner: 'cloud' }], new Date('2026-10-01T08:00:00Z'));
  c = mergeScans(db, [{ source: 'otokoc', ok: true, complete: true, listings: [], runner: 'cloud' }], new Date('2026-10-01T09:00:00Z'));
  assert.deepEqual(c.removed, ['otokoc:1']);
});

import { findDuplicates } from '../src/dedupe.js';

test('farklı sitelerdeki aynı araç eşleşir, farklı şehir/aynı site eşleşmez', () => {
  const mk = (key, source, o = {}) => {
    const l = { key, source, status: 'active', title: 'DC GARAJ TESLA MODEL Y 2024 32.000 KM HATASIZ', modelRaw: 'Tesla Model Y RWD', year: 2024, km: 32150, price: 2539750, city: 'İstanbul', firstSeen: '2026-10-01T00:00:00Z', ...o };
    l.c = classify(l);
    return l;
  };
  const a = mk('arabam:1', 'arabam');
  const b = mk('sahibinden:1', 'sahibinden');
  const c = mk('sahibinden:2', 'sahibinden', { city: 'Ankara' });           // farklı şehir
  const d = mk('arabam:2', 'arabam');                                        // aynı site
  const e = mk('borusan:1', 'borusan', { title: 'Tesla Model Y', km: 20000, price: 2600000 }); // farklı araç
  findDuplicates([a, b, c, d, e]);
  assert.ok(a.dup || d.dup, 'arabam ilanlarından biri sahibinden ile eşleşmeli');
  const g = (a.dup || d.dup).members;
  assert.ok(g.includes('sahibinden:1'));
  assert.equal(g.filter((k) => k.startsWith('arabam')).length, 1, 'grupta her siteden en fazla bir ilan');
  assert.equal(c.dup, undefined);
  assert.equal(e.dup, undefined);
  assert.equal([a, b, d].filter((l) => l.dup?.primary).length, 1);
});

import { pickImage } from '../src/sources/sahibinden.js';

test('sahibinden: simge yerine araç fotoğrafı seçilir', () => {
  const icon = 'https://s0.shbdn.com/assets/images/iconHasMegaPhotoLarge:d94.png';
  assert.equal(pickImage({ image: icon, images: [icon, 'https://i0.shbdn.com/photos/09/95/62/lthmb_1315099562zn3.jpg'] }), 'https://i0.shbdn.com/photos/09/95/62/x5_1315099562zn3.jpg');
  assert.equal(pickImage({ image: icon }), null);
  assert.match(pickImage({ image: 'https://image5.sahibinden.com/primeRow/72/44/36/pr_thmb_1340724436vbb.jpg' }), /primeRow/);
});

import { isFakeRow } from '../src/sources/sahibinden.js';

test('sahibinden: sahte (tuzak) ilanlar ayıklanır', () => {
  const heads = ['', 'Seri', 'Model', 'İlan Başlığı', 'Yıl', 'KM', 'Renk', 'Fiyat', 'İlan Tarihi', 'İl / İlçe', ''];
  const cells = ['', 'Model Y', 'RWD (Legacy)', 'x', '2024', '38.000', 'Beyaz', '3.159.000 TL', '02 Ekim\n2026', 'İstanbul\nBaşakşehir', ''].map((text) => ({ cls: '', text }));
  const fake = { id: '846782393', href: '/ilan/vasita-otomobil-tesla-otomatik-sb2f-bol-ekstrali-masrafsiz-tesla-acil-elektrik-846782393/detay', cells };
  const real = { id: '1343683453', href: '/ilan/vasita-otomobil-tesla-2023-tesla-model-y-performance-1343683453/detay', cells };
  assert.ok(isFakeRow(fake));
  assert.ok(!isFakeRow(real));
  assert.deepEqual(normalize([{ url: 'https://www.sahibinden.com/tesla', heads, rows: [fake, real] }]).map((l) => l.sourceId), ['1343683453']);
});

import { heavyStatus } from '../src/merge.js';

test('ağır hasar kaydı durumu', () => {
  assert.equal(heavyStatus({ damage: { heavy: true } }), 'var');
  assert.equal(heavyStatus({ damage: {}, c: { warnings: ['Ağır hasar kayıtlı'] } }), 'var');
  assert.equal(heavyStatus({ damage: { heavy: false } }), 'yok');
  assert.equal(heavyStatus({ damage: { tramer: 0 } }), 'yok');
  assert.equal(heavyStatus({ damage: { tramerRecord: false } }), 'yok');
  assert.equal(heavyStatus({ damage: { tramer: null } }), 'bilinmiyor');
});

test('sahibinden ağır hasar listesi: listedekiler kayıtlı, diğerleri kaydı yok', () => {
  const db = emptyDb();
  const mk = (id) => ({ source: 'sahibinden', sourceId: id, title: 'Tesla Model Y', modelRaw: 'Tesla Model Y RWD', year: 2023, km: 30000, price: 2000000 });
  mergeScans(db, [{ source: 'sahibinden', ok: true, complete: false, listings: [mk('1300000001'), mk('1300000002')], runner: 'tablet' }]);
  const heavy = { ...mk('1300000002'), damage: { heavy: true } };
  const c = mergeScans(db, [{ source: 'sahibinden', ok: true, complete: false, mode: 'heavy', listings: [heavy], heavyIds: ['1300000002'], heavyComplete: true, runner: 'tablet' }]);
  assert.equal(db.listings['sahibinden:1300000002'].c.heavy, 'var');
  assert.equal(db.listings['sahibinden:1300000001'].c.heavy, 'yok');
  assert.ok(db.sources.sahibinden.lastHeavy);
  assert.ok(c.updated >= 1);
});

import { findRelists } from '../src/dedupe.js';

test('kaldırılıp yeniden ilana konan araç eşleşir ve fiyat geçmişi birleşir', () => {
  const base = { title: 'HATASIZ BOYASIZ TESLA MODEL Y RWD 2024 32.150 KM', modelRaw: 'Tesla Model Y RWD', year: 2024, city: 'İstanbul', color: 'Beyaz' };
  const old = { ...base, key: 'sahibinden:1', source: 'sahibinden', sourceId: '1300000001', status: 'removed', km: 32150, price: 2600000,
    firstSeen: '2026-09-01T00:00:00Z', removedAt: '2026-09-20T00:00:00Z', priceHistory: [{ t: '2026-09-01T00:00:00Z', p: 2700000 }, { t: '2026-09-10T00:00:00Z', p: 2600000 }] };
  const relist = { ...base, key: 'sahibinden:2', source: 'sahibinden', sourceId: '1300000002', status: 'active', km: 32400, price: 2500000,
    firstSeen: '2026-09-22T00:00:00Z', priceHistory: [{ t: '2026-09-22T00:00:00Z', p: 2500000 }] };
  const other = { ...base, key: 'sahibinden:3', source: 'sahibinden', sourceId: '1300000003', status: 'active', km: 80000, price: 2100000, firstSeen: '2026-09-22T00:00:00Z', title: 'farklı araç' };
  for (const l of [old, relist, other]) l.c = classify(l);
  assert.equal(findRelists([old, relist, other]), 1);
  assert.equal(relist.relistOf, 'sahibinden:1');
  assert.equal(old.relistedAs, 'sahibinden:2');
  assert.deepEqual(relist.vehicleHistory.map((h) => h.p), [2700000, 2600000, 2500000]);
  assert.equal(other.relistOf, undefined);
});

import { mailPaused } from '../src/notify.js';

test('mail duraklatma', () => {
  assert.equal(mailPaused({}), false);
  assert.equal(mailPaused({ prefs: { mailPausedUntil: 'forever' } }), true);
  assert.equal(mailPaused({ prefs: { mailPausedUntil: new Date(Date.now() + 3600e3).toISOString() } }), true);
  assert.equal(mailPaused({ prefs: { mailPausedUntil: new Date(Date.now() - 1000).toISOString() } }), false, 'süresi dolunca kendiliğinden açılır');
});

import { encryptDb, decryptDb } from '../src/crypto.js';

test('şifreli veri: Node şifreler, tarayıcı (WebCrypto) çözer; yanlış şifre reddedilir', async () => {
  const db = { version: 1, listings: { 'a:1': { title: 'Tesla Model Y – çğüşöı' } }, prefs: {} };
  const file = encryptDb(db, 'doğru-şifre');
  assert.deepEqual(decryptDb(file, 'doğru-şifre'), db);
  assert.throws(() => decryptDb(file, 'yanlış'), /şifre/);
  // Aynı tuzla yeniden şifreleme (tarayıcıda hatırlanan anahtar geçerli kalmalı)
  assert.equal(encryptDb(db, 'doğru-şifre', file.salt).salt, file.salt);
  // Tarayıcıdaki adımların aynısı
  const b64 = (s) => Uint8Array.from(Buffer.from(s, 'base64'));
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode('doğru-şifre'), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: b64(file.salt), iterations: file.iter }, base, { name: 'AES-GCM', length: 256 }, true, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(file.iv) }, key, b64(file.data));
  const text = await new Response(new Blob([plain]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
  assert.deepEqual(JSON.parse(text), db);
});

import { fromRows } from '../src/sources/arabam.js';

test('arabam: eklentinin sayfada çıkardığı küçük satırlar', () => {
  const { listings, rowCount } = fromRows([
    { id: '44025870', href: '/ilan/sahibinden-satilik-tesla-model-y-performance-legacy/x/44025870', modelName: 'Tesla Model Y Performance (Legacy)', title: 'HATASIZ 49bin km',
      cells: ['', 'Tesla Model Y Performance (Legacy)', 'HATASIZ 49bin km', '2023', '49.900 KM', 'Siyah', '2.800.000 TL 2.710.000 TL', '15 Eylül 2026', 'Muğla Bodrum Karşılaştır'],
      priceText: '\n 2.710.000 TL\n', locs: ['Muğla', 'Bodrum'], image: 'https://arbstorage.mncdn.com/a/b_image_for_silan_1_240x180.jpg' },
    { id: '1', href: '/ilan/galeriden-satilik-renault-clio/x/1', modelName: 'Renault Clio', title: 'tesla ekranlı', cells: [], priceText: '700.000 TL', locs: [] },
  ]);
  assert.equal(rowCount, 2);
  assert.equal(listings.length, 1, 'Tesla olmayan satır atlanır');
  const l = listings[0];
  assert.equal(l.price, 2710000, 'indirimli ilanda güncel fiyat');
  assert.equal(l.km, 49900);
  assert.equal(l.year, 2023);
  assert.equal(l.city, 'Muğla');
  assert.equal(l.sellerType, 'sahibinden');
  assert.match(l.image, /_580x435\.jpg$/);
});

import { buildMarket, analyzeListing, damageCounts, pctOf, saleSignal, suggestOffer, priceTrend } from '../src/analyze.js';
import { buildAlert, matchesVersion, watchHit, subjectOf } from '../src/notify.js';
import { recompute } from '../src/merge.js';

// Sentetik piyasa: rastgelelik yok, fiyatlar versiyona ve km'ye göre belirlenir
function market(extra = [], opts = { newPrices: {} }) {
  const db = emptyDb();
  let id = 1;
  const add = (n, modelRaw, year, price, o = {}) => {
    for (let i = 0; i < n; i++) {
      const km = 10000 + i * 2000;
      const key = `arabam:${id}`;
      db.listings[key] = { key, source: 'arabam', sourceId: String(id++), status: 'active', title: 'TESLA', modelRaw, year, km,
        price: Math.round(price * (1 - km / 1e6) * (1 + ((i % 5) - 2) * 0.01)), firstSeen: '2026-10-01T00:00:00Z', priceHistory: [], ...o };
    }
  };
  add(30, 'Tesla Model Y Premium (Juniper)', 2025, 3000000);
  add(12, 'Tesla Model Y Standart (Juniper)', 2026, 2450000);
  add(10, 'Tesla Model Y Long Range (Juniper)', 2025, 3700000);
  add(25, 'Tesla Model Y RWD (Legacy)', 2023, 1900000);
  add(20, 'Tesla Model Y Long Range (Legacy)', 2023, 2250000);
  add(4, 'Tesla Model Y Premium (Juniper)', 2025, 2100000, { title: 'AGIR HASAR KAYITLI' });
  for (const l of extra) db.listings[l.key] = { source: 'sahibinden', status: 'active', title: 'TESLA', firstSeen: '2026-10-01T00:00:00Z', priceHistory: [], ...l };
  recompute(db, opts);
  return db;
}

test('fiyat modeli: Juniper Standart, Premium ve Long Range ayrı fiyatlanır', () => {
  const db = market([
    { key: 'sahibinden:1', sourceId: '1', modelRaw: 'Tesla Model Y Standart (Juniper)', year: 2026, km: 20000, price: 2400000 },
    { key: 'sahibinden:2', sourceId: '2', modelRaw: 'Tesla Model Y Premium (Juniper)', year: 2025, km: 20000, price: 2950000 },
    { key: 'sahibinden:3', sourceId: '3', modelRaw: 'Tesla Model Y Long Range (Juniper)', year: 2025, km: 20000, price: 3650000 },
  ]);
  const [std, prem, lr] = ['sahibinden:1', 'sahibinden:2', 'sahibinden:3'].map((k) => db.listings[k].a);
  assert.ok(std.expected < 2600000 && std.expected > 2250000, `Standart beklenen ${std.expected}`);
  assert.ok(prem.expected > 2750000 && prem.expected < 3150000, `Premium beklenen ${prem.expected}`);
  assert.ok(lr.expected > 3350000, `Long Range beklenen ${lr.expected}`);
  for (const a of [std, prem, lr]) assert.ok(Math.abs(a.deviation) < 0.08, `adil fiyatlı ilan sapması ${a.deviation}`);
});

test('fiyat modeli: ağır hasarlı araç ağır hasarlılarla kıyaslanır, "Fırsat" olmaz', () => {
  const db = market([{ key: 'sahibinden:9', sourceId: '9', modelRaw: 'Tesla Model Y Premium (Juniper)', year: 2025, km: 20000, price: 2050000, title: 'agir hasarli' }]);
  const l = db.listings['sahibinden:9'];
  assert.equal(l.c.heavy, 'var');
  assert.ok(l.a.expectedClean > l.a.expected * 1.2, 'hasarsız eşdeğeri belirgin yüksek olmalı');
  assert.ok(Math.abs(l.a.deviation) < 0.12, `ağır hasarlı piyasaya göre sapma ${l.a.deviation}`);
  assert.notEqual(l.a.label, 'Fırsat');
  // Hasarsız piyasanın ortalaması ağır hasarlılardan etkilenmez
  const clean = db.listings['arabam:1'].a;
  assert.equal(clean.expectedClean, undefined);
});

test('fiyat modeli: tek ilanlı versiyon kendi fiyatını "piyasa" göstermez', () => {
  // Juniper Performance yalnızca bu ilan; beklenen fiyat diğer versiyonlardan türetilmeli
  const db = market([{ key: 'sahibinden:5', sourceId: '5', modelRaw: 'Tesla Model Y Performance (Juniper)', year: 2025, km: 10000, price: 1500000 }]);
  const a = db.listings['sahibinden:5'].a;
  assert.ok(a.deviation < -0.3, `kendine uyan tahmin olmamalı (sapma ${a.deviation})`);
  assert.ok(a.cautions.some((c) => /az ilan var/.test(c)));
});

test('fiyat modeli: beklenen fiyat aralığı versiyonun tipik hatasına göre; az ilanlıda geniş', () => {
  const db = market([
    { key: 'sahibinden:21', sourceId: '21', modelRaw: 'Tesla Model Y Premium (Juniper)', year: 2025, km: 20000, price: 2950000 },
    { key: 'sahibinden:22', sourceId: '22', modelRaw: 'Tesla Model Y Performance (Juniper)', year: 2025, km: 20000, price: 4300000 },
  ]);
  const dense = db.listings['sahibinden:21'].a;
  const thin = db.listings['sahibinden:22'].a;
  assert.ok(dense.expectedLow < dense.expected && dense.expected < dense.expectedHigh);
  assert.ok(dense.expectedLow <= 2950000 && 2950000 <= dense.expectedHigh, 'adil fiyatlı ilan aralıkta');
  const width = (a) => a.expectedHigh / a.expectedLow - 1;
  assert.ok(width(thin) > 2 * width(dense), `az ilanlı versiyonda aralık daha geniş (${width(thin)} / ${width(dense)})`);
  assert.ok(db.market.segments.find((x) => x.trim === 'Premium' && x.generation === 'Juniper').typicalError > 0);
});

test('fiyat modeli: "Fırsat" yalnızca aralığın altında; az ilanlı versiyonda aynı indirim Fırsat olmaz', () => {
  const base = market();
  const prem = base.listings['arabam:1'].a.expected; // yoğun versiyon (30 ilan)
  const db = market([
    { key: 'sahibinden:31', sourceId: '31', modelRaw: 'Tesla Model Y Premium (Juniper)', year: 2025, km: 10000, price: Math.round(prem * 0.92) },
    { key: 'sahibinden:32', sourceId: '32', modelRaw: 'Tesla Model Y Premium (Juniper)', year: 2025, km: 10000, price: Math.round(prem * 0.985) },
    { key: 'sahibinden:33', sourceId: '33', modelRaw: 'Tesla Model 3 Long Range', year: 2022, km: 40000, price: 1500000 },
    { key: 'sahibinden:34', sourceId: '34', modelRaw: 'Tesla Model Y Performance (Juniper)', year: 2025, km: 10000, price: 3500000 },
  ]);
  const a = (k) => db.listings[k].a;
  assert.equal(a('sahibinden:31').label, 'Fırsat', `%8 altı yoğun versiyonda aralık dışı (aralık ${a('sahibinden:31').expectedLow})`);
  assert.ok(['Piyasa', 'İyi fiyat'].includes(a('sahibinden:32').label), 'aralık içinde Fırsat değil');
  // Juniper Performance tek ilan: beklenen fiyat diğer versiyonlardan, aralık geniş → %8-10 indirim Fırsat sayılmaz
  const perf = a('sahibinden:34');
  const cheap = market([{ key: 'sahibinden:35', sourceId: '35', modelRaw: 'Tesla Model Y Performance (Juniper)', year: 2025, km: 10000, price: Math.round(perf.expected * 0.91) }]).listings['sahibinden:35'].a;
  assert.notEqual(cheap.label, 'Fırsat', `az ilanlı versiyon (aralık ${cheap.expectedLow}–${cheap.expectedHigh})`);
});

test('fiyat modeli: sıfır fiyatı az ilanlı versiyonu taşır, kartta oran gösterilir, sıfır fiyatına Fırsat denmez', () => {
  const newPrices = { 'Model Y · Juniper · Performance': 4996000, 'Model Y · Juniper · Standart': 2474985, _not: 'açıklama' };
  const extra = [{ key: 'sahibinden:41', sourceId: '41', modelRaw: 'Tesla Model Y Performance (Juniper)', year: 2026, km: 3000, price: 4650000 }];
  const without = market(extra).listings['sahibinden:41'].a;
  const withNew = market(extra, { newPrices, year: 2026 }).listings['sahibinden:41'].a;
  assert.ok(Math.abs(withNew.expected / 4996000 - 1) < Math.abs(without.expected / 4996000 - 1), `sıfır fiyatına yaklaşmalı (${without.expected} → ${withNew.expected})`);
  assert.equal(withNew.newPrice, 4996000);
  assert.equal(withNew.newRatio, Math.round((4650000 / 4996000) * 1000) / 1000);
  assert.ok(withNew.reasons.some((r) => /Sıfırının %93'ü/.test(r)));
  // Sıfır fiyatına satılan neredeyse sıfır Standart, tahminin altında kalsa da Fırsat değil
  const std = market([{ key: 'sahibinden:42', sourceId: '42', modelRaw: 'Tesla Model Y Standart (Juniper)', year: 2026, km: 6000, price: 2474000 }], { newPrices, year: 2026 }).listings['sahibinden:42'].a;
  assert.notEqual(std.label, 'Fırsat');
});

test('fiyat modeli: kategorisi şüpheli Juniper fiyatına uyan versiyona atanır', () => {
  const db = market([
    // "Standart" kategorisinde ama Premium fiyatında, başlıkta donanım yok
    { key: 'sahibinden:51', sourceId: '51', modelRaw: 'Tesla Model Y Standart', title: 'satılık 2025 model Y', year: 2025, km: 20000, price: 2980000 },
    // Kategori yalnızca RWD, Standart fiyatında
    { key: 'sahibinden:52', sourceId: '52', modelRaw: 'Tesla Model Y RWD', title: 'TEMİZ TESLA', year: 2025, km: 20000, price: 2420000 },
    // Başlığı Standart diyen gerçek Standart değişmez
    { key: 'sahibinden:53', sourceId: '53', modelRaw: 'Tesla Model Y Standart', title: 'STANDART JUNIPER', year: 2025, km: 20000, price: 2420000 },
  ]);
  const c = (k) => db.listings[k].c;
  assert.equal(c('sahibinden:51').trim, 'Premium');
  assert.equal(c('sahibinden:51').trimFrom, 'Standart');
  assert.ok(db.listings['sahibinden:51'].a.cautions.some((x) => /fiyatına ve 2025 model olmasına göre Premium varsayıldı/.test(x)));
  assert.equal(c('sahibinden:52').trim, 'Standart');
  assert.equal(c('sahibinden:53').trim, 'Standart');
  assert.equal(c('sahibinden:53').trimAlt, undefined);
});

test('hasar durumuna göre fiyat: değişen/boya/tramer beklenen fiyatı düşürür, hasarsız eşdeğeri gösterilir', () => {
  const mk = (id, damage) => ({ key: `arabam:9${id}`, sourceId: `9${id}`, modelRaw: 'Tesla Model Y Premium (Juniper)', year: 2025, km: 20000, price: 2900000, damage });
  const db = market([mk(1, { summary: 'Tamamı orjinal', original: true, tramer: 0 }), mk(2, { summary: '3 değişen, 2 boyalı', tramer: 180000 })]);
  const clean = db.listings['arabam:91'].a, dmg = db.listings['arabam:92'].a;
  assert.ok(dmg.expected < clean.expected * 0.93, `hasarlı beklenen ${dmg.expected} < ${clean.expected}`);
  assert.ok(dmg.expectedClean > dmg.expected && dmg.damageDiscount < -0.07);
  assert.ok(dmg.reasons.some((r) => /Hasar durumu fiyata yansıtıldı \(3 değişen, 2 boyalı, tramer 180 bin\)/.test(r)));
  assert.equal(clean.expectedClean, undefined);
  assert.ok(db.market.damageEffects.changed < 0 && db.market.damageEffects.heavy < -0.1);
  assert.deepEqual([93, 110, 86, 40, 100, 120, 47].map(pctOf), ["%93'ü", "%110'u", "%86'sı", "%40'ı", "%100'ü", "%120'si", "%47'si"]);
  assert.deepEqual(damageCounts({ summary: '1 değişen, 1 boyalı, 2 lokal boyalı' }), { changed: 1, painted: 1, local: 2, paint: 2, tramer: 0 });
});

test('fiyat modeli: pahalı opsiyonlar beklenen fiyatı artırır ve kartta gösterilir', () => {
  const mk = (id, title) => ({ key: `sahibinden:6${id}`, sourceId: `6${id}`, modelRaw: 'Tesla Model Y Premium (Juniper)', year: 2025, km: 20000, price: 2950000, title });
  const db = market([mk(1, 'TESLA'), mk(2, 'TESLA EAP QUICKSILVER')]);
  const plain = db.listings['sahibinden:61'].a, rich = db.listings['sahibinden:62'].a;
  assert.ok(rich.expected > plain.expected * 1.025, `${rich.expected} > ${plain.expected}`);
  assert.ok(rich.reasons.some((r) => /Opsiyonlar beklenen fiyata eklendi: otopilot paketi \+%\d/.test(r)));
  assert.ok(db.market.optionEffects['otopilot paketi'] > 0);
});

test('ağır hasar geçmişi: aynı aracın diğer sitedeki (kalkmış) ilanı ağır hasarlıysa bu ilan da sayılır', () => {
  const car = { modelRaw: 'Tesla Model Y RWD (Legacy)', title: 'GALERİ TUNCAY TESLA MODEL Y RWD 28.000 KM CAM TAVAN', year: 2024, km: 28000, price: 1830000, city: 'Gaziantep' };
  const db = market([
    { ...car, key: 'arabam:801', source: 'arabam', sourceId: '801', status: 'removed', removedAt: '2026-10-17T00:00:00Z', damage: { heavy: true } },
    { ...car, key: 'sahibinden:801', sourceId: '801', damage: { heavy: false } },
  ]);
  const l = db.listings['sahibinden:801'];
  assert.equal(l.c.heavy, 'var');
  assert.equal(l.c.heavyFrom, 'arabam (kalkmış)');
  assert.ok(l.a.cautions.some((c) => /arabam \(kalkmış\) ilanında ağır hasar kayıtlı/.test(c)));
  assert.ok(!l.a.cautions.some((c) => /İlan metninde/.test(c)));
});

test('fiyat modeli: olağan aralığın çok altındaki hasarsız görünen ilan Şüpheli', () => {
  const db = market([{ key: 'sahibinden:61', sourceId: '61', modelRaw: 'Tesla Model Y Premium (Juniper)', year: 2025, km: 15000, price: 2500000 }]);
  const a = db.listings['sahibinden:61'].a;
  assert.equal(a.label, 'Şüpheli', `sapma ${a.deviation}, z ${a.z}`);
  assert.ok(a.cautions[0].includes('kaydı görünmeyen ağır hasar'));
});

test('satış sinyali: kısa sürede kalkan ilanlar ucuzsa satış oranı < 1, eskiden kalkanlar ucuzsa piyasa yükseliyor', () => {
  const now = Date.parse('2026-10-28T12:00:00Z');
  const extra = [];
  // 40 kalkmış ilan: w hafta önce kalkmış, fiyatı bugünkü seviyenin %2 + w×%1 altında, 5 günde satılmış
  for (let i = 0; i < 40; i++) {
    const w = i % 4, removedAt = new Date(now - w * 7 * 86400000).toISOString();
    extra.push({ key: `sahibinden:7${i}`, sourceId: `7${i}`, modelRaw: 'Tesla Model Y Premium (Juniper)', year: 2025, km: 20000, status: 'removed', removedAt,
      publishedAt: new Date(now - (w * 7 + 5) * 86400000).toISOString(), price: Math.round(2950000 * Math.exp(-0.02 - 0.01 * w)) });
  }
  const db = market(extra);
  const sale = saleSignal(Object.values(db.listings), buildMarket(Object.values(db.listings), { newPrices: {} }), now);
  assert.ok(sale && sale.n === 40);
  assert.ok(sale.saleRatio < 0.995 && sale.saleRatio > 0.95, `satış oranı ${sale.saleRatio}`);
  assert.ok(Math.abs(sale.weeklyDrift - 0.01) < 0.004, `haftalık kayma ${sale.weeklyDrift}`);
  assert.ok(db.market.sale, 'piyasa özetinde satış sinyali');
});

test('teklif önerisi: ucuz ilanda ilan fiyatından küçük pay, pahalıda piyasa seviyesi; uzun bekleyende pay artar', () => {
  const cheap = suggestOffer({ price: 2800000, expected: 3000000, low: 2850000, daysOn: 5, drops: 0, saleRatio: 0.98 });
  assert.equal(cheap.basis, 'ilan');
  assert.equal(cheap.offer, 2740000); // %2 pay
  const pricey = suggestOffer({ price: 3300000, expected: 3000000, low: 2850000, daysOn: 5, drops: 0, saleRatio: 0.98 });
  assert.equal(pricey.basis, 'piyasa');
  assert.equal(pricey.offer, 2940000);
  const stale = suggestOffer({ price: 2800000, expected: 3000000, low: 2850000, daysOn: 70, drops: 2, saleRatio: 0.98 });
  assert.ok(stale.offer < cheap.offer && stale.nego > 0.04);
  // Asla ilan fiyatının %15'inden fazla aşağısı önerilmez
  assert.equal(suggestOffer({ price: 4000000, expected: 3000000, low: 2850000, daysOn: 1, drops: 0 }).offer, 3400000);
  const db = market([{ key: 'sahibinden:81', sourceId: '81', modelRaw: 'Tesla Model Y Premium (Juniper)', year: 2025, km: 20000, price: 3100000 }]);
  const a = db.listings['sahibinden:81'].a;
  assert.ok(a.offer > 2600000 && a.offer < 3100000, `teklif ${a.offer}`);
});

test('fiyat trendi: yeni ilanların giriş fiyatı haftadan haftaya yükselirse trend pozitif', () => {
  const now = Date.parse('2026-10-28T12:00:00Z');
  const ls = [];
  for (let w = 0; w < 4; w++) for (let i = 0; i < 6; i++) {
    const pub = new Date(now - (w * 7 + 2) * 86400000).toISOString();
    ls.push({ key: `t${w}${i}`, status: 'active', publishedAt: pub, firstSeen: pub, price: Math.round(3000000 * (1 - 0.01 * w)), priceHistory: [],
      c: { model: 'Model Y', generation: 'Juniper', trim: 'Premium', segment: 'Model Y · Juniper · Premium' }, a: { expected: 3000000 } });
  }
  // İlk tam taramada görülen eski ilan (yayından çok sonra görülmüş) sayılmaz
  ls.push({ key: 'eski', status: 'active', publishedAt: '2026-08-01T09:00:00Z', firstSeen: '2026-10-02T00:00:00Z', price: 1000000, c: ls[0].c, a: { expected: 3000000 } });
  const t = priceTrend(ls, now)['Model Y · Juniper · Premium'];
  assert.equal(t.days, 21);
  assert.ok(Math.abs(t.change - 0.03) < 0.005, `değişim ${t.change}`);
  assert.equal(t.weeks.length, 8);
});

test('mail: versiyon filtresi ve hedef fiyatlı takip', () => {
  const l = (key, trim, generation, price, o = {}) => ({ key, status: 'active', price, km: 20000, year: 2025, c: { model: 'Model Y', generation, trim, heavy: 'yok' }, a: { label: 'Piyasa', score: 50 }, ...o });
  const std = l('s1', 'Standart', 'Juniper', 2250000);
  const prem = l('p1', 'Premium', 'Juniper', 3300000);
  const legacy = l('l1', 'Standart RWD', 'Legacy', 2200000);
  assert.ok(matchesVersion(std, 'Juniper Standart') && matchesVersion(std, 'Model Y · Juniper · Standart') && matchesVersion(std, 'juniper standart'));
  assert.ok(!matchesVersion(legacy, 'Juniper Standart') && !matchesVersion(legacy, 'Standart'));
  const alerts = { onlyLabels: ['Fırsat'], notifyPriceDrops: false, watches: [{ version: 'Juniper Standart', maxPrice: 2300000 }] };
  assert.equal(watchHit(std, alerts), 'Juniper Standart, ≤ 2,30 M, hasarsız');
  assert.equal(watchHit({ ...std, price: 2400000 }, alerts), null);
  assert.equal(watchHit({ ...std, c: { ...std.c, heavy: 'var' } }, alerts), null, 'ağır hasarlı takipte bildirilmez');
  const db = { listings: { s1: std, p1: prem, l1: legacy } };
  // Genel filtre yalnızca Fırsat istese de takipteki ilan bildirilir; fiyat düşüşü genel ayar kapalıyken de gelir
  const al = buildAlert(db, { added: ['s1', 'p1'], priceChanged: [{ key: 's1', from: 2350000, to: 2250000 }, { key: 'p1', from: 3400000, to: 3300000 }], removed: [], returned: [] }, alerts);
  assert.deepEqual(al.added.map((x) => x.key), ['s1']);
  assert.deepEqual(al.prices.map((x) => x.key), ['s1']);
  assert.match(subjectOf(al), /^🚗 🎯 Juniper Standart, ≤ 2,30 M, hasarsız: Juniper Standart 2\.250\.000 TL · /);
  // versions: yalnızca seçili versiyonlar
  const v = buildAlert(db, { added: ['s1', 'p1', 'l1'], priceChanged: [], removed: [], returned: [] }, { versions: ['Juniper Premium'] });
  assert.deepEqual(v.added.map((x) => x.key), ['p1']);
});

test('sahibinden ağır hasar listesi: boş veya filtresiz gelen liste kimseyi "kaydı yok" yapmaz', () => {
  const db = emptyDb();
  const mk = (id) => ({ source: 'sahibinden', sourceId: id, title: 'Tesla Model Y', modelRaw: 'Tesla Model Y RWD', year: 2023, km: 30000, price: 2000000 });
  const all = Array.from({ length: 12 }, (_, i) => String(1300000001 + i));
  mergeScans(db, [{ source: 'sahibinden', ok: true, complete: false, listings: all.map(mk), runner: 'tablet' }]);
  mergeScans(db, [{ source: 'sahibinden', ok: true, complete: false, mode: 'heavy', listings: [], heavyIds: [], heavyComplete: true, runner: 'tablet' }]);
  assert.equal(db.listings['sahibinden:1300000001'].c.heavy, 'bilinmiyor', 'boş liste');
  // Filtre çalışmamış: listedeki ilan sayısı aktif ilanların yarısından fazla
  mergeScans(db, [{ source: 'sahibinden', ok: true, complete: false, mode: 'heavy', listings: [], heavyIds: all, heavyComplete: true, runner: 'tablet' }]);
  assert.equal(db.listings['sahibinden:1300000001'].damage?.heavy ?? null, null);
  assert.equal(db.listings['sahibinden:1300000001'].c.heavy, 'bilinmiyor');
});

import { groupDamage } from '../src/dedupe.js';

test('aynı araç: bir sitedeki ağır hasar/tramer bilgisi diğer sitedeki "yok"u ezer', () => {
  const byKey = {
    'sahibinden:1': { key: 'sahibinden:1', damage: { heavy: false, tramer: null } },
    'arabam:1': { key: 'arabam:1', damage: { heavy: true, tramer: 185000, painted: true, summary: '2 parça boyalı' } },
  };
  const l = { ...byKey['sahibinden:1'], dup: { members: ['sahibinden:1', 'arabam:1'] } };
  const d = groupDamage(l, byKey);
  assert.equal(d.heavy, true);
  assert.equal(d.tramer, 185000);
  assert.equal(d.original, false);
});

import { parseDetail } from '../src/sources/arabam.js';

test('arabam detayı: ağır hasar alanı farklı yazımlarla okunur', () => {
  const page = (k, v) => `{"Id":1,"Key":"${k}","Value":"${v}"} "DamageInfo":{"Status":2,"DamagePrice":0}`;
  assert.equal(parseDetail(page('Ağır Hasarlı', 'Evet')).damage.heavy, true);
  assert.equal(parseDetail(page('Ağır Hasar Kayıtlı', 'EVET')).damage.heavy, true);
  assert.equal(parseDetail(page('Ağır Hasarlı', 'Hayır')).damage.heavy, false);
  assert.equal(parseDetail(page('Renk', 'Beyaz')).damage.heavy, null);
});

import { autoUpdateMode, checkForUpdate } from '../src/update.js';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

test('otomatik güncelleme modu: tablet kapanır, launchd ile çalışan Mac kodu çeker', () => {
  assert.equal(autoUpdateMode({ ARACTAKIP_AUTOUPDATE: '1' }, 'android', 500), 'exit');
  assert.equal(autoUpdateMode({}, 'darwin', 1), 'pull');
  assert.equal(autoUpdateMode({ XPC_SERVICE_NAME: 'com.aractakip.agent' }, 'darwin', 400), 'pull');
  assert.equal(autoUpdateMode({ XPC_SERVICE_NAME: '0' }, 'darwin', 400), null, 'terminalden "npm run agent"');
  assert.equal(autoUpdateMode({ ARACTAKIP_AUTOUPDATE: '0' }, 'darwin', 1), null);
  assert.equal(autoUpdateMode({}, 'linux', 1), null);
});

test('Mac ajanı main\'deki yeni kodu kendisi çeker, yerel değişikliğe dokunmaz', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aractakip-'));
  const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8' }).trim();
  const write = (dir, f, txt) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), txt); };
  try {
    git(tmp, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
    git(tmp, 'clone', '-q', 'origin.git', 'dev');
    const dev = path.join(tmp, 'dev');
    write(dev, 'src/a.js', '1');
    write(dev, 'web/app.js', '1');
    git(dev, 'add', '.');
    git(dev, 'commit', '-q', '-m', 'ilk');
    git(dev, 'push', '-q', 'origin', 'main');
    git(tmp, 'clone', '-q', 'origin.git', 'mac');
    const mac = path.join(tmp, 'mac');
    const head = () => git(mac, 'rev-parse', 'HEAD');
    const push = (f, txt) => { write(dev, f, txt); git(dev, 'commit', '-q', '-am', f); git(dev, 'push', '-q', 'origin', 'main'); return git(dev, 'rev-parse', 'HEAD'); };

    let since = head();
    assert.equal(await checkForUpdate({ dir: mac, mode: 'pull', since }), 'none');
    // Yalnızca site dosyası değişti: çekilir, yeniden başlatma gerekmez
    let tip = push('web/app.js', '2');
    assert.equal(await checkForUpdate({ dir: mac, mode: 'pull', since }), 'files');
    assert.equal(head(), tip);
    // Kod değişti: çekilir, ajan yeniden başlamalı
    tip = push('src/a.js', '2');
    assert.equal(await checkForUpdate({ dir: mac, mode: 'pull', since }), 'restart');
    assert.equal(head(), tip);
    since = head();
    assert.equal(await checkForUpdate({ dir: mac, mode: 'pull', since }), 'none', 'yeniden başladıktan sonra döngüye girmez');
    // Tablet modu yalnızca haber verir; kodu termux-run.sh çeker
    tip = push('src/a.js', '3');
    assert.equal(await checkForUpdate({ dir: mac, mode: 'exit', since }), 'restart');
    assert.notEqual(head(), tip);
    // Elle yapılmış yerel değişiklik ezilmez
    write(mac, 'src/a.js', 'yerel');
    assert.ok((await checkForUpdate({ dir: mac, mode: 'pull', since })).skipped);
    assert.equal(fs.readFileSync(path.join(mac, 'src/a.js'), 'utf8'), 'yerel');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('arabam mobil kart düzeni: model adresten, km başlıktan', async () => {
  const { fromRows, modelFromHref } = await import('../src/sources/arabam.js');
  assert.equal(modelFromHref('/ilan/galeriden-satilik-tesla-model-y-rwd-juniper/baslik/44688889'), 'Tesla Model Y RWD Juniper');
  assert.equal(modelFromHref('/ilan/yetkili-bayiden-satilik-tesla-model-3-long-range/x/1'), 'Tesla Model 3 Long Range');
  const { listings, rowCount } = fromRows([
    { mobile: true, id: '44972280', href: '/ilan/galeriden-satilik-tesla-model-y-rwd-legacy/dc-garaj/44972280', title: 'TESLA MODEL Y/2025/26.000KM/SOLID BLACK', cells: [], priceText: ' 2.729.750 TL ', locs: ['İstanbul', 'Kağıthane'], image: 'https://x/a_240x180.jpg' },
    { mobile: true, id: '44983429', href: '/ilan/sahibinden-satilik-renault-clio-1-0-tce-joy/tesla-ekranli/44983429', title: 'Tesla ekranlı Clio', cells: [], priceText: '1.170.000 TL', locs: [], image: null },
  ]);
  assert.equal(rowCount, 2);
  assert.equal(listings.length, 1);
  const [l] = listings;
  assert.equal(l.modelRaw, 'Tesla Model Y RWD Legacy');
  assert.equal(l.km, 26000);
  assert.equal(l.price, 2729750);
  assert.equal(l.year, null);
  assert.equal(l.city, 'İstanbul');
  assert.equal(l.sellerType, 'galeri');
});

import { parseDetail as parseSahDetail, detailCandidates } from '../src/sources/sahibinden.js';
import { createBridge } from '../src/bridge.js';

const SAH_DETAIL = {
  id: '1348205308',
  props: { 'İlan No': '1348205308', 'Seri': 'Model Y', 'Model': 'Standart (Juniper)', 'Yıl': '2025', 'KM': '14.400', 'Çekiş': 'Arkadan İtiş',
    'Renk': 'Beyaz', 'Garanti': 'Evet', 'Ağır Hasar Kayıtlı': 'Hayır', 'Kimden': 'Galeriden', 'Menzil': '534 km' },
  desc: 'Araç hatasızdır. Tramer kaydı 85 bin TL (sağ arka kapı). Geliştirilmiş otopilot ve komple PPF mevcuttur.',
  damage: [
    { label: 'Orijinal', items: ['Tavan', 'Kaput', 'Sol Ön Kapı'] },
    { label: 'Lokal Boyalı', items: ['Sağ Arka Kapı'] },
    { label: 'Boyalı', items: ['Sağ Arka Çamurluk', 'Arka Tampon'] },
    { label: 'Değişmiş', items: [] },
  ],
};

test('sahibinden detayı: ağır hasar alanı, boya/değişen grupları, açıklamadan tramer', () => {
  const d = parseSahDetail(SAH_DETAIL);
  assert.equal(d.damage.heavy, false);
  assert.equal(d.damage.heavyBy, 'detay');
  assert.equal(d.damage.summary, '2 boyalı, 1 lokal boyalı');
  assert.equal(d.damage.original, false);
  assert.equal(d.damage.painted, true);
  assert.equal(d.damage.changed, false);
  assert.equal(d.damage.tramer, 85000);
  assert.equal(d.damage.tramerFrom, 'açıklama');
  assert.equal(d.specs.drive, 'Arkadan İtiş');
  assert.equal(d.specs.rangeKm, 534);
  assert.equal(d.sellerType, 'galeri');
  assert.equal(d.warranty, 'Garantili');
  assert.match(d.description, /^Araç hatasızdır/);
  assert.deepEqual(damageCounts(d.damage), { changed: 0, painted: 2, local: 1, paint: 2.5, tramer: 85000 });
  // Hepsi orijinal; ağır hasar "Evet"
  const o = parseSahDetail({ props: { 'Ağır Hasar Kayıtlı': 'Evet' }, damage: [{ label: 'Orijinal', items: ['Tavan'] }, { label: 'Boyalı', items: [] }] });
  assert.deepEqual([o.damage.heavy, o.damage.summary, o.damage.original], [true, 'Tamamı orjinal', true]);
  // Grup başlığı yoksa parça şemasının sınıf adlarından
  const p = parseSahDetail({ props: { Seri: 'Model Y' }, parts: [{ cls: 'part changed' }, { cls: 'part painted' }, { cls: 'part original' }] });
  assert.equal(p.damage.summary, '1 değişen, 1 boyalı');
  // Bilgi yoksa alan yazılmaz (eski bilgiyi ezmesin)
  assert.deepEqual(parseSahDetail({ props: { Seri: 'Model Y' } }).damage, {});
});

test('sahibinden detayı: yeni ilanlar önce, sonra Fırsat/Şüpheli; detayı olan veya kalkan ilan istenmez', () => {
  const now = Date.parse('2026-10-29T12:00:00Z');
  const mk = (id, o) => ({ key: `sahibinden:${id}`, source: 'sahibinden', status: 'active', url: `https://www.sahibinden.com/ilan/tesla-${id}/detay`, firstSeen: '2026-10-01T00:00:00Z', a: { label: 'Piyasa', z: 0 }, ...o });
  const ls = [
    mk(1, { firstSeen: '2026-10-29T08:00:00Z' }), mk(2, { firstSeen: '2026-10-28T20:00:00Z' }),
    mk(3, { a: { label: 'Fırsat', z: -1.5 } }), mk(4, { a: { label: 'Şüpheli', z: -5 } }),
    mk(5), mk(6, { firstSeen: '2026-10-29T09:00:00Z', detailAt: '2026-10-29T10:00:00Z', detailV: 2 }),
    mk(7, { firstSeen: '2026-10-29T09:00:00Z', status: 'removed' }), { ...mk(8, { firstSeen: '2026-10-29T09:00:00Z' }), source: 'arabam' },
  ];
  assert.deepEqual(detailCandidates(ls, now).map((u) => u.match(/tesla-(\d+)/)[1]), ['1', '2', '4', '3']);
});

function testBridge({ caps, candidates = ['https://www.sahibinden.com/ilan/tesla-1348205308/detay'], intervals = {} } = {}) {
  const now = new Date().toISOString();
  const scans = [];
  const shared = (src) => ({ lastOk: now, lastFull: now, lastHeavy: now, lastOkRunner: 'local' });
  const b = createBridge({ onScan: async (sc) => scans.push(sc), needDetail: (src) => (src === 'sahibinden' ? candidates : []), shared, intervals: { gap: 0, ...intervals } });
  if (caps) b.page({ url: 'https://www.sahibinden.com/tesla', caps, ev: '2.2.2', challenge: true }); // eklenti yeteneklerini bildirir
  return { b, scans };
}

test('köprü: detay sayfası yalnızca destekleyen eklentiye istenir', async () => {
  assert.equal(testBridge().b.next(), null, 'eski eklenti: detay istenmez');
  const old = testBridge();
  old.b.page({ url: 'https://www.sahibinden.com/tesla', caps: ['sahibindenDetail'], challenge: true });
  assert.equal(old.b.next(), null, 'sürüm bildirmeyen 2.2.0/2.2.1: detay istenmez');
  const { b, scans } = testBridge({ caps: ['sahibindenDetail'] });
  const url = b.next();
  assert.match(url, /1348205308\/detay/);
  await b.page({ url, kind: 'sahibindenDetail', detail: SAH_DETAIL, caps: ['sahibindenDetail'] });
  assert.equal(scans.length, 1);
  assert.equal(scans[0].mode, 'detail');
  assert.equal(scans[0].listings[0].sourceId, '1348205308');
  assert.equal(scans[0].listings[0].damage.heavy, false);
  assert.ok(scans[0].listings[0].detailAt);
  assert.equal(b.status().sahibindenDetail24h, 1);
});

test('köprü: okunamayan detay tekrar istenmez; günlük sınır aşılmaz', async () => {
  const { b } = testBridge({ caps: ['sahibindenDetail'], intervals: { sahibindenDetail: 0 } });
  const url = b.next();
  await b.page({ url, kind: 'sahibindenDetail', detail: { id: '1348205308', empty: true, title: 'İlan yayında değil' } });
  assert.equal(b.next(), null, 'başarısız ilan tekrar istenmez');
  const many = Array.from({ length: 5 }, (_, i) => `https://www.sahibinden.com/ilan/tesla-13000000${i}0/detay`);
  const t = testBridge({ caps: ['sahibindenDetail'], candidates: many, intervals: { sahibindenDetail: 0, sahibindenDetailPerDay: 2 } });
  const got = [];
  for (let i = 0; i < 4; i++) {
    const u = t.b.next();
    if (u) { got.push(u); await t.b.page({ url: u, kind: 'sahibindenDetail', detail: { ...SAH_DETAIL, id: u.match(/(\d{9,})/)[1] } }); }
  }
  assert.equal(got.length, 2);
});

test('birleştirme: detaydaki ağır hasar alanını ağır hasar listesi ezmez; açıklama sınıflandırmaya girer', () => {
  const db = emptyDb();
  const base = { source: 'sahibinden', sourceId: '1348205308', title: 'TESLA', modelRaw: 'Tesla Model Y Standart', year: 2025, km: 14400, price: 2470000 };
  mergeScans(db, [{ source: 'sahibinden', ok: true, listings: [base], runner: 'tablet' }]);
  mergeScans(db, [{ source: 'sahibinden', ok: true, mode: 'detail', runner: 'tablet', listings: [{ source: 'sahibinden', sourceId: '1348205308', ...parseSahDetail({ ...SAH_DETAIL, props: { ...SAH_DETAIL.props, 'Ağır Hasar Kayıtlı': 'Evet' } }), detailAt: new Date().toISOString() }] }]);
  const l = db.listings['sahibinden:1348205308'];
  assert.ok(db.sources.sahibinden.lastDetail);
  assert.equal(l.c.heavy, 'var');
  assert.ok(l.c.tags.includes('EAP') && l.c.tags.includes('PPF'), 'açıklamadaki opsiyonlar');
  // Ağır hasar listesi bu ilanı içermese de "Evet" bilgisi kalır
  const others = Array.from({ length: 12 }, (_, i) => ({ ...base, sourceId: String(1300000000 + i) }));
  mergeScans(db, [{ source: 'sahibinden', ok: true, listings: others, runner: 'tablet' }]);
  mergeScans(db, [{ source: 'sahibinden', ok: true, mode: 'heavy', listings: [], heavyIds: ['1300000000'], heavyComplete: true, runner: 'tablet' }]);
  assert.equal(db.listings['sahibinden:1348205308'].damage.heavy, true);
  assert.equal(db.listings['sahibinden:1300000001'].damage.heavy, false);
  // Sonraki liste taraması (hasar bilgisi boş) detay bilgisini silmez
  mergeScans(db, [{ source: 'sahibinden', ok: true, listings: [{ ...base, damage: { tramer: null, heavy: null, summary: null, original: null } }], runner: 'tablet' }]);
  const after = db.listings['sahibinden:1348205308'];
  assert.equal(after.damage.summary, '2 boyalı, 1 lokal boyalı');
  assert.equal(after.damage.tramer, 85000);
  assert.ok(after.description);
});

test('köprü: üst üste 3 okunamayan detay sayfasından sonra detay okuma 12 saat durur', async () => {
  const many = Array.from({ length: 6 }, (_, i) => `https://www.sahibinden.com/ilan/tesla-13000000${i}0/detay`);
  const { b } = testBridge({ caps: ['sahibindenDetail'], candidates: many, intervals: { sahibindenDetail: 0 } });
  for (let i = 0; i < 3; i++) {
    const u = b.next();
    assert.ok(u, `${i + 1}. deneme`);
    await b.page({ url: u, kind: 'sahibindenDetail', detail: { id: u.match(/(\d{9,})/)[1], empty: true, title: 'x', diag: { classes: ['a'], html: '<div>', mobile: false } } });
  }
  assert.equal(b.next(), null);
  assert.ok(b.status().sahibindenDetailPausedUntil);
});

test('köprü: yeni eklenti sürümü gelince detay okuma durdurması ve hatalı ilanlar sıfırlanır', async () => {
  const { b } = testBridge({ caps: ['sahibindenDetail'], intervals: { sahibindenDetail: 0 } });
  for (let i = 0; i < 3; i++) {
    const u = b.next();
    if (u) await b.page({ url: u, kind: 'sahibindenDetail', detail: { id: '1348205308', empty: true } });
  }
  assert.equal(b.next(), null, 'durdu');
  await b.page({ url: 'https://www.sahibinden.com/tesla', challenge: true, caps: ['sahibindenDetail'], ev: '2.2.3' });
  assert.match(b.next(), /1348205308/, 'aynı ilan yeni sürümle tekrar denenir');
  assert.equal(b.status().extVersion, '2.2.3');
});

// Tabletteki gerçek detay sayfalarından (Ekim 2026) – açıklama kutusu, satıcı yazısı + boya/değişen + donanım listesi
const FEATURES = '\nGüvenlik\nABS\nAEB\nÇocuk Kilidi\nİç Donanım\nKoltuklar (Soğutmalı)\nDış Donanım\nPanoramik Cam Tavan\nRömork Çeki Demiri\nMultimedya\nApple CarPlay';
const REAL = {
  props: { 'Araç Durumu': 'İkinci El', Marka: 'Tesla', 'İlan No': '1348549733', Seri: 'Model Y', Model: 'Premium Long Range', Yıl: '2025', KM: '18.000',
    'Motor Gücü': '526 - 550 HP', Çekiş: 'Arkadan İtiş', Renk: 'Beyaz', 'Ağır Hasar Kayıtlı': 'Evet', Kimden: 'Sahibinden', Takas: 'Hayır' },
  damage: [{ label: 'Orijinal', items: [] }, { label: 'Lokal Boyalı', items: [] }, { label: 'Boyalı', items: [] }, { label: 'Değişen', items: [] }],
};

test('sahibinden detayı (gerçek düzen): boya/değişen bölüm metninden, açıklama satıcı yazısından, motor gücü aralığı', () => {
  const damaged = parseSahDetail({ ...REAL, desc: `Boyalı veya Değişen Parça\nOrijinal\nLokal Boyalı\nBoyalı\nDeğişen\nD\nD\nDeğişen Parçalar\nMotor Kaputu\nSağ Ön Çamurluk${FEATURES}` });
  assert.equal(damaged.damage.summary, '2 değişen');
  assert.equal(damaged.damage.changed, true);
  assert.equal(damaged.damage.heavy, true);
  assert.equal(damaged.description, '', 'satıcı yazısı yok: donanım listesi açıklama sayılmaz');
  assert.equal(damaged.specs.hp, 526);
  assert.equal(damaged.detailV, 2);
  const clean = parseSahDetail({ ...REAL, desc: `Aracı geçen yıl aldık. Tramer ve hasar kaydı yoktur. EAP ömür boyu.\nBoyalı veya Değişen Parça\nOrijinal\nLokal Boyalı\nBoyalı\nDeğişen\nOrijinal\nAracın tüm parçaları orijinaldır. Değişen ve boyalı parçası bulunmamaktadır.${FEATURES}` });
  assert.deepEqual([clean.damage.summary, clean.damage.original, clean.damage.painted, clean.damage.changed], ['Tamamı orjinal', true, false, false]);
  assert.equal(clean.description, 'Aracı geçen yıl aldık. Tramer ve hasar kaydı yoktur. EAP ömür boyu.');
  assert.equal(clean.damage.tramer, 0);
  const mixed = parseSahDetail({ ...REAL, desc: 'Boyalı veya Değişen Parça Orijinal Lokal Boyalı Boyalı Değişen LB B Lokal Boyalı Parçalar Bagaj Kapağı Boyalı Parçalar Ön Tampon Sol Ön Kapı Güvenlik ABS' });
  assert.equal(mixed.damage.summary, '2 boyalı, 1 lokal boyalı');
  // Bölüm metni kesilmişse "boyasız" sanılmaz
  const cut = parseSahDetail({ ...REAL, desc: 'Uzun satıcı yazısı' });
  assert.equal(cut.damage.painted, undefined);
  assert.equal(cut.damage.summary, undefined);
  // Classify: donanım listesindeki "Römork Çeki Demiri" etiket olmaz (açıklama artık yalnızca satıcı yazısı)
  assert.ok(!classify({ modelRaw: 'Tesla Model Y Premium Long Range', year: 2025, title: 'TESLA', description: damaged.description }).tags.includes('Çekme demiri'));
});

test('sahibinden detayı: eski ayrıştırıcıyla okunmuşlar yeni ilanlardan sonra yeniden okunur', () => {
  const now = Date.parse('2026-10-29T12:00:00Z');
  const mk = (id, o) => ({ key: `sahibinden:${id}`, source: 'sahibinden', status: 'active', url: `https://www.sahibinden.com/ilan/tesla-${id}/detay`, firstSeen: '2026-10-01T00:00:00Z', a: { label: 'Piyasa' }, ...o });
  const ls = [mk(1, { detailAt: 'x' }), mk(2, { firstSeen: '2026-10-29T08:00:00Z' }), mk(3, { detailAt: 'x', detailV: 2 }), mk(4, { a: { label: 'Fırsat' } })];
  assert.deepEqual(detailCandidates(ls, now).map((u) => u.match(/tesla-(\d+)/)[1]), ['2', '1', '4']);
});
