// Sayfa içeriğini okuyup arka plan betiğine iletir. Sayfada hiçbir şeye tıklamaz, form doldurmaz.
// Yalnızca eklentinin kendi sabitlenmiş sekmesindeki sayfalar ajana gönderilir (arka plan kontrol eder).
(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  // Büyük sayfa gönderilemezse küçük bir tanı mesajıyla ajana bildir
  // Bu sürümün okuyabildiği sayfa türleri: ajan detay sayfalarını yalnızca destekleyen eklentiye ister
  const CAPS = ['sahibindenDetail'];
  const send = (msg) => api.runtime.sendMessage({ ...msg, url: location.href, caps: CAPS }).catch((e) =>
    api.runtime.sendMessage({ type: 'diag', where: 'content', error: `${host} ${msg.kind || ''} ${Math.round(JSON.stringify(msg).length / 1024)} KB gönderilemedi: ${e && e.message}` }).catch(() => {}));
  const host = location.host;
  const isChallenge = () =>
    /\/cs\/|tloading/.test(location.pathname) ||
    /just a moment|bir dakika|tarayıcınızı kontrol/i.test(document.title + ' ' + (document.body?.innerText || '').slice(0, 300));

  function sahibinden() {
    const table = document.querySelector('#searchResultsTable');
    if (!table) return false;
    const heads = [...table.querySelectorAll('thead td, thead th')].map((t) => t.innerText.trim());
    const rows = [...table.querySelectorAll('tbody tr.searchResultsItem[data-id]')].map((tr) => {
      const a = tr.querySelector('a.classifiedTitle') || tr.querySelector('a[href*="/ilan/"]');
      const img = tr.querySelector('img');
      return {
        id: tr.getAttribute('data-id'),
        currency: tr.getAttribute('data-currency'),
        href: a ? a.getAttribute('href') : null,
        title: ((a && (a.getAttribute('title') || a.innerText)) || '').trim(),
        image: img ? img.getAttribute('data-src') || img.getAttribute('src') : null,
        // Satırdaki ilk görsel bazen "çok fotoğraflı" simgesi olabiliyor; tümünü gönder, ajan seçsin
        images: [
          ...[...tr.querySelectorAll('img, source')].flatMap((e) => [e.getAttribute('data-src'), e.getAttribute('src'), (e.getAttribute('srcset') || '').split(' ')[0]]),
          // Vitrin ilanlarında fotoğraf <img> değil; arka plan stili veya data- özelliğinde olabiliyor
          ...(tr.innerHTML.match(/https?:\/\/[^"'()\s]+?\/photos\/[^"'()\s]+?\.(?:jpe?g|webp|avif)/gi) || []),
          ...[...tr.querySelectorAll('[style*="background"]')].map((e) => (getComputedStyle(e).backgroundImage.match(/url\(["']?([^"')]+)/) || [])[1]),
        ].filter(Boolean),
        store: !!tr.querySelector('.store-icon'),
        imgHtml: (tr.querySelector('td.searchResultsLargeThumbnail') || tr.querySelector('td'))?.innerHTML.replace(/\s+/g, ' ').slice(0, 1500),
        cells: [...tr.querySelectorAll('td')].map((td) => ({ cls: td.className, text: td.innerText.trim() })),
      };
    });
    const total = Number((document.querySelector('.result-text')?.innerText.match(/([\d.]+)\s*ilan/) || [])[1]?.replace(/\./g, '')) || null;
    send({ kind: 'sahibinden', heads, rows, total });
    return true;
  }

  // İlan detay sayfası: özellik listesi (Ağır Hasar Kayıtlı, Çekiş, Kimden…), açıklama, boya/değişen bilgisi.
  // Sayfa düzeni değişebileceği için birkaç yoldan okunur; ajan ilk sayfalarda neyin bulunduğunu kaydına yazar.
  const detailId = () => (location.pathname.match(/\/ilan\/.*?(\d{9,})\/detay/) || [])[1];
  const clean = (t) => (t || '').replace(/[ \t ]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
  const LABELS = new Map(['İlan No', 'Marka', 'Seri', 'Model', 'Yıl', 'Yakıt Tipi', 'Vites', 'Araç Durumu', 'KM', 'Kasa Tipi',
    'Motor Gücü', 'Çekiş', 'Renk', 'Garanti', 'Ağır Hasar Kayıtlı', 'Ağır Hasarlı', 'Kimden', 'Takas', 'Menzil', 'Ortalama Menzil',
    'Batarya Kapasitesi', 'Pil Kapasitesi', 'Tramer', 'Tramer Tutarı'].map((k) => [k.toLocaleLowerCase('tr-TR'), k]));

  // Okunamayan detay sayfası için tanı: "Ağır hasar" yazısının çevresindeki HTML ve ilgili sınıf adları
  function detailDiag() {
    const hit = [...document.body.querySelectorAll('*')].find((e) => !e.childElementCount && /ağır hasar|çekiş|kimden/i.test(e.textContent) && e.textContent.length < 60);
    let box = hit;
    for (let i = 0; i < 4 && box?.parentElement; i++) { box = box.parentElement; if (box.childElementCount >= 4) break; }
    const classes = [...new Set([...document.querySelectorAll('[class]')].flatMap((e) => String(e.className?.baseVal ?? e.className).split(/\s+/))
      .filter((c) => /classified|info|detail|attr|feature|spec|damage|desc|propert/i.test(c)))].slice(0, 40);
    return { hit: hit ? hit.outerHTML.slice(0, 200) : null, html: box ? box.outerHTML.replace(/\s+/g, ' ').slice(0, 1500) : null, classes, mobile: innerWidth < 800 };
  }

  function sahibindenDetail() {
    const id = detailId();
    if (!id) return false;
    const props = {};
    for (const li of document.querySelectorAll('.classifiedInfoList li, .classifiedInfo ul li')) {
      const k = clean(li.querySelector('strong, .label, dt')?.textContent).replace(/:$/, '');
      const v = clean(li.querySelector('span, .value, dd')?.textContent);
      if (k && k.length < 40 && !(k in props)) props[k] = v.slice(0, 100);
    }
    // Düzenden bağımsız yol: bilinen etiket metnini taşıyan öğenin yanındaki değer
    // (ör. <div>Ağır Hasar Kayıtlı</div><div>Hayır</div>, <dt>Çekiş</dt><dd>Arkadan İtiş</dd>)
    for (const el of document.body.querySelectorAll('*')) {
      if (el.childElementCount || /^(SCRIPT|STYLE|OPTION|A|BUTTON)$/.test(el.tagName)) continue;
      const label = clean(el.textContent).replace(/:$/, '');
      const key = label.length < 30 && LABELS.get(label.toLocaleLowerCase('tr-TR'));
      if (!key || key in props) continue;
      let v = clean(el.nextElementSibling?.textContent);
      const pt = clean(el.parentElement?.textContent);
      if (!v && pt.startsWith(label) && pt.length < label.length + 100) v = pt.slice(label.length);
      if (!v) v = clean(el.parentElement?.nextElementSibling?.textContent);
      v = v.replace(/^:\s*/, '');
      if (v && v.length < 100) props[key] = v;
    }
    if (Object.keys(props).length < 2 && !props['Ağır Hasar Kayıtlı']) return false;
    const descEl = [...document.querySelectorAll('#classifiedDescription, .classifiedDescription, [id*="escription" i], [class*="escription" i]')]
      .sort((a, b) => (b.innerText || '').length - (a.innerText || '').length)[0];
    const desc = clean(descEl?.innerText).slice(0, 3000);
    // Boya / değişen: "Orijinal / Lokal Boyalı / Boyalı / Değişmiş" başlıklı parça listeleri
    const LABEL = /^(orijinal|orjinal|lokal boyal[ıi]|boyal[ıi]|de[ğg]i[şs]mi[şs]|de[ğg]i[şs]en|belirtilmemi[şs])( par[çc]alar)?\s*:?$/i;
    const damage = [];
    for (const el of document.querySelectorAll('h2, h3, h4, h5, strong, b, dt, span, p, li, div')) {
      if (el.childElementCount > 1) continue;
      const label = clean(el.textContent);
      if (!label || label.length > 30 || !LABEL.test(label)) continue;
      const sib = el.nextElementSibling;
      const list = sib && sib.matches('ul, ol, dd, div, p') ? sib : el.parentElement?.querySelector('ul, ol');
      const items = list ? [...new Set([...list.querySelectorAll('li')].map((x) => clean(x.textContent)).filter((t) => t && t.length < 40))] : [];
      const text = !items.length && list ? clean(list.textContent).slice(0, 200) : '';
      damage.push({ label, items: items.slice(0, 20), text });
      if (damage.length >= 12) break;
    }
    // Parça şeması: hasar bölümündeki öğelerin sınıf adları (ör. "painted", "changed") – tanı ve yedek okuma için
    const box = document.querySelector('[class*="damage" i], [id*="damage" i], [class*="car-part" i], [class*="boya" i]');
    const parts = box ? [...box.querySelectorAll('[class]')].slice(0, 80)
      .map((e) => ({ cls: String(e.className?.baseVal ?? e.className).slice(0, 60), text: clean(e.getAttribute('title') || e.textContent).slice(0, 40) }))
      .filter((p) => /paint|boya|chang|degis|değiş|local|lokal|orig|orij/i.test(p.cls)) : [];
    send({ kind: 'sahibindenDetail', detail: {
      id, props, desc, damage, parts: parts.slice(0, 40),
      sample: box ? { cls: String(box.className?.baseVal ?? box.className).slice(0, 80), text: clean(box.textContent).slice(0, 400) } : null,
    } });
    return true;
  }

  function arabam() {
    // Sayfanın tamamı (~1,3 MB) yerine yalnızca gereken parçalar: ilan satırları veya detay verisi
    // Liste satırları sayfada ayrıştırılır; yalnızca gerekli alanlar gönderilir (~25 KB).
    // (Tüm satır HTML'i ~360 KB; Android'deki Firefox bu büyüklükteki mesajları sessizce düşürüyor.)
    const rows = [...document.querySelectorAll('tr.listing-list-item[id^="listing"]')];
    const cards = rows.length ? [] : [...document.querySelectorAll('div.listing-list-item[id^="listing"]')];
    if (rows.length) {
      const arows = rows.map((tr) => {
        const img = tr.querySelector('img.listing-image');
        const a = tr.querySelector('a[href^="/ilan/"]');
        return {
          id: tr.getAttribute('data-imp-id') || tr.id.replace('listing', ''),
          href: a ? a.getAttribute('href') : '',
          modelName: (tr.querySelector('td.listing-modelname .listing-text-new')?.textContent || '').trim(),
          title: (tr.querySelector('.listing-title-lines')?.textContent || '').trim(),
          cells: [...tr.querySelectorAll('td')].map((td) => td.textContent.replace(/\s+/g, ' ').trim().slice(0, 200)),
          priceText: tr.querySelector('.listing-price')?.textContent || '',
          locs: [...tr.querySelectorAll('span[title]')].map((sp) => sp.getAttribute('title')),
          image: img ? img.getAttribute('data-src') || img.getAttribute('src') : null,
        };
      });
      send({ kind: 'arabam', arows });
      return true;
    }
    if (cards.length) {
      // Mobil düzen (Android'de arabam tablo yerine kart gösteriyor): model adresten, yıl/km detaydan gelir
      const arows = cards.map((d) => {
        const img = d.querySelector('img');
        const a = d.querySelector('a[href^="/ilan/"]');
        return {
          mobile: true,
          id: d.getAttribute('data-imp-id') || d.id.replace('listing', ''),
          href: a ? a.getAttribute('href') : '',
          modelName: '',
          title: (d.querySelector('h3')?.textContent || '').replace(/\s+/g, ' ').trim(),
          cells: [],
          priceText: d.querySelector('.listing-price')?.textContent || '',
          locs: (d.querySelector('.listing-location span')?.textContent || '').split(',').map((x) => x.trim()).filter(Boolean),
          image: img ? img.getAttribute('data-src') || img.getAttribute('src') : null,
        };
      });
      send({ kind: 'arabam', arows });
      return true;
    }
    const scripts = [...document.scripts].map((sc) => sc.textContent).filter((t) => /DamageInfo|"Key":"Marka"/.test(t));
    if (scripts.length) {
      send({ kind: 'arabam', html: scripts.join('\n') });
      return true;
    }
    return false;
  }

  function borusan() {
    const nd = document.getElementById('__NEXT_DATA__');
    if (!nd) return false;
    send({ kind: 'borusan', nextData: nd.textContent });
    return true;
  }

  const readers = { 'www.sahibinden.com': () => sahibinden() || sahibindenDetail(), 'www.arabam.com': arabam, 'borusannext.com': borusan };
  const read = readers[host];
  if (!read) return;

  // arabam için adım adım tanı (yalnızca küçük metin mesajları; sorun çözülünce kaldırılabilir)
  const diag = (t) => host === 'www.arabam.com' && api.runtime.sendMessage({ type: 'diag', where: 'arabam', error: t }).catch(() => {});
  diag(`betik çalıştı: ${location.href.slice(0, 90)} durum=${document.readyState} satır=${document.querySelectorAll('.listing-list-item').length}`);

  // Sitenin "olağan dışı erişim" engel sayfası: beklemeden bildir, ajan o siteyi saatlerce bekletir
  if (/olağan\s*dışı\s*erişim|olağandışı erişim|unusual (traffic|access)/i.test((document.body?.innerText || '').slice(0, 2000))) {
    send({ challenge: true, blocked: true });
    return;
  }

  let tries = 0;
  const attempt = () => {
    if (isChallenge()) {
      // Cloudflare'in otomatik kontrolü birkaç saniyede kendiliğinden geçer; geçmezse bildir
      if (tries === 0) diag(`doğrulama sanıldı: başlık="${document.title.slice(0, 60)}" metin="${(document.body?.innerText || '').slice(0, 120).replace(/\s+/g, ' ')}"`);
      if (++tries <= 6) return setTimeout(attempt, 3000);
      send({ challenge: true });
      return;
    }
    const ok = read();
    if (ok) { diag('okundu ve gönderildi'); return; }
    if (++tries <= 6) setTimeout(attempt, 2500);
    // Detay sayfası okunamadı (ilan kalkmış, düzen değişmiş): ajan beklemesin, başlığı tanı için gönder
    else if (host === 'www.sahibinden.com' && detailId()) send({ kind: 'sahibindenDetail', detail: { id: detailId(), empty: true, title: document.title.slice(0, 120), diag: detailDiag() } });
    else diag(`okunamadı: satır=${document.querySelectorAll('.listing-list-item').length} tr=${document.querySelectorAll('tr').length} başlık="${document.title.slice(0, 60)}"`);
  };
  attempt();
})();
