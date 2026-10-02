// Sayfa içeriğini okuyup arka plan betiğine iletir. Sayfada hiçbir şeye tıklamaz, form doldurmaz.
// Yalnızca eklentinin kendi sabitlenmiş sekmesindeki sayfalar ajana gönderilir (arka plan kontrol eder).
(() => {
  const send = (msg) => chrome.runtime.sendMessage({ ...msg, url: location.href }).catch(() => {});
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
        store: !!tr.querySelector('.store-icon'),
        cells: [...tr.querySelectorAll('td')].map((td) => ({ cls: td.className, text: td.innerText.trim() })),
      };
    });
    const total = Number((document.querySelector('.result-text')?.innerText.match(/([\d.]+)\s*ilan/) || [])[1]?.replace(/\./g, '')) || null;
    send({ kind: 'sahibinden', heads, rows, total });
    return true;
  }

  function arabam() {
    if (!document.querySelector('tr.listing-list-item, .product-properties, #classifiedDetail') && !/DamageInfo/.test(document.documentElement.innerHTML)) return false;
    send({ kind: 'arabam', html: document.documentElement.outerHTML });
    return true;
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
