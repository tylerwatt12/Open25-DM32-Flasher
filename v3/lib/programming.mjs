// SPDX-License-Identifier: GPL-3.0-or-later
// Persisted field meanings follow RadioFoundry's MIT codeplug/settings specifications
// and Classic r13's MIT RFKV extension. This module never accesses a radio.
import { SECTOR, assert, concat, crc32, equal, filled, get16, get32, u16, u32 } from './bytes.mjs';

export const CLASSIC_R13_SCHEMA = 'classic-r13-rfkv-explicit-tg-v1';
export const NATIVE_SCHEMA = 'rfkv-p25-contact-v1';
export const PROGRAMMING_WRITE_RANGES = Object.freeze([
  Object.freeze({ start: 0x700000, end: 0x710000 }),
  Object.freeze({ start: 0x79b000, end: 0x7ae000 }),
  Object.freeze({ start: 0x7af000, end: 0x7cf000 }),
]);
export const PROGRAMMING_RANGES = Object.freeze([
  PROGRAMMING_WRITE_RANGES[0], Object.freeze({ start: 0x719000, end: 0x71b000 }),
  // RX-list records continue past the contacts' last writable sector.
  Object.freeze({ start: 0x79b000, end: 0x7af000 }), PROGRAMMING_WRITE_RANGES[2],
]);
const ROOT = 0x70e000, JOURNAL = 0x719000, CONTACTS = 0x7a7620, LISTS = 0x7ad6a0;
const MAGIC = 0x564b4652, CHANNELS = 1024, CONTACT_SIZE = 24, CHANNEL_SIZE = 56;
const erased = bytes => bytes.every(b => b === 255);
const le16 = (bytes, at = 0) => get16(bytes, at, true);
const le32 = (bytes, at = 0) => get32(bytes, at, true);
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function requireFormat(condition, message) { if (!condition) fail('programming_format', message); }
function snapshot(data) {
  assert(data instanceof Uint8Array && data.length === 0x1000000, 'Programming inspection requires the identified 16 MiB data-flash snapshot.');
  return data;
}
const bitmapAddress = bank => bank === 0 ? 0x703780 : 0x79b1b0 + (bank - 1) * 7184;
const channelAddress = number => bitmapAddress(Math.floor((number - 1) / 128)) + 16 + (number - 1) % 128 * CHANNEL_SIZE;
function nameCheck(bytes) {
  let hash = 2166136261, ended = false;
  for (const byte of bytes.subarray(0, 16)) {
    const b = ended || byte === 255 ? 0 : byte;
    ended ||= b === 0; hash = Math.imul(hash ^ b, 16777619) >>> 0;
  }
  return (hash ^ hash >>> 16) & 65535;
}
function validName(bytes) {
  let ended = false, length = 0;
  for (const byte of bytes.subarray(0, 16)) {
    if (byte === 0 || byte === 255) ended = true;
    else if (ended || byte < 0x20 || byte > 0x7e && byte < 0xa0) return false;
    else length++;
  }
  return length > 0;
}
function bcd(bytes, little = false) {
  let value = 0;
  for (const byte of little ? [...bytes].reverse() : bytes) {
    if ((byte >> 4) > 9 || (byte & 15) > 9) return null;
    value = value * 100 + (byte >> 4) * 10 + (byte & 15);
  }
  return value;
}
function checkJournal(data) {
  const j0 = data.subarray(JOURNAL, JOURNAL + SECTOR), j1 = data.subarray(JOURNAL + SECTOR, JOURNAL + 2 * SECTOR);
  if (erased(j0)) return; // J1 may hold a copy staged before a header was committed.
  const magic = le32(j0), address = le32(j0, 4);
  const target = (a, length) => a >= 0 && a + length <= data.length && !(a < JOURNAL + 2 * SECTOR && a + length > JOURNAL);
  if (magic === 0x4c4e4a4f) {
    requireFormat(address % SECTOR === 0 && target(address, SECTOR) && crc32(j0.subarray(0, 12)) === le32(j0, 12) && crc32(j1) === le32(j0, 8), 'The firmware sector journal is damaged; boot the installed firmware to settle it before upgrading.');
    if (j0[16] !== 0) fail('programming_journal_pending', 'A firmware storage write is pending. Boot the installed firmware normally before upgrading.');
    return;
  }
  if (magic === 0x324e4a4f) {
    const length = le32(j0, 8), two = address % SECTOR + length > SECTOR;
    requireFormat(length > 0 && length <= SECTOR - 24 && target(address, length) && crc32(concat(j0.subarray(0, 12), j0.subarray(24, 24 + length))) === le32(j0, 12), 'The firmware patch journal is damaged; boot the installed firmware to settle it before upgrading.');
    if (j0[20] !== 0 || j0[16] !== 0 || j0[17] !== 0 || two && (j0[18] !== 0 || j0[19] !== 0))
      fail('programming_journal_pending', 'A firmware storage write is pending. Boot the installed firmware normally before upgrading.');
    return;
  }
  fail('programming_format', 'The firmware storage journal has an unrecognized format; programming migration is refused.');
}
function readKv(data) {
  const entries = [], pages = [], seen = new Set();
  let address = ROOT;
  if (erased(data.subarray(ROOT, ROOT + SECTOR))) return { entries, pages };
  while (address) {
    requireFormat(!seen.has(address) && pages.length < 33, 'The RFKV continuation chain contains a cycle or too many pages.');
    seen.add(address);
    const bytes = data.subarray(address, address + SECTOR);
    requireFormat(le32(bytes) === MAGIC && bytes[4] === 1, 'Programming uses an unrecognized RFKV format or version.');
    const header = bytes[5], length = le16(bytes, 6), next = le32(bytes, 12);
    requireFormat(header >= 16 && header + length <= SECTOR && crc32(bytes.subarray(header, header + length)) === le32(bytes, 8), 'The RFKV header, length or checksum is invalid.');
    const page = { address, header, length, bytes };
    pages.push(page);
    let at = header;
    while (at < header + length) {
      requireFormat(at + 4 <= header + length, 'An RFKV entry header is truncated.');
      const key = le16(bytes, at), size = le16(bytes, at + 2);
      requireFormat(key !== 0 && key !== 65535 && at + 4 + size <= header + length, 'An RFKV entry has an invalid key or length.');
      entries.push({ key, address: address + at, value: bytes.slice(at + 4, at + 4 + size) });
      at += 4 + size;
    }
    requireFormat(next === 0 || next % SECTOR === 0 && next >= 0xaf000 && next < 0xcf000, 'An RFKV continuation names an unknown storage range.');
    address = next ? 0x700000 + next : 0;
  }
  return { entries, pages };
}
function readChannels(data) {
  const channels = [], referenced = new Set();
  for (let number = 1; number <= CHANNELS; number++) {
    const address = channelAddress(number), bytes = data.subarray(address, address + CHANNEL_SIZE);
    // Preserve dangling references too: allocating their erased contact slot could
    // unexpectedly change another channel when it is next used.
    if (!erased(bytes)) {
      const contact = le16(bytes, 0x2e);
      if (contact >= 1 && contact <= 1024) referenced.add(contact);
    }
    const i = number - 1, bitmap = bitmapAddress(Math.floor(i / 128));
    if (!(data[bitmap + Math.floor(i % 128 / 8)] & 1 << i % 8) || erased(bytes)) continue;
    requireFormat(bytes[0x18] <= 1, 'A channel uses the retired mode-byte programming format; it is not an r13 RFKV migration source.');
    requireFormat(validName(bytes) && bcd(bytes.subarray(0x10, 0x14), true) > 0 && bcd(bytes.subarray(0x14, 0x18), true) > 0, 'An occupied channel has invalid name or frequency fields; its programming format cannot be identified safely.');
    channels.push({ number, address, bytes });
  }
  // Lists are kept byte for byte. Reserve even dormant members rather than making
  // a currently missing contact silently become a different DMR target.
  for (let index = 0; index < 76; index++) {
    const bytes = data.subarray(LISTS + index * 80, LISTS + (index + 1) * 80);
    if (erased(bytes)) continue;
    for (let at = 16; at < 80; at += 2) {
      const contact = le16(bytes, at);
      if (contact >= 1 && contact <= 1024) referenced.add(contact);
    }
  }
  return { channels, referenced };
}
function decodedContact(data, index) {
  if (index < 1 || index > 1024) return null;
  const bytes = contactAt(data, index), type = bytes[0x14];
  if (bytes[0] === 255 || type > 2) return null;
  const id = type === 2 ? 0xffffff : bcd(bytes.subarray(0x10, 0x14));
  return id >= 1 && id <= 0xffffff ? { type, id } : null;
}
function defaultContact(data, channel) {
  const direct = le16(channel.bytes, 0x2e);
  if (direct) return decodedContact(data, direct);
  const list = channel.bytes[0x2b];
  if (list < 1 || list > 76) return null;
  const count = data[0x7ad620 + list - 1];
  if (count === 0 || count === 255) return null;
  const address = LISTS + (list - 1) * 80;
  for (let i = 0; i < Math.min(count - 1, 32); i++) {
    const contact = decodedContact(data, le16(data, address + 16 + i * 2));
    if (contact && contact.type !== 1) return contact;
  }
  return null;
}
function checkClassicSemantics(data, live, first) {
  const settings = first.get(0xa02)?.value;
  let globalId = settings?.length >= 4 ? le32(settings) : 0;
  if (globalId < 1 || globalId > 0xfffffe) globalId = bcd(data.subarray(0x7000e8, 0x7000ec)) || 0;
  if (globalId > 0xffffff) globalId = 0;
  for (const tag of live) {
    const p = tag.params, v = tag.entry.value, ch = tag.bytes;
    requireFormat(v[0] === 2 && v[1] === 255, 'A channel parked by r13 names another protocol or system; its transition is not registered.');
    requireFormat(ch[0x18] === 1 && (ch[0x33] & 4) !== 0, 'An r13 P25 tag does not have the safe DMR receive-only stand-in required for external migration.');
    requireFormat((p.length < 6 || !(p[5] & 0xfe)) && (p.length < 9 || p[8] === 0), 'A channel parked by r13 requests mixed mode, security or an unknown P25 extension; upgrading would change its restrictions.');
    requireFormat(!(ch[0x26] & 4) || equal(ch.subarray(0x10, 0x14), ch.subarray(0x14, 0x18)), 'A channel parked by r13 requests unsupported split-channel talkaround.');
    if (!(p.length >= 8 && p[5] & 1)) {
      const contact = defaultContact(data, tag);
      requireFormat(!contact || contact.type !== 1 && !(contact.type === 0 && contact.id > 65535), 'A channel parked by r13 names a private call or an out-of-range P25 group; upgrading would activate unsupported semantics.');
    }
    const own = ch[0x26] & 0x80 ? ch[0x27] * 65536 + ch[0x28] * 256 + ch[0x29] : 0;
    const id = own || globalId;
    requireFormat(id <= 0xfffffe && (!(v[4] & 1) || id !== 0), 'A P25 channel has an ID that r13 could not use; repair it before upgrading.');
  }
}
function analyze(data, sourceIdentity) {
  snapshot(data); checkJournal(data);
  const kv = readKv(data), { channels, referenced } = readChannels(data);
  const first = new Map();
  for (const entry of kv.entries) if (!first.has(entry.key)) first.set(entry.key, entry);
  const explicit = [], live = [];
  for (const channel of channels) {
    const entry = first.get(0x400 + channel.number - 1);
    if (!entry) continue;
    const v = entry.value;
    requireFormat(v.length >= 5 && v[0] !== 0 && v[0] !== 255 && (!(v[4] & 4) || v.length >= 9), 'A channel-mode tag has a truncated or invalid header.');
    if (le16(v, 2) !== nameCheck(channel.bytes) || !(v[4] & 2) && !(channel.bytes[0x18] === 1 && channel.bytes[0x33] & 4)) continue;
    const at = v[4] & 4 ? 9 : 5;
    const tag = { ...channel, entry, paramsAt: at, params: v.subarray(at) };
    live.push(tag);
    if (v[0] !== 2 || tag.params.length < 6 || !(tag.params[5] & 1)) continue;
    requireFormat(v[1] === 255 && tag.params.length >= 8 && !(tag.params[5] & 0xfe) && (tag.params.length < 9 || tag.params[8] === 0), 'A P25 tag has an unsupported r13 extension (mixed mode, security, system or incomplete target); it cannot be converted safely.');
    requireFormat(!(channel.bytes[0x26] & 4) || equal(channel.bytes.subarray(0x10, 0x14), channel.bytes.subarray(0x14, 0x18)), 'An r13 P25 channel requests unsupported split-channel talkaround.');
    const talkgroup = le16(tag.params, 6);
    requireFormat(talkgroup !== 0, 'P25 talkgroup zero cannot be represented by a native contact without changing receive behavior.');
    explicit.push({ ...tag, talkgroup });
  }
  const blank = kv.pages.length === 0 && channels.length === 0 && PROGRAMMING_RANGES
    .filter(range => range.start !== JOURNAL).every(({ start, end }) => erased(data.subarray(start, end)));
  if (blank) return { ...kv, channels, referenced, explicit, schema: 'blank' };
  const known = sourceIdentity && [CLASSIC_R13_SCHEMA, NATIVE_SCHEMA].includes(sourceIdentity.schema) &&
    /^[0-9a-f]{64}$/.test(sourceIdentity.applicationSha256) && Number.isSafeInteger(sourceIdentity.applicationBytes) && sourceIdentity.applicationBytes > 0;
  if (!known) fail('programming_source_unknown', 'The installed firmware is not an identified programming-migration source. Its version label and similar-looking records cannot authorize an upgrade.');
  if (sourceIdentity.schema === CLASSIC_R13_SCHEMA) checkClassicSemantics(data, live, first);
  else requireFormat(explicit.length === 0 && kv.pages.length <= 1, 'The installed native firmware and legacy programming disagree; use the saved recovery archive before upgrading.');
  return { ...kv, channels, referenced, explicit, schema: sourceIdentity.schema };
}
export function inspectProgramming({ data, sourceIdentity }) {
  const info = analyze(data, sourceIdentity);
  return { schema: info.schema, sourceCandidates: [info.schema], channels: info.channels.length,
    explicitChannels: info.explicit.length, rfkvPages: info.pages.length };
}
function contactAt(data, index) { return data.subarray(CONTACTS + (index - 1) * CONTACT_SIZE, CONTACTS + index * CONTACT_SIZE); }
function groupTarget(bytes) {
  if (!validName(bytes) || bytes[0x14] > 2) return null;
  if (bytes[0x14] === 2) return 65535;
  if (bytes[0x14] !== 0) return null; // A private call with the same ID is different.
  const id = bcd(bytes.subarray(0x10, 0x14));
  return id >= 1 && id <= 65535 ? id : null;
}
function newContact(talkgroup) {
  const bytes = filled(CONTACT_SIZE), name = new TextEncoder().encode(`P25 TG ${talkgroup}`);
  bytes.set(name, 0);
  const digits = String(talkgroup).padStart(8, '0');
  for (let at = 0; at < 4; at++) bytes[0x10 + at] = Number(digits[at * 2]) * 16 + Number(digits[at * 2 + 1]);
  bytes.set([0, 0, 0, 1], 0x14); // Group, reserved bytes, no timeslot override.
  return bytes;
}
export function planProgrammingMigration({ data, sourceIdentity, sourceSchema, targetSchema }) {
  if (targetSchema !== NATIVE_SCHEMA) fail('programming_transition', 'The selected firmware programming schema has no registered migration.');
  const info = analyze(data, sourceIdentity);
  if (sourceSchema !== info.schema) fail('programming_source_changed', 'The programming source no longer matches the inspected schema.');
  if (![CLASSIC_R13_SCHEMA, NATIVE_SCHEMA, 'blank'].includes(sourceSchema)) fail('programming_transition', 'The source programming schema has no registered migration.');
  const changes = new Map(), targets = new Map(), free = [];
  const write = (address, bytes, role) => {
    for (let at = 0; at < bytes.length;) {
      const base = Math.floor((address + at) / SECTOR) * SECTOR;
      requireFormat(PROGRAMMING_WRITE_RANGES.some(r => base >= r.start && base + SECTOR <= r.end), 'A migration write is outside the reviewed programming ranges.');
      if (!changes.has(base)) changes.set(base, { address: base, before: data.slice(base, base + SECTOR), after: data.slice(base, base + SECTOR), role });
      const change = changes.get(base), offset = address + at - base, n = Math.min(bytes.length - at, SECTOR - offset);
      change.after.set(bytes.subarray(at, at + n), offset); at += n;
    }
  };
  for (let index = 1; index <= 1024; index++) {
    const bytes = contactAt(data, index), target = groupTarget(bytes);
    if (target !== null && !targets.has(target)) targets.set(target, index);
    if (erased(bytes) && !info.referenced.has(index)) free.push(index);
  }
  let created = 0, reused = 0;
  const replacements = new Map();
  for (const tag of info.explicit) {
    let contact = targets.get(tag.talkgroup);
    if (!contact) {
      if (!free.length) fail('programming_contacts_full', 'There are no safely unused contact slots for the r13 P25 talkgroups. No changes were written.');
      contact = free.shift(); targets.set(tag.talkgroup, contact); created++;
      write(CONTACTS + (contact - 1) * CONTACT_SIZE, newContact(tag.talkgroup), 'contacts');
    } else reused++;
    write(tag.address + 0x2e, u16(contact, true), 'channels');
    write(tag.address + 0x2b, Uint8Array.of(0), 'channels');
    const v = tag.entry.value.slice();
    // Preserve the NACs, squelch, common header, fallback and opaque suffix. Once
    // this bit is cleared, the native contact is the sole talk-target owner.
    v[tag.paramsAt + 5] &= 0xfe;
    replacements.set(tag.entry.address, v);
  }
  if (info.explicit.length || info.pages.length > 1) {
    requireFormat(info.pages.slice(1).every(page => page.header === 16), 'RFKV continuation pages contain unknown header extensions that cannot be flattened safely.');
    const root = info.pages[0], entries = concat(...info.entries.map(entry => concat(u16(entry.key, true), u16(entry.value.length, true), replacements.get(entry.address) || entry.value)));
    if (root.header + entries.length > SECTOR) fail('programming_capacity', 'All r13 programming and settings do not fit the native RFKV sector. The upgrade was refused without dropping records.');
    const bytes = root.bytes.slice();
    bytes.set(u16(entries.length, true), 6); bytes.set(u32(crc32(entries), true), 8); bytes.set(u32(0, true), 12);
    bytes.set(entries, root.header);
    write(ROOT, bytes, 'rfkv');
  }
  const order = { contacts: 0, channels: 1, rfkv: 2 };
  const plan = [...changes.values()].filter(change => !equal(change.before, change.after)).sort((a, b) => order[a.role] - order[b.role] || a.address - b.address);
  return { sourceSchema, targetSchema, changed: plan.length > 0, changes: plan,
    summary: { channelsConverted: info.explicit.length, contactsCreated: created, contactsReused: reused, rfkvPages: info.pages.length, sectorsChanged: plan.length } };
}
