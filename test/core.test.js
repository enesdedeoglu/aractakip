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
  const [l] = normalize([{ url: 'https://www.sahibinden.com/tesla', heads, rows: [{ id: '1', cells: vals.map((text) => ({ cls: '', text })) }] }]);
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
