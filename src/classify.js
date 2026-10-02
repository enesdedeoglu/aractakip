// Tesla ilanlarını model / nesil / versiyon / etiketlere göre kategorize eder.

const lc = (s) => (s || '').toLocaleLowerCase('tr-TR');

export function detectModel(text) {
  const t = lc(text);
  if (/cyber\s*truck/.test(t)) return 'Cybertruck';
  if (/roadster/.test(t)) return 'Roadster';
  const m = t.match(/model\s*-?\s*([3ysx])\b/);
  if (m) return `Model ${m[1].toUpperCase()}`;
  if (/\bm3\b/.test(t)) return 'Model 3';
  if (/\bmy\b/.test(t)) return 'Model Y';
  return 'Diğer';
}

export function detectGeneration(model, text, year) {
  const t = lc(text);
  if (model === 'Model Y') {
    if (/juniper/.test(t)) return 'Juniper';
    if (/legacy/.test(t)) return 'Legacy';
    return year && year >= 2025 ? 'Juniper' : 'Legacy';
  }
  if (model === 'Model 3') {
    if (/highland/.test(t)) return 'Highland';
    return year && year >= 2024 ? 'Highland' : 'Klasik';
  }
  if (model === 'Model S' || model === 'Model X') return year && year >= 2021 ? 'Yeni kasa (2021+)' : 'Klasik';
  return '-';
}

export function detectTrim(model, text) {
  const t = lc(text);
  if (/plaid/.test(t)) return 'Plaid';
  if (/performance|perfo?rmans|\bp\d{2,3}d\b|\bperf\b/.test(t)) return 'Performance';
  const awd = /\bawd\b|dual\s*motor|çift\s*motor|4wd|4x4|\b\d{2,3}d\b/.test(t);
  if (/long\s*range|uzun\s*menzil|\blr\b|premium|maximum\s*range/.test(t)) return awd ? 'Long Range AWD' : 'Long Range';
  if (/standart|standard|\bsr\+?\b|\brwd\b|arkadan\s*itiş|base/.test(t)) return 'Standart RWD';
  if (awd) return 'Long Range AWD';
  if ((model === 'Model S' || model === 'Model X') && /\b(75|85|90|100)\b/.test(t)) return 'Long Range';
  return 'Belirsiz';
}

const TAG_RULES = [
  ['FSD', /\bfsd\b|full\s*self|tam\s*otonom/],
  ['EAP', /\beap\b|enhanced\s*auto|gelişmiş\s*otopilot/],
  ['HW4', /\bhw\s*4\b|hardware\s*4/],
  ['PPF', /\bppf\b|şeffaf\s*kaplama/],
  ['Garantili', /garanti/],
  ['Hatasız', /hatasız|hatasiz/],
  ['Boyasız', /boyasız|boyasiz/],
  ['Değişensiz', /değişensiz|degisensiz/],
  ['Tramersiz', /tramersiz|tramer\s*yok|hasar\s*kaydı\s*yok/],
  ['Takas', /takas/],
  ['Krediye uygun', /kredi/],
  ['Acil', /\bacil\b/],
  ['Beyaz iç', /beyaz\s*(iç|koltuk|döşeme)/],
  ['Çekme demiri', /çeki\s*demir|çekme\s*demir/],
];

const DAMAGE_RULES = [
  ['Ağır hasar kayıtlı', /ağır\s*hasar|(^|[^\p{L}])pert([^\p{L}]|$)/gu],
  ['Hasarlı', /(^|[^\p{L}])(hasarlı|kazalı)([^\p{L}]|$)/gu],
  ['Değişen var', /değişen\s*var|\d+\s*parça\s*değişen/gu],
];

// "ağır hasar kaydı yok", "hasarlı değil" gibi olumsuz ifadeleri ayıkla
const NEGATION = /^.{0,18}?(yok|yoktur|değil|kayıtsız|bulunmamakta|hayır)/u;
function matchesPositive(t, re) {
  re.lastIndex = 0;
  for (const m of t.matchAll(re)) {
    if (!NEGATION.test(t.slice(m.index + m[0].length))) return true;
  }
  return false;
}

export function detectTags(text) {
  const t = lc(text);
  const tags = TAG_RULES.filter(([, re]) => re.test(t)).map(([n]) => n);
  const warnings = DAMAGE_RULES.filter(([, re]) => matchesPositive(t, re)).map(([n]) => n);
  return { tags, warnings };
}

export function classify(l) {
  const text = `${l.modelRaw || ''} ${l.title || ''} ${l.specs?.trim || ''} ${l.specs?.drive || ''}`;
  const model = detectModel(`${l.modelRaw || ''} ${l.title || ''}`);
  const generation = detectGeneration(model, text, l.year);
  let trim = detectTrim(model, `${l.modelRaw || ''} ${l.specs?.trim || ''} ${l.specs?.drive || ''}`);
  if (trim === 'Belirsiz') trim = detectTrim(model, text);
  const { tags, warnings } = detectTags(`${l.title || ''}`);
  if (l.damage?.original) {
    for (const t of ['Boyasız', 'Değişensiz']) if (!tags.includes(t)) tags.push(t);
  }
  if (l.damage?.tramer === 0 && !tags.includes('Tramersiz')) tags.push('Tramersiz');
  if (l.damage?.heavy) warnings.push('Ağır hasar kayıtlı');
  if (l.warranty && !/garantisiz/i.test(l.warranty) && !tags.includes('Garantili')) tags.push('Garantili');
  const kmBand = l.km == null ? 'Bilinmiyor' : l.km < 20000 ? '0-20 bin' : l.km < 50000 ? '20-50 bin' : l.km < 100000 ? '50-100 bin' : l.km < 150000 ? '100-150 bin' : '150 bin+';
  return {
    model,
    generation,
    trim,
    segment: `${model} · ${generation} · ${trim}`,
    kmBand,
    tags,
    warnings: [...new Set(warnings)],
  };
}
