// Farklı sitelerde ilanı verilen aynı aracı eşleştirir (ör. bir galerinin hem sahibinden hem arabam ilanı).
// Aynı sitedeki ilanlar asla birleştirilmez (galeriler benzer araçları ayrı ilanlarla satıyor).

const lc = (s) => (s || '').toLocaleLowerCase('tr-TR').replace(/­/g, '').trim();
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

/** İki ilanın aynı araç olma puanı; null = kesinlikle farklı */
export function matchScore(a, b, ta = tokens(a.title), tb = tokens(b.title)) {
  if (a.source === b.source) return null;
  if (a.c.model !== b.c.model || a.c.generation !== b.c.generation) return null;
  if (!a.year || a.year !== b.year) return null;
  if (a.km == null || b.km == null || !a.price || !b.price) return null;
  if (a.city && b.city && lc(a.city) !== lc(b.city)) return null;
  if (a.color && b.color && lc(a.color) !== lc(b.color)) return null;
  if (a.c.trim !== b.c.trim && a.c.trim !== 'Belirsiz' && b.c.trim !== 'Belirsiz') return null;

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

/** Grup içindeki bilinen hasar/ekspertiz bilgisini birleştirir (analiz için; asıl kayıt değişmez) */
export function groupDamage(l, byKey) {
  if (!l.dup) return l.damage;
  const out = { ...(l.damage || {}) };
  for (const k of l.dup.members) {
    const d = byKey[k]?.damage;
    if (!d) continue;
    for (const [f, v] of Object.entries(d)) if (out[f] == null && v != null) out[f] = v;
  }
  return out;
}
