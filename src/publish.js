// Siteyi GitHub Actions olmadan yayınlar: main dalındaki web/, şifreli veri ve Firefox eklentisi
// gh-pages dalına tek commit olarak yazılır; GitHub Pages siteyi bu daldan sunar.
// Mac ve tablet aynı işi yapar; dalın son commit zamanı ortak kısıt olduğu için ikisi birden yayınlamaz.
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { openStore } from './store.js';

const BRANCH = 'gh-pages';
// Daldan yayında GitHub Pages saatte ~10 yayınla sınırlı (yumuşak sınır)
export const MIN_GAP_MS = 6 * 60000;
const BOT = { name: 'aractakip-bot', email: 'aractakip-bot@users.noreply.github.com' };
const EXT_FILES = ['bg.js', 'content.js', 'popup.html', 'popup.js'];

const gitSha = (buf) => crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');

// ---------- Küçük zip (xpi) üretici: sıkıştırılmış, sabit tarihli (aynı içerik = aynı dosya) ----------
const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

export function zip(files) {
  const parts = [], central = [];
  let offset = 0;
  for (const [name, data] of files) {
    const nameBuf = Buffer.from(name);
    const comp = zlib.deflateRawSync(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6);
    head.writeUInt16LE(8, 8); head.writeUInt16LE(0, 10); head.writeUInt16LE(0x21, 12); // 1980-01-01
    head.writeUInt32LE(crc32(data), 14); head.writeUInt32LE(comp.length, 18); head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(nameBuf.length, 26); head.writeUInt16LE(0, 28);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(8, 10); cd.writeUInt16LE(0, 12); cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc32(data), 16); cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt32LE(offset, 42);
    parts.push(head, nameBuf, comp);
    central.push(cd, nameBuf);
    offset += head.length + nameBuf.length + comp.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBuf, end]);
}

// ---------- Yayın ----------
const blobCache = new Map(); // sha -> içerik (web/index.html ve eklenti dosyaları)

/** Sonuç: { published: true, commit } veya { skipped: neden } */
export async function publishSite({ force = false, store = openStore() } = {}) {
  if (store.kind !== 'github') return { skipped: 'yerel kayıt' };
  const j = async (p, init) => {
    const r = await store.api(p, init);
    if (!r.ok) throw Object.assign(new Error(`GitHub ${r.status} ${p}: ${(await r.text()).slice(0, 200)}`), { status: r.status });
    return r.json();
  };
  const blob = async (sha) => {
    if (!blobCache.has(sha)) blobCache.set(sha, Buffer.from((await j(`/git/blobs/${sha}`)).content, 'base64'));
    return blobCache.get(sha);
  };

  // Son yayın: çok yeniyse bekle (diğer cihaz da aynı kuralı uygular)
  let pages = null;
  const ref = await store.api(`/git/ref/heads/${BRANCH}`);
  if (ref.ok) pages = await j(`/git/commits/${(await ref.json()).object.sha}`);
  else if (ref.status !== 404) throw new Error(`GitHub ${ref.status} gh-pages okunamadı`);
  if (!force && pages && Date.now() - Date.parse(pages.committer.date) < MIN_GAP_MS) return { skipped: 'yakın zamanda yayınlandı' };

  const mainCommit = await j(`/git/commits/${(await j('/git/ref/heads/main')).object.sha}`);
  const tree = (await j(`/git/trees/${mainCommit.tree.sha}?recursive=1`)).tree;
  const old = new Map(pages ? (await j(`/git/trees/${pages.tree.sha}?recursive=1`)).tree.filter((e) => e.type === 'blob').map((e) => [e.path, e.sha]) : []);
  const find = (p, type = 'blob') => tree.find((e) => e.path === p && e.type === type);

  const out = new Map(); // yol -> { sha } | { data }
  // Web dosyaları; index.html'deki __BUILD__ önbellek kırıcı web klasörünün sürümüyle değişir
  const build = find('web', 'tree').sha.slice(0, 8);
  for (const e of tree) {
    if (e.type !== 'blob' || !e.path.startsWith('web/')) continue;
    const p = e.path.slice(4);
    out.set(p, p === 'index.html' ? { data: Buffer.from((await blob(e.sha)).toString('utf8').replaceAll('__BUILD__', build)) } : { sha: e.sha });
  }
  // Veri: şifreliyse yalnızca şifreli dosya
  const db = find('data/db.enc.json') || find('data/db.json');
  if (db) out.set(db.path, { sha: db.sha });
  out.set('.nojekyll', { data: Buffer.alloc(0) });

  // Firefox eklentisi: yalnızca extension/ değişince yeniden paketlenir
  const ext = find('extension', 'tree');
  const marker = Buffer.from(`${ext.sha}\n`);
  if (old.get('.ext-src') === gitSha(marker) && old.has('aractakip-firefox.xpi') && old.has('updates.json')) {
    out.set('aractakip-firefox.xpi', { sha: old.get('aractakip-firefox.xpi') });
    out.set('updates.json', { sha: old.get('updates.json') });
  } else {
    const files = [];
    for (const f of EXT_FILES) files.push([f, await blob(find(`extension/${f}`).sha)]);
    const manifest = await blob(find('extension/manifest.firefox.json').sha);
    files.push(['manifest.json', manifest]);
    const { version, browser_specific_settings: bss } = JSON.parse(manifest.toString('utf8'));
    const [owner, name] = store.repo.split('/');
    const site = `https://${owner}.github.io/${name}/`;
    out.set('aractakip-firefox.xpi', { data: zip(files) });
    out.set('updates.json', { data: Buffer.from(JSON.stringify({ addons: { [bss.gecko.id]: { updates: [{ version, update_link: `${site}aractakip-firefox.xpi` }] } } })) });
  }
  out.set('.ext-src', { data: marker });

  // Hiçbir şey değişmediyse commit atma
  for (const v of out.values()) if (v.data) v.sha = gitSha(v.data);
  if (old.size === out.size && [...out].every(([p, v]) => old.get(p) === v.sha)) return { skipped: 'değişiklik yok' };

  const entries = [];
  for (const [path, v] of out) {
    let sha = v.sha;
    if (v.data && ![...old.values()].includes(sha)) {
      sha = (await j('/git/blobs', { method: 'POST', body: JSON.stringify({ content: v.data.toString('base64'), encoding: 'base64' }) })).sha;
    }
    entries.push({ path, mode: '100644', type: 'blob', sha });
  }
  const newTree = await j('/git/trees', { method: 'POST', body: JSON.stringify({ tree: entries }) });
  const commit = await j('/git/commits', {
    method: 'POST',
    body: JSON.stringify({ message: `site: ${mainCommit.sha.slice(0, 7)}`, tree: newTree.sha, parents: pages ? [pages.sha] : [], author: BOT, committer: BOT }),
  });
  const upd = pages
    ? await store.api(`/git/refs/heads/${BRANCH}`, { method: 'PATCH', body: JSON.stringify({ sha: commit.sha, force: false }) })
    : await store.api('/git/refs', { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${BRANCH}`, sha: commit.sha }) });
  if (upd.status === 422) return { skipped: 'diğer cihaz aynı anda yayınladı' };
  if (!upd.ok) throw new Error(`GitHub ${upd.status} gh-pages güncellenemedi`);
  return { published: true, commit: commit.sha };
}
