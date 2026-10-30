// Tesla ilanlarını model / nesil / versiyon / etiketlere göre kategorize eder.

const lc = (s) => (s || '').toLocaleLowerCase('tr-TR');
const ASCII = { ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u', â: 'a', î: 'i', û: 'u' };
// Eşleştirme için Türkçe karakterler sadeleştirilir: "AGIR HASARLI", "Ağır Hasarlı" ve "agir hasarli" aynı yakalanır
export const fold = (s) => lc(s).replace(/[çğıöşüâîû]/g, (c) => ASCII[c]).replace(/̇/g, '');

export function detectModel(text) {
  const t = fold(text);
  if (/cyber\s*truck/.test(t)) return 'Cybertruck';
  if (/roadster/.test(t)) return 'Roadster';
  const m = t.match(/model\s*-?\s*([3ysx])\b/);
  if (m) return `Model ${m[1].toUpperCase()}`;
  if (/\bm3\b/.test(t)) return 'Model 3';
  if (/\bmy\b/.test(t)) return 'Model Y';
  return 'Diğer';
}

const GEN_Y = { juniper: /juniper|junper|yeni\s*kasa/, legacy: /legacy|legasy|eski\s*kasa/ };

/**
 * @param title  ilan başlığı: satıcının kendi yazdığı nesil, sitenin kategori alanından önce gelir
 *               (2025 Legacy'ler sık sık "(Juniper)" kategorisine konuyor)
 */
export function detectGeneration(model, text, year, title = '') {
  const t = fold(text);
  if (model === 'Model Y') {
    // Juniper Türkiye'de 2025'te satışa çıktı; 2024 ve öncesi "(Juniper)" kategorisinde olsa da Legacy
    if (year && year <= 2024) return 'Legacy';
    const tt = fold(title);
    const tj = GEN_Y.juniper.test(tt), tl = GEN_Y.legacy.test(tt);
    if (tj !== tl) return tj ? 'Juniper' : 'Legacy';
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

const RE = {
  perf: /performance|perfo?rmans|\bp\d{2,3}d\b|\bperf\b/,
  lr: /long\s*range|uzun\s*menzil|\blr\b|maximum\s*range|launch\s*series/,
  awd: /\bawd\b|dual\s*motor|cift\s*motor|4wd|4x4|dort\s*ceker|4\s*ceker|\b\d{2,3}d\b/,
  rwd: /\brwd\b|arkadan\s*(itis|itme|cekis)|tek\s*motor|single\s*motor/,
  premium: /premium/,
  std: /standart|standard|\bstandar\b|\bsr\+?\b|\bbase\b/,
  // "Standart menzil / SR": 2025'te satılan Juniper arkadan itiş (bugünkü adıyla Premium) için de kullanılıyor
  stdRange: /standar[dt]?\s*(menzil|range)|\bsr\+?\b/,
  // Kasım 2025'te gelen sade Standart'ta olmayan donanımlar: başlıkta geçiyorsa araç eski tam donanımlı
  // arkadan itiştir (Premium). "Soğutma" ilanlarda koltuk havalandırması anlamında kullanılıyor.
  premiumKit: /premium|c(am)?\.?\s*tavan|cam\s*tvn|panoramik|tavan\s*perde|arka\s*ekran|koltuk\s*sogutma|sogutma|havalandirmali|15\s*hoparlor|(4|dort)\s*k(o)?lt?k\s*isitma|arka\s*koltuk\s*isitma/,
  // 2026'da trafiğe çıkmış 2025 model arkadan itiş: eski Premium Kasım 2025'te kalktığı için Standart
  reg2026: /2026.{0,25}?(cikis|trafi)/,
};

/**
 * Versiyon tespiti. Juniper Model Y'de Türkiye'deki satış adları ayrı versiyon sayılır:
 *  - Standart: Kasım 2025'te gelen sade donanımlı arkadan itiş (arka ekran, cam tavan, 15 hoparlör yok)
 *  - Premium : 2025'te satılan tam donanımlı arkadan itiş (eski adı "Standart menzil / SR")
 *  - Long Range RWD / AWD (Premium Long Range), Performance
 * @returns {{ trim: string, guessed: boolean }}  guessed = yalnızca "RWD" yazıyor, versiyon yıla göre tahmin edildi
 */
function trimOf(model, text, { generation, year, specs, guess = true } = {}) {
  const t = fold(text);
  const out = (trim, guessed = false) => ({ trim, guessed });
  if (/plaid/.test(t)) return out('Plaid');
  if (RE.perf.test(t)) return out('Performance');
  const awd = RE.awd.test(t);
  const rwd = !awd && RE.rwd.test(t);
  const lr = RE.lr.test(t) || specs?.batteryKwh >= 70 || specs?.rangeKm >= 560;

  if (model === 'Model Y') {
    if (lr || awd) return out(rwd ? 'Long Range RWD' : 'Long Range AWD');
    if (generation === 'Juniper') {
      // 2026'da "Premium" arkadan itiş = Premium Long Range RWD (eski kısa menzilli Premium Kasım 2025'te kalktı)
      if (RE.premium.test(t)) return out(year >= 2026 ? 'Long Range RWD' : 'Premium');
      if (RE.std.test(t) && !RE.stdRange.test(t)) return out('Standart');
      if (rwd || RE.stdRange.test(t)) {
        if (!guess) return out('Belirsiz');
        if (RE.stdRange.test(t) && year < 2026) return out('Premium');
        // Standart Kasım 2025'te geldi, aynı anda eski arkadan itiş (Premium) satıştan kalktı
        return out(year >= 2026 ? 'Standart' : 'Premium', true);
      }
      return out('Belirsiz');
    }
    if (RE.std.test(t) || rwd) return out('Standart RWD');
    return out('Belirsiz');
  }
  if (lr) return out(awd ? 'Long Range AWD' : rwd ? 'Long Range RWD' : 'Long Range');
  if (RE.std.test(t) || rwd || (model === 'Model 3' && RE.premium.test(t))) return out('Standart RWD');
  if (awd) return out('Long Range AWD');
  if ((model === 'Model S' || model === 'Model X') && /\b(75|85|90|100)\b/.test(t)) return out('Long Range');
  return out('Belirsiz');
}

export function detectTrim(model, text, ctx = {}) {
  return trimOf(model, text, ctx).trim;
}

const TAG_RULES = [
  ['FSD', /\bfsd\b|full\s*self|tam\s*otonom/],
  ['EAP', /\beap\b|enhanced\s*auto|gelis(tiril)?mis\s*oto\s*pilot/],
  ['HW4', /\bhw\s*4\b|hardware\s*4/],
  ['PPF', /\bppf\b|seffaf\s*kaplama/],
  ['Garantili', /garanti(?!si?z|(si)?\s*(yok|bitti|bitmis|dolmus|dolmustur))/],
  ['Hatasız', /hatasiz/],
  ['Boyasız', /boyasiz/],
  ['Değişensiz', /degisensiz/],
  // "ağır hasar kaydı yok" tramer kaydı olmadığı anlamına gelmez
  ['Tramersiz', /tramersiz|tramer\s*(kaydi\s*)?yok|(?<!agir\s?)hasar\s*kaydi\s*yok/],
  ['Takas', /takas(?!\s*(yok|olmaz|dusunulmez|kabul\s*edilmez))/],
  ['Krediye uygun', /kredi/],
  ['Acil', /\bacil\b/],
  ['Beyaz iç', /beyaz\s*(ic|koltuk|doseme)/],
  ['Quicksilver', /quick\s*silver/],
  ['Ultra kırmızı', /ultra\s*(red|kirmizi)/],
  ['20" jant', /20\s*(inc|inch|"|''|'|\s*jant)/],
  ['Çekme demiri', /ceki\s*demir|cekme\s*demir/],
];

const DAMAGE_RULES = [
  // "ağır hasarsız" / "pertsiz" olumsuzdur; "çekme belgeli" = pert kaydından sonra yeniden tescil
  ['Ağır hasar kayıtlı', /agir\s*hasar(?!siz)|(^|[^\p{L}])pert(?!\p{L})|cekme\s*belge|hurda\s*belge/gu],
  ['Hasarlı', /(^|[^\p{L}])(hasarli|kazali)(?!\p{L})/gu],
  ['Değişen var', /degisen(i|ler)?\s*var|(^|[^\d])[1-9]\d?\s*parca\s*degisen|degisenli/gu],
];

// Olumsuzluk, hasar ifadesinin hemen ardından gelmeli ("ağır hasar kaydı yok", "pert değildir",
// "ağır hasar: hayır", "ağır hasar ve tramer kaydı yoktur"). Arada yalnızca "kaydı / kayıtlı / bilgisi"
// gibi dolgu sözcükleri olabilir; "ağır hasar kayıtlı, değişen yok" ya da "hasarlı tramer yok" olumludur.
const FILLER = new Set(['i', 'li', 'si', 'kaydi', 'kayit', 'kayitli', 'kaydida', 'kayitlari', 'bilgisi', 'durumu', 'sorgusu', 'gecmisi', 'parca', 'parcasi', 'parcalar', 'parcalari',
  'mevcut', 'hicbir', 'kesinlikle', 'asla', 'olarak', 've', 'veya', 'ya', 'da', 'de']);
const AFTER_CONJ = new Set(['tramer', 'boya', 'degisen', 'kaza', 'hasar']); // yalnızca "ve / veya"dan sonra dolgu sayılır
const NEG = /^(yok|degil|bulunma|bulunmu|olmayan|olmad|olmam|hayir|kayitsiz|temiz)/;
// Açıklamalardaki kalıp cümleler: "ağır hasar sorgusu yapılabilir", "tramer ve hasar kaydı kontrol edilebilir"
const NEUTRAL = /^(sorgu|sorgula|kontrol|bak|yapil|yapab|test|rapor|ekspert|ogren|incele|gosteril|ulas)/;

function negatedAfter(rest) {
  const toks = rest.slice(0, 80).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  let prev = null;
  for (let i = 0; i < toks.length && i < 5; i++) {
    const w = toks[i];
    if (NEG.test(w) || NEUTRAL.test(w)) return true;
    const filler = FILLER.has(w) || (AFTER_CONJ.has(w) && ['ve', 'veya', 'da'].includes(prev));
    if (!filler) return false;
    prev = w;
  }
  return false;
}

function matchesPositive(t, re) {
  re.lastIndex = 0;
  for (const m of t.matchAll(re)) {
    if (!negatedAfter(t.slice(m.index + m[0].length))) return true;
  }
  return false;
}

export function detectTags(text) {
  const t = fold(text);
  const tags = TAG_RULES.filter(([, re]) => re.test(t)).map(([n]) => n);
  const warnings = DAMAGE_RULES.filter(([, re]) => matchesPositive(t, re)).map(([n]) => n);
  return { tags, warnings };
}

export function classify(l) {
  const sp = l.specs || {};
  // Sitenin kendi kategori/özellik alanları önce; başlık yalnızca bunlar yetmezse devreye girer
  const structured = `${l.modelRaw || ''} ${sp.series || ''} ${sp.trim || ''} ${sp.drive || ''}`;
  const text = `${structured} ${l.title || ''}`;
  // Liste satırında seri boş gelebiliyor ("Tesla Performance Performance"); detaydaki seri de kullanılır
  const model = detectModel(`${l.modelRaw || ''} ${sp.series || ''} ${l.title || ''}`);
  const generation = detectGeneration(model, text, l.year, l.title);
  const ctx = { generation, year: l.year, specs: sp };
  let { trim, guessed } = trimOf(model, structured, { ...ctx, guess: false });
  if (trim === 'Belirsiz') ({ trim, guessed } = trimOf(model, text, ctx));
  const title = fold(l.title);
  let trimAlt;
  const catPremium = RE.premium.test(fold(structured));
  if (model === 'Model Y' && generation === 'Juniper' && (l.year ?? 0) <= 2025 && (trim === 'Standart' || (trim === 'Premium' && !catPremium))) {
    // Satıcılar 2025'in tam donanımlı arkadan itişlilerini sık sık "Standart" kategorisine koyuyor
    if (RE.premiumKit.test(title)) ({ trim, guessed } = { trim: 'Premium', guessed: false });
    else if (RE.reg2026.test(title)) ({ trim, guessed } = { trim: 'Standart', guessed: false });
    // "Standart menzil / range / SR" çoğunlukla eski Premium'u anlatıyor ama gerçek Standart'a da yazılıyor
    // (Ekim 2026: 2,3–2,9 M ve 3,2–3,4 M olmak üzere iki küme): Premium varsayılır, fiyat teyit eder
    else if (RE.stdRange.test(title)) ({ trim, guessed, trimAlt } = { trim: 'Premium', guessed: false, trimAlt: ['Premium', 'Standart'] });
    else if (RE.std.test(title)) ({ trim, guessed } = { trim: 'Standart', guessed: false });
    // Başlık versiyon söylemiyorsa kategori şüpheli: fiyat modeli iki versiyondan uyanı seçer (analyze.resolveTrims)
    else trimAlt = guessed ? ['Premium', 'Standart'] : ['Standart', 'Premium'];
  } else if (model === 'Model Y' && generation === 'Juniper' && guessed) {
    trimAlt = ['Standart', 'Long Range RWD'];
  }
  const { tags, warnings } = detectTags(`${l.title || ''} ${l.description || ''}`);
  // Açıklamadaki hasar ifadeleri: ilanın yapılandırılmış alanları (ağır hasar Evet/Hayır, boya-değişen listesi)
  // daha güvenilir. Alan "Hayır" diyorsa açıklamadaki "ağır hasar" yalnızca not olarak gösterilir.
  const notes = [];
  if (l.description) {
    const fromTitle = detectTags(l.title || '').warnings;
    for (const w of warnings.filter((x) => !fromTitle.includes(x))) {
      const structured = w === 'Ağır hasar kayıtlı' ? l.damage?.heavy === false : !!l.damage?.summary;
      if (!structured) continue;
      warnings.splice(warnings.indexOf(w), 1);
      notes.push(w === 'Ağır hasar kayıtlı'
        ? 'Açıklamada "ağır hasar" geçiyor ama ilanın Ağır Hasar Kayıtlı alanı "Hayır" – açıklamayı okuyun'
        : `Açıklamada "${w}" geçiyor – boya/değişen listesini kontrol edin`);
    }
  }
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
    trimGuessed: guessed || undefined,
    trimAlt,
    segment: `${model} · ${generation} · ${trim}`,
    kmBand,
    tags,
    warnings: [...new Set(warnings)],
    notes: notes.length ? notes : undefined,
  };
}
