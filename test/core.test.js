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
  assert.equal(c.trim, 'Long Range');
  assert.equal(classify({ modelRaw: 'Tesla Model S P100D', year: 2017 }).trim, 'Performance');
  assert.equal(classify({ modelRaw: 'Tesla Model Y RWD (Legacy) 218 BG', year: 2025 }).generation, 'Legacy');
});

test('olumsuz hasar ifadeleri uyarı üretmez', () => {
  assert.deepEqual(classify({ modelRaw: 'Tesla Model Y', title: 'ağır hasar kaydı yok, hasarlı değil' }).warnings, []);
  assert.ok(classify({ modelRaw: 'Tesla Model Y', title: 'ağır hasarlı' }).warnings.includes('Ağır hasar kayıtlı'));
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
