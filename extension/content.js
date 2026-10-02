// sahibinden sayfasındaki ilan tablosunu okur ve arka plan betiğine iletir. Sayfada hiçbir şeye tıklamaz.
(() => {
  const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => {});

  if (/\/cs\/|tloading/.test(location.pathname) || document.body.innerText.includes('Tarayıcınızı kontrol ediyoruz')) {
    send({ type: 'challenge', url: location.href });
    return;
  }
  if (!/tesla/i.test(location.pathname)) return;

  const read = () => {
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
        title: (a && (a.getAttribute('title') || a.innerText) || '').trim(),
        image: img ? img.getAttribute('data-src') || img.getAttribute('src') : null,
        store: !!tr.querySelector('.store-icon'),
        cells: [...tr.querySelectorAll('td')].map((td) => ({ cls: td.className, text: td.innerText.trim() })),
      };
    });
    const total = Number((document.querySelector('.result-text')?.innerText.match(/([\d.]+)\s*ilan/) || [])[1]?.replace(/\./g, '')) || null;
    send({ type: 'page', url: location.href, heads, rows, total });
    return true;
  };
  if (!read()) setTimeout(read, 2500);
})();
