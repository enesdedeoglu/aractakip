// Adil fiyat modeli + puanlama + tavsiye metinleri.
// Tüm aktif Tesla ilanları üzerinde
//   log(fiyat) ~ model + nesil + versiyon + nesil×versiyon + yıl + km + km² + ağır hasar + değişen + boya + tramer
// şeklinde hiyerarşik ridge regresyon kurulur. Nesil×versiyon terimi sayesinde ör. Juniper Standart ile
// Juniper Premium (ya da Legacy RWD) ayrı fiyatlanır; az ilanlı versiyonlar üst seviyelere (nesil, versiyon) yaslanır.
// Satıştaki versiyonların sıfır fiyatı (ayarlar → newPrices) birkaç "sıfıra yakın ilan" ağırlığında modele girer;
// az ilanlı versiyonların beklenen fiyatı böylece sıfır fiyatına dayanır.
// Her ilanın beklenen fiyatı o ilan modelden çıkarılarak (leave-one-out) hesaplanır: az ilanlı bir versiyonda
// ilan, kendi fiyatını "piyasa" diye göstermez. Aynı leave-one-out hatalarından her versiyonun tipik hatası
// ölçülür ve beklenen fiyat bir aralıkla verilir; "Fırsat" / "Pahalı" bu aralığın dışına göre belirlenir.

import { fold } from './classify.js';

const DAY = 86400000;
const HEAVY = 'Ağır hasar kayıtlı';
// Ağır hasar kaydının fiyata etkisi için ön bilgi (~%30 düşük, 4 ilan ağırlığında); ilan arttıkça veriden öğrenilir
const HEAVY_PRIOR = Math.log(0.7);
const HEAVY_WEIGHT = 4;
// Boya / değişen / tramer etkisi için ön bilgi (birim başına log fiyat etkisi, kaç ilan ağırlığında).
// Gerçek ilanlarda (Ekim 2026) değişen parça başına ~%3-5, boyalı parça başına ~%2-4 düşüş görüldü.
const DAMAGE_FEATURES = [
  ['değişen', Math.log(0.97), 6], // değişen parça sayısı
  ['boya', Math.log(0.985), 6], // boyalı parça (lokal boya yarım sayılır)
  ['tramer', Math.log(0.97), 6], // log(1 + tramer / 100 bin TL)
];
// Sıfır fiyatı: model yılı bu yıl, ~1000 km'lik ilan gibi, 3 ilan ağırlığında. Teslimat aylar sürdüğü için
// sıfıra yakın ikinci el, sıfır fiyatı civarında ilana çıkıyor (Ekim 2026: Standart ve Long Range RWD ≈ %100).
const ANCHOR_WEIGHT = 3;
const ANCHOR_KM = 1000;
// Beklenen fiyat aralığı: ilanların ~%80'i içinde kalır (normal dağılımda ±1,28σ)
const Z = 1.28;
// Versiyonun tipik hatası, az ilan varken bu geniş ön bilgiye yaslanır (K ilan ağırlığında)
const SIGMA_THIN = 0.07;
const SIGMA_K = 5;
const SIGMA_MIN = 0.015;
const SIGMA_MAX = 0.3;
// Kategorik seviyeler ve ridge cezaları (büyük ceza = üst seviyeye daha çok yaslanır)
const LEVELS = [
  ['model', (r) => r.c.model, 0.3],
  ['nesil', (r) => `${r.c.model}|${r.c.generation}`, 0.5],
  ['versiyon', (r) => `${r.c.model}|${r.c.trim}`, 0.5],
  ['segment', (r) => `${r.c.model}|${r.c.generation}|${r.c.trim}`, 1],
  // Versiyon × model yılı: ör. 2025 ve 2026 Juniper Standart aynı araç, genel yıl etkisi ona uymuyor
  ['segment×yıl', (r) => `${r.c.model}|${r.c.generation}|${r.c.trim}|${r.year}`, 2],
];

export const isHeavy = (l) => l.c?.heavy === 'var' || l.damage?.heavy === true || (l.c?.warnings || []).includes(HEAVY);

/** Ekspertiz özetinden ("3 değişen, 1 lokal boyalı") boya/değişen sayıları ve tramer */
export function damageCounts(d = {}) {
  const s = fold(d?.summary || '');
  const n = (re) => [...s.matchAll(re)].reduce((a, m) => a + Number(m[1]), 0);
  let changed = n(/(\d+)\s*(?:parca\s*)?degisen/g);
  let painted = n(/(\d+)\s*(?:parca\s*)?boyali/g);
  const local = n(/(\d+)\s*(?:parca\s*)?lokal\s*boyali/g);
  if (!changed && d?.changed) changed = 1;
  if (!painted && !local && d?.painted) painted = 1;
  const tramer = d?.tramer > 0 ? d.tramer : 0;
  return { changed: Math.min(changed, 6), painted, local, paint: Math.min(painted + local / 2, 8), tramer };
}

function median(arr) {
  const a = arr.filter((x) => x != null && !Number.isNaN(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
const matVec = (M, x) => M.map((row) => dot(row, x));

function invert(A) {
  // Gauss-Jordan (kısmi pivot); ridge cezası sayesinde matris her zaman tersinir
  const n = A.length;
  const M = A.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c];
    if (Math.abs(d) < 1e-12) continue;
    for (let k = 0; k < 2 * n; k++) M[c][k] /= d;
    for (let r = 0; r < n; r++) {
      if (r === c || !M[r][c]) continue;
      const f = M[r][c];
      for (let k = 0; k < 2 * n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row) => row.slice(n));
}

// Km bilinmiyorsa aynı yıldaki ilanların medyan km'si (yoksa yıl başına ~18 bin km) kullanılır
function kmImputer(rows) {
  const byYear = new Map();
  for (const r of rows) if (r.km != null && r.year) {
    if (!byYear.has(r.year)) byYear.set(r.year, []);
    byYear.get(r.year).push(r.km);
  }
  const med = new Map([...byYear].map(([y, a]) => [y, median(a)]));
  return (r) => r.km ?? med.get(r.year) ?? Math.max(5000, (new Date().getFullYear() - (r.year || 2022) + 0.5) * 18000);
}

const BASE = ['1', 'yıl', 'km', 'km²', 'ağır hasar'];
const DMG0 = BASE.length; // hasar özelliklerinin başladığı sütun

function buildFeatures(rows, imputeKm) {
  const names = [...BASE, ...DAMAGE_FEATURES.map(([n]) => n)];
  const pen = [1e-6, 1e-3, 1e-3, 0.5, HEAVY_WEIGHT, ...DAMAGE_FEATURES.map(([, , w]) => w)];
  const prior = [0, 0, 0, 0, HEAVY_PRIOR, ...DAMAGE_FEATURES.map(([, p]) => p)];
  const index = new Map();
  for (const [lvl, key, lambda] of LEVELS) for (const r of rows) {
    const id = `${lvl}:${key(r)}`;
    if (!index.has(id)) { index.set(id, names.length); names.push(id); pen.push(lambda); prior.push(0); }
  }
  /** @param clean hasarsız eşdeğer: ağır hasar, boya, değişen ve tramer yok sayılır */
  const vec = (r, clean = false) => {
    const x = new Array(names.length).fill(0);
    const km = imputeKm(r) / 100000;
    x[0] = 1; x[1] = (r.year ?? 2022) - 2023; x[2] = km; x[3] = km * km;
    if (!clean) {
      const dc = damageCounts(r.damage);
      x[4] = isHeavy(r) ? 1 : 0;
      x[DMG0] = dc.changed; x[DMG0 + 1] = dc.paint; x[DMG0 + 2] = Math.log1p(dc.tramer / 100000);
    }
    for (const [lvl, key] of LEVELS) {
      const i = index.get(`${lvl}:${key(r)}`);
      if (i != null) x[i] = 1;
    }
    return x;
  };
  return { names, pen, prior, vec };
}

// Ağırlıklı cezalı en küçük kareler: (XᵀWX + Λ) β = XᵀWy + Λ β₀
function fit(rows, vec, pen, prior) {
  const p = pen.length;
  const A = Array.from({ length: p }, () => new Array(p).fill(0));
  const b = new Array(p).fill(0);
  for (const r of rows) {
    const x = vec(r);
    const y = Math.log(r.price);
    const w = r.w ?? 1;
    for (let i = 0; i < p; i++) {
      if (!x[i]) continue;
      b[i] += w * x[i] * y;
      for (let j = 0; j < p; j++) if (x[j]) A[i][j] += w * x[i] * x[j];
    }
  }
  for (let i = 0; i < p; i++) { A[i][i] += pen[i]; b[i] += pen[i] * prior[i]; }
  const Ainv = invert(A);
  return { beta: matVec(Ainv, b), Ainv };
}

/** Ayarlardaki sıfır fiyatları: { "Model Y · Juniper · Standart": 2474985, ... } (sayı olmayan alanlar not) */
export function newPriceTable(newPrices) {
  return Object.fromEntries(Object.entries(newPrices || {}).filter(([k, v]) => k.split(' · ').length === 3 && Number(v) > 100000));
}

// Sıfır fiyatı → modele "sıfıra yakın ilan" olarak giren sahte satırlar
function anchorRows(table, year) {
  return Object.entries(table).map(([segment, price]) => {
    const [model, generation, trim] = segment.split(' · ');
    return { key: `sıfır:${segment}`, anchor: true, w: ANCHOR_WEIGHT, year, km: ANCHOR_KM, price: Number(price), damage: {}, c: { model, generation, trim, segment, warnings: [] } };
  });
}

const eligible = (l) => l.status === 'active' && l.price > 100000 && l.year && l.c && l.c.model !== 'Diğer';

/**
 * Piyasa modeli: aktif, fiyatı/yılı belli ilanlardan
 * @param opts.newPrices  satıştaki versiyonların sıfır fiyatları (segment → TL)
 * @param opts.year       sıfır fiyatlarının model yılı (varsayılan: bu yıl)
 */
export function buildMarket(listings, { newPrices = {}, year = new Date().getFullYear() } = {}) {
  const rows = listings.filter(eligible);
  if (rows.length < 8) return null;
  const table = newPriceTable(newPrices);
  const anchors = anchorRows(table, year);
  const imputeKm = kmImputer(rows);
  const { vec, pen, prior, names } = buildFeatures([...rows, ...anchors], imputeKm);
  // Km'si bilinen ilanlar katsayıları belirler (yeterince varsa)
  const known = rows.filter((r) => r.km != null);
  let train = known.length >= 20 ? known : rows;
  let m = fit([...train, ...anchors], vec, pen, prior);
  // Aykırı değerleri (çok ucuz/pahalı, yanlış girilmiş fiyatlar) at ve yeniden kur
  const clean = train.filter((r) => Math.abs(Math.log(r.price) - dot(m.beta, vec(r))) < 0.3);
  if (clean.length >= 8) { train = clean; m = fit([...train, ...anchors], vec, pen, prior); }
  // Leave-one-out düzeltmesi için her eğitim ilanının etkisi: β₋ᵢ = β − A⁻¹xᵢ · eᵢ/(1−hᵢ)
  // eᵢ/(1−hᵢ) aynı zamanda ilanın leave-one-out tahmin hatasıdır
  const loo = new Map();
  const errs = new Map();
  const heavyErrs = [];
  for (const r of train) {
    const x = vec(r);
    const ax = matVec(m.Ainv, x);
    const h = Math.min(0.95, dot(x, ax));
    const k = (Math.log(r.price) - dot(m.beta, x)) / (1 - h);
    loo.set(r.key, { ax, k });
    if (isHeavy(r)) heavyErrs.push(k);
    if (!errs.has(r.c.segment)) errs.set(r.c.segment, []);
    errs.get(r.c.segment).push(k);
  }
  // Tipik hata: sağlam ölçek (1,4826 × medyan |hata| ≈ σ); az ilanlı versiyon geniş ön bilgiye yaslanır
  const robust = (e) => 1.4826 * median(e.map(Math.abs));
  const sigmaAll = robust([...errs.values()].flat());
  const sigma0 = Math.max(sigmaAll, SIGMA_THIN);
  const sigmaSeg = {};
  for (const [seg, e] of errs) {
    const s = robust(e);
    sigmaSeg[seg] = Math.min(SIGMA_MAX, Math.max(SIGMA_MIN, Math.sqrt((e.length * s * s + SIGMA_K * sigma0 * sigma0) / (e.length + SIGMA_K))));
  }
  // Ağır hasarlı araçların fiyatı hasarın derecesine göre çok daha dağınık: aralıklarına ek belirsizlik
  const sh = heavyErrs.length ? robust(heavyErrs) : 0;
  const sigmaHeavy = Math.sqrt(Math.max(0, (heavyErrs.length * sh * sh + SIGMA_K * sigma0 * sigma0) / (heavyErrs.length + SIGMA_K) - sigmaAll * sigmaAll));
  const modelCounts = {};
  for (const r of rows) modelCounts[r.c.model] = (modelCounts[r.c.model] || 0) + 1;
  const segCounts = {};
  for (const r of train) segCounts[r.c.segment] = (segCounts[r.c.segment] || 0) + 1;
  const eff = (i) => Math.exp(m.beta[i]) - 1;
  return {
    beta: m.beta, Ainv: m.Ainv, vec, loo, n: train.length, kmKnown: known.length, modelCounts, segCounts,
    sigmaAll, sigma0, sigmaSeg, sigmaHeavy, newPrices: table, year,
    heavyEffect: eff(4),
    // Hasarın fiyata etkisi (veriden öğrenilen, ön bilgiyle): parça / 100 bin TL tramer başına
    damageEffects: { heavy: eff(4), changed: eff(DMG0), painted: eff(DMG0 + 1), tramer100k: Math.exp(m.beta[DMG0 + 2] * Math.log(2)) - 1 },
    names,
  };
}

/**
 * Tahmin: beklenen fiyat, tipik hata (log ölçekte σ) ve ~%80 aralık.
 * İlan (veya aynı aracın diğer sitedeki ilanı) modeli kurarken kullanıldıysa onsuz hesaplanır.
 */
export function predict(l, market, clean = false) {
  const x = market.vec(l, clean);
  let lp = dot(market.beta, x);
  const own = [l.key, ...(l.dup?.members || [])].map((k) => market.loo.get(k)).find(Boolean);
  if (own) lp -= dot(x, own.ax) * own.k;
  // Parametre belirsizliği: modelin az bildiği (yüksek kaldıraçlı) ilanlarda aralık genişler
  const h = Math.max(0, dot(x, matVec(market.Ainv, x)));
  const seg = market.sigmaSeg[l.c.segment] ?? market.sigma0;
  const extra = !clean && isHeavy(l) ? market.sigmaHeavy : 0;
  const sigma = Math.sqrt(seg * seg + market.sigmaAll * market.sigmaAll * h + extra * extra);
  return { expected: Math.exp(lp), sigma, low: Math.exp(lp - Z * sigma), high: Math.exp(lp + Z * sigma) };
}

/** Beklenen fiyat (geriye uyumluluk) */
export function expectedPrice(l, market, clean = false) {
  return predict(l, market, clean).expected;
}

/**
 * Versiyonu ilanda açıkça yazmayan Juniper'lerde (classify → trimAlt) fiyata en uyan versiyon seçilir.
 * Ör. "Standart" kategorisinde 3,3 M'ye satılan 2025 araç büyük ihtimalle eski tam donanımlı Premium'dur.
 * l.c yerinde değiştirilir. @returns değişen ilan sayısı
 */
export function resolveTrims(listings, market) {
  if (!market) return 0;
  let changed = 0;
  for (const l of listings) {
    const alts = l.c?.trimAlt;
    if (!alts || !l.price || !l.year) continue;
    const fitOf = (trim) => {
      const c = { ...l.c, trim, segment: `${l.c.model} · ${l.c.generation} · ${trim}` };
      return Math.abs(Math.log(l.price / expectedPrice({ ...l, c }, market)));
    };
    const best = alts.reduce((a, b) => (fitOf(b) < fitOf(a) ? b : a));
    if (best !== l.c.trim) {
      if (!l.c.trimGuessed) l.c.trimFrom = l.c.trim; // sitenin kategorisi (yıl tahmini değil)
      l.c.trim = best;
      l.c.segment = `${l.c.model} · ${l.c.generation} · ${best}`;
      l.c.trimGuessed = true;
      changed++;
    }
    l.c.trimBy = 'fiyat';
  }
  return changed;
}

const NF0 = new Intl.NumberFormat('tr-TR');
function fmtTL(n) {
  return n == null ? '-' : `${NF0.format(Math.round(n))} TL`;
}

/** Kısa fiyat: 2,35 M / 850 bin */
const NF2 = new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export function fmtM(n) {
  if (n == null) return '-';
  return n >= 1e6 ? `${NF2.format(n / 1e6)} M` : `${Math.round(n / 1000)} bin`;
}

// "%93'ü", "%110'u", "%86'sı": sayının okunuşuna göre iyelik eki
const ONES = ['', "'i", "'si", "'ü", "'ü", "'i", "'sı", "'si", "'i", "'u"];
const TENS = ['', "'u", "'si", "'u", "'ı", "'si", "'ı", "'i", "'i", "'ı"];
export function pctOf(n) {
  const v = Math.round(n);
  const ek = v === 0 ? "'ı" : v % 10 ? ONES[v % 10] : v % 100 ? TENS[(v / 10) % 10] : v % 1000 ? "'ü" : "'i";
  return `%${v}${ek}`;
}

/**
 * Kalkan ilanlardan satış sinyali. İlan fiyatı satış fiyatı değildir; kısa sürede (≤21 gün) kalkan ve yeniden
 * ilana konmayan araçlar büyük ihtimalle satıldı. Bunların fiyatının bugünkü modele göre sapması, kalkış
 * zamanına göre doğruyla ayrıştırılır: sapma ≈ a + b·hafta. a: bugün satılanların ilan seviyesine göre konumu,
 * b: haftalık piyasa kayması (eski ilanlar daha ucuzsa piyasa yükseliyor).
 * @returns { n, saleRatio, weeklyDrift, monthlyDrift } veya null (yetersiz veri)
 */
export function saleSignal(listings, market, now = Date.now()) {
  if (!market) return null;
  const relisted = new Set(listings.map((l) => l.relistOf).filter(Boolean));
  const pts = [];
  const active = [];
  for (const l of listings) {
    if (!l.c || l.c.model === 'Diğer' || !l.price || !l.year || isHeavy(l) || (l.dup && !l.dup.primary)) continue;
    const dev = Math.log(l.price / predict(l, market).expected);
    if (Math.abs(dev) > 0.2) continue;
    if (l.status === 'active') { active.push(dev); continue; }
    const start = Date.parse(l.publishedAt || l.firstSeen), end = Date.parse(l.removedAt);
    if (!Number.isFinite(end) || relisted.has(l.key) || end - start > 21 * DAY || now - end > 60 * DAY) continue;
    pts.push([(now - end) / (7 * DAY), dev]);
  }
  if (pts.length < 30 || active.length < 30) return null;
  // Basit en küçük kareler (aykırılar yukarıda atıldı)
  const n = pts.length;
  const mx = pts.reduce((a, [x]) => a + x, 0) / n, my = pts.reduce((a, [, y]) => a + y, 0) / n;
  const sxx = pts.reduce((a, [x]) => a + (x - mx) ** 2, 0);
  const b = sxx > 0.5 ? pts.reduce((a, [x, y]) => a + (x - mx) * (y - my), 0) / sxx : 0;
  const a = my - b * mx;
  const level = median(active);
  const r3 = (x) => Math.round(x * 1000) / 1000;
  return { n, saleRatio: r3(Math.exp(a - level)), weeklyDrift: r3(-b), monthlyDrift: r3(Math.exp(-b * 30 / 7) - 1) };
}

/**
 * Teklif önerisi: gerçekçi satış seviyesi (beklenen × satış oranı) ile ilan fiyatından pazarlık payı düşülmüş
 * değerin küçüğü. Pazarlık payı ilanda kalma süresi ve fiyat düşüşleriyle artar.
 */
export function suggestOffer({ price, expected, low, daysOn, drops, saleRatio = 0.985 }) {
  if (!price || !expected) return null;
  const nego = 0.02 + (daysOn > 30 ? 0.01 : 0) + (daysOn > 60 ? 0.01 : 0) + (drops ? 0.005 : 0);
  const fromAsk = price * (1 - nego);
  const fromMarket = Math.max(expected * saleRatio, low ?? 0);
  const offer = Math.max(price * 0.85, Math.min(fromAsk, fromMarket));
  return { offer: Math.round(offer / 10000) * 10000, nego, basis: fromAsk <= fromMarket ? 'ilan' : 'piyasa' };
}

/**
 * Versiyon bazında fiyat trendi: her hafta yayına giren ilanların giriş fiyatının bugünkü beklenen fiyatına
 * oranının medyanı. Yıl/km/hasar farkı beklenen fiyatla ayıklanır; yalnızca yeni ilanlara bakıldığı için
 * ucuzların hızla satılıp pahalıların kalmasından doğan yanılgı oluşmaz.
 * @returns { [segment]: { weeks: [{ w, n, idx }] (eskiden yeniye), change, days } }
 */
export function priceTrend(listings, now = Date.now(), weeks = 8) {
  const add = (map, key, k, v) => {
    if (!map.has(key)) map.set(key, Array.from({ length: weeks }, () => []));
    map.get(key)[k].push(v);
  };
  const segs = new Map();
  for (const l of listings) {
    if (!l.a?.expected || !l.c || isHeavy(l) || (l.dup && !l.dup.primary) || !l.publishedAt) continue;
    const pub = Date.parse(l.publishedAt);
    // Giriş fiyatı ancak ilan yayından hemen sonra görüldüyse bilinir (ilk tam taramadaki eski ilanlar hariç)
    if (!(Date.parse(l.firstSeen) - pub <= 2 * DAY)) continue;
    const k = Math.floor((now - pub) / (7 * DAY));
    if (k < 0 || k >= weeks) continue;
    const v = Math.log((l.priceHistory?.[0]?.p || l.price) / l.a.expected);
    add(segs, l.c.segment, k, v);
    add(segs, `${l.c.model} · Tümü`, k, v);
  }
  const out = {};
  for (const [seg, byWeek] of segs) {
    const pts = byWeek.map((a, k) => ({ w: k, n: a.length, idx: a.length >= 3 ? Math.round(median(a) * 1000) / 1000 : null }));
    // Bu hafta ile en fazla 4 hafta önceki (yeterli ilanı olan) en eski hafta karşılaştırılır
    let old = null;
    for (let k = 2; k <= 4; k++) if (pts[k]?.n >= 5) old = pts[k];
    const cur = pts[0].n >= 5 ? pts[0] : pts[1]?.n >= 5 ? pts[1] : null;
    out[seg] = {
      weeks: [...pts].reverse(),
      change: cur && old && old.w > cur.w ? Math.round((Math.exp(cur.idx - old.idx) - 1) * 1000) / 1000 : null,
      days: cur && old ? (old.w - cur.w) * 7 : null,
    };
  }
  return out;
}

/** "2,25–2,45 M" */
export const fmtRange = (lo, hi) => `${lo >= 1e6 && hi >= 1e6 ? fmtM(lo).replace(' M', '') : fmtM(lo)}–${fmtM(hi)}`;

const round = (n, step = 1000) => (n == null ? null : Math.round(n / step) * step);

/** @param ctx.sale saleSignal sonucu (teklif önerisi için) */
export function analyzeListing(l, market, all, { sale = null } = {}) {
  const now = Date.now();
  const reasons = [];   // olumlu
  const cautions = [];  // dikkat
  const heavy = isHeavy(l);
  const d = l.damage || {};
  const dc = damageCounts(d);
  // Beklenen fiyat aracın hasar durumuna göre (ağır hasar, değişen, boya, tramer); hasarsız eşdeğeri ayrıca hesaplanır
  let pred = null, expected = null, expectedClean = null, deviation = null, z = null;
  if (market && l.price && l.year && l.c.model !== 'Diğer') {
    pred = predict(l, market);
    expected = pred.expected;
    expectedClean = predict(l, market, true).expected;
    deviation = l.price / expected - 1;
    z = Math.log(l.price / expected) / pred.sigma;
  }
  const damageDiscount = expected && expectedClean ? expected / expectedClean - 1 : 0;
  const damaged = heavy || damageDiscount < -0.01;
  // Sıfır fiyatı (satıştaki versiyonlar için)
  const newPrice = market?.newPrices?.[l.c.segment] ?? null;
  const newRatio = newPrice && l.price ? l.price / newPrice : null;
  // Benzer ilanlar: aynı segment, ±1 yıl, aynı ağır hasar durumu
  const comps = all.filter((o) => o.key !== l.key && !(l.dup && l.dup.members.includes(o.key)) && o.status === 'active' && o.price && o.c.segment === l.c.segment && o.year && l.year && Math.abs(o.year - l.year) <= 1 && isHeavy(o) === heavy);
  const compMedian = median(comps.map((o) => o.price));

  let score = 50;
  // Fiyat, versiyonun tipik hatasına göre değerlendirilir (az ilanlı versiyonda aynı sapma daha az anlamlı)
  if (z != null) score -= Math.max(-3, Math.min(3, z)) * 10;

  // Hasar / ekspertiz bilgisi
  if (heavy) {
    // Fiyat zaten ağır hasarlı piyasaya göre; puan cezası küçük, etiket en fazla "İyi fiyat" (aşağıda)
    score -= 8;
    cautions.push(`Ağır hasar kayıtlı – ${expectedClean ? `fiyat ağır hasarlı araçlara göre değerlendirildi (hasarsız eşdeğeri ≈ ${fmtTL(expectedClean)}); ` : ''}sigorta, kredi ve tekrar satışta sorun olabilir`);
  } else if (damageDiscount < -0.01) {
    const parts = [dc.changed && `${dc.changed} değişen`, dc.painted && `${dc.painted} boyalı`, dc.local && `${dc.local} lokal boyalı`, dc.tramer && `tramer ${fmtM(dc.tramer)}`].filter(Boolean).join(', ');
    reasons.push(`Hasar durumu fiyata yansıtıldı (${parts}): beklenen fiyat hasarsız eşdeğerinden %${Math.abs(damageDiscount * 100).toFixed(0)} düşük (hasarsız ≈ ${fmtTL(expectedClean)})`);
  }
  if (d.tramer > 0) {
    const ratio = d.tramer / (expectedClean || l.price);
    score -= Math.min(20, ratio * 150);
    cautions.push(`Tramer kaydı ${fmtTL(d.tramer)} – hasar detayını ve onarım kalitesini kontrol edin`);
    // Aracın değerinin dörtte biri kadar tramer: kayıt "yok" görünse de ağır hasar niteliğinde
    if (!heavy && ratio >= 0.25) cautions.push(`Tramer, aracın hasarsız değerinin ${pctOf(ratio * 100)} – ağır hasar kaydı görünmese de ağır hasarlı olabilir; şasi numarasıyla sorgulayın`);
  } else if (d.tramer === 0) { score += 3; reasons.push('Tramer kaydı yok'); }
  if (d.original) { score += 5; reasons.push('Boyasız, değişensiz'); }
  else if (d.painted || d.changed || dc.changed || dc.paint) { score -= 6; cautions.push(d.summary || 'Boyalı/değişen parça var'); }
  else if (d.summary && !/orjinal|orijinal/i.test(d.summary)) cautions.push(`Boya/değişen: ${d.summary}`);
  for (const w of l.c.warnings) {
    if (w === HEAVY && (d.heavy || l.c.heavyFrom)) continue;
    if (w !== HEAVY) score -= 12;
    cautions.push(`İlan metninde: "${w}"`);
  }
  if (l.c.heavyFrom) cautions.push(`Aynı aracın ${l.c.heavyFrom} ilanında ağır hasar kayıtlı görünüyordu – bu ilanda kayıt "yok" görünse de ağır hasarlı sayıldı`);

  // Satıcı
  if (l.sellerType === 'kurumsal') { score += 4; reasons.push(`Kurumsal satıcı (${l.sellerName || l.source}) – ekspertizli ve iade/garanti koşulları daha net`); }
  if (l.c.tags.includes('Garantili')) { score += 3; reasons.push('Garantili'); }
  if (l.c.tags.includes('FSD')) reasons.push('FSD paketli (Türkiye’de kullanım kısıtlı olabilir)');
  if (l.c.tags.includes('PPF')) reasons.push('PPF kaplamalı');
  if (l.reserved) cautions.push('Opsiyonlu / rezerve – satılmak üzere olabilir');

  // Km / yaş
  if (l.year && l.km != null) {
    const age = Math.max(0.5, new Date().getFullYear() - l.year + 0.5);
    const perYear = l.km / age;
    if (perYear < 10000) { score += 4; reasons.push(`Düşük kullanım (~${Math.round(perYear / 1000)} bin km/yıl)`); }
    else if (perYear > 35000) { score -= 4; cautions.push(`Yoğun kullanım (~${Math.round(perYear / 1000)} bin km/yıl) – batarya sağlığını (SOH) test ettirin`); }
  }
  if (l.km == null) cautions.push('Km bilgisi yok – fiyat tahmini yaklaşık');
  if (l.km > 150000) cautions.push('150 bin km üzeri – batarya/drive unit garanti süresini kontrol edin (8 yıl / 192 bin km)');

  // Fiyat hareketleri ve ilanda kalma süresi
  const hist = l.priceHistory || [];
  const drops = hist.filter((h, i) => i > 0 && h.p < hist[i - 1].p);
  if (drops.length) {
    const first = hist[0].p;
    const pct = ((l.price - first) / first) * 100;
    score += Math.min(6, drops.length * 3);
    reasons.push(`Fiyatı ${drops.length} kez düştü (${pct.toFixed(1)}%) – satıcı istekli`);
  }
  const startTs = Date.parse(l.publishedAt || l.firstSeen);
  const daysOn = Number.isFinite(startTs) ? Math.max(0, Math.round((now - startTs) / DAY)) : null;
  if (daysOn != null && daysOn > 30) reasons.push(`${daysOn} gündür ilanda – pazarlık payı yüksek`);

  score = Math.max(0, Math.min(100, Math.round(score)));

  // Versiyon bilgisi
  if (l.c.trimGuessed) {
    const other = (l.c.trimAlt || []).filter((t) => t !== l.c.trim);
    const why = l.c.trimBy === 'fiyat' ? `fiyatına ve ${l.year} model olmasına göre` : `${l.year} model olduğu için`;
    cautions.push(`Versiyon ilanda açıkça yazmıyor${l.c.trimFrom && l.c.trimFrom !== l.c.trim ? ` (kategori: ${l.c.trimFrom})` : ''}; ${why} ${l.c.trim} varsayıldı${other.length ? ` (${other.join(' / ')} olabilir)` : ''} – ilan detayından kontrol edin`);
  } else if (l.c.trim === 'Belirsiz') cautions.push('Versiyon (Standart / Premium / Long Range / Performance) belirlenemedi – beklenen fiyat yaklaşık');
  const inTrain = market && [l.key, ...(l.dup?.members || [])].some((k) => market.loo.has(k));
  const segOthers = market ? (market.segCounts[l.c.segment] || 0) - (inTrain ? 1 : 0) : 0;
  if (market && deviation != null && l.c.trim !== 'Belirsiz' && segOthers < 3) {
    cautions.push(`${l.c.generation !== '-' ? `${l.c.generation} ` : ''}${l.c.trim} için az ilan var (${Math.max(0, segOthers)}) – beklenen fiyat ${newPrice ? 'sıfır fiyatından ve ' : ''}benzer versiyonlardan türetildi, aralık geniş`);
  }

  // Etiket: fiyat, versiyonun olağan fiyat aralığının (~%80) neresinde?
  const thin = !market || (market.modelCounts[l.c.model] || 0) < 6;
  const below = pred && l.price < pred.low;
  const above = pred && l.price > pred.high;
  const sureTrim = !l.c.trimGuessed && l.c.trim !== 'Belirsiz';
  // Gerçek fırsatlar aralığın biraz altında olur; çok uzağı (≥3,5σ ve %12+) çoğunlukla gizli hasar ya da yanlış bilgi
  const extreme = z != null && z <= -3.5 && deviation <= -0.12;
  let label;
  if (thin || deviation == null) {
    label = 'Veri az';
    score = 50;
    cautions.push(`${l.c.model} için yeterli karşılaştırma ilanı yok – fiyatı benzer ilanlarla elle karşılaştırın`);
  } else if ((deviation <= -0.25 && z <= -2.5) || (extreme && !heavy)) {
    if (l.sellerType === 'kurumsal') {
      label = 'İyi fiyat';
      cautions.unshift('Olağan fiyat aralığının çok altında – gizli ağır hasar, farklı versiyon veya hatalı fiyat olabilir; ekspertiz raporunu isteyin');
    } else {
      label = 'Şüpheli';
      score = Math.min(score, 35);
      cautions.unshift('Olağan fiyat aralığının çok altında – kaydı görünmeyen ağır hasar/pert, farklı versiyon, yanlış fiyat veya dolandırıcılık olabilir. Kapora göndermeyin, aracı görmeden ödeme yapmayın.');
    }
  } else if (below) label = !heavy && sureTrim && score >= 55 && !(newRatio >= 0.97) ? 'Fırsat' : 'İyi fiyat';
  else if (z <= -0.5) label = 'İyi fiyat';
  else if (above) label = 'Pahalı';
  else label = 'Piyasa';

  if (deviation != null && !thin) {
    const pct = Math.abs(deviation * 100).toFixed(1);
    const ref = heavy ? 'Ağır hasarlı araç tahmininin' : damaged ? 'Hasar durumuna göre tahminin' : 'Piyasa tahmininin';
    const range = fmtRange(pred.low, pred.high);
    if (below) reasons.unshift(`${ref} %${pct} altında – olağan aralığın (${range}) dışında`);
    else if (above) cautions.unshift(`${ref} %${pct} üstünde – olağan aralığın (${range}) dışında, pazarlık edin`);
    else if (deviation < -0.02) reasons.unshift(`${ref} %${pct} altında (olağan aralık ${range})`);
    else if (deviation > 0.03) cautions.unshift(`${ref} %${pct} üstünde (olağan aralık ${range})`);
    else reasons.unshift(`${heavy ? 'Ağır hasarlı araç' : 'Piyasa'} fiyatında (beklenen ≈ ${fmtM(expected)})`);
    // Hasar kaydı görünmeyen ama çok ucuz araç: ilanda yazmasa da ağır hasar/pert olabilir
    if (!heavy && deviation <= -0.15) cautions.push('Fiyat piyasanın belirgin altında – ilanda yazmasa da ağır hasar/pert kaydını şasi numarasıyla (SBM / e-Devlet) sorgulayın');
  }
  if (newRatio) (newRatio >= 0.97 ? cautions : reasons).push(`Sıfırının ${pctOf(newRatio * 100)} (sıfır ${fmtM(newPrice)}${newRatio >= 0.97 ? ' – sıfırı teslimat beklemeli bu fiyata alınabilir' : ''})`);

  // Teklif önerisi (aktif, değerlendirilebilir ilanlar)
  const offer = l.status === 'active' && pred && label !== 'Veri az' && label !== 'Şüpheli'
    ? suggestOffer({ price: l.price, expected, low: pred.low, daysOn, drops: drops.length, saleRatio: sale?.saleRatio })
    : null;

  let advice;
  if (heavy && label !== 'Veri az' && label !== 'Şüpheli') advice = `Ağır hasar kayıtlı: ${label === 'İyi fiyat' ? 'ağır hasarlı araçlara göre uygun' : label === 'Piyasa' ? 'ağır hasarlı araç piyasasında' : 'ağır hasarlı araçlara göre bile pahalı'}. Detaylı ekspertiz şart; tekrar satışta değer kaybı yüksektir.`;
  else if (label === 'Veri az') advice = 'Piyasada az örnek var; tahmin güvenilir değil. Yurt dışı ve sıfır fiyatlarıyla da kıyaslayın.';
  else if (label === 'Şüpheli') advice = 'Dikkatli olun: fiyat gerçek dışı derecede düşük. Ekspertiz ve noter dışında ödeme yapmayın.';
  else if (label === 'Fırsat') advice = 'Hızlı davranın: olağan fiyat aralığının altında. Ekspertiz + batarya SOH testi yaptırıp karar verin.';
  else if (label === 'İyi fiyat') advice = below && !sureTrim ? 'Ucuz görünüyor ama versiyon kesin değil; önce donanımı (cam tavan, arka ekran, menzil) teyit edin.' : 'Değerlendirilebilir. Küçük bir pazarlıkla iyi bir alım olur.';
  else if (label === 'Piyasa') advice = 'Normal piyasa fiyatı. Pazarlık payı varsa düşünülebilir.';
  else advice = `Pahalı. ${compMedian ? `Benzer ilanların medyanı ${fmtTL(compMedian)}. ` : ''}Pazarlık etmeden almayın.`;

  return {
    expected: round(expected),
    expectedLow: pred ? round(pred.low, 10000) : null,
    expectedHigh: pred ? round(pred.high, 10000) : null,
    sigma: pred ? Math.round(pred.sigma * 1000) / 1000 : null,
    z: z != null ? Math.round(z * 100) / 100 : null,
    expectedClean: damaged && expectedClean ? round(expectedClean) : undefined,
    damageDiscount: damaged ? Math.round(damageDiscount * 1000) / 1000 : undefined,
    newPrice: newPrice || undefined,
    newRatio: newRatio ? Math.round(newRatio * 1000) / 1000 : undefined,
    deviation: deviation != null ? Math.round(deviation * 1000) / 1000 : null,
    score,
    label,
    advice,
    reasons,
    cautions,
    comps: comps.length,
    compMedian: compMedian ? Math.round(compMedian) : null,
    segmentCount: market ? Math.max(0, segOthers) : 0,
    confidence: comps.length >= 5 && segOthers >= 5 && sureTrim ? 'yüksek' : comps.length >= 2 ? 'orta' : 'düşük',
    daysOnMarket: daysOn,
    offer: offer?.offer,
    offerBasis: offer?.basis,
  };
}

/** Segment bazında piyasa özeti (model verilirse versiyonun tipik hatası ve sıfır fiyatıyla) */
export function marketSummary(listings, market = null, { sale = null, all = listings } = {}) {
  const active = listings.filter((l) => l.status === 'active' && l.price);
  const groups = new Map();
  for (const l of active) {
    const key = `${l.c.model}|${l.c.generation}|${l.c.trim}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(l);
  }
  const now = Date.now();
  const trends = market ? priceTrend(all, now) : {};
  const segments = [...groups.entries()].map(([key, ls]) => {
    const [model, generation, trim] = key.split('|');
    const seg = `${model} · ${generation} · ${trim}`;
    const years = ls.map((l) => l.year).filter(Boolean);
    // Fiyat istatistikleri ağır hasarlılar hariç (en düşük fiyat çoğu zaman pert araç oluyor)
    const clean = ls.filter((l) => !isHeavy(l));
    const priced = clean.length ? clean : ls;
    const sigma = market?.sigmaSeg[seg];
    return {
      model, generation, trim,
      count: ls.length,
      heavy: ls.length - clean.length,
      medianPrice: median(priced.map((l) => l.price)),
      minPrice: Math.min(...priced.map((l) => l.price)),
      medianKm: median(ls.map((l) => l.km)),
      years: years.length ? [Math.min(...years), Math.max(...years)] : null,
      new7d: ls.filter((l) => now - Date.parse(l.firstSeen) < 7 * DAY).length,
      // Tipik hata: ilanların yarısının tahminden sapması bundan az (σ × 0,674)
      typicalError: sigma ? Math.round(sigma * 0.6745 * 1000) / 1000 : undefined,
      newPrice: market?.newPrices?.[seg],
      trend: trends[seg],
    };
  }).sort((a, b) => b.count - a.count);
  const removed30 = listings.filter((l) => l.status === 'removed' && now - Date.parse(l.removedAt) < 30 * DAY);
  const r3 = (x) => Math.round(x * 1000) / 1000;
  const damageEffects = market ? Object.fromEntries(Object.entries(market.damageEffects).map(([k, v]) => [k, r3(v)])) : undefined;
  const modelTrends = Object.fromEntries(Object.entries(trends).filter(([k]) => k.endsWith(' · Tümü')).map(([k, v]) => [k.replace(' · Tümü', ''), v]));
  return { segments, removed30d: removed30.length, activeCount: active.length, damageEffects, typicalError: market ? r3(market.sigmaAll * 0.6745) : undefined, sale: sale || undefined, trends: modelTrends };
}
