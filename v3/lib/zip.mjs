// SPDX-License-Identifier: GPL-3.0-or-later
// Deliberately small ZIP subset: stored entries, no encryption or ZIP64.
// Attribution names are retained in memory; archives are never extracted to disk.
import { assert, concat, crc32, decoder, encoder, get16, get32 } from './bytes.mjs';
export const MAX_ARCHIVE = 48 * 1024 * 1024;
const component = name => /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/.test(name);
const safeName = name => component(name) || name.startsWith('notices/') && name.length <= 192 && name.split('/').every(component);
function header(length) { const bytes = new Uint8Array(length); return [bytes, new DataView(bytes.buffer)]; }
export function zip(entries) {
  assert(entries instanceof Map && entries.size > 0 && entries.size <= 128, 'Invalid archive entries.');
  const parts = [], central = [];
  let offset = 0;
  for (const [name, data] of entries) {
    assert(safeName(name) && data instanceof Uint8Array, 'Invalid archive file.');
    const filename = encoder.encode(name), crc = crc32(data);
    const [local, l] = header(30);
    l.setUint32(0, 0x04034b50, true); l.setUint16(4, 20, true);
    l.setUint16(12, 0x21, true); l.setUint32(14, crc, true);
    l.setUint32(18, data.length, true); l.setUint32(22, data.length, true); l.setUint16(26, filename.length, true);
    parts.push(local, filename, data);
    const [record, c] = header(46);
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true);
    c.setUint16(14, 0x21, true); c.setUint32(16, crc, true);
    c.setUint32(20, data.length, true); c.setUint32(24, data.length, true);
    c.setUint16(28, filename.length, true); c.setUint32(42, offset, true);
    central.push(record, filename); offset += local.length + filename.length + data.length;
  }
  const directory = concat(...central), [end, e] = header(22);
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, entries.size, true); e.setUint16(10, entries.size, true);
  e.setUint32(12, directory.length, true); e.setUint32(16, offset, true);
  const result = concat(...parts, directory, end);
  assert(result.length <= MAX_ARCHIVE, 'Archive exceeds the supported size.');
  return result;
}
export function unzip(bytes) {
  assert(bytes instanceof Uint8Array && bytes.length >= 22 && bytes.length <= MAX_ARCHIVE, 'Invalid archive size.');
  const end = bytes.length - 22;
  assert(get32(bytes, end, true) === 0x06054b50 && get16(bytes, end + 20, true) === 0, 'Unsupported or incomplete ZIP archive.');
  const count = get16(bytes, end + 10, true), directorySize = get32(bytes, end + 12, true), directoryOffset = get32(bytes, end + 16, true);
  assert(count > 0 && count <= 128 && get16(bytes, end + 8, true) === count && get32(bytes, end + 4, true) === 0, 'Multi-volume or excessive ZIP archive.');
  assert(directoryOffset + directorySize === end, 'Invalid ZIP directory.');
  const files = new Map(); let position = directoryOffset, expectedLocal = 0;
  for (let i = 0; i < count; i++) {
    assert(position + 46 <= end && get32(bytes, position, true) === 0x02014b50, 'Invalid ZIP entry.');
    const flags = get16(bytes, position + 8, true), method = get16(bytes, position + 10, true);
    const crc = get32(bytes, position + 16, true), compressed = get32(bytes, position + 20, true), length = get32(bytes, position + 24, true);
    const nameLength = get16(bytes, position + 28, true), extra = get16(bytes, position + 30, true), comment = get16(bytes, position + 32, true), local = get32(bytes, position + 42, true);
    assert(flags === 0 && method === 0 && compressed === length && extra === 0 && comment === 0 && get16(bytes, position + 34, true) === 0, 'Only uncompressed, unencrypted single-volume archives are supported.');
    assert(position + 46 + nameLength <= end, 'Truncated ZIP name.');
    const name = decoder.decode(bytes.subarray(position + 46, position + 46 + nameLength));
    assert(safeName(name) && !files.has(name), 'Unsafe or duplicate archive filename.');
    assert(local === expectedLocal && local + 30 + nameLength + length <= directoryOffset, 'Overlapping or truncated ZIP contents.');
    assert(get32(bytes, local, true) === 0x04034b50 && get16(bytes, local + 6, true) === 0 && get16(bytes, local + 8, true) === 0 && get16(bytes, local + 26, true) === nameLength && get16(bytes, local + 28, true) === 0, 'ZIP headers disagree.');
    assert(get32(bytes, local + 14, true) === crc && get32(bytes, local + 18, true) === length && get32(bytes, local + 22, true) === length, 'ZIP lengths or CRCs disagree.');
    assert(decoder.decode(bytes.subarray(local + 30, local + 30 + nameLength)) === name, 'ZIP filenames disagree.');
    const data = bytes.slice(local + 30 + nameLength, local + 30 + nameLength + length);
    assert(crc32(data) === crc, `Archive integrity check failed: ${name}`);
    files.set(name, data); expectedLocal = local + 30 + nameLength + length; position += 46 + nameLength;
  }
  assert(position === end && expectedLocal === directoryOffset, 'Unexpected data in ZIP archive.');
  return files;
}
export const jsonBytes = value => encoder.encode(JSON.stringify(value, null, 2) + '\n');
export function readJSON(files, name) {
  const data = files.get(name);
  assert(data && data.length <= 2 * 1024 * 1024, `Missing or excessive ${name}.`);
  try { return JSON.parse(decoder.decode(data)); } catch { throw new Error(`Invalid ${name}.`); }
}
