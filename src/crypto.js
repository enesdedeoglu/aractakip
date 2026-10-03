// Veri şifreleme: gzip + AES-256-GCM, anahtar şifreden PBKDF2-SHA256 ile türetilir.
// Dosya biçimi tarayıcıdaki WebCrypto ile birebir uyumludur (şifreli metin + 16 bayt etiket).
import crypto from 'node:crypto';
import zlib from 'node:zlib';

export const KDF_ITER = 310000;
const keyCache = new Map();

function deriveKey(password, saltB64, iter = KDF_ITER) {
  const id = `${saltB64}:${iter}:${crypto.createHash('sha256').update(password).digest('hex')}`;
  if (!keyCache.has(id)) keyCache.set(id, crypto.pbkdf2Sync(password, Buffer.from(saltB64, 'base64'), iter, 32, 'sha256'));
  return keyCache.get(id);
}

/** @param salt mevcut tuz (aynı kalmalı ki tarayıcıda hatırlanan anahtar geçerli kalsın) */
export function encryptDb(db, password, salt = null) {
  const saltB64 = salt || crypto.randomBytes(16).toString('base64');
  const key = deriveKey(password, saltB64);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plain = zlib.gzipSync(Buffer.from(JSON.stringify(db)), { level: 9 });
  const ct = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  return { v: 1, alg: 'AES-256-GCM', kdf: 'PBKDF2-SHA256', iter: KDF_ITER, gzip: true, salt: saltB64, iv: iv.toString('base64'), data: ct.toString('base64') };
}

export function decryptDb(file, password) {
  const key = deriveKey(password, file.salt, file.iter || KDF_ITER);
  const buf = Buffer.from(file.data, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(file.iv, 'base64'));
  decipher.setAuthTag(buf.subarray(buf.length - 16));
  let plain;
  try {
    plain = Buffer.concat([decipher.update(buf.subarray(0, buf.length - 16)), decipher.final()]);
  } catch {
    throw new Error('Veri çözülemedi: şifre (ARACTAKIP_DATA_KEY) yanlış');
  }
  return JSON.parse((file.gzip ? zlib.gunzipSync(plain) : plain).toString('utf8'));
}
