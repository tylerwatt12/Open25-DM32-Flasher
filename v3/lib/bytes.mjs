// SPDX-License-Identifier: GPL-3.0-or-later
export const SECTOR = 4096;
export const PAGE = 256;
export const APP_START = 0xc000;
export const encoder = new TextEncoder();
export const decoder = new TextDecoder('utf-8', { fatal: true });
export function assert(condition, message) { if (!condition) throw new Error(message); }
export function concat(...arrays) {
  const result = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let offset = 0;
  for (const a of arrays) { result.set(a, offset); offset += a.length; }
  return result;
}
export function equal(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
export const hex = a => Array.from(a, x => x.toString(16).padStart(2, '0')).join('');
export async function sha256(a) { return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', a))); }
export function u32(value, little = false) {
  const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, value, little); return b;
}
export function u16(value, little = false) {
  const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, value, little); return b;
}
export const get32 = (a, offset = 0, little = false) => new DataView(a.buffer, a.byteOffset, a.byteLength).getUint32(offset, little);
export const get16 = (a, offset = 0, little = false) => new DataView(a.buffer, a.byteOffset, a.byteLength).getUint16(offset, little);
export const sum8 = a => a.reduce((sum, b) => sum + b, 0) & 255;
export const filled = (n, value = 255) => new Uint8Array(n).fill(value);
export function range(address, length, size) {
  assert(Number.isSafeInteger(address) && Number.isSafeInteger(length) && address >= 0 && length > 0 && address + length <= size, 'Address is outside the identified flash chip.');
}
const table = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const b of bytes) crc = table[(crc ^ b) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
export const sleep = (ms, signal) => new Promise((resolve, reject) => {
  signal?.throwIfAborted();
  const abort = () => { clearTimeout(timer); reject(signal.reason); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
  signal?.addEventListener('abort', abort, { once: true });
});
export async function sectorHashes(data) {
  const hashes = [];
  for (let a = 0; a < data.length; a += SECTOR) hashes.push(await sha256(data.subarray(a, a + SECTOR)));
  return hashes;
}
