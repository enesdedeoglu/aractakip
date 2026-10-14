// Ajanın kendini güncellemesi: GitHub'daki main dalında yeni kod varsa güncellenip yeniden başlar.
//  - tablet ("exit"): termux-run.sh ajan kapanınca kodu çekip yeniden başlatır; ajan yalnızca kapanır
//  - Mac ("pull"): launchd ajan kapanınca yeniden başlatır ama kodu çekmez; ajan kodu kendisi çeker.
//    Yalnızca main dalındaysa ve hızlı ileri sarılabiliyorsa (yerel değişiklik yoksa) günceller.
import { execFile } from 'node:child_process';

export const LAUNCHD_LABEL = 'com.aractakip.agent';
// Değişince ajanın yeniden başlaması gereken yollar; web/ ve extension/ diskten okunduğu için yalnızca çekilir
const CODE = ['src', 'package.json', 'package-lock.json', 'config'];
const FILES = ['web', 'extension', 'scripts', 'README.md'];

/** 'exit' | 'pull' | null */
export function autoUpdateMode(env = process.env, platform = process.platform, ppid = process.ppid) {
  const v = env.ARACTAKIP_AUTOUPDATE;
  if (v === '1') return 'exit';
  if (v === 'pull') return 'pull';
  if (v === '0') return null;
  // launchd ile çalışan Mac ajanı (install-agent.sh): launchd işlerinin üst süreci launchd'dir (pid 1)
  if (platform === 'darwin' && (env.XPC_SERVICE_NAME === LAUNCHD_LABEL || ppid === 1)) return 'pull';
  return null;
}

const run = (cmd, args, cwd) => new Promise((resolve, reject) => {
  execFile(cmd, args, { cwd, encoding: 'utf8', timeout: 5 * 60000 }, (e, out, err) => (e ? reject(Object.assign(e, { stderr: err })) : resolve(out.trim())));
});

/**
 * Bir kez kontrol eder.
 * @param since çalışan kodun commit'i (ajan başlarken HEAD); kod değişikliği buna göre ölçülür ki
 *        çekme başarılı olup npm kurulumu yarıda kalırsa sonraki kontrolde yeniden denensin
 * @returns 'restart' (yeni kod hazır, ajan kapanmalı) | 'files' (yalnızca site/eklenti dosyaları çekildi) |
 *          'none' | { skipped: neden }
 */
export async function checkForUpdate({ dir, mode, since = 'HEAD', exec = run }) {
  const git = (...args) => exec('git', ['-C', dir, ...args], dir);
  const differs = (from, paths) => git('diff', '--quiet', from, 'origin/main', '--', ...paths).then(() => false, (e) => {
    if (e.code === 1) return true;
    throw e;
  });
  await git('fetch', '-q', 'origin', 'main');
  const code = await differs(since, CODE);
  if (mode === 'exit') return code ? 'restart' : 'none';
  if (!code && !(await differs('HEAD', FILES))) return 'none';
  const branch = await git('rev-parse', '--abbrev-ref', 'HEAD');
  if (branch !== 'main') return { skipped: `depo "${branch}" dalında` };
  try {
    await git('merge', '-q', '--ff-only', 'origin/main');
  } catch (e) {
    return { skipped: `kod çekilemedi, yerel değişiklik olabilir (${(e.stderr || e.message).trim().split('\n')[0]})` };
  }
  if (!code) return 'files';
  if (await differs(since, ['package.json', 'package-lock.json'])) {
    try {
      await exec('npm', ['install', '--no-audit', '--no-fund'], dir);
    } catch (e) {
      return { skipped: `npm install başarısız (${(e.stderr || e.message).trim().split('\n')[0]})` };
    }
  }
  return 'restart';
}
