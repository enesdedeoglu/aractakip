// Mail bildirimlerini durdur/devam ettir.  node scripts/mail-toggle.js durdur "1 hafta" | devam
import { setMailPause } from '../src/prefs.js';
import { loadSettings } from '../src/settings.js';

loadSettings();
const [action = 'durdur', duration = 'süresiz'] = process.argv.slice(2);
if (!['durdur', 'devam'].includes(action)) { console.error('Kullanım: durdur [1 gün|3 gün|1 hafta|süresiz] | devam'); process.exit(1); }
const prefs = await setMailPause(action, duration, process.env.CI ? 'github' : 'komut');
console.log('Mail:', prefs.mailPausedUntil ? `durduruldu (${prefs.mailPausedUntil === 'forever' ? 'süresiz' : prefs.mailPausedUntil})` : 'açık');
