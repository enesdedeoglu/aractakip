// İlan açıklamasından bilgi çıkarır: tramer tutarı ("tramer 85 bin", "12.500 TL tramer", "tramersiz").
// Opsiyon etiketleri (FSD, PPF, Quicksilver…) ve hasar ifadeleri classify.js'te başlık + açıklama üzerinden okunur.
import { fold } from './classify.js';

const NUM = String.raw`(\d{1,3}(?:[.,]\d{3})+|\d+(?:[.,]\d+)?)\s*(milyon|bin|k(?![a-z])|tl|₺)?`;
// "tramer kaydı: 85 bin", "tramer tutarı 12.500 TL", "tramer 85k"
const AFTER = new RegExp(String.raw`tramer(?:i|li|siz)?(?:\s*(?:kaydi|kayit|tutari|bedeli|miktari|var|mevcut|toplam|olarak|:|-|=))*\s*${NUM}`, 'g');
// "85 bin tramer", "12.500 TL'lik tramer", "85.000 tramerli"
const BEFORE = new RegExp(String.raw`${NUM}\s*(?:'?l[iı]k\s*)?tramer`, 'g');
const ZERO = /tramersiz|tramer\s*(?:kaydi\s*)?(?:yok|yoktur|bulunmamaktadir|bulunmuyor|temiz|0\b)|(?<!agir\s?)hasar\s*kaydi\s*yok/;

function amount(num, unit) {
  let v = Number(num.replace(/[.,](?=\d{3}(\D|$))/g, '').replace(',', '.'));
  if (!Number.isFinite(v)) return null;
  if (unit === 'milyon') v *= 1e6;
  else if (unit === 'bin' || unit === 'k') v *= 1000;
  else if (v < 1000) {
    if (unit) return null; // "500 TL" gibi anlamsız küçük tutar
    v *= 1000; // birimsiz küçük sayı: "tramer 85" → 85 bin
  }
  // Yıl gibi görünen birimsiz sayılar (ör. "2024 tramer sorgusu") tutar değildir
  if (!unit && v >= 2000 && v <= 2030) return null;
  return v >= 1000 && v <= 5e6 ? Math.round(v) : null;
}

/** @returns { tramer: number|null } – tutar bulunamadı ama "tramersiz" yazıyorsa 0 */
export function parseDescription(text) {
  const t = fold(text || '').replace(/\s+/g, ' ');
  if (!t) return { tramer: null };
  const found = [];
  for (const re of [AFTER, BEFORE]) {
    re.lastIndex = 0;
    for (const m of t.matchAll(re)) {
      // "tramer 85 bin yok" gibi olumsuz cümle ya da "2 parça" gibi sayılar atlanır
      const rest = t.slice(m.index + m[0].length, m.index + m[0].length + 14);
      if (/^\s*(parca|adet|yil|km|kilometre|ay\b)/.test(rest)) continue;
      const v = amount(m[1], m[2]);
      if (v != null) found.push(v);
    }
  }
  if (found.length) return { tramer: Math.max(...found) };
  return { tramer: ZERO.test(t) ? 0 : null };
}
