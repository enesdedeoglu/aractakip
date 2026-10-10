// Kullanıcı tercihleri ortak kayıtta (db.prefs) tutulur; tüm cihazlar ve site aynı değeri görür.
import { openStore, ConflictError } from './store.js';
import { sleep } from './util.js';

export const DURATIONS = { '1 gün': 1, '3 gün': 3, '1 hafta': 7, 'süresiz': null };

/** action: 'durdur' | 'devam'; duration: DURATIONS anahtarı veya gün sayısı */
export async function setMailPause(action, duration = 'süresiz', by = 'site') {
  const store = openStore();
  for (let i = 0; i < 6; i++) {
    const { db, version } = await store.load();
    db.prefs ||= {};
    if (action === 'devam') db.prefs.mailPausedUntil = null;
    else {
      const days = typeof duration === 'number' ? duration : DURATIONS[duration];
      db.prefs.mailPausedUntil = days == null ? 'forever' : new Date(Date.now() + days * 86400000).toISOString();
    }
    db.prefs.mailChangedAt = new Date().toISOString();
    db.prefs.mailChangedBy = by;
    try {
      await store.save(db, version, `mail bildirimleri: ${action === 'devam' ? 'devam' : `durduruldu (${duration})`}`);
      return db.prefs;
    } catch (e) {
      if (!(e instanceof ConflictError)) throw e;
      await sleep(1500 * (i + 1));
    }
  }
  throw new Error('Kayıt güncellenemedi (çakışma)');
}
