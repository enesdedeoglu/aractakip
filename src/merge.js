// Tarama sonuçlarını veritabanına işler; yeni / fiyat değişimi / kalkan ilanları tespit eder.
import { classify } from './classify.js';
import { buildMarket, analyzeListing, marketSummary } from './analyze.js';

const HOUR = 3600000;
const KEEP_REMOVED_DAYS = 120;
const MAX_EVENTS = 500;

export const keyOf = (l) => `${l.source}:${l.sourceId}`;

/**
 * @param db  veritabanı (yerinde değiştirilir)
 * @param scans  [{ source, ok, error, listings, complete, mode, runner }]
 * @returns değişiklikler
 */
export function mergeScans(db, scans, now = new Date()) {
  const t = now.toISOString();
  const changes = { added: [], priceChanged: [], removed: [], returned: [] };

  for (const s of scans) {
    // Durum, çalıştıran (cloud / local) bazında tutulur; böylece bulutta engellenen bir kaynak
    // yerel ajanın başarılı sonucunu ezmez.
    const st = (db.sources[s.source] ||= {});
    const run = ((st.runs ||= {})[s.runner] ||= {});
    run.lastRun = t;
    run.ok = s.ok;
    run.error = s.ok ? null : s.error;
    if (!s.ok) continue;
    st.lastOk = t;
    st.lastOkRunner = s.runner;
    if (s.complete) st.lastFull = t;

    const seen = new Set();
    for (const raw of s.listings) {
      const key = keyOf(raw);
      seen.add(key);
      const prev = db.listings[key];
      if (!prev) {
        const l = {
          ...raw,
          key,
          firstSeen: t,
          lastSeen: t,
          status: 'active',
          priceHistory: raw.price ? [{ t, p: raw.price }] : [],
        };
        delete l.needsDetail;
        db.listings[key] = l;
        changes.added.push(key);
        continue;
      }
      // Var olan ilan: alanları güncelle (detaydan gelen bilgileri koru)
      const keep = { firstSeen: prev.firstSeen, priceHistory: prev.priceHistory || [], damage: prev.damage, specs: prev.specs, detailAt: prev.detailAt, color: prev.color };
      const wasRemoved = prev.status === 'removed';
      // Boş gelen alanlar (ör. tarih sıralı listede km yok) eski değeri ezmesin
      const rawClean = Object.fromEntries(Object.entries(raw).filter(([, v]) => v != null));
      Object.assign(prev, rawClean, {
        firstSeen: keep.firstSeen,
        lastSeen: t,
        status: 'active',
        removedAt: null,
        missCount: 0,
        priceHistory: keep.priceHistory,
        damage: mergeDamage(keep.damage, raw.damage),
        specs: { ...(keep.specs || {}), ...(raw.specs || {}) },
        detailAt: raw.detailAt || keep.detailAt,
        color: raw.color || keep.color,
      });
      delete prev.needsDetail;
      const last = prev.priceHistory[prev.priceHistory.length - 1];
      if (raw.price && last && raw.price !== last.p) {
        prev.priceHistory.push({ t, p: raw.price });
        changes.priceChanged.push({ key, from: last.p, to: raw.price });
      } else if (raw.price && !last) prev.priceHistory.push({ t, p: raw.price });
      if (wasRemoved) changes.returned.push(key);
    }

    // Tam tarama: listede olmayanları "kalktı" say (2 tam taramada görülmezse ve 6 saattir yoksa)
    if (s.complete) {
      for (const l of Object.values(db.listings)) {
        if (l.source !== s.source || l.status !== 'active' || seen.has(l.key)) continue;
        l.missCount = (l.missCount || 0) + 1;
        if (l.missCount >= 2 && now - Date.parse(l.lastSeen) > 6 * HOUR) {
          l.status = 'removed';
          l.removedAt = t;
          changes.removed.push(l.key);
        }
      }
    }
    st.count = Object.values(db.listings).filter((l) => l.source === s.source && l.status === 'active').length;
  }

  // Eski kaldırılmış ilanları temizle
  for (const [k, l] of Object.entries(db.listings)) {
    if (l.status === 'removed' && now - Date.parse(l.removedAt) > KEEP_REMOVED_DAYS * 24 * HOUR) delete db.listings[k];
  }

  recompute(db);

  const ev = [
    ...changes.added.map((key) => ({ t, type: 'new', key })),
    ...changes.priceChanged.map((c) => ({ t, type: 'price', key: c.key, from: c.from, to: c.to })),
    ...changes.removed.map((key) => ({ t, type: 'removed', key })),
    ...changes.returned.map((key) => ({ t, type: 'returned', key })),
  ];
  db.events = [...ev, ...(db.events || [])].slice(0, MAX_EVENTS);
  db.updatedAt = t;
  return changes;
}

function mergeDamage(a = {}, b = {}) {
  const out = { ...(a || {}) };
  for (const [k, v] of Object.entries(b || {})) if (v != null) out[k] = v;
  return out;
}

/** Sınıflandırma + piyasa modeli + tavsiyeleri yeniden hesapla */
export function recompute(db) {
  const all = Object.values(db.listings);
  for (const l of all) l.c = classify(l);
  const market = buildMarket(all);
  for (const l of all) l.a = analyzeListing(l, market, all);
  db.market = marketSummary(all);
  db.model = market ? { n: market.n, at: new Date().toISOString() } : null;
}

export function summarizeChanges(c) {
  const parts = [];
  if (c.added.length) parts.push(`+${c.added.length} yeni`);
  if (c.priceChanged.length) parts.push(`${c.priceChanged.length} fiyat değişimi`);
  if (c.removed.length) parts.push(`${c.removed.length} kalktı`);
  if (c.returned.length) parts.push(`${c.returned.length} geri geldi`);
  return parts.join(', ');
}

export const hasChanges = (c) => c.added.length + c.priceChanged.length + c.removed.length + c.returned.length > 0;
