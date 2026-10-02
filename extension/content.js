// Sayfa içeriğini okuyup arka plan betiğine iletir. Sayfada hiçbir şeye tıklamaz, form doldurmaz.
// Yalnızca eklentinin kendi sabitlenmiş sekmesindeki sayfalar ajana gönderilir (arka plan kontrol eder).
(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  const send = (msg) => api.runtime.sendMessage({ ...msg, url: location.href }).catch(() => {});
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

  function arabam() {
    // Sayfanın tamamı (~1,3 MB) yerine yalnızca gereken parçalar: ilan satırları veya detay verisi
    const rows = [...document.querySelectorAll('tr.listing-list-item')];
    if (rows.length) {
      send({ kind: 'arabam', html: `<table><tbody>${rows.map((r) => r.outerHTML).join('')}</tbody></table>` });
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

  const readers = { 'www.sahibinden.com': sahibinden, 'www.arabam.com': arabam, 'borusannext.com': borusan };
  const read = readers[host];
  if (!read) return;

  // Sitenin "olağan dışı erişim" engel sayfası: beklemeden bildir, ajan o siteyi saatlerce bekletir
  if (/olağan\s*dışı\s*erişim|olağandışı erişim|unusual (traffic|access)/i.test((document.body?.innerText || '').slice(0, 2000))) {
    send({ challenge: true, blocked: true });
    return;
  }

  let tries = 0;
  const attempt = () => {
    if (isChallenge()) {
      // Cloudflare'in otomatik kontrolü birkaç saniyede kendiliğinden geçer; geçmezse bildir
      if (++tries <= 6) return setTimeout(attempt, 3000);
      send({ challenge: true });
      return;
    }
    if (!read() && ++tries <= 6) setTimeout(attempt, 2500);
  };
  attempt();
})();
