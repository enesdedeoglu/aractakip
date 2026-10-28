// Farklı sitelerde ilanı verilen aynı aracı eşleştirir (ör. bir galerinin hem sahibinden hem arabam ilanı).
// Aynı sitedeki ilanlar asla birleştirilmez (galeriler benzer araçları ayrı ilanlarla satıyor).

// Aynı başlık/şehir binlerce kez karşılaştırılıyor; toLocaleLowerCase yavaş olduğu için sonuçlar saklanır
const lcCache = new Map();
const lc = (s) => {
  s = s || '';
  let v = lcCache.get(s);
  if (v === undefined) {
    if (lcCache.size > 20000) lcCache.clear();
    lcCache.set(s, (v = s.toLocaleLowerCase('tr-TR').replace(/­/g, '').trim()));
  }
  return v;
};
const STOP = new Set(['tesla', 'model', 'y', '3', 's', 'x', 've', 'ile', 'de', 'da', 'den', 'dan', 'satılık', 'sahibinden', 'galeriden', 'km', 'tl']);

function tokens(title) {
  return new Set(lc(title).replace(/[^\p{L}\p{N}]+/gu, ' ').split(' ').filter((t) => t.length >= 2 && !STOP.has(t)));
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

// Versiyonu belirsiz ya da yalnızca yıldan tahmin edilmiş ilan her versiyonla uyumlu sayılır
const sameTrim = (a, b) => a.c.trim === b.c.trim || [a, b].some((l) => l.c.trim === 'Belirsiz' || l.c.trimGuessed);

/** İki ilanın aynı araç olma puanı; null = kesinlikle farklı */
export function matchScore(a, b, ta = tokens(a.title), tb = tokens(b.title)) {
  if (a.source === b.source) return null;
  if (a.c.model !== b.c.model || a.c.generation !== b.c.generation) return null;
  if (!a.year || a.year !== b.year) return null;
  if (a.km == null || b.km == null || !a.price || !b.price) return null;
  if (a.city && b.city && lc(a.city) !== lc(b.city)) return null;
  if (a.color && b.color && lc(a.color) !== lc(b.color)) return null;
  if (!sameTrim(a, b)) return null;

  const dkm = Math.abs(a.km - b.km);
  if (dkm > Math.max(500, 0.01 * Math.max(a.km, b.km))) return null;
  const dp = Math.abs(a.price - b.price) / Math.min(a.price, b.price);
  if (dp > 0.05) return null;

  let score = 0;
  const round = a.km % 1000 === 0;
  if (dkm === 0) score += round ? 1 : 3; // 20.000 gibi yuvarlak km'ler sık tekrarlanır
  else score += 0.5;
  if (dp === 0) score += 2;
  else if (dp <= 0.02) score += 1;
  const sim = jaccard(ta, tb);
  if (sim >= 0.6) score += 3;
  else if (sim >= 0.35) score += 1.5;
  if (a.district && b.district && lc(a.district) === lc(b.district)) score += 1;
  return score;
}

const THRESHOLD = 4;

/**
 * Aktif ilanları gruplar. Her ilana l.dup = { id, primary, members } yazar (yalnızca grup varsa).
 * @returns grup sayısı
 */
export function findDuplicates(listings) {
  const active = listings.filter((l) => l.status === 'active' && l.km != null && l.price && l.year && l.c);
  for (const l of listings) delete l.dup;

  // Aday çiftleri yalnızca aynı model+yıl kovası içinde ara
  const buckets = new Map();
  for (const l of active) {
    const k = `${l.c.model}|${l.year}`;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(l);
  }
  const pairs = [];
  for (const group of buckets.values()) {
    const toks = group.map((l) => tokens(l.title));
    for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) {
      const s = matchScore(group[i], group[j], toks[i], toks[j]);
      if (s != null && s >= THRESHOLD) pairs.push([s, group[i], group[j]]);
    }
  }

  // En güçlü eşleşmeden başlayarak birleştir; bir grupta her siteden en fazla bir ilan
  pairs.sort((x, y) => y[0] - x[0]);
  const groupOf = new Map();
  for (const [, a, b] of pairs) {
    const ga = groupOf.get(a.key) || new Set([a]);
    const gb = groupOf.get(b.key) || new Set([b]);
    if (ga === gb) continue;
    const sources = new Set([...ga].map((l) => l.source));
    if ([...gb].some((l) => sources.has(l.source))) continue;
    const merged = new Set([...ga, ...gb]);
    for (const l of merged) groupOf.set(l.key, merged);
  }

  const groups = new Set(groupOf.values());
  for (const g of groups) {
    const members = [...g];
    // Ana ilan: hasar/ekspertiz bilgisi olan, sonra en ucuz, sonra en eski
    const info = (l) => (l.damage && (l.damage.tramer != null || l.damage.original != null) ? 1 : 0);
    members.sort((a, b) => info(b) - info(a) || a.price - b.price || Date.parse(a.firstSeen) - Date.parse(b.firstSeen));
    const id = members.map((l) => l.key).sort()[0];
    members.forEach((l, i) => {
      l.dup = { id, primary: i === 0, members: members.map((m) => m.key) };
    });
  }
  return groups.size;
}

/**
 * Grup içindeki bilinen hasar/ekspertiz bilgisini birleştirir (analiz için; asıl kayıt değişmez).
 * Temkinli birleştirme: bir site ağır hasar / boya / değişen bildiriyorsa, diğer sitedeki "yok" bilgisi onu ezmez;
 * tramer için en yüksek tutar alınır.
 */
export function groupDamage(l, byKey) {
  if (!l.dup) return l.damage;
  const all = [l.damage, ...l.dup.members.filter((k) => k !== l.key).map((k) => byKey[k]?.damage)].filter(Boolean);
  const out = { ...(l.damage || {}) };
  for (const d of all) for (const [f, v] of Object.entries(d)) if (out[f] == null && v != null) out[f] = v;
  if (all.some((d) => d.heavy === true)) out.heavy = true;
  const tramers = all.map((d) => d.tramer).filter((v) => v > 0);
  if (tramers.length) { out.tramer = Math.max(...tramers); out.tramerRecord = true; }
  for (const f of ['painted', 'changed']) if (all.some((d) => d[f] === true)) out[f] = true;
  if (out.painted || out.changed || all.some((d) => d.original === false)) {
    out.original = false;
    const worse = all.find((d) => d.original === false && d.summary) || all.find((d) => (d.painted || d.changed) && d.summary);
    if (worse) out.summary = worse.summary;
  }
  return out;
}

/** Analiz için grup görünümü: birleşik hasar bilgisi + tüm ilan metinlerindeki hasar uyarıları */
export function groupView(l, byKey) {
  const others = (l.dup?.members || []).filter((k) => k !== l.key).map((k) => byKey[k]).filter(Boolean);
  const warnings = [...new Set([...(l.c?.warnings || []), ...others.flatMap((o) => o.c?.warnings || [])])];
  return { ...l, damage: groupDamage(l, byKey), c: { ...l.c, warnings } };
}

/**
 * Yeniden ilan tespiti: kaldırılan bir ilanın aracı (aynı veya başka sitede) yeniden ilana konduysa bağlar.
 * Yeni ilana l.relistOf ve araç bazında birleşik fiyat geçmişi (l.vehicleHistory) yazılır.
 * Fiyat değişmiş olabileceği için %12'ye kadar fiyat farkına, km'nin biraz artmasına izin verilir.
 */
export function findRelists(listings) {
  const DAY = 86400000;
  for (const l of listings) { delete l.relistOf; delete l.relistedAs; delete l.vehicleHistory; }
  const removed = listings.filter((l) => l.status === 'removed' && l.c && l.km != null && l.price && l.year);
  const fresh = listings.filter((l) => l.status === 'active' && l.c && l.km != null && l.price && l.year);
  const pairs = [];
  for (const a of fresh) {
    const ta = tokens(a.title);
    for (const r of removed) {
      const gap = Date.parse(a.publishedAt || a.firstSeen) - Date.parse(r.removedAt); // sitedeki yayın tarihi
      // Yeni ilan, eskisi kalktıktan sonra (en fazla 12 saat önce) açılmış olmalı; daha önceden açık olan
      // ilan aynı aracın başka sitedeki paralel ilanıdır, yeniden ilan değil
      if (gap < -DAY / 2 || gap > 60 * DAY) continue;
      if (a.c.model !== r.c.model || a.c.generation !== r.c.generation || a.year !== r.year) continue;
      if (a.city && r.city && lc(a.city).split(/\s/)[0] !== lc(r.city).split(/\s/)[0]) continue;
      if (a.color && r.color && lc(a.color) !== lc(r.color)) continue;
      if (!sameTrim(a, r)) continue;
      const dkm = a.km - r.km;
      if (dkm < -500 || dkm > Math.max(3000, 0.05 * r.km)) continue;
      const dp = Math.abs(a.price - r.price) / r.price;
      if (dp > 0.12) continue;
      let score = 0;
      score += dkm === 0 ? (a.km % 1000 === 0 ? 1 : 3) : 0.5;
      const sim = jaccard(ta, tokens(r.title));
      if (sim >= 0.6) score += 3; else if (sim >= 0.35) score += 1.5;
      if (dp === 0) score += 1;
      if (a.source === r.source && a.sellerType === r.sellerType) score += 0.5;
      if (a.district && r.district && lc(a.district) === lc(r.district)) score += 1;
      if (score >= 4) pairs.push([score, a, r]);
    }
  }
  pairs.sort((x, y) => y[0] - x[0]);
  const used = new Set();
  let n = 0;
  for (const [, a, r] of pairs) {
    if (used.has(a.key) || used.has(r.key)) continue;
    used.add(a.key); used.add(r.key);
    a.relistOf = r.key;
    r.relistedAs = a.key;
    n++;
  }
  // Araç bazında fiyat geçmişi: önceki ilan zinciri + bu ilan
  const byKey = Object.fromEntries(listings.map((l) => [l.key, l]));
  for (const a of fresh) {
    if (!a.relistOf) continue;
    const chain = [];
    let cur = a;
    for (let i = 0; cur && i < 5; i++) { chain.unshift(cur); cur = byKey[cur.relistOf]; }
    a.vehicleHistory = chain.flatMap((x) => (x.priceHistory || []).map((h) => ({ ...h, src: x.source, key: x.key })));
  }
  return n;
}

/**
 * Ağır hasar geçmişi: aynı aracın başka sitedeki (kalkmış olsa da) ya da kaldırılıp yeniden konmadan önceki
 * ilanında ağır hasar kayıtlı göründüyse, kaydı "yok" görünen aktif ilan da ağır hasarlı sayılmalı.
 * @param heavyOf  ilanın kendi bilgisine göre ağır hasarlı mı
 * @returns Map(aktif ilan anahtarı → ağır hasarlı görünen ilan)
 */
export function heavyHistory(listings, heavyOf) {
  const out = new Map();
  const byKey = Object.fromEntries(listings.map((l) => [l.key, l]));
  const heavy = listings.filter((l) => l.c && l.km != null && l.price && l.year && heavyOf(l));
  if (!heavy.length) return out;
  const htoks = new Map(heavy.map((h) => [h.key, tokens(h.title)]));
  for (const l of listings) {
    if (l.status !== 'active' || !l.c || heavyOf(l)) continue;
    // Yeniden ilan zinciri (aynı site dahil)
    for (let r = byKey[l.relistOf], i = 0; r && i < 10; r = byKey[r.relistOf], i++) {
      if (heavyOf(r)) { out.set(l.key, r); break; }
    }
    if (out.has(l.key) || l.km == null) continue;
    const tl = tokens(l.title);
    for (const h of heavy) {
      if (h.key === l.key || l.dup?.members.includes(h.key)) continue;
      const s = matchScore({ ...h, status: 'active' }, l, htoks.get(h.key), tl);
      if (s != null && s >= THRESHOLD) { out.set(l.key, h); break; }
    }
  }
  return out;
}
