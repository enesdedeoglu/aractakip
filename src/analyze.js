// Adil fiyat modeli + puanlama + tavsiye metinleri.
// Tüm aktif Tesla ilanları üzerinde
//   log(fiyat) ~ model + nesil + versiyon + nesil×versiyon + yıl + km + km² + ağır hasar
// şeklinde hiyerarşik ridge regresyon kurulur. Nesil×versiyon terimi sayesinde ör. Juniper Standart ile
// Juniper Premium (ya da Legacy RWD) ayrı fiyatlanır; az ilanlı versiyonlar üst seviyelere (nesil, versiyon) yaslanır.
// Her ilanın beklenen fiyatı o ilan modelden çıkarılarak (leave-one-out) hesaplanır: az ilanlı bir versiyonda
// ilan, kendi fiyatını "piyasa" diye göstermez.

const DAY = 86400000;
const HEAVY = 'Ağır hasar kayıtlı';
// Ağır hasar kaydının fiyata etkisi için ön bilgi (~%30 düşük, 4 ilan ağırlığında); ilan arttıkça veriden öğrenilir
const HEAVY_PRIOR = Math.log(0.7);
const HEAVY_WEIGHT = 4;
// Kategorik seviyeler ve ridge cezaları (büyük ceza = üst seviyeye daha çok yaslanır)
const LEVELS = [
  ['model', (r) => r.c.model, 0.3],
  ['nesil', (r) => `${r.c.model}|${r.c.generation}`, 0.5],
  ['versiyon', (r) => `${r.c.model}|${r.c.trim}`, 0.5],
  ['segment', (r) => `${r.c.model}|${r.c.generation}|${r.c.trim}`, 1],
];

export const isHeavy = (l) => l.c?.heavy === 'var' || l.damage?.heavy === true || (l.c?.warnings || []).includes(HEAVY);

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

function buildFeatures(rows, imputeKm) {
  const names = ['1', 'yıl', 'km', 'km²', 'ağır hasar'];
  const pen = [1e-6, 1e-3, 1e-3, 0.5, HEAVY_WEIGHT];
  const prior = [0, 0, 0, 0, HEAVY_PRIOR];
  const index = new Map();
  for (const [lvl, key, lambda] of LEVELS) for (const r of rows) {
    const id = `${lvl}:${key(r)}`;
    if (!index.has(id)) { index.set(id, names.length); names.push(id); pen.push(lambda); prior.push(0); }
  }
  /** @param heavy ağır hasar durumunu zorla (ör. hasarsız eşdeğer fiyat için false) */
  const vec = (r, heavy = isHeavy(r)) => {
    const x = new Array(names.length).fill(0);
    const km = imputeKm(r) / 100000;
    x[0] = 1; x[1] = (r.year ?? 2022) - 2023; x[2] = km; x[3] = km * km; x[4] = heavy ? 1 : 0;
    for (const [lvl, key] of LEVELS) {
      const i = index.get(`${lvl}:${key(r)}`);
      if (i != null) x[i] = 1;
    }
    return x;
  };
  return { names, pen, prior, vec };
}

// Cezalı en küçük kareler: (XᵀX + Λ) β = Xᵀy + Λ β₀
function fit(rows, vec, pen, prior) {
  const p = pen.length;
  const A = Array.from({ length: p }, () => new Array(p).fill(0));
  const b = new Array(p).fill(0);
  for (const r of rows) {
    const x = vec(r);
    const y = Math.log(r.price);
    for (let i = 0; i < p; i++) {
      if (!x[i]) continue;
      b[i] += x[i] * y;
      for (let j = 0; j < p; j++) if (x[j]) A[i][j] += x[i] * x[j];
    }
  }
  for (let i = 0; i < p; i++) { A[i][i] += pen[i]; b[i] += pen[i] * prior[i]; }
  const Ainv = invert(A);
  return { beta: matVec(Ainv, b), Ainv };
}

/** Piyasa modeli: aktif, fiyatı/yılı belli ilanlardan */
export function buildMarket(listings) {
  const rows = listings.filter((l) => l.status === 'active' && l.price > 100000 && l.year && l.c && l.c.model !== 'Diğer');
  if (rows.length < 8) return null;
  const imputeKm = kmImputer(rows);
  const { vec, pen, prior } = buildFeatures(rows, imputeKm);
  // Km'si bilinen ilanlar katsayıları belirler (yeterince varsa)
  const known = rows.filter((r) => r.km != null);
  let train = known.length >= 20 ? known : rows;
  let m = fit(train, vec, pen, prior);
  // Aykırı değerleri (çok ucuz/pahalı, yanlış girilmiş fiyatlar) at ve yeniden kur
  const clean = train.filter((r) => Math.abs(Math.log(r.price) - dot(m.beta, vec(r))) < 0.3);
  if (clean.length >= 8) { train = clean; m = fit(train, vec, pen, prior); }
  // Leave-one-out düzeltmesi için her eğitim ilanının etkisi: β₋ᵢ = β − A⁻¹xᵢ · eᵢ/(1−hᵢ)
  const loo = new Map();
  for (const r of train) {
    const x = vec(r);
    const ax = matVec(m.Ainv, x);
    const h = Math.min(0.95, dot(x, ax));
    loo.set(r.key, { ax, k: (Math.log(r.price) - dot(m.beta, x)) / (1 - h) });
  }
  const modelCounts = {};
  for (const r of rows) modelCounts[r.c.model] = (modelCounts[r.c.model] || 0) + 1;
  const segCounts = {};
  for (const r of train) segCounts[r.c.segment] = (segCounts[r.c.segment] || 0) + 1;
  return { beta: m.beta, vec, loo, n: train.length, kmKnown: known.length, modelCounts, segCounts, heavyEffect: Math.exp(m.beta[4]) - 1 };
}

/** Beklenen fiyat; ilan (veya aynı aracın diğer sitedeki ilanı) modeli kurarken kullanıldıysa onsuz hesaplanır */
export function expectedPrice(l, market, heavy = isHeavy(l)) {
  const x = market.vec(l, heavy);
  let lp = dot(market.beta, x);
  const own = [l.key, ...(l.dup?.members || [])].map((k) => market.loo.get(k)).find(Boolean);
  if (own) lp -= dot(x, own.ax) * own.k;
  return Math.exp(lp);
}

function fmtTL(n) {
  return n == null ? '-' : `${Math.round(n).toLocaleString('tr-TR')} TL`;
}

export function analyzeListing(l, market, all) {
  const now = Date.now();
  const reasons = [];   // olumlu
  const cautions = [];  // dikkat
  const heavy = isHeavy(l);
  // Ağır hasarlı araç, ağır hasarlı araç fiyatıyla kıyaslanır; hasarsız eşdeğer fiyatı ayrıca gösterilir
  let expected = null, expectedClean = null, deviation = null;
  if (market && l.price && l.year && l.c.model !== 'Diğer') {
    expected = expectedPrice(l, market);
    expectedClean = heavy ? expectedPrice(l, market, false) : expected;
    deviation = l.price / expected - 1;
  }
  // Benzer ilanlar: aynı segment, ±1 yıl, aynı ağır hasar durumu
  const comps = all.filter((o) => o.key !== l.key && !(l.dup && l.dup.members.includes(o.key)) && o.status === 'active' && o.price && o.c.segment === l.c.segment && o.year && l.year && Math.abs(o.year - l.year) <= 1 && isHeavy(o) === heavy);
  const compMedian = median(comps.map((o) => o.price));

  let score = 50;
  if (deviation != null) score -= deviation * 250;

  // Hasar / ekspertiz bilgisi
  const d = l.damage || {};
  if (heavy) {
    // Fiyat zaten ağır hasarlı piyasaya göre; puan cezası küçük, etiket en fazla "İyi fiyat" (aşağıda)
    score -= 8;
    cautions.push(`Ağır hasar kayıtlı – ${expectedClean ? `fiyat ağır hasarlı araçlara göre değerlendirildi (hasarsız eşdeğeri ≈ ${fmtTL(expectedClean)}); ` : ''}sigorta, kredi ve tekrar satışta sorun olabilir`);
  }
  if (d.tramer > 0) {
    const ratio = expected ? d.tramer / expected : d.tramer / l.price;
    score -= Math.min(20, ratio * 150);
    cautions.push(`Tramer kaydı ${fmtTL(d.tramer)} – hasar detayını ve onarım kalitesini kontrol edin`);
  } else if (d.tramer === 0) { score += 3; reasons.push('Tramer kaydı yok'); }
  if (d.original) { score += 5; reasons.push('Boyasız, değişensiz'); }
  else if (d.painted || d.changed) { score -= 6; cautions.push(d.summary || 'Boyalı/değişen parça var'); }
  else if (d.summary && !/orjinal|orijinal/i.test(d.summary)) cautions.push(`Boya/değişen: ${d.summary}`);
  for (const w of l.c.warnings) {
    if (w === HEAVY && d.heavy) continue;
    if (w !== HEAVY) score -= 12;
    cautions.push(`İlan metninde: "${w}"`);
  }

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
  if (l.c.trimGuessed) cautions.push(`Versiyon ilanda açıkça yazmıyor; ${l.year} model olduğu için ${l.c.trim} varsayıldı – ilan detayından kontrol edin`);
  else if (l.c.trim === 'Belirsiz') cautions.push('Versiyon (Standart / Premium / Long Range / Performance) belirlenemedi – beklenen fiyat yaklaşık');
  const inTrain = market && [l.key, ...(l.dup?.members || [])].some((k) => market.loo.has(k));
  const segOthers = market ? (market.segCounts[l.c.segment] || 0) - (inTrain ? 1 : 0) : 0;
  if (market && deviation != null && l.c.trim !== 'Belirsiz' && segOthers < 3) {
    cautions.push(`${l.c.generation !== '-' ? `${l.c.generation} ` : ''}${l.c.trim} için az ilan var (${Math.max(0, segOthers)}) – beklenen fiyat benzer versiyonlardan türetildi`);
  }

  const thin = !market || (market.modelCounts[l.c.model] || 0) < 6;
  let label;
  if (thin || deviation == null) {
    label = 'Veri az';
    score = 50;
    cautions.push(`${l.c.model} için yeterli karşılaştırma ilanı yok – fiyatı benzer ilanlarla elle karşılaştırın`);
  } else if (deviation <= -0.25 && l.sellerType !== 'kurumsal') {
    label = 'Şüpheli';
    score = Math.min(score, 35);
    cautions.unshift('Piyasanın çok altında – hasar, yanlış fiyat veya dolandırıcılık olabilir. Kapora göndermeyin, aracı görmeden ödeme yapmayın.');
  } else if (score >= 72 && !heavy) label = 'Fırsat';
  else if (score >= 58) label = 'İyi fiyat';
  else if (score >= 42) label = 'Piyasa';
  else label = 'Pahalı';

  if (deviation != null && !thin) {
    const pct = Math.abs(deviation * 100).toFixed(1);
    const ref = heavy ? 'Ağır hasarlı araç tahmininin' : 'Piyasa tahmininin';
    if (deviation < -0.02) reasons.unshift(`${ref} %${pct} altında (beklenen ≈ ${fmtTL(expected)})`);
    else if (deviation > 0.03) cautions.unshift(`${ref} %${pct} üstünde (beklenen ≈ ${fmtTL(expected)}) – pazarlık edin`);
    else reasons.unshift(`${heavy ? 'Ağır hasarlı araç' : 'Piyasa'} fiyatında (beklenen ≈ ${fmtTL(expected)})`);
    // Hasar kaydı görünmeyen ama çok ucuz araç: ilanda yazmasa da ağır hasar/pert olabilir
    if (!heavy && deviation <= -0.15) cautions.push('Fiyat piyasanın belirgin altında – ilanda yazmasa da ağır hasar/pert kaydını şasi numarasıyla (SBM / e-Devlet) sorgulayın');
  }

  let advice;
  if (heavy && label !== 'Veri az' && label !== 'Şüpheli') advice = `Ağır hasar kayıtlı: ${label === 'İyi fiyat' ? 'ağır hasarlı araçlara göre uygun' : label === 'Piyasa' ? 'ağır hasarlı araç piyasasında' : 'ağır hasarlı araçlara göre bile pahalı'}. Detaylı ekspertiz şart; tekrar satışta değer kaybı yüksektir.`;
  else if (label === 'Veri az') advice = 'Piyasada az örnek var; tahmin güvenilir değil. Yurt dışı ve sıfır fiyatlarıyla da kıyaslayın.';
  else if (label === 'Şüpheli') advice = 'Dikkatli olun: fiyat gerçek dışı derecede düşük. Ekspertiz ve noter dışında ödeme yapmayın.';
  else if (label === 'Fırsat') advice = 'Hızlı davranın: piyasanın altında. Ekspertiz + batarya SOH testi yaptırıp karar verin.';
  else if (label === 'İyi fiyat') advice = 'Değerlendirilebilir. Küçük bir pazarlıkla iyi bir alım olur.';
  else if (label === 'Piyasa') advice = 'Normal piyasa fiyatı. Pazarlık payı varsa düşünülebilir.';
  else advice = `Pahalı. ${compMedian ? `Benzer ilanların medyanı ${fmtTL(compMedian)}. ` : ''}Pazarlık etmeden almayın.`;

  return {
    expected: expected ? Math.round(expected / 1000) * 1000 : null,
    expectedClean: heavy && expectedClean ? Math.round(expectedClean / 1000) * 1000 : undefined,
    deviation: deviation != null ? Math.round(deviation * 1000) / 1000 : null,
    score,
    label,
    advice,
    reasons,
    cautions,
    comps: comps.length,
    compMedian: compMedian ? Math.round(compMedian) : null,
    segmentCount: market ? Math.max(0, segOthers) : 0,
    confidence: comps.length >= 5 && segOthers >= 5 && !l.c.trimGuessed ? 'yüksek' : comps.length >= 2 ? 'orta' : 'düşük',
    daysOnMarket: daysOn,
  };
}

/** Segment bazında piyasa özeti */
export function marketSummary(listings) {
  const active = listings.filter((l) => l.status === 'active' && l.price);
  const groups = new Map();
  for (const l of active) {
    const key = `${l.c.model}|${l.c.generation}|${l.c.trim}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(l);
  }
  const now = Date.now();
  const segments = [...groups.entries()].map(([key, ls]) => {
    const [model, generation, trim] = key.split('|');
    const years = ls.map((l) => l.year).filter(Boolean);
    // Fiyat istatistikleri ağır hasarlılar hariç (en düşük fiyat çoğu zaman pert araç oluyor)
    const clean = ls.filter((l) => !isHeavy(l));
    const priced = clean.length ? clean : ls;
    return {
      model, generation, trim,
      count: ls.length,
      heavy: ls.length - clean.length,
      medianPrice: median(priced.map((l) => l.price)),
      minPrice: Math.min(...priced.map((l) => l.price)),
      medianKm: median(ls.map((l) => l.km)),
      years: years.length ? [Math.min(...years), Math.max(...years)] : null,
      new7d: ls.filter((l) => now - Date.parse(l.firstSeen) < 7 * DAY).length,
    };
  }).sort((a, b) => b.count - a.count);
  const removed30 = listings.filter((l) => l.status === 'removed' && now - Date.parse(l.removedAt) < 30 * DAY);
  return { segments, removed30d: removed30.length, activeCount: active.length };
}
