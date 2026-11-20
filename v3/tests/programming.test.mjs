import test from 'node:test';
import assert from 'node:assert/strict';
import { CLASSIC_R13_SCHEMA, NATIVE_SCHEMA, PROGRAMMING_RANGES, PROGRAMMING_WRITE_RANGES,
  inspectProgramming as inspectRaw, planProgrammingMigration } from '../lib/programming.mjs';
import { concat, crc32, equal, filled, get16, get32, sha256, u16, u32 } from '../lib/bytes.mjs';
import { C_SOURCE_RECORDS, C_NATIVE_EXPECTED } from './programming-c-vectors.mjs';

// Synthetic serialized r13/native records. These contain no real radio data,
// firmware, keys or captured programming. Fixed name checks exercise the wire
// format independently of the converter's FNV implementation.
const ROOT = 0x70e000, CONTACTS = 0x7a7620;
// Identity verification itself is tested at the engine boundary against the
// published application hash. Pure format tests supply an already verified identity.
const R13_ID = { schema: CLASSIC_R13_SCHEMA, applicationSha256: 'a'.repeat(64), applicationBytes: 315648 };
const NATIVE_ID = { schema: NATIVE_SCHEMA, applicationSha256: 'b'.repeat(64), applicationBytes: 400000 };
const inspectProgramming = args => inspectRaw({ sourceIdentity: R13_ID, ...args });
const nameChecks = { 'P25 A': 1665, 'P25 B': 56749, 'RX only': 30790, DMR: 11591, 'Last channel': 20954 };
const bank = b => b ? 0x79b1b0 + (b - 1) * 7184 : 0x703780;
const chAddress = n => bank(Math.floor((n - 1) / 128)) + 16 + (n - 1) % 128 * 56;
const record = (key, value) => concat(u16(key, true), u16(value.length, true), value);
function channel(data, number = 1, name = 'P25 A', { contact = 0, list = 0, mode = 1, ownId = 0x123456 } = {}) {
  const bytes = filled(56, 0);
  bytes.fill(255, 0, 16); bytes.set(new TextEncoder().encode(name));
  bytes.set([0, 0, 0x85, 0x43], 0x10); bytes.set([0, 0, 0x85, 0x43], 0x14);
  bytes[0x18] = mode; bytes[0x19] = 5; bytes[0x33] = 4;
  bytes[0x26] = 0x80; bytes.set([ownId >> 16, ownId >> 8 & 255, ownId & 255], 0x27);
  bytes[0x2b] = list; bytes.set(u16(contact, true), 0x2e);
  const i = number - 1; data[bank(Math.floor(i / 128)) + Math.floor(i % 128 / 8)] |= 1 << i % 8;
  data.set(bytes, chAddress(number));
  return bytes;
}
function tag(name = 'P25 A', tg = 4242, { tx = true, fallback = false, params, suffix = [] } = {}) {
  return concat(Uint8Array.of(2, 255), u16(nameChecks[name], true), Uint8Array.of((tx ? 1 : 0) | (fallback ? 4 : 0)),
    fallback ? Uint8Array.of(12, 0, 0x4b, 0x2a) : new Uint8Array(),
    params || concat(Uint8Array.of(1, 0x23, 0x81, 0x56, 0x84, 1), u16(tg, true), Uint8Array.of(0)), Uint8Array.from(suffix));
}
function page(data, address, records, next = 0, extension = []) {
  const payload = concat(...records), bytes = filled(4096);
  bytes.set(new TextEncoder().encode('RFKV')); bytes[4] = 1; bytes[5] = 16 + extension.length;
  bytes.set(u16(payload.length, true), 6); bytes.set(u32(crc32(payload), true), 8); bytes.set(u32(next, true), 12);
  bytes.set(extension, 16); bytes.set(payload, bytes[5]); data.set(bytes, address);
}
function contact(data, index, { type = 0, id = 4242, timeslot = 1, partial = false } = {}) {
  const bytes = filled(24); bytes.set(new TextEncoder().encode('Existing'));
  const digits = String(id).padStart(8, '0');
  bytes.set(Array.from({ length: 4 }, (_, i) => Number(digits[i * 2]) * 16 + Number(digits[i * 2 + 1])), 16);
  bytes.set([type, 0, 0, timeslot], 20); if (partial) bytes[0] = 255;
  data.set(bytes, CONTACTS + (index - 1) * 24);
}
function fixture() {
  const data = filled(0x1000000);
  for (let b = 0; b < 8; b++) data.fill(0, bank(b), bank(b) + 16);
  channel(data); page(data, ROOT, [record(0x400, tag())]); return data;
}
function plan(data, extra = {}) {
  const sourceIdentity = Object.hasOwn(extra, 'sourceIdentity') ? extra.sourceIdentity : R13_ID;
  return planProgrammingMigration({ data, sourceIdentity, sourceSchema: inspectProgramming({ data, sourceIdentity }).schema, targetSchema: NATIVE_SCHEMA, ...extra });
}
function applied(data, migration) {
  const out = data.slice(); for (const change of migration.changes) out.set(change.after, change.address); return out;
}
const code = (data, expected) => assert.throws(() => plan(data), error => error.code === expected);

test('an erased snapshot and compatible native programming require no writes', () => {
  const blank = filled(0x1000000);
  assert.equal(inspectProgramming({ data: blank }).schema, 'blank'); assert.equal(plan(blank).changed, false);
  const data = fixture(); page(data, ROOT, [record(0x400, tag('P25 A', 1, { params: Uint8Array.of(0, 0, 0, 0, 0) }))]);
  assert.equal(inspectProgramming({ data, sourceIdentity: NATIVE_ID }).schema, NATIVE_SCHEMA); assert.deepEqual(plan(data, { sourceIdentity: NATIVE_ID }).changes, []);
});
test('r13 migration preserves speech IDs, NACs, RX policy, fallback, settings, opaque keys/tails and bytes outside its exact changes', () => {
  const data = fixture();
  channel(data, 1, 'P25 A', { contact: 900, list: 23 });
  const originalTag = tag('P25 A', 4242, { tx: false, fallback: true, suffix: [0x91, 0x92, 0x93] });
  page(data, ROOT, [record(0x8f01, Uint8Array.of(11, 22, 33)), record(0xa02, Uint8Array.of(0x12, 0x34, 0x56, 0, 9)), record(0x400, originalTag)], 0, [0xaa, 0xbb]);
  data.set([7, 8, 9], 0x711020); data.set([31, 32], 0x710070); data[0xf01234] = 0x44;
  const before = data.slice(), migration = plan(data), out = applied(data, migration);
  assert(equal(data, before), 'planning never mutates its input');
  assert.equal(migration.sourceSchema, CLASSIC_R13_SCHEMA); assert.equal(migration.summary.channelsConverted, 1);
  assert.equal(migration.summary.contactsCreated, 1); assert.equal(migration.changes.at(-1).role, 'rfkv');
  const address = chAddress(1);
  assert.equal(get16(out, address + 0x2e, true), 1); assert.equal(out[address + 0x2b], 0);
  assert.deepEqual(out.slice(address + 0x26, address + 0x2b), before.slice(address + 0x26, address + 0x2b));
  assert.equal(out[address + 0x33], 4); // Base remains RX-only; tag TX permission is unchanged.
  const newTagOffset = ROOT + 18 + record(0x8f01, Uint8Array.of(11, 22, 33)).length + record(0xa02, Uint8Array.of(0x12, 0x34, 0x56, 0, 9)).length + 4;
  const expectedTag = originalTag.slice(); expectedTag[9 + 5] = 0;
  assert.deepEqual(out.slice(newTagOffset, newTagOffset + expectedTag.length), expectedTag);
  assert.deepEqual(out.slice(CONTACTS, CONTACTS + 24), Uint8Array.from([80, 50, 53, 32, 84, 71, 32, 52, 50, 52, 50, 255, 255, 255, 255, 255, 0, 0, 0x42, 0x42, 0, 0, 0, 1]));
  for (let at = 0; at < out.length; at++) if (out[at] !== before[at])
    assert(migration.changes.some(change => at >= change.address && at < change.address + 4096), `unexpected change at ${at.toString(16)}`);
  assert.deepEqual(plan(out).changes, [], 'a second application is an exact no-op');
});
test('matching group and all-call contacts are reused, private calls are never reused, same TG channels share contacts', () => {
  const data = fixture(); channel(data, 2, 'P25 B'); channel(data, 3, 'RX only');
  contact(data, 1, { type: 1 }); contact(data, 2, { type: 0 }); contact(data, 3, { type: 2, id: 16777215 });
  page(data, ROOT, [record(0x400, tag()), record(0x401, tag('P25 B')), record(0x402, tag('RX only', 65535, { tx: false }))]);
  const migration = plan(data), out = applied(data, migration);
  assert.equal(migration.summary.contactsCreated, 0); assert.equal(migration.summary.contactsReused, 3);
  assert.equal(get16(out, chAddress(1) + 0x2e, true), 2);
  assert.equal(get16(out, chAddress(2) + 0x2e, true), 2);
  assert.equal(get16(out, chAddress(3) + 0x2e, true), 3);
  assert.deepEqual(out.slice(CONTACTS, CONTACTS + 72), data.slice(CONTACTS, CONTACTS + 72));
});
test('allocator protects dormant/dangling channel and list references and partially populated slots', () => {
  const data = fixture(); channel(data, 2, 'DMR', { contact: 1 });
  data[bank(0)] &= ~2; // Dormant record still reserves contact 1.
  data.fill(0, 0x7ad6a0, 0x7ad6a0 + 80); data.set(u16(2, true), 0x7ad6b0);
  contact(data, 3, { partial: true });
  const out = applied(data, plan(data)); assert.equal(get16(out, chAddress(1) + 0x2e, true), 4);
  const data2 = fixture(); channel(data2, 2, 'P25 B'); page(data2, ROOT, [record(0x400, tag()), record(0x401, tag('P25 B'))]);
  const migration = plan(data2); assert.equal(migration.summary.contactsCreated, 1);
  assert.equal(get16(applied(data2, migration), chAddress(2) + 0x2e, true), 1);
});
test('sparse preflight reads cover the final RX list and protect its dangling contact reference', () => {
  const data = fixture(), lastList = 0x7ad6a0 + 75 * 80;
  data.fill(0, lastList, lastList + 80); data.set(u16(1, true), lastList + 16);
  const sparse = filled(data.length);
  for (const { start, end } of PROGRAMMING_RANGES) sparse.set(data.subarray(start, end), start);
  const out = applied(sparse, plan(sparse));
  assert.equal(get16(out, chAddress(1) + 0x2e, true), 2);
  assert.equal(lastList + 80, 0x7aee60);
  assert(PROGRAMMING_RANGES.some(range => range.start <= lastList && range.end >= lastList + 80));
});
test('full contact table fails during planning without mutating any byte', () => {
  const data = fixture(); for (let i = 1; i <= 1024; i++) contact(data, i, { type: 1, id: i });
  const before = data.slice(); code(data, 'programming_contacts_full'); assert(equal(data, before));
});
test('channel 1024/contact 1 sharing an erase sector is merged once without losing either edit', () => {
  const data = fixture(); channel(data, 1024, 'Last channel');
  page(data, ROOT, [record(0x400, tag()), record(0x7ff, tag('Last channel', 1234))]);
  const migration = plan(data), out = applied(data, migration);
  assert.equal(new Set(migration.changes.map(change => change.address)).size, migration.changes.length);
  assert.equal(get16(out, chAddress(1024) + 0x2e, true), 2);
  assert.equal(out[CONTACTS], 80); assert.equal(out[CONTACTS + 24], 80);
});
test('a complete r13 continuation chain is flattened without losing duplicate order, private keys or mode settings', () => {
  const data = fixture(), a = record(0x400, tag()), shadow = record(0x400, tag('P25 A', 8888)), settings = record(0xa02, Uint8Array.of(1, 2, 3, 4, 9));
  page(data, ROOT, [a, record(0x8f03, Uint8Array.of(4, 5))], 0xaf000);
  page(data, 0x7af000, [shadow, settings]);
  const migration = plan(data), out = applied(data, migration);
  assert.equal(migration.summary.rfkvPages, 2); assert.equal(get32(out, ROOT + 12, true), 0);
  const payload = out.subarray(ROOT + 16, ROOT + 16 + get16(out, ROOT + 6, true));
  assert.deepEqual(payload.slice(-shadow.length - settings.length), concat(shadow, settings));
  assert.deepEqual(out.slice(0x7af000, 0x7b0000), data.slice(0x7af000, 0x7b0000), 'old spill bytes are preserved');
  assert.equal(inspectProgramming({ data: out, sourceIdentity: NATIVE_ID }).schema, NATIVE_SCHEMA);
});
test('oversized chains, unknown spill extensions, bad links/cycles/CRCs, future RFKV and bad entries fail closed', () => {
  const cases = [
    data => { page(data, ROOT, [record(0x400, tag()), record(0x8001, filled(3900, 1))], 0xaf000); page(data, 0x7af000, [record(0x8002, filled(200, 2))]); },
    data => { page(data, ROOT, [record(0x400, tag())], 0xaf000); page(data, 0x7af000, [], 0, [0x44]); },
    data => { data[ROOT + 12] = 3; },
    data => { page(data, ROOT, [record(0x400, tag())], 0xaf000); page(data, 0x7af000, [], 0xaf000); },
    data => { data[ROOT + 8] ^= 1; },
    data => { data[ROOT + 4] = 2; },
    data => { page(data, ROOT, [Uint8Array.of(1, 0, 9, 0, 0)]); },
  ];
  cases.forEach((change, index) => { const data = fixture(); change(data); code(data, index === 0 ? 'programming_capacity' : 'programming_format'); });
});
test('unknown/modified r13 security, mixed mode, system, TG zero and retired representations are refused', () => {
  for (const params of [Uint8Array.of(0, 0, 0, 0, 0, 1), Uint8Array.of(0, 0, 0, 0, 0, 3, 1, 0, 0), Uint8Array.of(0, 0, 0, 0, 0, 1, 1, 0, 1), Uint8Array.of(0, 0, 0, 0, 0, 0x81, 1, 0, 0)]) {
    const data = fixture(); page(data, ROOT, [record(0x400, tag('P25 A', 1, { params }))]); code(data, 'programming_format');
  }
  const zero = fixture(); page(zero, ROOT, [record(0x400, tag('P25 A', 0))]); code(zero, 'programming_format');
  const old = fixture(); old[chAddress(1) + 0x18] = 2; code(old, 'programming_format');
  const split = fixture(); split[chAddress(1) + 0x26] |= 4; split[chAddress(1) + 0x14] = 1; code(split, 'programming_format');
});
test('stale tags never transfer a talkgroup to a reused channel and later duplicate tags remain opaque', () => {
  const data = fixture(); const stale = tag(); stale[2] ^= 1;
  page(data, ROOT, [record(0x400, stale)]);
  assert.equal(inspectProgramming({ data }).schema, CLASSIC_R13_SCHEMA); assert.equal(plan(data).changed, false);
});
test('both firmware journal formats block pending transactions and admit checksum-valid completed transactions', () => {
  for (const patch of [false, true]) {
    const data = fixture(), j0 = filled(4096), target = 0x703000;
    if (patch) {
      j0.set(u32(0x324e4a4f, true)); j0.set(u32(target + 11, true), 4); j0.set(u32(3, true), 8); j0.set([4, 5, 6], 24);
      j0.set(u32(crc32(concat(j0.subarray(0, 12), j0.subarray(24, 27))), true), 12);
    } else {
      j0.set(u32(0x4c4e4a4f, true)); j0.set(u32(target, true), 4); j0.set(u32(crc32(data.subarray(0x71a000, 0x71b000)), true), 8);
      j0.set(u32(crc32(j0.subarray(0, 12)), true), 12);
    }
    data.set(j0, 0x719000); code(data, 'programming_journal_pending');
    if (patch) { data[0x719010] = 0; data[0x719011] = 0; data[0x719014] = 0; }
    else data[0x719010] = 0;
    assert.equal(plan(data).changed, true);
    data[0x71900c] ^= 1; code(data, 'programming_format');
  }
});
test('registered transitions bind the inspected source and fixed read/write scopes exclude calibration/settings/journal writes', () => {
  const data = fixture();
  assert.throws(() => plan(data, { sourceSchema: NATIVE_SCHEMA }), error => error.code === 'programming_source_changed');
  assert.throws(() => plan(data, { targetSchema: 'future' }), error => error.code === 'programming_transition');
  assert(PROGRAMMING_RANGES.some(r => r.start === 0x719000 && r.end === 0x71b000));
  assert(!PROGRAMMING_WRITE_RANGES.some(r => r.start < 0x71b000 && r.end > 0x710000));
});
test('unknown firmware cannot authorize nonblank migration, including native-looking r13 programming', () => {
  const data = fixture();
  assert.throws(() => inspectRaw({ data }), error => error.code === 'programming_source_unknown');
  assert.throws(() => plan(data, { sourceIdentity: { schema: CLASSIC_R13_SCHEMA } }), error => error.code === 'programming_source_unknown');
  page(data, ROOT, [record(0x400, tag('P25 A', 1, { params: Uint8Array.of(0, 0, 0, 0, 0) }))]);
  assert.throws(() => inspectRaw({ data }), error => error.code === 'programming_source_unknown');
  assert.equal(inspectProgramming({ data }).schema, CLASSIC_R13_SCHEMA);
});
test('identified r13 checks every native-looking live channel for previously parked semantics', () => {
  for (const modify of [
    data => { contact(data, 1, { type: 1 }); channel(data, 1, 'P25 A', { contact: 1 }); },
    data => { contact(data, 1, { id: 70000 }); channel(data, 1, 'P25 A', { contact: 1 }); },
    data => { data[chAddress(1) + 0x26] |= 4; data[chAddress(1) + 0x14] = 1; },
    data => { page(data, ROOT, [record(0x400, tag('P25 A', 1, { params: Uint8Array.of(0, 0, 0, 0, 0, 2, 0, 0, 0) }))]); },
    data => { const v = tag('P25 A', 1, { params: Uint8Array.of(0, 0, 0, 0, 0) }); v[0] = 3; page(data, ROOT, [record(0x400, v)]); },
    data => { channel(data, 1, 'P25 A', { ownId: 0xffffff }); },
    data => { const v = tag('P25 A', 1, { params: Uint8Array.of(0, 0, 0, 0, 0) }); v[4] |= 2; page(data, ROOT, [record(0x400, v)]); data[chAddress(1) + 0x18] = 0; data[chAddress(1) + 0x33] = 0; },
  ]) {
    const data = fixture(); page(data, ROOT, [record(0x400, tag('P25 A', 1, { params: Uint8Array.of(0, 0, 0, 0, 0) }))]); modify(data);
    code(data, 'programming_format');
  }
  const data = fixture();
  assert.throws(() => inspectProgramming({ data, sourceIdentity: NATIVE_ID }), error => error.code === 'programming_format');
});
test('actual r13 C-writer records migrate to bytes accepted by the current native C reader', async () => {
  const data = filled(0x1000000);
  for (const record of C_SOURCE_RECORDS) data.set(Uint8Array.from(record.hex.match(/../g), byte => Number.parseInt(byte, 16)), record.address);
  const migration = plan(data), out = applied(data, migration);
  assert.equal(migration.summary.channelsConverted, 2);
  for (const { address, length, sha256: expected } of C_NATIVE_EXPECTED)
    assert.equal(await sha256(out.subarray(address, address + length)), expected, `native C-reader vector at ${address.toString(16)}`);
  // The C reader also qualified the two inherited IDs, NAC "any", explicit
  // separate TX NAC, all-call target, common OWN/FALLBACK flags, opaque suffix,
  // existing contact owner, and original FM/DMR records in these exact bytes.
});
