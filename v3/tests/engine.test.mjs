import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Installer, radioRegions } from '../lib/engine.mjs';
import { APP_START, SECTOR, filled, equal, sha256 } from '../lib/bytes.mjs';
import { DM32_CODEC, prepareDm32Codec } from '../lib/policy.mjs';
import { jsonBytes, zip } from '../lib/zip.mjs';
import { verifyArchive } from '../lib/archive.mjs';
import { syntheticCodec } from './codec-fixture.mjs';
import { MemoryJournal, MemoryFile } from './helpers.mjs';

class RecordingRadio {
  simulated = true;
  program = filled(0x100000, 0x51);
  data = filled(0x1000000);
  reads = []; writes = []; resets = []; proof = false; fullProof = new Set();
  failAt = Infinity; restartError;
  constructor({ codec = true, program } = {}) {
    if (program) this.program = program.slice();
    else {
      this.program.fill(255, DM32_CODEC.start);
      if (codec) this.program.set(syntheticCodec(), DM32_CODEC.start);
    }
  }
  get chips() { return { program: { jedec: 'c84014', size: this.program.length }, data: { jedec: 'ef4018', size: this.data.length } }; }
  async read(memory, address, length, progress = () => {}, signal, stopRequested) {
    signal?.throwIfAborted();
    this.reads.push({ memory, address, length });
    const bytes = this[memory].slice(address, address + length);
    if (stopRequested?.()) return bytes.slice(0, 0);
    progress({ done: length, total: length });
    if (this.restoreTarget && address === 0 && length === this[memory].length && equal(bytes, this.restoreTarget[memory])) this.fullProof.add(memory);
    return bytes;
  }
  async writeProgram(plan, progress) {
    this.proof = false;
    for (let i = 0; i < plan.length; i++) {
      if (i === this.failAt) throw new Error('Synthetic link loss during program write');
      const { address, data } = plan[i];
      assert(address >= APP_START); assert.equal(data.length, SECTOR);
      this.program.set(data, address); this.writes.push({ memory: 'program', address });
      await progress({ done: i + 1, total: plan.length, memory: 'program', address });
    }
    this.proof = true;
  }
  async applyPlan(plan, progress) {
    this.proof = false; this.fullProof.clear();
    this.restoreTarget = { program: this.program.slice(), data: this.data.slice() };
    for (const { memory, address, before, data } of plan) {
      assert(equal(this[memory].subarray(address, address + SECTOR), before));
      this.restoreTarget[memory].set(data, address);
    }
    for (let i = 0; i < plan.length; i++) {
      const { memory, address, data } = plan[i];
      this[memory].set(data, address); this.writes.push({ memory, address });
      await progress({ done: i + 1, total: plan.length, memory, address });
    }
  }
  async restartVerified(options) {
    if (options.verificationMethod === 'sector-crc32') assert(this.proof);
    else assert(this.fullProof.has('program') && this.fullProof.has('data') || options.verificationSkipped);
    this.resets.push(options);
    if (this.restartError) throw this.restartError;
  }
}
async function firmware(target = 'dm32-048', length = 8193) {
  const application = filled(length, 0x17);
  return zip(new Map([['firmware.json', jsonBytes({ format: 'open25-dm32-firmware', version: 2,
    target, release: 'v3-test', applicationSha256: await sha256(application),
    ...(target.startsWith('dm32-') ? { codecTablesEnd: DM32_CODEC.tablesHi } : {}) })], ['application.bin', application]]));
}
function stockFile(program) {
  const bytes = filled(0x100 + program.length - APP_START);
  bytes.set(new TextEncoder().encode('BFUV32-V2')); bytes.set(new TextEncoder().encode('END'), 0xfd);
  bytes.set(program.subarray(APP_START), 0x100); return bytes;
}
async function setup(options) {
  const radio = new RecordingRadio(options), journal = new MemoryJournal(), engine = new Installer({ journal });
  await engine.attach(radio); await engine.selectFirmware(await firmware());
  radio.reads.length = 0; return { radio, journal, engine };
}

test('attach performs only boot identification and reports no raw radio contents', async () => {
  const radio = new RecordingRadio(), engine = new Installer({ journal: new MemoryJournal() });
  let report;
  await engine.attach(radio, undefined, value => { report = value; });
  await Promise.resolve();
  assert.deepEqual(radio.reads, [{ memory: 'program', address: 0, length: APP_START }]);
  // Simulators intentionally suppress optional hardware reporting only in the UI.
  assert.equal(report, undefined);
  assert(!Object.hasOwn(engine.state.identity, 'calibrationPageSha256'));
});
test('update reads only the prepared slot, writes application only, and reports checksum verification honestly', async () => {
  for (const target of ['dm32-048', 'dm32-operator']) {
    const { engine, radio } = await setup(); await engine.selectFirmware(await firmware(target));
    const boot = radio.program.slice(0, APP_START), codec = radio.program.slice(DM32_CODEC.start), data = radio.data.slice();
    const receipt = await engine.install({ firstInstall: false });
    assert.deepEqual(radio.reads, [{ memory: 'program', address: DM32_CODEC.start, length: DM32_CODEC.end - DM32_CODEC.start }]);
    assert.equal(receipt.state, 'sector-crc32-verified'); assert.equal(receipt.verificationMethod, 'sector-crc32');
    assert.equal(receipt.readbackVerified, false); assert.equal(receipt.verificationSkipped, false); assert.equal(receipt.resetSent, true);
    assert(receipt.sectors.every(p => p.memory === 'program' && p.address >= APP_START && p.address < DM32_CODEC.start));
    assert.equal(receipt.sectors.at(-1).address, APP_START);
    assert(equal(radio.program.subarray(0, APP_START), boot)); assert(equal(radio.program.subarray(DM32_CODEC.start), codec)); assert(equal(radio.data, data));
    assert.equal((await engine.completeWrite(receipt)).state, 'complete');
    await assert.rejects(engine.completeWrite(receipt), /current completed write/);
  }
});
test('update with no prepared codec stops without a native hunt, writes or completion proof', async () => {
  const { engine, radio, journal } = await setup({ codec: false });
  await assert.rejects(engine.install({ firstInstall: false }), /Choose First install/);
  assert.equal(radio.reads.length, 1); assert.equal(radio.reads[0].address, DM32_CODEC.start);
  assert.equal(radio.writes.length, 0); assert.equal(journal.records.length, 0);
});
test('first-install choice is explicit before any reads or writes', async () => {
  const { engine, radio } = await setup();
  await assert.rejects(engine.install(), /Choose First install or Update/);
  await assert.rejects(engine.install({ firstInstall: 'yes' }), /Choose First install or Update/);
  assert.equal(radio.writes.length, 0); assert.equal(radio.reads.length, 0);
});
test('first install from radio reads program once, preserves an already prepared codec, and never reads data', async () => {
  const { engine, radio } = await setup();
  const receipt = await engine.install({ firstInstall: true });
  assert.deepEqual(radio.reads, [{ memory: 'program', address: 0, length: DM32_CODEC.end }]);
  assert.equal(receipt.codec.preserved, true); assert.equal(receipt.codec.prepared, false);
  assert(receipt.sectors.every(p => p.address < DM32_CODEC.start));
});
test('first install cannot write when native codec discovery fails', async () => {
  const { engine, radio, journal } = await setup({ codec: false });
  await assert.rejects(engine.install({ firstInstall: true }), error => /^codec_/.test(error.code));
  assert.deepEqual(radio.reads, [{ memory: 'program', address: 0, length: DM32_CODEC.end }]);
  assert.equal(radio.writes.length, 0); assert.equal(journal.records.length, 0);
});
test('factory revert writes the complete application including erased tail, preserving boot and all data', async () => {
  const { engine, radio } = await setup();
  const boot = radio.program.slice(0, APP_START), data = radio.data.slice();
  const stock = filled(DM32_CODEC.end); stock.set(filled(9000, 0x25), APP_START);
  const file = stockFile(stock).slice(0, 0x100 + 9000);
  const receipt = await engine.revertFactory(file);
  assert.equal(radio.reads.length, 0); assert.equal(receipt.operation, 'factory');
  assert.equal(receipt.writtenRanges[0].end, DM32_CODEC.end);
  assert(equal(radio.program.subarray(APP_START), stock.subarray(APP_START)));
  assert(equal(radio.program.subarray(0, APP_START), boot)); assert(equal(radio.data, data));
  assert.equal(receipt.sectors.at(-1).address, APP_START);
});
test('bad factory input revokes previous completion and never starts a new write', async () => {
  const { engine, radio } = await setup();
  const receipt = await engine.install({ firstInstall: false }), writes = radio.writes.length;
  await assert.rejects(engine.revertFactory(new Uint8Array(9000)), /BFUV32/);
  await assert.rejects(engine.completeWrite(receipt), /current completed write/);
  assert.equal(radio.writes.length, writes);
});
test('partial direct write invalidates the session and is not reported complete or reset', async () => {
  const { engine, radio, journal } = await setup(); radio.failAt = 3;
  await assert.rejects(engine.install({ firstInstall: false }), /link loss/);
  assert.equal(radio.writes.length, 3); assert.equal(radio.resets.length, 0);
  assert.equal(engine.state.connected, false); assert.equal(journal.records.at(-1).state, 'interrupted');
  await assert.rejects(engine.completeWrite(journal.records.at(-1)), /current completed write/);
});
test('earned checksum completion survives restart loss without claiming that restart succeeded', async () => {
  const { engine, radio } = await setup(); radio.restartError = new Error('Device vanished during reset');
  const receipt = await engine.install({ firstInstall: false });
  assert.equal(receipt.state, 'sector-crc32-verified'); assert.equal(receipt.resetSent, false);
  assert.match(receipt.restartError.message, /vanished/); assert.equal(engine.state.connected, false);
  assert.equal((await engine.completeWrite(receipt)).state, 'complete');
});
test('manual packages cannot expand application writes into the codec slot', async () => {
  const { engine, radio } = await setup();
  await assert.rejects(engine.selectFirmware(await firmware('manual-target', DM32_CODEC.start - APP_START + 1)), /overlaps/);
  assert.equal(radio.writes.length, 0);
});
test('full backup and restore retain two-chip byte verification independently from direct flashing', async () => {
  const { engine, radio } = await setup(), file = new MemoryFile();
  const originalProgram = radio.program.slice(), originalData = radio.data.slice();
  await engine.backupToDisk(file);
  radio.program[0x1000] ^= 1; radio.data[0x100] = 0x77;
  const receipt = await engine.restore(file.bytes, true, 'private-backup.zip');
  assert(receipt.sectors.some(p => p.memory === 'program' && p.address < APP_START));
  assert(receipt.sectors.some(p => p.memory === 'data'));
  assert.equal(receipt.readbackVerified, true); assert.equal(receipt.verificationSkipped, false);
  assert(equal(radio.program, originalProgram)); assert(equal(radio.data, originalData));
  assert.equal((await engine.completeWrite(receipt)).state, 'complete');
  await assert.rejects(engine.restore(file.bytes, false), /belongs to the connected physical radio/);
});
test('radio info is read-only, reports codec and calibration presence, and labels unknown storage', async () => {
  const { engine, radio } = await setup();
  radio.data[0x1fff] = 2; radio.data.set([0, 0x40, 0, 0x47, 255, 255, 255, 255], 0x710000);
  const info = await engine.inspect();
  assert.equal(info.codec.status, 'prepared'); assert.equal(info.calibration.status, 'found');
  assert.deepEqual(info.calibration.pages, [0x1000]); assert.equal(info.calibration.fallbackPresent, true);
  assert.deepEqual(info.regions, radioRegions(), 'inspection and chip activity use the same region owner');
  assert(info.regions.some(r => r.known === false)); assert.equal(radio.writes.length, 0);
  assert(info.notes.some(n => /not a validation/.test(n)));
  radio.data[0x2fff] = 2;
  assert.equal((await engine.inspect()).calibration.status, 'ambiguous');
});
test('chip overview regions have plain hover copy and do not count nested ranges twice', () => {
  const regions = radioRegions();
  assert.equal(new Set(regions.map(region => region.id)).size, regions.length);
  for (const region of regions) {
    assert(region.name && region.contents);
    assert.doesNotMatch(region.name + region.contents, /0x[0-9a-f]+/i);
  }
  for (const memory of ['program', 'data']) {
    const overview = regions.filter(region => region.memory === memory && !region.overlay).sort((a, b) => a.start - b.start);
    for (let i = 1; i < overview.length; i++) assert(overview[i - 1].end <= overview[i].start, 'overview regions must not overlap');
    for (const region of regions.filter(region => region.memory === memory && region.overlay))
      assert(overview.some(parent => parent.start <= region.start && parent.end >= region.end), 'overlays stay within a broader region');
  }
  const changed = radioRegions(); changed[0].name = 'Caller edit';
  assert.notEqual(radioRegions()[0].name, changed[0].name, 'each view receives its own derived metadata');
});
test('a real native codec read from the radio is prepared and installed without full data reads', { skip: !process.env.DM32_OEM_BACKUP }, async () => {
  const original = await verifyArchive(new Uint8Array(await readFile(process.env.DM32_OEM_BACKUP)));
  const prepared = await prepareDm32Codec(original.images.program);
  const { engine, radio } = await setup({ program: original.images.program });
  const receipt = await engine.install({ firstInstall: true });
  assert.equal(receipt.codec.prepared, true); assert.equal(receipt.codec.profile, prepared.tag);
  assert.equal(receipt.codec.source, 'radio'); assert.equal(receipt.codec.preserved, false);
  assert(equal(radio.program.subarray(DM32_CODEC.start), prepared.slot));
  assert.equal(radio.reads.length, 1); assert.equal(radio.reads[0].memory, 'program');
  const info = new Installer({ journal: new MemoryJournal() });
  const raw = new RecordingRadio({ program: original.images.program }); await info.attach(raw);
  const summary = await info.inspect();
  assert.equal(summary.codec.status, 'native'); assert.equal(typeof summary.codec.codeOffset, 'number');
  assert.equal(typeof summary.codec.tablesOffset, 'number');
});
