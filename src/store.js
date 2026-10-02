// Veri deposu: tek bir data/db.json dosyası.
//  - fs     : yerel dosya (geliştirme)
//  - github : GitHub Contents API (bulut + yerel ajan aynı dosyaya yazar, sha ile çakışma kontrolü)
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { loadSettings } from './settings.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DB_PATH = 'data/db.json';

export function emptyDb() {
  return { version: 1, updatedAt: null, sources: {}, listings: {}, events: [], market: null, model: null };
}

export class ConflictError extends Error {}

class FsStore {
  constructor(file = path.join(ROOT, DB_PATH)) { this.file = file; this.kind = 'fs'; }
  async load() {
    try { return { db: JSON.parse(await fs.readFile(this.file, 'utf8')), version: null }; }
    catch (e) { if (e.code === 'ENOENT') return { db: emptyDb(), version: null }; throw e; }
  }
  async save(db) {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(db));
    await fs.rename(tmp, this.file);
  }
}

function ghToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  try { return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim(); } catch { return null; }
}

class GithubStore {
  constructor(repo, branch = 'main') {
    this.kind = 'github';
    this.repo = repo;
    this.branch = branch;
    this.token = ghToken();
    if (!this.token) throw new Error('GitHub token yok (GITHUB_TOKEN veya `gh auth login`)');
  }
  async api(p, init = {}) {
    const res = await fetch(`https://api.github.com/repos/${this.repo}${p}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github.object+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(init.headers || {}),
      },
      signal: AbortSignal.timeout(60000),
    });
    return res;
  }
  async load() {
    const res = await this.api(`/contents/${DB_PATH}?ref=${this.branch}`);
    if (res.status === 404) return { db: emptyDb(), version: null };
    if (!res.ok) throw new Error(`GitHub okuma hatası ${res.status}: ${await res.text()}`);
    const meta = await res.json();
    let b64 = meta.content;
    if (!b64 || meta.encoding === 'none') {
      const blob = await (await this.api(`/git/blobs/${meta.sha}`)).json();
      b64 = blob.content;
    }
    return { db: JSON.parse(Buffer.from(b64, 'base64').toString('utf8')), version: meta.sha };
  }
  async save(db, version, message) {
    const body = {
      message: message || 'veri güncellemesi',
      content: Buffer.from(JSON.stringify(db)).toString('base64'),
      branch: this.branch,
      committer: { name: 'aractakip-bot', email: 'aractakip-bot@users.noreply.github.com' },
    };
    if (version) body.sha = version;
    const res = await this.api(`/contents/${DB_PATH}`, { method: 'PUT', body: JSON.stringify(body) });
    if (res.status === 409 || res.status === 422) throw new ConflictError(`GitHub çakışma ${res.status}`);
    if (!res.ok) throw new Error(`GitHub yazma hatası ${res.status}: ${await res.text()}`);
  }
}

export function openStore() {
  const repo = process.env.ARACTAKIP_REPO || readRepoConfig();
  const kind = process.env.STORE || (repo ? 'github' : 'fs');
  if (kind === 'github') return new GithubStore(repo, process.env.ARACTAKIP_BRANCH || 'main');
  return new FsStore();
}

function readRepoConfig() {
  return loadSettings().repo || null;
}

export { ROOT };
