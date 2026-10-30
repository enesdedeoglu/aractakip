// Chrome eklentisi köprüsü.
// Eklenti, kullanıcının kendi Chrome'unda tek bir sabitlenmiş sekme kullanır: ajandan sıradaki adresi
// ister (GET /next), sekmede açar, sayfa içeriğini geri gönderir (POST /page). Hangi sayfanın ne zaman
// açılacağına ve sayfaların nasıl işleneceğine burada karar verilir.
import { parseList as parseArabamList, fromRows as arabamFromRows, parseDetail as parseArabamDetail, kmFromTitle } from './sources/arabam.js';
import { parseNextData as parseBorusan, toListing as borusanListing } from './sources/borusan.js';
import { normalize as normalizeSahibinden, pickImage, isFakeRow, parseDetail as parseSahibindenDetail, detailSummary } from './sources/sahibinden.js';
import { log } from './util.js';

const MIN = 60000;
const SAH = 'https://www.sahibinden.com/tesla?pagingSize=50&sorting=date_desc';
// sahibinden arama filtresi "Ağır Hasar Kayıtlı: Evet" (a116445=1263353)
const SAH_HEAVY = `${SAH}&a116445=1263353`;
const ARB = 'https://www.arabam.com/ikinci-el/otomobil?searchText=tesla&take=50';
const BOR = 'https://borusannext.com/araba-al/tesla';

/**
 * @param opts.onScan (scan) => Promise   – tamamlanan taramayı veritabanına işler
 * @param opts.needDetail (source) => string[]  – detay bilgisi eksik ilan adresleri ('arabam' | 'sahibinden')
 * @param opts.onChallenge (url) => void
 */
/**
 * @param opts.shared (source) => { lastOk, lastFull, blockedUntil, blockCount, lastBlockAt } – ortak kayıttan
 *        (tüm cihazlar + ajan yeniden başlasa bile geçerli zamanlama)
 */
export function createBridge({ onScan, needDetail, onChallenge, shared = () => ({}), runner = 'local', version = 0, primary = null, intervals = {} }) {
  const iv = {
    sahibinden: 15, sahibindenFull: 1440, sahibindenHeavy: 720,
    arabam: 5, arabamFull: 120,
    borusan: 10,
    // sahibinden ilan detayı: yalnızca yeni ve değerlendirmesi detaya bağlı ilanlar, seyrek ve günlük sınırlı
    sahibindenDetail: 6, sahibindenDetailPerDay: 80,
    gap: 0.75,     // iki sayfa açılışı arasındaki en kısa süre (dk)
    crawlGap: 1,   // tam taramada sayfalar arası en kısa süre (dk)
    ...intervals,
  };
  const last = {};          // görev adı -> son çalışma zamanı
  let crawl = null;         // süren çok sayfalı tarama { source, pages, nextUrl, started }
  let inflight = null;      // { url, task, at }
  let lastNav = 0;
  let lastSeen = 0;         // eklentinin son bağlantısı
  let detailQueue = [];
  const failedDetail = new Set();
  const requested = new Map();
  let loggedNoImg = 0; // fotoğrafsız satır tanısı yalnızca bir kez yazılsın
  let caps = new Set();     // eklentinin okuyabildiği sayfa türleri (eski eklenti detay sayfası okuyamaz)
  const detailTimes = [];   // son 24 saatte açılan sahibinden detay sayfaları
  let detailDiag = 0;       // ilk detay sayfalarında bulunanlar tanı için kayda yazılır
  let detailFails = 0;      // üst üste okunamayan detay sayfası
  let arabamDiag = 0;       // arabam detayındaki hasar alanları (parça listesi var mı) tanı için kayda yazılır
  let detailPausedUntil = 0;
  let extVersion = null;     // eklentinin bildirdiği sürüm (eski eklenti bildirmez)

  // Görev zamanı geldi mi? Ortak kayıttaki son tarama (hangi cihaz yaptıysa) ve engel süresi de dikkate alınır.
  // Aralıklar ±%15 oynatılır ki istekler saat gibi düzenli olmasın.
  const SOURCE_OF = { arabam: 'arabam', arabamFull: 'arabam', sahibinden: 'sahibinden', sahibindenFull: 'sahibinden', sahibindenHeavy: 'sahibinden', sahibindenDetail: 'sahibinden', borusan: 'borusan' };
  const jitter = {};
  const timeouts = {};
  const pausedUntil = {};
  const fullPausedUntil = {};
  const due = (task, every) => {
    const span = every * MIN * (jitter[task] ??= 0.85 + Math.random() * 0.3);
    if (Date.now() - (last[task] || 0) < span) return false;
    const src = SOURCE_OF[task];
    if (src) {
      if ((pausedUntil[src] || 0) > Date.now()) return false;
      if (task.endsWith('Full') && (fullPausedUntil[src] || 0) > Date.now()) return false;
      const st = shared(src) || {};
      // Engel o siteyi engelli gören cihaza özel (ör. Mac'teki tarayıcı oturumu); eski ortak kayıt da geçerli
      if (Date.parse(st.blocks?.[runner]) > Date.now() || Date.parse(st.blockedUntil) > Date.now()) return false;
      const at = Date.parse(task.endsWith('Full') ? st.lastFull : task.endsWith('Heavy') ? st.lastHeavy : task.endsWith('Detail') ? st.lastDetail : st.lastOk);
      if (Number.isFinite(at) && Date.now() - at < span) { last[task] = at; return false; }
      // Asıl tarayıcı (ör. 7/24 açık tablet) bu siteyi son 3 tur içinde taradıysa diğer cihazlar girmez;
      // asıl tarayıcı kapanırsa 3 tur sonra yedek cihaz devralır
      if (primary && runner !== primary) {
        const pr = st.runs?.[primary];
        // Ortak kayıt en sık ~10 dk'da bir yazıldığı için pencere en az 30 dk (kısa aralıklı sitelerde yanlış devralmayı önler)
        if (pr && Date.now() - Date.parse(pr.lastRun) < Math.max(3 * every, 30) * MIN) return false;
      }
      // Sahiplik: siteyi başka bir cihaz düzenli tarıyorsa ona bırak; 3 tur taramazsa devral.
      // O cihaz daha eski kodla çalışıyorsa (ör. güncellenmemiş tablet) güncel cihaz devralır.
      // Asıl tarayıcı başkasının sahipliğini beklemez.
      const okAt = Date.parse(st.lastOk);
      const owner = st.lastOkRunner;
      const ownerOutdated = version > (st.runs?.[owner]?.v || 0);
      if (runner !== primary && owner && owner !== runner && !ownerOutdated && Number.isFinite(okAt) && Date.now() - okAt < 3 * every * MIN) return false;
    }
    jitter[task] = 0.85 + Math.random() * 0.3;
    return true;
  };

  // Site "olağan dışı erişim" engeli koyduysa o siteyi saatlerce hiç deneme (3 → 6 → 12 → 24 saat)
  function block(source, reason) {
    const st = shared(source) || {};
    const prev = st.blockInfo?.[runner] || {};
    const recent = Date.now() - Date.parse(prev.at || 0) < 24 * 60 * MIN;
    const count = recent ? (prev.count || 0) + 1 : 1;
    const hours = Math.min(24, 3 * 2 ** (count - 1));
    const until = new Date(Date.now() + hours * 60 * MIN).toISOString();
    log(`⛔ ${source}: ${reason} – ${hours} saat beklenecek`);
    onChallenge?.(`https://${source}`, { blocked: true, hours });
    if (crawl?.source === source) crawl = null;
    return onScan({ source, ok: false, error: `${reason} (${hours} saat bekleniyor)`, listings: [], complete: false, mode: 'blocked', blockedUntil: until, blockCount: count });
  }

  // Aynı detay sayfası bir saat içinde tekrar istenmesin (kayıt henüz yazılmamış olabilir)
  const freshDetail = (u) => !failedDetail.has(u) && Date.now() - (requested.get(u) || 0) > 60 * MIN;

  // Okuyucu sayfa düzenine uymuyorsa boşuna sahibinden ziyareti olmasın: 3 başarısızlıktan sonra 12 saat ara
  function detailFailed(why) {
    if (++detailFails < 3) return;
    detailFails = 0;
    detailPausedUntil = Date.now() + 12 * 60 * MIN;
    log(`⏸ sahibinden detay: üst üste 3 sayfa okunamadı (${why}) – bu cihazda 12 saat detay okunmayacak`);
  }

  function nextSahibindenDetail() {
    // 2.2.2 öncesi eklentilerin detay okuyucusu güncel sahibinden sayfasını tanımıyor (sürüm de bildirmiyorlar)
    if (!caps.has('sahibindenDetail') || !extVersion || detailPausedUntil > Date.now()) return null;
    while (detailTimes.length && Date.now() - detailTimes[0] > 24 * 60 * MIN) detailTimes.shift();
    if (detailTimes.length >= iv.sahibindenDetailPerDay) return null;
    return needDetail('sahibinden', extVersion).find(freshDetail) || null;
  }

  function next() {
    lastSeen = Date.now();
    // Önceki sayfa bekleniyor (eski tabletlerde büyük sayfalar 1-2 dk sürebiliyor)
    if (inflight && Date.now() - inflight.at < (iv.pageTimeout || 2.5) * MIN) return null;
    if (inflight?.task === 'sahibindenDetail') {
      // Detay sayfası yanıt vermedi: o ilanı bir daha isteme, ama siteyi durdurma (liste taraması sürsün)
      log(`eklenti: sahibinden detay zaman aşımı (${inflight.url})`);
      failedDetail.add(inflight.url);
      last.sahibindenDetail = Date.now();
      inflight = null;
      detailFailed('zaman aşımı');
    }
    if (inflight) {
      log(`eklenti: ${inflight.task} zaman aşımı`);
      const wasCrawl = inflight.task === 'crawl';
      const src = wasCrawl ? crawl?.source : SOURCE_OF[inflight.task];
      if (crawl && wasCrawl) { last[crawl.source] = Date.now(); crawl = null; }
      else last[inflight.task] = Date.now();
      inflight = null;
      if (wasCrawl && src) {
        // Tam tarama yanıt vermediyse yalnızca tam taramayı ertele; hızlı tarama (yeni ilanlar) sürsün
        fullPausedUntil[src] = Date.now() + 6 * 60 * MIN;
        log(`⏸ ${src}: tam tarama yanıt vermedi – bu cihazda 6 saat ertelendi, hızlı tarama devam ediyor`);
      } else if (src) {
        // Sayfa üst üste cevap vermiyorsa bu cihazda o siteyi 1 saat beklet (yalnızca yerel: sebep cihazın
        // yavaşlığı da olabilir; ortak engel yalnızca sitenin engel sayfası görülünce konur)
        timeouts[src] = (timeouts[src] || 0) + 1;
        if (timeouts[src] >= 2) {
          timeouts[src] = 0;
          pausedUntil[src] = Date.now() + 60 * MIN;
          log(`⏸ ${src}: üst üste yanıt alınamadı – bu cihazda 1 saat beklenecek`);
        }
      }
    }
    if (Date.now() - lastNav < iv.gap * MIN) return null;
    if (crawl?.nextUrl && Date.now() - lastNav < iv.crawlGap * MIN) return null;

    let pick = null;
    let sahDetail = null;
    if (crawl && crawl.nextUrl) pick = { task: 'crawl', url: crawl.nextUrl };
    else if (due('arabam', iv.arabam)) pick = due('arabamFull', iv.arabamFull)
      ? (crawl = { source: 'arabam', pages: [], page: 1, emptyStreak: 0, nextUrl: ARB, started: Date.now() }, { task: 'crawl', url: ARB })
      : { task: 'arabam', url: `${ARB}&sort=startedAt.desc` };
    else if (due('sahibinden', iv.sahibinden)) pick = due('sahibindenFull', iv.sahibindenFull)
      ? (crawl = { source: 'sahibinden', pages: [], offset: 0, nextUrl: SAH, started: Date.now() }, { task: 'crawl', url: SAH })
      : { task: 'sahibinden', url: SAH };
    else if (due('sahibindenHeavy', iv.sahibindenHeavy)) pick = { task: 'sahibindenHeavy', url: SAH_HEAVY };
    else if (due('borusan', iv.borusan)) pick = { task: 'borusan', url: BOR };
    else if ((sahDetail = nextSahibindenDetail()) && due('sahibindenDetail', iv.sahibindenDetail)) {
      requested.set(sahDetail, Date.now());
      detailTimes.push(Date.now());
      pick = { task: 'sahibindenDetail', url: sahDetail };
    } else {
      if (!detailQueue.length) detailQueue = needDetail('arabam').filter(freshDetail).slice(0, 10);
      const u = detailQueue.shift();
      if (u) { requested.set(u, Date.now()); pick = { task: 'arabamDetail', url: u }; }
    }
    if (!pick) return null;
    if (pick.task === 'crawl') crawl.nextUrl = null;
    inflight = { ...pick, at: Date.now() };
    lastNav = Date.now();
    return pick.url;
  }

  async function page({ url, kind, html, arows, nextData, heads, rows, total, challenge, blocked, login, detail, caps: c, ev }) {
    lastSeen = Date.now();
    if (Array.isArray(c)) caps = new Set(c);
    if (ev && ev !== extVersion) {
      // Yeni eklenti kuruldu: önceki okuma hataları eski sürüme aitti, detay okumaya baştan başla
      if (extVersion || detailPausedUntil) log(`eklenti sürümü ${extVersion || '?'} → ${ev}: sahibinden detay okuma sıfırlandı`);
      else log(`eklenti sürümü: ${ev}`);
      extVersion = ev;
      detailFails = 0;
      detailPausedUntil = 0;
      failedDetail.clear();
      requested.clear();
    }
    const task = inflight?.task;
    const hostSrc = /sahibinden/.test(url) ? 'sahibinden' : /arabam/.test(url) ? 'arabam' : /borusan/.test(url) ? 'borusan' : null;
    if (hostSrc) timeouts[hostSrc] = 0;
    if (blocked && hostSrc) {
      if (task) last[task] = Date.now();
      inflight = null;
      return block(hostSrc, 'site otomatik erişim engeli gösterdi');
    }
    const done = () => { if (task && task !== 'crawl') last[task] = Date.now(); inflight = null; };
    if (login && hostSrc) {
      // Oturum kapanmış (site giriş sayfasına yönlendirdi): bu cihazda o siteyi 1 saat deneme, kullanıcıya haber ver
      pausedUntil[hostSrc] = Date.now() + 60 * MIN;
      if (crawl?.source === hostSrc) crawl = null;
      if (task) last[task] = Date.now();
      inflight = null;
      return onChallenge?.(url, { login: true });
    }
    if (challenge) {
      onChallenge?.(url);
      // Doğrulama ekranında beklemeyelim: görevi ertele (kullanıcı geçince sonraki turda tekrar denenir)
      if (task === 'crawl' && crawl) { last[crawl.source] = last[`${crawl.source}Full`] = Date.now(); crawl = null; }
      else if (task) last[task] = Date.now();
      inflight = null;
      return;
    }
    const host = new URL(url).host;
    try {
      if (host.endsWith('sahibinden.com') && detail) {
        done();
        const id = String(detail.id || (url.match(/(\d{9,})\/detay/) || [])[1] || '');
        if (!id || detail.empty) {
          failedDetail.add(url);
          log(`sahibinden detay okunamadı (${id}): "${(detail.title || '').slice(0, 80)}"`);
          const dg = detail.diag;
          if (dg) {
            log(`sahibinden detay tanı: mobil=${dg.mobile} sınıflar=${(dg.classes || []).join(' ')} öğe=${dg.hit || '-'}`);
            log(`sahibinden detay tanı html: ${dg.html || '-'}`);
          }
          return detailFailed('düzen tanınmadı');
        }
        detailFails = 0;
        const parsed = parseSahibindenDetail(detail);
        log(`sahibinden detay ${id}: ${detailSummary(parsed)}`);
        if (detailDiag++ < 3) {
          log(`sahibinden detay tanı: alanlar=${Object.keys(detail.props || {}).join('|')} kutular=${(detail.descSources || []).join(' ')}`);
          log(`sahibinden detay tanı: hasar=${JSON.stringify(detail.damage || []).slice(0, 400)} şema=${JSON.stringify((detail.parts || []).slice(0, 6)).slice(0, 300)} kutu=${JSON.stringify(detail.sample || null).slice(0, 300)}`);
        }
        return onScan({ source: 'sahibinden', listings: [{ source: 'sahibinden', sourceId: id, ...parsed, detailEv: ev || extVersion || undefined, detailAt: new Date().toISOString() }], complete: false, mode: 'detail' });
      }
      if (host.endsWith('sahibinden.com') && rows) {
        const pg = { url, heads, rows };
        if (task === 'sahibindenDetail') {
          // Kalkmış ilanın adresi kategori listesine yönleniyor: o ilan tekrar istenmez (okuma hatası sayılmaz)
          failedDetail.add(inflight.url);
          log(`sahibinden detay: ilan listeye yönlendi, büyük ihtimalle kalkmış (${(inflight.url.match(/(\d{9,})\/detay/) || [])[1] || inflight.url})`);
        }
        if (task === 'sahibindenHeavy') {
          // Ağır hasar kayıtlı ilan listesi: buradakiler "kayıtlı", tek sayfaya sığdıysa diğerleri "kaydı yok"
          done();
          // Site filtreyi düşürüp (ör. doğrulama sonrası yönlendirme) normal listeyi gösterdiyse hiçbir ilan işaretlenmez
          if (!/[?&]a116445=1263353(&|$)/.test(url)) {
            log('sahibinden: ağır hasar filtresi sayfada yok, liste işaretlenmedi');
            return onScan({ source: 'sahibinden', listings: normalizeSahibinden([pg]), complete: false, mode: 'quick' });
          }
          const listings = normalizeSahibinden([pg]).map((l) => ({ ...l, damage: { ...l.damage, heavy: true } }));
          // Boş sayfa "hiç ağır hasarlı yok" sayılmaz; aksi halde tüm ilanlar "kaydı yok" görünür
          const heavyComplete = listings.length > 0 && rows.length < 50 && (!total || listings.length >= total * 0.9);
          return onScan({ source: 'sahibinden', listings, complete: false, mode: 'heavy', heavyIds: listings.map((l) => l.sourceId), heavyComplete });
        }
        if (task === 'crawl' && crawl?.source === 'sahibinden') {
          crawl.pages.push(pg);
          const more = rows.length >= 50 && crawl.offset + 50 < Math.min(total || 1000, 1000);
          inflight = null;
          if (more) { crawl.offset += 50; crawl.nextUrl = `${SAH}&pagingOffset=${crawl.offset}`; return; }
          const listings = normalizeSahibinden(crawl.pages);
          const complete = !total || listings.length >= total * 0.9;
          crawl = null;
          last.sahibinden = last.sahibindenFull = Date.now();
          return onScan({ source: 'sahibinden', listings, complete, mode: 'full' });
        }
        done();
        if (rows.length && !normalizeSahibinden([pg]).length) log('sahibinden: satırlar ayrıştırılamadı, başlıklar:', heads);
        const fakes = rows.filter(isFakeRow).length;
        if (fakes) log(`sahibinden: ${fakes} sahte (tuzak) ilan ayıklandı`);
        const noImg = rows.filter((r) => !isFakeRow(r) && !pickImage(r) && !/iconHasMegaPhoto|otherNoImage/.test(r.image || ''));
        if (noImg.length && !loggedNoImg++) log(`sahibinden: ${noImg.length} satırda fotoğraf bulunamadı, örnek:`, JSON.stringify({ id: noImg[0].id, image: noImg[0].image, images: noImg[0].images, imgHtml: noImg[0].imgHtml }).slice(0, 900));
        return onScan({ source: 'sahibinden', listings: normalizeSahibinden([pg]), complete: false, mode: 'quick' });
      }
      if (host.endsWith('arabam.com') && (html || arows)) {
        if (/\/ilan\//.test(new URL(url).pathname)) {
          done();
          const id = (url.match(/\/(\d+)(?:[?#].*)?$/) || [])[1];
          if (!id || !/DamageInfo|"Key":"Marka"/.test(html)) { failedDetail.add(url); return; }
          const detail = parseArabamDetail(html);
          if (arabamDiag++ < 2) {
            // Parça bazında boya/değişen bilgisi sayfada var mı: ilgili JSON anahtarları ve özellik adları
            const keys = [...new Set([...html.matchAll(/"([A-Za-z]*(?:Part|Damage|Paint|Chang|Expert|Boya|Degis)[A-Za-z]*)"\s*:/gi)].map((m) => m[1]))].slice(0, 30);
            const props = [...new Set([...html.matchAll(/"Key":"([^"]+)"/g)].map((m) => m[1]))].slice(0, 40);
            const near = (html.match(/.{0,60}(?:Parts|Painted|Changed|Ekspertiz).{0,240}/) || [''])[0];
            log(`arabam detay tanı: anahtarlar=${keys.join(',')} özellikler=${props.join('|')}`);
            log(`arabam detay tanı örnek: ${near.slice(0, 300)}`);
          }
          return onScan({ source: 'arabam', listings: [{ source: 'arabam', sourceId: id, ...detail, detailAt: new Date().toISOString() }], complete: false, mode: 'detail' });
        }
        // Yeni eklenti satırları sayfada ayrıştırıp gönderir (küçük veri); eski sürüm tüm HTML'i
        const { listings, rowCount } = arows ? arabamFromRows(arows) : parseArabamList(html);
        listings.forEach((l) => { if (l.km == null) l.km = kmFromTitle(l.title); });
        if (task === 'crawl' && crawl?.source === 'arabam') {
          crawl.pages.push(...listings);
          crawl.emptyStreak = listings.length ? 0 : crawl.emptyStreak + 1;
          inflight = null;
          if (rowCount >= 50 && crawl.emptyStreak < 2 && crawl.page < 30) {
            crawl.page += 1; crawl.nextUrl = `${ARB}&page=${crawl.page}`; return;
          }
          const all = [...new Map(crawl.pages.map((l) => [l.sourceId, l])).values()];
          crawl = null;
          last.arabam = last.arabamFull = Date.now();
          return onScan({ source: 'arabam', listings: all, complete: all.length > 20, mode: 'full' });
        }
        done();
        return onScan({ source: 'arabam', listings, complete: false, mode: 'quick' });
      }
      if (host.endsWith('borusannext.com') && (nextData || html)) {
        done();
        const { datas } = parseBorusan(nextData || html);
        const listings = datas.filter((d) => /tesla/i.test(d.brand) && !d.isSold).map(borusanListing);
        // Tesla sayısı 12'yi geçerse (Borusan sayfa başına 12 gösteriyor) diğer sayfalar da eklenebilir
        return onScan({ source: 'borusan', listings, complete: true, mode: 'full' });
      }
      done();
    } catch (e) {
      log(`eklenti sayfası işlenemedi (${host}): ${e.message}`);
      if (task === 'crawl' && crawl) { last[crawl.source] = Date.now(); crawl = null; }
      done();
    }
  }

  const status = () => ({
    connected: Date.now() - lastSeen < 2 * MIN,
    lastSeen: lastSeen ? new Date(lastSeen).toISOString() : null,
    crawl: crawl ? { source: crawl.source, pages: crawl.pages.length } : null,
    inflight: inflight?.task || null,
    caps: [...caps],
    extVersion,
    sahibindenDetail24h: detailTimes.length,
    sahibindenDetailPausedUntil: detailPausedUntil > Date.now() ? new Date(detailPausedUntil).toISOString() : undefined,
    last: Object.fromEntries(Object.entries(last).map(([k, v]) => [k, new Date(v).toISOString()])),
  });

  return { next, page, status };
}
