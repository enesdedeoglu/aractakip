import test from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../src/classify.js';
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

import { buildMarket, analyzeListing } from '../src/analyze.js';
import { recompute } from '../src/merge.js';

// Sentetik piyasa: rastgelelik yok, fiyatlar versiyona ve km'ye göre belirlenir
function market(extra = []) {
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
  recompute(db);
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
