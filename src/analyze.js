// Adil fiyat modeli + puanlama + tavsiye metinleri.
// Tüm aktif Tesla ilanları üzerinde log(fiyat) ~ model/nesil/versiyon + yıl + km
// şeklinde ridge regresyon kurulur; her ilanın beklenen piyasa fiyatı buradan hesaplanır.

const DAY = 86400000;

function median(arr) {
  const a = arr.filter((x) => x != null && !Number.isNaN(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function solve(A, b) {
  // Gauss eliminasyonu (kısmi pivot)
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    if (Math.abs(M[c][c]) < 1e-12) continue;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => (Math.abs(row[i]) < 1e-12 ? 0 : row[n] / row[i]));
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
  const cats = { model: new Set(), mg: new Set(), mt: new Set() };
  for (const r of rows) {
    cats.model.add(r.c.model);
    cats.mg.add(`${r.c.model}|${r.c.generation}`);
    cats.mt.add(`${r.c.model}|${r.c.trim}`);
  }
  const names = ['1', 'yıl', 'km', 'km²'];
  const keys = [];
  for (const [k, set] of Object.entries(cats)) for (const v of set) { names.push(`${k}:${v}`); keys.push([k, v]); }
  const vec = (r) => {
    const age = (r.year ?? 2022) - 2023;
    const km = imputeKm(r) / 100000;
    const x = [1, age, km, km * km];
    for (const [k, v] of keys) {
      const val = k === 'model' ? r.c.model : k === 'mg' ? `${r.c.model}|${r.c.generation}` : `${r.c.model}|${r.c.trim}`;
      x.push(val === v ? 1 : 0);
    }
    return x;
  };
  return { names, vec };
}

function fit(rows, vec, lambda = 0.3) {
  const X = rows.map(vec);
  const y = rows.map((r) => Math.log(r.price));
  const p = X[0].length;
  const XtX = Array.from({ length: p }, () => new Array(p).fill(0));
  const Xty = new Array(p).fill(0);
  for (let i = 0; i < X.length; i++) {
    for (let a = 0; a < p; a++) {
      Xty[a] += X[i][a] * y[i];
      for (let b = 0; b < p; b++) XtX[a][b] += X[i][a] * X[i][b];
    }
  }
  // Sabit, yıl ve km dışındaki kategorik katsayılara ridge cezası
  for (let a = 4; a < p; a++) XtX[a][a] += lambda;
  XtX[0][0] += 1e-6; XtX[1][1] += 1e-3; XtX[2][2] += 1e-3; XtX[3][3] += 0.5;
  return solve(XtX, Xty);
}

const predict = (beta, x) => Math.exp(x.reduce((s, v, i) => s + v * beta[i], 0));

/** Piyasa modeli: aktif, fiyatı/yılı belli ilanlardan */
export function buildMarket(listings) {
  const rows = listings.filter((l) => l.status === 'active' && l.price > 100000 && l.year && l.c && l.c.model !== 'Diğer');
  if (rows.length < 8) return null;
  const imputeKm = kmImputer(rows);
  const { vec } = buildFeatures(rows, imputeKm);
  // Km'si bilinen ilanlar katsayıları belirler (yeterince varsa)
  const known = rows.filter((r) => r.km != null);
  const train = known.length >= 20 ? known : rows;
  let beta = fit(train, vec);
  // Aykırı değerleri (çok ucuz/pahalı, yanlış girilmiş fiyatlar) at ve yeniden kur
  const clean = train.filter((r) => Math.abs(Math.log(r.price / predict(beta, vec(r)))) < 0.3);
  if (clean.length >= 8) beta = fit(clean, vec);
  const modelCounts = {};
  for (const r of rows) modelCounts[r.c.model] = (modelCounts[r.c.model] || 0) + 1;
  return { beta, vec, n: clean.length, kmKnown: known.length, modelCounts };
}

function fmtTL(n) {
  return n == null ? '-' : `${Math.round(n).toLocaleString('tr-TR')} TL`;
}

export function analyzeListing(l, market, all) {
  const now = Date.now();
  const reasons = [];   // olumlu
  const cautions = [];  // dikkat
  let expected = null, deviation = null;
  if (market && l.price && l.year && l.c.model !== 'Diğer') {
    expected = predict(market.beta, market.vec(l));
    deviation = l.price / expected - 1;
  }
  // Benzer ilanlar: aynı segment, ±1 yıl
  const comps = all.filter((o) => o.key !== l.key && !(l.dup && l.dup.members.includes(o.key)) && o.status === 'active' && o.price && o.c.segment === l.c.segment && o.year && l.year && Math.abs(o.year - l.year) <= 1);
  const compMedian = median(comps.map((o) => o.price));

  let score = 50;
  if (deviation != null) score -= deviation * 250;

  // Hasar / ekspertiz bilgisi
  const d = l.damage || {};
  if (d.heavy) { score -= 35; cautions.push('Ağır hasar kayıtlı – değeri ciddi düşüktür, sigorta/kredi sorun olabilir'); }
  if (d.tramer > 0) {
    const ratio = expected ? d.tramer / expected : d.tramer / l.price;
    score -= Math.min(20, ratio * 150);
    cautions.push(`Tramer kaydı ${fmtTL(d.tramer)} – hasar detayını ve onarım kalitesini kontrol edin`);
  } else if (d.tramer === 0) { score += 3; reasons.push('Tramer kaydı yok'); }
  if (d.original) { score += 5; reasons.push('Boyasız, değişensiz'); }
  else if (d.painted || d.changed) { score -= 6; cautions.push(d.summary || 'Boyalı/değişen parça var'); }
  else if (d.summary && !/orjinal|orijinal/i.test(d.summary)) cautions.push(`Boya/değişen: ${d.summary}`);
  for (const w of l.c.warnings) {
    if (w === 'Ağır hasar kayıtlı' && d.heavy) continue;
    score -= w === 'Ağır hasar kayıtlı' ? 30 : 12;
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
  } else if (score >= 72) label = 'Fırsat';
  else if (score >= 58) label = 'İyi fiyat';
  else if (score >= 42) label = 'Piyasa';
  else label = 'Pahalı';

  if (deviation != null && !thin) {
    const pct = Math.abs(deviation * 100).toFixed(1);
    if (deviation < -0.02) reasons.unshift(`Piyasa tahmininin %${pct} altında (beklenen ≈ ${fmtTL(expected)})`);
    else if (deviation > 0.03) cautions.unshift(`Piyasa tahmininin %${pct} üstünde (beklenen ≈ ${fmtTL(expected)}) – pazarlık edin`);
    else reasons.unshift(`Piyasa fiyatında (beklenen ≈ ${fmtTL(expected)})`);
  }

  let advice;
  if (label === 'Veri az') advice = 'Piyasada az örnek var; tahmin güvenilir değil. Yurt dışı ve sıfır fiyatlarıyla da kıyaslayın.';
  else if (label === 'Şüpheli') advice = 'Dikkatli olun: fiyat gerçek dışı derecede düşük. Ekspertiz ve noter dışında ödeme yapmayın.';
  else if (label === 'Fırsat') advice = 'Hızlı davranın: piyasanın altında. Ekspertiz + batarya SOH testi yaptırıp karar verin.';
  else if (label === 'İyi fiyat') advice = 'Değerlendirilebilir. Küçük bir pazarlıkla iyi bir alım olur.';
  else if (label === 'Piyasa') advice = 'Normal piyasa fiyatı. Pazarlık payı varsa düşünülebilir.';
  else advice = `Pahalı. ${compMedian ? `Benzer ilanların medyanı ${fmtTL(compMedian)}. ` : ''}Pazarlık etmeden almayın.`;

  return {
    expected: expected ? Math.round(expected / 1000) * 1000 : null,
    deviation: deviation != null ? Math.round(deviation * 1000) / 1000 : null,
    score,
    label,
    advice,
    reasons,
    cautions,
    comps: comps.length,
    compMedian: compMedian ? Math.round(compMedian) : null,
    confidence: comps.length >= 5 ? 'yüksek' : comps.length >= 2 ? 'orta' : 'düşük',
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
    return {
      model, generation, trim,
      count: ls.length,
      medianPrice: median(ls.map((l) => l.price)),
      minPrice: Math.min(...ls.map((l) => l.price)),
      medianKm: median(ls.map((l) => l.km)),
      years: years.length ? [Math.min(...years), Math.max(...years)] : null,
      new7d: ls.filter((l) => now - Date.parse(l.firstSeen) < 7 * DAY).length,
    };
  }).sort((a, b) => b.count - a.count);
  const removed30 = listings.filter((l) => l.status === 'removed' && now - Date.parse(l.removedAt) < 30 * DAY);
  return { segments, removed30d: removed30.length, activeCount: active.length };
}
