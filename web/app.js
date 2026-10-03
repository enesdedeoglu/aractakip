/* Tesla İlan Takip – istemci uygulaması (bağımlılıksız) */
(() => {
  const POLL_MS = 60_000;
  const PAGE = 36;
  const DAY = 86400000;

  const SOURCE_NAMES = { arabam: 'arabam.com', sahibinden: 'sahibinden', otokoc: 'Otokoç', borusan: 'Borusan Next' };
  const RUNNER_NAMES = { cloud: 'bulut', local: 'bilgisayar', tablet: 'tablet' };
  const SELLER_NAMES = { sahibinden: 'Sahibinden', galeri: 'Galeri', kurumsal: 'Kurumsal', yetkili: 'Yetkili bayi' };
  const LABELS = ['Fırsat', 'İyi fiyat', 'Piyasa', 'Pahalı', 'Şüpheli', 'Veri az'];
  const LABEL_EMOJI = { 'Fırsat': '🔥', 'İyi fiyat': '👍', 'Piyasa': '⚖️', 'Pahalı': '💸', 'Şüpheli': '⚠️', 'Veri az': '·' };
  const MODEL_ORDER = ['Model Y', 'Model 3', 'Model S', 'Model X', 'Cybertruck', 'Roadster', 'Diğer'];

  const $ = (s) => document.querySelector(s);
  const el = (tag, attrs = {}, html = '') => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (v != null) e.setAttribute(k, v);
    }
    if (html) e.innerHTML = html;
    return e;
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const tl = (n) => (n == null ? '—' : `${Math.round(n).toLocaleString('tr-TR')} TL`);
  const tlShort = (n) => (n == null ? '—' : n >= 1e6 ? `${(n / 1e6).toLocaleString('tr-TR', { maximumFractionDigits: 2 })} M` : `${Math.round(n / 1000)} bin`);
  const kmFmt = (n) => (n == null ? 'km ?' : `${n.toLocaleString('tr-TR')} km`);
  const ago = (iso) => {
    if (!iso) return '—';
    const s = (Date.now() - Date.parse(iso)) / 1000;
    if (s < 60) return 'az önce';
    if (s < 3600) return `${Math.round(s / 60)} dk önce`;
    if (s < 86400) return `${Math.round(s / 3600)} sa önce`;
    return `${Math.round(s / 86400)} gün önce`;
  };

  // Görüntüleyiciye özel tercihler (favoriler, filtreler) – yalnızca bu tarayıcıda
  const store = {
    get(k, d) { try { const v = localStorage.getItem('tt:' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem('tt:' + k, JSON.stringify(v)); } catch { /* yoksay */ } },
  };

  const state = {
    db: null,
    listings: [],
    favs: new Set(store.get('favs', [])),
    seenKeys: null,
    shown: PAGE,
    f: Object.assign({
      model: null, q: '', sort: 'score', labels: [], gens: [], trims: [], sources: [], sellers: [], heavy: [],
      yMin: '', yMax: '', pMax: '', kMax: '', onlyNew: false, noDamage: false, hideReserved: false, onlyFav: false, showRemoved: false, dedupe: true, hideHeavy: true,
    }, store.get('filters', {})),
  };
  state.f.heavy ||= [];
  if (state.f.hideHeavy === undefined) state.f.hideHeavy = true;

  // ---------- Şifreli veri ve giriş ----------
  // Herkese açık sitede veri şifreli (data/db.enc.json). Şifreden türetilen anahtar bu cihazda saklanır;
  // şifrenin kendisi saklanmaz. Bilgisayardaki yerel arayüz (127.0.0.1) şifresiz veriyi sunar.
  const IS_LOCAL = /^(127\.0\.0\.1|localhost)$/.test(location.hostname);
  const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  let sessionKey = null; // { salt, key: CryptoKey }

  async function deriveKey(password, file) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: b64(file.salt), iterations: file.iter }, base, { name: 'AES-GCM', length: 256 }, true, ['decrypt']);
  }

  async function decryptFile(file, key) {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(file.iv) }, key, b64(file.data));
    const stream = new Blob([plain]).stream().pipeThrough(new DecompressionStream('gzip'));
    return JSON.parse(await new Response(stream).text());
  }

  async function savedKey(file) {
    try {
      const s = JSON.parse(localStorage.getItem('tt:key') || sessionStorage.getItem('tt:key') || 'null');
      if (!s || s.salt !== file.salt) return null;
      return crypto.subtle.importKey('raw', b64(s.k), { name: 'AES-GCM' }, true, ['decrypt']);
    } catch { return null; }
  }

  function askPassword(file) {
    return new Promise((resolve) => {
      $('#login').hidden = false;
      $('#loginPass').focus();
      $('#loginForm').onsubmit = async (e) => {
        e.preventDefault();
        $('#loginErr').textContent = '';
        $('#loginBtn').disabled = true;
        $('#loginBtn').textContent = 'Açılıyor…';
        try {
          const key = await deriveKey($('#loginPass').value, file);
          const db = await decryptFile(file, key); // yanlış şifrede burada hata verir
          const raw = toB64(await crypto.subtle.exportKey('raw', key));
          const rec = JSON.stringify({ salt: file.salt, k: raw });
          try { ($('#loginRemember').checked ? localStorage : sessionStorage).setItem('tt:key', rec); } catch { /* depolama kapalı */ }
          sessionKey = { salt: file.salt, key };
          $('#loginPass').value = '';
          $('#login').hidden = true;
          resolve(db);
        } catch {
          $('#loginErr').textContent = 'Şifre yanlış.';
        } finally {
          $('#loginBtn').disabled = false;
          $('#loginBtn').textContent = 'Giriş';
        }
      };
    });
  }

  async function fetchDb() {
    const t = `?t=${Date.now()}`;
    if (IS_LOCAL) return (await fetch(`data/db.json${t}`, { cache: 'no-store' })).json();
    const res = await fetch(`data/db.enc.json${t}`, { cache: 'no-store' });
    if (res.status === 404) return (await fetch(`data/db.json${t}`, { cache: 'no-store' })).json(); // şifrelemeye geçiş öncesi
    if (!res.ok) throw new Error(res.status);
    const file = await res.json();
    $('#logoutBtn').hidden = false;
    let key = sessionKey?.salt === file.salt ? sessionKey.key : await savedKey(file);
    if (key) {
      try { const db = await decryptFile(file, key); sessionKey = { salt: file.salt, key }; return db; }
      catch { try { localStorage.removeItem('tt:key'); sessionStorage.removeItem('tt:key'); } catch {} }
    }
    return askPassword(file);
  }

  function logout() {
    try { localStorage.removeItem('tt:key'); sessionStorage.removeItem('tt:key'); } catch {}
    sessionKey = null;
    location.reload();
  }

  // ---------- Veri ----------
  async function load(first = false) {
    if (!$('#login').hidden) return; // giriş bekleniyor
    try {
      const db = await fetchDb();
      const fresh = [];
      const keys = new Set(Object.keys(db.listings || {}));
      if (state.seenKeys) for (const k of keys) if (!state.seenKeys.has(k) && db.listings[k].status === 'active') fresh.push(db.listings[k]);
      state.seenKeys = keys;
      state.db = db;
      state.listings = Object.values(db.listings || {});
      $('#live').classList.remove('off');
      render();
      if (!first && fresh.length) announce(fresh);
    } catch (e) {
      $('#live').classList.add('off');
      if (first) $('#grid').innerHTML = `<div class="empty">Veri yüklenemedi (${esc(e.message)}). İlk tarama henüz tamamlanmamış olabilir.</div>`;
    }
  }

  function announce(fresh) {
    fresh.sort((a, b) => (b.a?.score ?? 0) - (a.a?.score ?? 0));
    for (const l of fresh.slice(0, 3)) {
      toast(`${LABEL_EMOJI[l.a?.label] || ''} <b>Yeni:</b> ${esc(l.c.model)} ${esc(l.c.trim)} ${l.year || ''} · ${tl(l.price)} · ${SOURCE_NAMES[l.source]} — <a href="${esc(l.url)}" target="_blank" rel="noopener">aç</a>`);
      if ('Notification' in window && Notification.permission === 'granted') {
        const n = new Notification(`Yeni Tesla: ${l.c.model} ${l.year || ''} · ${tl(l.price)}`, {
          body: `${l.a?.label || ''} · ${kmFmt(l.km)} · ${l.city || ''} · ${SOURCE_NAMES[l.source]}\n${l.a?.advice || ''}`,
          icon: l.image || undefined,
          tag: l.key,
        });
        n.onclick = () => window.open(l.url, '_blank');
      }
    }
    if (fresh.length > 3) toast(`+${fresh.length - 3} yeni ilan daha`);
    requestAnimationFrame(() => fresh.forEach((l) => document.querySelector(`[data-key="${CSS.escape(l.key)}"]`)?.classList.add('flash')));
    document.title = `(${fresh.length}) Tesla İlan Takip`;
  }

  function toast(html) {
    const t = el('div', { class: 'toast' }, html);
    $('#toasts').append(t);
    setTimeout(() => t.remove(), 9000);
  }

  // ---------- Filtreleme ----------
  const isNew = (l) => Date.now() - Date.parse(l.firstSeen) < DAY;
  // Ağır hasar kaydı: 'var' | 'yok' | 'bilinmiyor' — kayıttaki hesaplanmış değere güvenmeden ilanın (ve
  // farklı sitelerdeki aynı aracın) hasar bilgisinden hesaplanır
  function heavyOf(l) {
    const members = [l, ...(l.dup?.members || []).map((k) => state.db.listings[k]).filter(Boolean)];
    let known = false;
    for (const m of members) {
      const d = m.damage || {};
      if (d.heavy === true || (m.c?.warnings || []).includes('Ağır hasar kayıtlı')) return 'var';
      if (d.heavy === false || d.tramer === 0 || d.tramerRecord === false) known = true;
    }
    return known ? 'yok' : 'bilinmiyor';
  }
  const hasDamage = (l) => (l.c?.warnings?.length || 0) > 0 || l.damage?.heavy || (l.damage?.tramer || 0) > 0 || l.damage?.painted || l.damage?.changed;

  // Farklı sitelerdeki aynı araç tek kart: filtreye uyan üyelerden ana ilanı (yoksa ilk uyanı) tut
  function collapse(list) {
    if (!state.f.dedupe) return list;
    const out = new Map();
    for (const l of list) {
      const id = l.dup?.id || l.key;
      const cur = out.get(id);
      if (!cur || (l.dup?.primary && !cur.dup?.primary)) out.set(id, l);
    }
    return [...out.values()];
  }
  const isPrimary = (l) => !l.dup || l.dup.primary;

  function baseFiltered(ignore = '') {
    return collapse(rawFiltered(ignore));
  }

  function rawFiltered(ignore = '') {
    const f = state.f;
    const q = f.q.trim().toLocaleLowerCase('tr-TR');
    return state.listings.filter((l) => {
      if (!f.showRemoved && l.status !== 'active') return false;
      if (ignore !== 'model' && f.model && l.c.model !== f.model) return false;
      if (ignore !== 'labels' && f.labels.length && !f.labels.includes(l.a?.label)) return false;
      if (ignore !== 'gens' && f.gens.length && !f.gens.includes(l.c.generation)) return false;
      if (ignore !== 'trims' && f.trims.length && !f.trims.includes(l.c.trim)) return false;
      if (ignore !== 'sources' && f.sources.length && !f.sources.includes(l.source)) return false;
      if (ignore !== 'sellers' && f.sellers.length && !f.sellers.includes(l.sellerType || 'bilinmiyor')) return false;
      if (ignore !== 'heavy' && (f.heavy || []).length && !f.heavy.includes(heavyOf(l))) return false;
      if (f.yMin && (l.year || 0) < +f.yMin) return false;
      if (f.yMax && (l.year || 9999) > +f.yMax) return false;
      if (f.pMax && (l.price || 0) > +f.pMax) return false;
      if (f.kMax && l.km != null && l.km > +f.kMax) return false;
      if (f.onlyNew && !isNew(l)) return false;
      if (f.noDamage && hasDamage(l)) return false;
      if (f.hideHeavy && heavyOf(l) === 'var') return false;
      if (f.hideReserved && l.reserved) return false;
      if (f.onlyFav && !state.favs.has(l.key)) return false;
      if (q) {
        const hay = `${l.title} ${l.modelRaw} ${l.city} ${l.district} ${l.sellerName} ${l.c.segment} ${(l.c.tags || []).join(' ')}`.toLocaleLowerCase('tr-TR');
        if (!q.split(/\s+/).every((w) => hay.includes(w))) return false;
      }
      return true;
    });
  }

  const SORTS = {
    score: (a, b) => (b.a?.score ?? 0) - (a.a?.score ?? 0) || Date.parse(b.firstSeen) - Date.parse(a.firstSeen),
    new: (a, b) => Date.parse(b.publishedAt || b.firstSeen) - Date.parse(a.publishedAt || a.firstSeen),
    dev: (a, b) => (a.a?.deviation ?? 9) - (b.a?.deviation ?? 9),
    priceAsc: (a, b) => (a.price ?? 1e12) - (b.price ?? 1e12),
    priceDesc: (a, b) => (b.price ?? 0) - (a.price ?? 0),
    km: (a, b) => (a.km ?? 1e9) - (b.km ?? 1e9),
    year: (a, b) => (b.year ?? 0) - (a.year ?? 0),
  };

  // ---------- Çizim ----------
  function render() {
    renderHeader();
    renderModelChips();
    renderFilterChips();
    renderGrid();
    renderMarket();
    renderArchive();
    renderFeed();
  }

  function renderHeader() {
    const db = state.db;
    renderMailBtn();
    $('#updated').textContent = `Son güncelleme: ${ago(db.updatedAt)} · ${new Date(db.updatedAt).toLocaleString('tr-TR')}`;
    const active = state.listings.filter((l) => l.status === 'active');
    const cars = active.filter(isPrimary);
    const new24 = cars.filter(isNew).length;
    const deals = cars.filter((l) => l.a?.label === 'Fırsat').length;
    const drops7 = (db.events || []).filter((e) => e.type === 'price' && e.to < e.from && Date.now() - Date.parse(e.t) < 7 * DAY).length;
    const stats = [
      [cars.length, `Aktif Tesla (${active.length - cars.length} çift ilan birleşti)`],
      [new24, 'Son 24 saatte yeni'],
      [deals, '🔥 Fırsat'],
      [drops7, 'Fiyatı düşen (7 gün)'],
      [db.market?.removed30d ?? 0, 'Kalkan / satılan (30 gün)'],
    ];
    $('#stats').innerHTML = stats.map(([v, t]) => `<div class="stat"><b>${v}</b><span>${t}</span></div>`).join('');

    const srcs = ['sahibinden', 'arabam', 'otokoc', 'borusan'];
    $('#sources').innerHTML = srcs.map((s) => {
      const st = db.sources?.[s];
      const count = active.filter((l) => l.source === s).length;
      let cls = '', info = 'henüz taranmadı';
      if (st?.lastOk) {
        const age = Date.now() - Date.parse(st.lastOk);
        cls = age < 30 * 60000 ? 'ok' : 'stale';
        info = `${ago(st.lastOk)} (${RUNNER_NAMES[st.lastOkRunner] || 'bilgisayar'})`;
      }
      // Yalnızca son başarılı taramadan sonra oluşan ve 6 saatten yeni hatalar
      const okAt = Date.parse(st?.lastOk || 0);
      const errs = Object.entries(st?.runs || {})
        .filter(([, r]) => !r.ok && Date.parse(r.lastRun) > okAt && Date.now() - Date.parse(r.lastRun) < 6 * 3600000)
        .map(([r, x]) => `${RUNNER_NAMES[r] || r}: ${x.error}`);
      if (errs.length && !st?.lastOk) cls = 'err';
      const blocks = Object.entries(st?.blocks || {}).filter(([, u]) => Date.parse(u) > Date.now());
      if (st?.blockedUntil && Date.parse(st.blockedUntil) > Date.now()) blocks.push(['hepsi', st.blockedUntil]);
      if (blocks.length) {
        const fmt = (u) => new Date(u).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
        info += ` · engel: ${blocks.map(([r, u]) => `${RUNNER_NAMES[r] || r} ${fmt(u)}'e kadar bekliyor`).join(', ')}`;
        if (blocks.length && cls !== 'ok') cls = 'stale';
      }
      if (s === 'sahibinden' && !st?.lastOk) info = 'Chrome eklentisi bekleniyor';
      return `<span class="src" title="${esc(errs.join('\n') || 'sorun yok')}"><i class="dot ${cls}"></i><b>${SOURCE_NAMES[s]}</b> ${count} ilan · ${esc(info)}${errs.length ? ' ⚠' : ''}</span>`;
    }).join('');
  }

  function renderModelChips() {
    const base = baseFiltered('model');
    const counts = {};
    for (const l of base) counts[l.c.model] = (counts[l.c.model] || 0) + 1;
    const models = MODEL_ORDER.filter((m) => counts[m]);
    const chip = (m, label, n) => {
      const ls = base.filter((l) => !m || l.c.model === m);
      const prices = ls.map((l) => l.price).filter(Boolean).sort((a, b) => a - b);
      const med = prices.length ? prices[Math.floor(prices.length / 2)] : null;
      return `<button class="model-chip ${state.f.model === m ? 'active' : ''}" data-model="${m || ''}"><b>${label}</b><span>${n} ilan · medyan ${tlShort(med)}</span></button>`;
    };
    $('#modelChips').innerHTML = chip(null, 'Tümü', base.length) + models.map((m) => chip(m, m, counts[m])).join('');
  }

  function chipGroup(id, key, values, names = {}) {
    const base = baseFiltered(key);
    const field = { labels: (l) => l.a?.label, gens: (l) => l.c.generation, trims: (l) => l.c.trim, sources: (l) => l.source, sellers: (l) => l.sellerType || 'bilinmiyor', heavy: heavyOf }[key];
    const counts = {};
    for (const l of base) { const v = field(l); counts[v] = (counts[v] || 0) + 1; }
    const vals = values || Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
    $(id).innerHTML = vals.filter((v) => counts[v] || state.f[key].includes(v)).map((v) =>
      `<button class="chip ${state.f[key].includes(v) ? 'on' : ''}" data-key="${key}" data-val="${esc(v)}">${esc(names[v] || (key === 'labels' ? `${LABEL_EMOJI[v]} ${v}` : v))}<small>${counts[v] || 0}</small></button>`).join('');
  }

  function renderFilterChips() {
    chipGroup('#fLabel', 'labels', LABELS);
    chipGroup('#fGen', 'gens');
    chipGroup('#fTrim', 'trims');
    chipGroup('#fSource', 'sources', null, SOURCE_NAMES);
    chipGroup('#fSeller', 'sellers', null, { ...SELLER_NAMES, bilinmiyor: 'Bilinmiyor' });
    chipGroup('#fHeavy', 'heavy', ['yok', 'var', 'bilinmiyor'], { yok: '✓ Kaydı yok', var: '⚠ Kayıtlı', bilinmiyor: 'Bilinmiyor' });
  }

  function sparkline(hist) {
    if (!hist || hist.length < 2) return '';
    const ps = hist.map((h) => h.p);
    const min = Math.min(...ps), max = Math.max(...ps), span = max - min || 1;
    const pts = ps.map((p, i) => `${(i / (ps.length - 1)) * 88 + 1},${22 - ((p - min) / span) * 20}`).join(' ');
    const last = ps[ps.length - 1], first = ps[0];
    const color = last < first ? 'var(--good)' : 'var(--bad)';
    const pct = ((last - first) / first) * 100;
    return `<div class="spark"><svg viewBox="0 0 90 24"><polyline fill="none" stroke="${color}" stroke-width="2" points="${pts}"/></svg>${hist.length - 1} değişim · ${pct > 0 ? '+' : ''}${pct.toFixed(1)}%</div>`;
  }

  function card(l) {
    const a = l.a || {};
    const dev = a.deviation;
    const devCls = dev == null || a.label === 'Veri az' ? '' : dev < -0.02 ? 'down' : dev > 0.03 ? 'up' : 'flat';
    const devTxt = devCls ? `<span class="dev ${devCls}">${dev > 0 ? '+' : ''}${(dev * 100).toFixed(1)}%</span>` : '';
    const labelCls = `l-${(a.label || '').split(' ')[0]}`;
    const d = l.damage || {};
    const meta = [
      kmFmt(l.km),
      l.city ? esc(l.city) : null,
      SELLER_NAMES[l.sellerType] || null,
      l.color ? esc(l.color) : null,
      d.tramer > 0 ? `<span class="warn">Tramer ${tlShort(d.tramer)}</span>` : null,
      heavyOf(l) === 'yok' ? '<span class="tag">Ağır hasar kaydı yok</span>' : null,
      l.reserved ? '<span class="warn">Opsiyonlu</span>' : null,
      ...(l.c.warnings || []).map((w) => `<span class="warn">${esc(w)}</span>`),
      ...(l.c.tags || []).slice(0, 5).map((t) => `<span class="tag">${esc(t)}</span>`),
    ].filter(Boolean).map((x) => (x.startsWith('<span') ? x : `<span>${x}</span>`)).join('');
    const why = [
      ...(a.reasons || []).slice(0, 3).map((r) => `<li class="pro">${esc(r)}</li>`),
      ...(a.cautions || []).slice(0, 3).map((r) => `<li class="con">${esc(r)}</li>`),
    ].join('');
    const others = (l.dup?.members || []).filter((k) => k !== l.key).map((k) => state.db.listings[k]).filter(Boolean);
    const otherHtml = others.length ? `<div class="others">Aynı araç: ${others.map((o) => {
      const d = o.price - l.price;
      const diff = d ? ` <small class="${d < 0 ? 'cheaper' : ''}">(${d < 0 ? '' : '+'}${tlShort(Math.abs(d)).replace(/^/, d < 0 ? '−' : '')})</small>` : ' <small>(aynı fiyat)</small>';
      return `<a href="${esc(o.url)}" target="_blank" rel="noopener">${SOURCE_NAMES[o.source]} ${tl(o.price)}</a>${diff}`;
    }).join(' · ')}</div>` : '';
    const fav = state.favs.has(l.key);
    const c = el('article', { class: `card ${l.status !== 'active' ? 'removed' : ''}`, 'data-key': l.key });
    c.innerHTML = `
      <a class="thumb" href="${esc(l.url)}" target="_blank" rel="noopener">
        ${l.image ? `<img src="${esc(l.image)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<span class="noimg">${l.megaPhoto ? 'fotoğraflar ilan sayfasında ↗' : 'fotoğraf yok'}</span>`}
        <span class="badge ${labelCls}">${LABEL_EMOJI[a.label] || ''} ${esc(a.label || '')}${a.label !== 'Veri az' ? ` · ${a.score}` : ''}</span>
        ${l.status !== 'active' ? '<span class="ribbon">KALKTI</span>' : isNew(l) ? '<span class="ribbon">YENİ</span>' : ''}
        <span class="src-tag">${SOURCE_NAMES[l.source]}${others.length ? ` +${others.length} site` : ''}</span>
      </a>
      <button class="fav ${fav ? 'on' : ''}" type="button" title="Favori" data-fav="${esc(l.key)}">${fav ? '★' : '☆'}</button>
      <div class="body">
        <a class="title" href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.c.model)} ${l.c.generation !== '-' ? esc(l.c.generation) : ''} · ${esc(l.c.trim)} · ${l.year || '?'}</a>
        <div class="subtitle" title="${esc(l.title)}">${esc(l.title)}</div>
        <div class="price-row"><span class="price">${tl(l.price)}</span>${devTxt}</div>
        ${a.expected && a.label !== 'Veri az' ? `<div class="expected">Beklenen ≈ ${tl(a.expected)}${a.compMedian ? ` · benzer ${a.comps} ilan medyanı ${tlShort(a.compMedian)}` : ''}</div>` : ''}
        <div class="meta">${meta}</div>
        ${otherHtml}
        <div class="advice">${esc(a.advice || '')}</div>
        ${why ? `<ul class="why">${why}</ul>` : ''}
        ${sparkline(l.vehicleHistory || l.priceHistory)}
        ${relistLine(l)}
        <button class="hist-btn" type="button" data-hist="${esc(l.key)}">📈 Fiyat geçmişi${(l.vehicleHistory || l.priceHistory || []).length > 1 ? ` (${(l.vehicleHistory || l.priceHistory).length - 1} değişim)` : ''}</button>
        <div class="foot"><span>İlk görülme: ${ago(l.firstSeen)}</span><span>${a.daysOnMarket != null ? `${a.daysOnMarket} gündür ilanda` : ''}</span></div>
      </div>`;
    return c;
  }

  function renderGrid() {
    const list = baseFiltered().sort(SORTS[state.f.sort] || SORTS.score);
    $('#count').textContent = `${list.length} ilan`;
    const hidden = state.f.hideHeavy ? collapse(state.listings.filter((l) => l.status === 'active' && heavyOf(l) === 'var')).length : 0;
    $('#heavyCount').textContent = hidden ? `(${hidden} gizli)` : '';
    const grid = $('#grid');
    grid.replaceChildren(...list.slice(0, state.shown).map(card));
    if (!list.length) grid.innerHTML = '<div class="empty">Bu filtrelere uyan ilan yok.</div>';
    $('#more').hidden = list.length <= state.shown;
  }

  // ---------- Piyasa sekmesi ----------
  const LABEL_COLORS = { 'Fırsat': 'var(--good)', 'İyi fiyat': 'var(--info)', 'Piyasa': 'var(--muted)', 'Pahalı': 'var(--warn)', 'Şüpheli': 'var(--bad)', 'Veri az': 'var(--border)' };

  function renderMarket() {
    const active = state.listings.filter((l) => l.status === 'active' && l.price && isPrimary(l));
    const sel = $('#scatterModel');
    const models = MODEL_ORDER.filter((m) => active.some((l) => l.c.model === m));
    const current = sel.value || models[0];
    sel.innerHTML = models.map((m) => `<option ${m === current ? 'selected' : ''}>${m}</option>`).join('');
    const pts = active.filter((l) => l.c.model === (sel.value || current) && l.km != null);
    const W = 760, H = 340, P = { l: 56, r: 14, t: 12, b: 36 };
    if (!pts.length) { $('#scatter').innerHTML = '<p class="hint">Km bilgisi olan ilan yok.</p>'; }
    else {
      const xs = pts.map((l) => l.km), ys = pts.map((l) => l.price);
      const xMax = Math.max(...xs) * 1.05 || 1, yMin = Math.min(...ys) * 0.92, yMax = Math.max(...ys) * 1.05;
      const X = (v) => P.l + (v / xMax) * (W - P.l - P.r);
      const Y = (v) => H - P.b - ((v - yMin) / (yMax - yMin)) * (H - P.t - P.b);
      const ticksY = Array.from({ length: 5 }, (_, i) => yMin + ((yMax - yMin) * i) / 4);
      const ticksX = Array.from({ length: 5 }, (_, i) => (xMax * i) / 4);
      $('#scatter').innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Fiyat-km dağılımı">
        ${ticksY.map((v) => `<line class="grid-line" x1="${P.l}" x2="${W - P.r}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${P.l - 6}" y="${Y(v) + 4}" text-anchor="end">${tlShort(v)}</text>`).join('')}
        ${ticksX.map((v) => `<text x="${X(v)}" y="${H - P.b + 18}" text-anchor="middle">${Math.round(v / 1000)} bin km</text>`).join('')}
        ${pts.map((l) => `<circle class="pt" data-url="${esc(l.url)}" cx="${X(l.km).toFixed(1)}" cy="${Y(l.price).toFixed(1)}" r="${l.year >= 2025 ? 6 : 4.5}" fill="${LABEL_COLORS[l.a?.label] || 'var(--muted)'}" fill-opacity=".85"><title>${esc(`${l.c.segment} ${l.year}\n${tl(l.price)} · ${kmFmt(l.km)}\n${l.a?.label} (${l.a?.score})`)}</title></circle>`).join('')}
      </svg>
      <div class="legend">${LABELS.map((lb) => `<span><i style="background:${LABEL_COLORS[lb]}"></i>${lb}</span>`).join('')}<span>büyük nokta = 2025+</span></div>`;
    }

    const segs = state.db.market?.segments || [];
    $('#segTable').innerHTML = `<thead><tr><th>Model</th><th>Nesil</th><th>Versiyon</th><th class="num">İlan</th><th class="num">Medyan fiyat</th><th class="num">En düşük</th><th class="num">Medyan km</th><th>Yıllar</th><th class="num">7 günde yeni</th></tr></thead>
      <tbody>${segs.map((s) => `<tr><td>${esc(s.model)}</td><td>${esc(s.generation)}</td><td>${esc(s.trim)}</td><td class="num">${s.count}</td><td class="num">${tl(s.medianPrice)}</td><td class="num">${tl(s.minPrice)}</td><td class="num">${s.medianKm != null ? Math.round(s.medianKm).toLocaleString('tr-TR') : '—'}</td><td>${s.years ? (s.years[0] === s.years[1] ? s.years[0] : `${s.years[0]}–${s.years[1]}`) : '—'}</td><td class="num">${s.new7d}</td></tr>`).join('')}</tbody>`;
  }

  // ---------- Yeniden ilan & arşiv ----------
  const daysBetween = (a, b) => Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / DAY));
  const listedFrom = (l) => l.publishedAt || l.firstSeen;

  function relistLine(l) {
    const prev = l.relistOf && state.db.listings[l.relistOf];
    if (!prev) return '';
    const d = l.price - prev.price;
    const chg = d ? ` · fiyat ${tl(prev.price)} → ${tl(l.price)} (<span class="${d < 0 ? 'chg-down' : 'chg-up'}">${d < 0 ? '▼' : '▲'} %${Math.abs((d / prev.price) * 100).toFixed(1)}</span>)` : ' · aynı fiyat';
    return `<div class="relist">↻ Yeniden ilan: önceki ilanı ${daysBetween(prev.removedAt, listedFrom(l))} gün önce kalkmıştı (${SOURCE_NAMES[prev.source]}, ${daysBetween(listedFrom(prev), prev.removedAt)} gün ilanda)${chg}</div>`;
  }

  function median(a) { const s = a.filter((x) => x != null).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; }

  function renderArchive() {
    const days = +$('#archDays').value || 90;
    const model = $('#archModel').value;
    const q = $('#archQ').value.trim().toLocaleLowerCase('tr-TR');
    const removedAll = state.listings.filter((l) => l.status === 'removed' && Date.now() - Date.parse(l.removedAt) < days * DAY);
    const models = MODEL_ORDER.filter((m) => removedAll.some((l) => l.c.model === m));
    const sel = $('#archModel');
    const cur = sel.value;
    sel.innerHTML = '<option value="">Tüm modeller</option>' + models.map((m) => `<option ${m === cur ? 'selected' : ''}>${m}</option>`).join('');
    const rows = removedAll.filter((l) => (!model || l.c.model === model) &&
      (!q || `${l.title} ${l.city} ${l.c.segment}`.toLocaleLowerCase('tr-TR').includes(q)))
      .sort((a, b) => Date.parse(b.removedAt) - Date.parse(a.removedAt));

    // Model/versiyon bazında özet: kaç ilan kalktı, ortalama kaç günde, son fiyatlar
    const groups = new Map();
    for (const l of rows) {
      const k = `${l.c.model} · ${l.c.generation} · ${l.c.trim}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(l);
    }
    $('#archSummary').innerHTML = rows.length
      ? `<thead><tr><th>Segment</th><th class="num">Kalkan</th><th class="num">Medyan ilanda kalma</th><th class="num">Medyan son fiyat</th><th class="num">İlk→son fiyat (medyan)</th><th class="num">Yeniden ilana konan</th></tr></thead><tbody>${
        [...groups.entries()].sort((a, b) => b[1].length - a[1].length).map(([k, ls]) => {
          const chg = median(ls.map((l) => { const h = l.priceHistory || []; return h.length ? ((l.price - h[0].p) / h[0].p) * 100 : null; }));
          return `<tr><td>${esc(k)}</td><td class="num">${ls.length}</td><td class="num">${median(ls.map((l) => daysBetween(listedFrom(l), l.removedAt)))} gün</td><td class="num">${tl(median(ls.map((l) => l.price)))}</td><td class="num">${chg == null ? '—' : `${chg > 0 ? '+' : ''}${chg.toFixed(1)}%`}</td><td class="num">${ls.filter((l) => l.relistedAs).length}</td></tr>`;
        }).join('')}</tbody>`
      : '<tbody><tr><td>Bu dönemde kalkan ilan yok. İlanların kalktığı, tam taramalarda artık görülmemesiyle anlaşılır (sahibinden günde bir taranır).</td></tr></tbody>';

    $('#archTable').innerHTML = rows.length ? `<thead><tr><th>Kalktı</th><th>Araç</th><th>Kaynak</th><th class="num">İlk fiyat</th><th class="num">Son fiyat</th><th class="num">İlanda</th><th>Sonra</th></tr></thead><tbody>${rows.slice(0, 400).map((l) => {
      const first = (l.priceHistory || [])[0]?.p ?? l.price;
      const d = l.price - first;
      const next = l.relistedAs && state.db.listings[l.relistedAs];
      return `<tr>
        <td>${new Date(l.removedAt).toLocaleDateString('tr-TR')}<br><small>${ago(l.removedAt)}</small></td>
        <td class="car"><a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.c.model)} ${esc(l.c.trim)} ${l.year || ''}</a><br><small>${kmFmt(l.km)} · ${esc(l.city || '')} · ${esc(l.title.slice(0, 50))}</small></td>
        <td>${SOURCE_NAMES[l.source]}<br><small>${SELLER_NAMES[l.sellerType] || ''}</small></td>
        <td class="num">${tl(first)}</td>
        <td class="num">${tl(l.price)}${d ? `<br><small class="${d < 0 ? 'chg-down' : 'chg-up'}">${d < 0 ? '▼' : '▲'} %${Math.abs((d / first) * 100).toFixed(1)}</small>` : ''}</td>
        <td class="num">${daysBetween(listedFrom(l), l.removedAt)} gün<br><button class="hist-btn" type="button" data-hist="${esc(l.key)}">📈</button></td>
        <td>${next ? `<a href="${esc(next.url)}" target="_blank" rel="noopener">↻ yeniden ilan</a><br><small>${SOURCE_NAMES[next.source]} ${tl(next.price)}${next.status === 'removed' ? ' (o da kalktı)' : ''}</small>` : '<small>satıldı / kaldırıldı</small>'}</td>
      </tr>`;
    }).join('')}</tbody>` : '';
  }

  // ---------- İlan ayrıntısı: fiyat geçmişi ----------
  const SERIES_COLORS = ['var(--accent)', 'var(--info)', 'var(--good)', 'var(--warn)'];
  const fmtDate = (iso) => {
    const d = new Date(iso);
    return d.toLocaleDateString('tr-TR', d.getFullYear() === new Date().getFullYear() ? { day: '2-digit', month: 'short' } : { day: '2-digit', month: 'short', year: 'numeric' });
  };

  // Aracın tüm ilanları: kendisi, yeniden ilan zinciri (öncekiler) ve farklı sitelerdeki aynı araç
  function vehicleListings(l) {
    const out = [];
    const add = (x, role) => { if (x && !out.some((o) => o.l.key === x.key)) out.push({ l: x, role }); };
    add(l, 'bu ilan');
    let prev = l.relistOf && state.db.listings[l.relistOf];
    for (let i = 0; prev && i < 5; i++) { add(prev, 'önceki ilan'); prev = prev.relistOf && state.db.listings[prev.relistOf]; }
    for (const k of l.dup?.members || []) add(state.db.listings[k], 'aynı araç');
    return out;
  }

  function priceChart(series) {
    const pts = series.flatMap((s) => s.points);
    if (!pts.length) return '';
    const W = 700, H = 240, P = { l: 70, r: 16, t: 14, b: 30 };
    const now = Date.now();
    const t0 = Math.min(...pts.map((p) => p.t)), t1 = Math.max(now, ...pts.map((p) => p.t));
    const ps = pts.map((p) => p.p);
    let lo = Math.min(...ps), hi = Math.max(...ps);
    const pad = Math.max((hi - lo) * 0.15, hi * 0.02);
    lo -= pad; hi += pad;
    const X = (t) => P.l + ((t - t0) / Math.max(1, t1 - t0)) * (W - P.l - P.r);
    const Y = (v) => H - P.b - ((v - lo) / (hi - lo)) * (H - P.t - P.b);
    const ticksY = Array.from({ length: 4 }, (_, i) => lo + ((hi - lo) * i) / 3);
    const ticksX = Array.from({ length: 4 }, (_, i) => t0 + ((t1 - t0) * i) / 3);
    const lines = series.map((s, i) => {
      if (!s.points.length) return '';
      // basamaklı çizgi: fiyat bir sonraki değişikliğe kadar geçerli; son nokta bugüne (veya kalkışa) uzar
      const end = s.end ?? now;
      let d = `M${X(s.points[0].t)},${Y(s.points[0].p)}`;
      s.points.forEach((p, j) => {
        if (j) d += ` H${X(p.t)} V${Y(p.p)}`;
      });
      d += ` H${X(end)}`;
      const dots = s.points.map((p) => `<circle cx="${X(p.t)}" cy="${Y(p.p)}" r="4" fill="${SERIES_COLORS[i % 4]}"><title>${fmtDate(new Date(p.t).toISOString())}: ${tl(p.p)} (${esc(s.name)})</title></circle>`).join('');
      return `<path class="line" d="${d}" stroke="${SERIES_COLORS[i % 4]}" ${s.dashed ? 'stroke-dasharray="6 4"' : ''}/>${dots}`;
    }).join('');
    return `<div class="d-chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Fiyat geçmişi grafiği">
      ${ticksY.map((v) => `<line class="grid-line" x1="${P.l}" x2="${W - P.r}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${P.l - 8}" y="${Y(v) + 4}" text-anchor="end">${tlShort(v)}</text>`).join('')}
      ${ticksX.map((t) => `<text x="${X(t)}" y="${H - 8}" text-anchor="middle">${t1 - t0 < 3 * DAY
        ? new Date(t).toLocaleString('tr-TR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
        : new Date(t).toLocaleDateString('tr-TR', { day: '2-digit', month: 'short' })}</text>`).join('')}
      ${lines}
    </svg></div>
    <div class="d-legend">${series.map((s, i) => `<span><i style="background:${SERIES_COLORS[i % 4]}"></i>${esc(s.name)}</span>`).join('')}</div>`;
  }

  function openDetail(key) {
    const l = state.db?.listings[key];
    if (!l) return;
    const vl = vehicleListings(l);
    const series = vl.map(({ l: x, role }) => ({
      name: `${SOURCE_NAMES[x.source]} · ${role}${x.status === 'removed' ? ' (kalktı)' : ''}`,
      points: (x.priceHistory || []).map((h) => ({ t: Date.parse(h.t), p: h.p })),
      end: x.status === 'removed' ? Date.parse(x.removedAt) : null,
      dashed: role !== 'bu ilan',
    }));
    // Araç bazında ilk fiyat → bugünkü fiyat
    const own = (l.vehicleHistory || l.priceHistory || []);
    const first = own[0]?.p ?? l.price;
    const chg = l.price - first;
    const since = l.relistOf ? (vl.at(-1)?.l.publishedAt || vl.at(-1)?.l.firstSeen) : (l.publishedAt || l.firstSeen);

    // Tüm değişiklikler tek tabloda (en yeni üstte)
    const rows = [];
    for (const { l: x, role } of vl) {
      const h = x.priceHistory || [];
      h.forEach((e, i) => rows.push({ t: e.t, p: e.p, prev: i ? h[i - 1].p : null, x, role, first: i === 0 }));
      if (x.status === 'removed') rows.push({ t: x.removedAt, removed: true, x, role });
    }
    rows.sort((a, b) => Date.parse(b.t) - Date.parse(a.t));

    $('#dTitle').textContent = `${l.c.model} ${l.c.generation !== '-' ? l.c.generation : ''} · ${l.c.trim} · ${l.year || ''}`;
    $('#dSub').innerHTML = `${esc(l.title)} · ${kmFmt(l.km)} · ${esc(l.city || '')} · <a href="${esc(l.url)}" target="_blank" rel="noopener">ilanı aç ↗</a>`;
    $('#dBody').innerHTML = `
      <div class="d-stats">
        <div><b>${tl(l.price)}</b><span>güncel fiyat</span></div>
        <div><b>${tl(first)}</b><span>ilk görülen fiyat</span></div>
        <div><b class="${chg < 0 ? 'chg-down' : chg > 0 ? 'chg-up' : ''}">${chg ? `${chg < 0 ? '▼' : '▲'} ${tlShort(Math.abs(chg))} (%${Math.abs((chg / first) * 100).toFixed(1)})` : 'değişmedi'}</b><span>toplam değişim</span></div>
        <div><b>${daysBetween(since, new Date().toISOString())} gün</b><span>${l.relistOf ? 'ilk ilandan beri' : 'ilanda'}</span></div>
      </div>
      ${own.length <= 1 && vl.length === 1 ? `<p class="d-note">Fiyat, ilan ilk görüldüğünden (${fmtDate(l.firstSeen)}) beri değişmedi. Değişiklik olursa burada tarihiyle görünecek ve fiyat düşüşünde mail alacaksın.</p>` : ''}
      ${priceChart(series)}
      <table class="hist">
        <thead><tr><th>Tarih</th><th>İlan</th><th class="num">Fiyat</th><th class="num">Değişim</th></tr></thead>
        <tbody>${rows.map((r) => r.removed
          ? `<tr><td>${fmtDate(r.t)}</td><td>${SOURCE_NAMES[r.x.source]} <small>${r.role}</small></td><td class="num" colspan="2"><small>ilan kalktı</small></td></tr>`
          : `<tr><td>${fmtDate(r.t)}</td><td><a href="${esc(r.x.url)}" target="_blank" rel="noopener">${SOURCE_NAMES[r.x.source]}</a> <small>${r.role}${r.first ? ' · ilk görüldü' : ''}</small></td><td class="num">${tl(r.p)}</td>
             <td class="num">${r.prev ? `<span class="${r.p < r.prev ? 'chg-down' : 'chg-up'}">${r.p < r.prev ? '▼' : '▲'} ${tlShort(Math.abs(r.p - r.prev))} (%${Math.abs(((r.p - r.prev) / r.prev) * 100).toFixed(1)})</span>` : '—'}</td></tr>`).join('')}</tbody>
      </table>`;
    const dlg = $('#detail');
    if (!dlg.open) dlg.showModal();
    history.replaceState(null, '', `#ilan=${encodeURIComponent(key)}`);
  }

  function closeDetail() {
    const dlg = $('#detail');
    if (dlg.open) dlg.close();
    if (location.hash.startsWith('#ilan=')) history.replaceState(null, '', location.pathname + location.search);
  }

  // ---------- Mail bildirimleri: durdur / devam ----------
  const LOCAL = IS_LOCAL;
  const WORKFLOW_URL = 'https://github.com/enesdedeoglu/aractakip/actions/workflows/mail.yml';

  function mailPausedUntil() {
    const u = state.db?.prefs?.mailPausedUntil;
    if (u === 'forever') return 'forever';
    return u && Date.parse(u) > Date.now() ? u : null;
  }

  function renderMailBtn() {
    const p = mailPausedUntil();
    const b = $('#mailBtn');
    b.classList.toggle('paused', !!p);
    b.textContent = p ? '✉️ Mail durduruldu' : '✉️ Mail açık';
  }

  async function openMailDlg(refresh = true) {
    if (LOCAL && refresh) {
      try { const r = await (await fetch('/api/prefs')).json(); if (r.ok) { state.db.prefs = r.prefs; renderMailBtn(); } } catch { /* yoksay */ }
    }
    const p = mailPausedUntil();
    $('#mailState').innerHTML = p
      ? `Mail bildirimleri <b>durduruldu</b>${p === 'forever' ? ' (süresiz)' : ` – ${new Date(p).toLocaleString('tr-TR', { day: '2-digit', month: 'long', hour: '2-digit', minute: '2-digit' })}'e kadar`}. Bu sürede yeni ilan ve fiyat değişikliği maili gelmez; sitede her şey güncellenmeye devam eder.`
      : 'Mail bildirimleri <b>açık</b>: yeni ilan ve fiyat değişikliklerinde mail geliyor.';
    if (LOCAL) {
      $('#mailBody').innerHTML = p
        ? '<div class="mail-actions"><button class="btn primary" data-mail="devam" type="button">Maili yeniden başlat</button></div>'
        : `<div class="mail-actions">${['1 gün', '3 gün', '1 hafta', 'süresiz'].map((d) => `<button class="btn" data-mail="durdur" data-dur="${d}" type="button">${d} durdur</button>`).join('')}</div>`;
    } else {
      $('#mailBody').innerHTML = `<ol class="steps">
        <li><a href="${WORKFLOW_URL}" target="_blank" rel="noopener"><b>GitHub'daki "Mail bildirimleri" sayfasını aç ↗</b></a> (GitHub hesabınla giriş yapmış olmalısın – bu ayarı yalnızca sen değiştirebilirsin)</li>
        <li>Sağdaki <b>Run workflow</b> düğmesine bas.</li>
        <li><b>${p ? 'devam' : 'durdur'}</b>${p ? '' : ' ve süreyi'} seç, yeşil <b>Run workflow</b> ile onayla.</li>
        <li>1–2 dakika içinde bu sayfada durum güncellenir.</li>
      </ol>
      <p class="hint">Bilgisayarında veya tablette <code>127.0.0.1:5173</code> adresinden açarsan tek tıkla değiştirebilirsin.</p>`;
    }
    const d = $('#mailDlg');
    if (!d.open) d.showModal();
  }

  async function setMail(action, duration) {
    try {
      const r = await (await fetch('/api/mail', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, duration }) })).json();
      if (!r.ok) throw new Error(r.error);
      state.db.prefs = r.prefs;
      renderMailBtn();
      openMailDlg(false);
      toast(action === 'devam' ? 'Mail bildirimleri yeniden başladı.' : `Mail bildirimleri durduruldu (${duration}).`);
    } catch (e) {
      toast(`Değiştirilemedi: ${esc(e.message)}`);
    }
  }

  // ---------- Akış ----------
  function renderFeed() {
    const evs = (state.db.events || []).slice(0, 150);
    const icon = { new: '🆕', price: '₺', removed: '✕', returned: '↺' };
    $('#feed').innerHTML = evs.map((e) => {
      const l = state.db.listings[e.key];
      if (!l) return '';
      const name = `${l.c.model} ${l.c.trim} ${l.year || ''}`;
      let txt;
      const also = (l.dup?.members || []).filter((k) => k !== l.key).map((k) => SOURCE_NAMES[state.db.listings[k]?.source]).filter(Boolean);
      if (e.type === 'new' && l.relistOf && state.db.listings[l.relistOf]) txt = `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(name)}</a> yeniden ilana kondu · ${tl(state.db.listings[l.relistOf].price)} → ${tl(l.priceHistory?.[0]?.p ?? l.price)} · ${SOURCE_NAMES[l.source]}`;
      else if (e.type === 'new') txt = `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(name)}</a> eklendi · ${tl(l.priceHistory?.[0]?.p ?? l.price)} · ${SOURCE_NAMES[l.source]} · ${LABEL_EMOJI[l.a?.label] || ''} ${esc(l.a?.label)}${also.length ? ` · <small>aynı araç ${also.join(', ')}'da da var</small>` : ''}`;
      else if (e.type === 'price') txt = `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(name)}</a> fiyatı ${tl(e.from)} → <b>${tl(e.to)}</b> (${e.to < e.from ? '▼' : '▲'} %${Math.abs(((e.to - e.from) / e.from) * 100).toFixed(1)}) · ${SOURCE_NAMES[l.source]}`;
      else if (e.type === 'removed') txt = `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(name)}</a> ilanı kalktı (satıldı olabilir) · son fiyat ${tl(l.price)}`;
      else txt = `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(name)}</a> tekrar yayında · ${tl(l.price)}`;
      return `<li><span class="ic ${e.type} ${e.type === 'price' && e.to > e.from ? 'up' : ''}">${icon[e.type]}</span><span class="txt">${txt}</span><span class="when">${ago(e.t)}</span></li>`;
    }).join('') || '<li>Henüz hareket yok.</li>';
  }

  // ---------- Olaylar ----------
  function save() { store.set('filters', state.f); }
  function update() { state.shown = PAGE; save(); render(); }

  function syncInputs() {
    const f = state.f;
    $('#q').value = f.q; $('#sort').value = f.sort;
    for (const k of ['yMin', 'yMax', 'pMax', 'kMax']) $('#' + k).value = f[k];
    for (const k of ['onlyNew', 'noDamage', 'hideReserved', 'onlyFav', 'showRemoved', 'dedupe', 'hideHeavy']) $('#' + k).checked = f[k];
  }

  document.addEventListener('click', (e) => {
    const t = e.target.closest('button, circle');
    if (!t) return;
    if (t.dataset.model !== undefined && t.classList.contains('model-chip')) {
      state.f.model = t.dataset.model || null; update();
    } else if (t.classList.contains('chip')) {
      const arr = state.f[t.dataset.key];
      const i = arr.indexOf(t.dataset.val);
      if (i >= 0) arr.splice(i, 1); else arr.push(t.dataset.val);
      update();
    } else if (t.id === 'logoutBtn') {
      logout();
    } else if (t.id === 'mailBtn') {
      openMailDlg();
    } else if (t.id === 'mailClose') {
      $('#mailDlg').close();
    } else if (t.dataset.mail) {
      setMail(t.dataset.mail, t.dataset.dur);
    } else if (t.dataset.hist) {
      openDetail(t.dataset.hist);
    } else if (t.id === 'dClose') {
      closeDetail();
    } else if (t.dataset.fav) {
      const k = t.dataset.fav;
      if (state.favs.has(k)) state.favs.delete(k); else state.favs.add(k);
      store.set('favs', [...state.favs]);
      renderGrid();
    } else if (t.tagName === 'circle' && t.dataset.url) {
      window.open(t.dataset.url, '_blank', 'noopener');
    } else if (t.classList.contains('tab')) {
      document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === t));
      document.querySelectorAll('.tabpane').forEach((p) => p.classList.toggle('active', p.id === `tab-${t.dataset.tab}`));
      store.set('tab', t.dataset.tab);
    }
  });

  let qTimer;
  $('#q').addEventListener('input', (e) => { clearTimeout(qTimer); qTimer = setTimeout(() => { state.f.q = e.target.value; update(); }, 200); });
  $('#sort').addEventListener('change', (e) => { state.f.sort = e.target.value; update(); });
  for (const k of ['yMin', 'yMax', 'pMax', 'kMax']) $('#' + k).addEventListener('change', (e) => { state.f[k] = e.target.value; update(); });
  for (const k of ['onlyNew', 'noDamage', 'hideReserved', 'onlyFav', 'showRemoved', 'dedupe', 'hideHeavy']) $('#' + k).addEventListener('change', (e) => { state.f[k] = e.target.checked; update(); });
  $('#reset').addEventListener('click', () => {
    Object.assign(state.f, { model: null, q: '', labels: [], gens: [], trims: [], sources: [], sellers: [], heavy: [], yMin: '', yMax: '', pMax: '', kMax: '', onlyNew: false, noDamage: false, hideReserved: false, onlyFav: false, showRemoved: false, dedupe: true, hideHeavy: true });
    syncInputs(); update();
  });
  $('#more').addEventListener('click', () => { state.shown += PAGE; renderGrid(); });
  $('#toggleFilters').addEventListener('click', () => $('#filters').classList.toggle('open'));
  $('#scatterModel').addEventListener('change', renderMarket);
  for (const id of ['#archModel', '#archDays']) $(id).addEventListener('change', renderArchive);
  $('#archQ').addEventListener('input', renderArchive);

  const nb = $('#notifyBtn');
  function syncNotifyBtn() {
    if (!('Notification' in window)) { nb.hidden = true; return; }
    nb.textContent = Notification.permission === 'granted' ? '🔔 Bildirimler açık' : '🔔 Bildirimleri aç';
    nb.disabled = Notification.permission === 'granted';
  }
  nb.addEventListener('click', async () => { await Notification.requestPermission(); syncNotifyBtn(); });
  syncNotifyBtn();

  document.addEventListener('visibilitychange', () => { if (!document.hidden) { document.title = 'Tesla İlan Takip'; load(); } });

  $('#detail').addEventListener('click', (e) => { if (e.target.id === 'detail') closeDetail(); }); // arka plana tıklayınca kapan
  $('#mailDlg').addEventListener('click', (e) => { if (e.target.id === 'mailDlg') e.target.close(); });
  $('#detail').addEventListener('close', () => { if (location.hash.startsWith('#ilan=')) history.replaceState(null, '', location.pathname + location.search); });

  const tab = store.get('tab', 'listings');
  document.querySelector(`.tab[data-tab="${tab}"]`)?.click();
  syncInputs();
  load(true).then(() => {
    // Paylaşılan bağlantı: #ilan=<anahtar> ilanın fiyat geçmişini açar
    const m = location.hash.match(/^#ilan=(.+)$/);
    if (m) openDetail(decodeURIComponent(m[1]));
  });
  setInterval(load, POLL_MS);
})();
