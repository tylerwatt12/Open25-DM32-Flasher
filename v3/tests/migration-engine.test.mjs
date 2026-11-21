// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Installer } from '../lib/engine.mjs';
import { readFirmware } from '../lib/firmware.mjs';
import { verifyMigrationArchive } from '../lib/migration-archive.mjs';
import { identifyProgrammingSource, PROGRAMMING_SOURCES } from '../lib/programming-source.mjs';
import { NATIVE_SCHEMA, CLASSIC_R13_SCHEMA, inspectProgramming } from '../lib/programming.mjs';
import { APP_START, SECTOR, equal, filled, sha256 } from '../lib/bytes.mjs';
import { DM32_CODEC } from '../lib/policy.mjs';
import { jsonBytes, zip, unzip } from '../lib/zip.mjs';
import { legacyProgrammingFixture } from './programming-fixture.mjs';
import { syntheticCodec } from './codec-fixture.mjs';
import { MemoryJournal, MemoryFile } from './helpers.mjs';
const dependencyPins = JSON.parse(await readFile(new URL('../../dependencies.json', import.meta.url), 'utf8'));
const r13Bytes = new Uint8Array(await readFile(new URL('../../' + dependencyPins.migration_source_firmware.path, import.meta.url)));
assert.equal(await sha256(r13Bytes), dependencyPins.migration_source_firmware.sha256);
const r13 = await readFirmware(r13Bytes);
const application = filled(8193, 0x27);
async function packageBytes(programming = { schema: NATIVE_SCHEMA }) {
  return zip(new Map([['firmware.json', jsonBytes({ format: 'open25-dm32-firmware', version: 2,
    target: 'dm32-048', release: 'private-migration-test', applicationSha256: await sha256(application),
    codecTablesEnd: DM32_CODEC.tablesHi, programming })], ['application.bin', application]]));
}
class MigrationRadio {
  simulated = true; writes = []; resets = []; failAt = Infinity; proof = false;
  constructor({ program, data } = {}) {
    this.program = program || filled(DM32_CODEC.end); this.data = data || legacyProgrammingFixture();
    if (!program) { this.program.fill(0x51, 0, APP_START); this.program.set(r13.application, APP_START); this.program.set(syntheticCodec(), DM32_CODEC.start); }
  }
  get chips() { return { program: { jedec: 'c84014', size: this.program.length }, data: { jedec: 'ef4018', size: this.data.length } }; }
  async read(memory, address, length, progress = () => {}) {
    const bytes = this[memory].slice(address, address + length); progress({ activity: 'read', memory, start: address, length, done: length, total: length }); return bytes;
  }
  async writeMigration(plan, progress) {
    this.proof = false;
    for (const { memory, address, before } of plan) assert(equal(this[memory].subarray(address, address + SECTOR), before));
    for (let index = 0; index < plan.length; index++) {
      const { memory, address, data } = plan[index];
      if (index === this.failAt) {
        this[memory].fill(255, address, address + SECTOR); this[memory].set(data.subarray(0, SECTOR / 2), address);
        throw new Error('Synthetic power interruption during sector write');
      }
      this[memory].set(data, address); this.writes.push({ memory, address });
      await progress({ activity: 'write', done: index + 1, total: plan.length, memory, address });
    }
    this.proof = true;
  }
  async writeProgram(plan, progress) {
    return this.writeMigration(plan.map(sector => ({ ...sector, memory: 'program', before: this.program.slice(sector.address, sector.address + SECTOR) })), progress);
  }
  async restartVerified(options) { assert(this.proof); this.resets.push(options); }
}
async function setup(radio = new MigrationRadio()) {
  const journal = new MemoryJournal(), engine = new Installer({ journal });
  await engine.attach(radio); await engine.selectFirmware(await packageBytes());
  return { radio, journal, engine };
}
test('schema declarations are explicit, strict and supported by the bundled registry', async () => {
  assert.equal((await readFirmware(await packageBytes())).manifest.programming.schema, NATIVE_SCHEMA);
  for (const programming of [{ schema: 'future-v9' }, { schema: NATIVE_SCHEMA, script: 'anything' }, {}, 'native', null])
    await assert.rejects(readFirmware(await packageBytes(programming)), /Unsupported programming schema/);
});
test('source identities require complete reviewed application content and erased padding', async () => {
  const slot = filled(DM32_CODEC.start - APP_START); slot.set(r13.application);
  assert.deepEqual(await identifyProgrammingSource({ application: slot }), PROGRAMMING_SOURCES[0]);
  slot[r13.application.length + 50] = 0;
  assert.equal(await identifyProgrammingSource({ application: slot }), null);
  slot.fill(255); slot.set(application);
  assert.equal((await identifyProgrammingSource({ application: slot, targetManifest: { programming: { schema: NATIVE_SCHEMA }, applicationSha256: await sha256(application), applicationBytes: application.length } })).schema, NATIVE_SCHEMA);
});
test('preflight presents the plan, installation requires a saved recovery file, and all changed data are in the receipt', async () => {
  const { radio, engine } = await setup(), originalProgram = radio.program.slice(), originalData = radio.data.slice();
  assert.equal(engine.state.programming.sourceSchema, CLASSIC_R13_SCHEMA);
  assert.equal(engine.state.programming.summary.channelsConverted, 1); assert.equal(radio.writes.length, 0);
  await assert.rejects(engine.install({ firstInstall: false }), /recovery ZIP/); assert.equal(radio.writes.length, 0);
  const file = new MemoryFile('migration-recovery.zip'), receipt = await engine.install({ firstInstall: false, recoveryHandle: file });
  const saved = await verifyMigrationArchive(file.bytes);
  assert(equal(saved.program, originalProgram.subarray(APP_START)));
  for (const { address, before } of saved.changes) assert(equal(before, originalData.subarray(address, address + SECTOR)));
  assert.equal(saved.manifest.sourceIdentity.applicationSha256, r13.manifest.applicationSha256);
  assert.equal(saved.manifest.identity.uniqueHardwareIdentity, false);
  assert.equal(receipt.verificationMethod, 'sector-readback'); assert.equal(receipt.sectorReadbackVerified, true);
  assert.equal(receipt.readbackVerified, false); assert.equal(receipt.verificationSkipped, false);
  assert(receipt.writtenRanges.some(range => range.memory === 'data'));
  assert.deepEqual(radio.writes.at(-1), { memory: 'program', address: APP_START });
  assert.equal(inspectProgramming({ data: radio.data, sourceIdentity: { schema: NATIVE_SCHEMA, applicationSha256: await sha256(application), applicationBytes: application.length } }).schema, NATIVE_SCHEMA);
  assert.equal((await engine.completeWrite(receipt)).state, 'complete');
});
test('the final receive-list page is read and its dormant contact reference is protected', async () => {
  const radio = new MigrationRadio();
  const lastList = 0x7ad6a0 + 75 * 80; radio.data[lastList + 16] = 1; radio.data[lastList + 17] = 0;
  const { engine } = await setup(radio);
  await engine.install({ firstInstall: false, recoveryHandle: new MemoryFile() });
  assert.equal(radio.data[0x703790 + 0x2e], 2, 'Contact 1 referenced by the last RX group must remain unused.');
});
test('unknown modified firmware and changes after review stop before any writes', async () => {
  let radio = new MigrationRadio(); radio.program[APP_START + 100] ^= 1;
  let engine = new Installer({ journal: new MemoryJournal() }); await engine.attach(radio);
  await assert.rejects(engine.selectFirmware(await packageBytes()), /recognized|identity|source|unknown/i); assert.equal(radio.writes.length, 0);
  for (const memory of ['program', 'data']) {
    ({ radio, engine } = await setup()); radio[memory][memory === 'program' ? APP_START + 100 : 0x703790] ^= 1;
    await assert.rejects(engine.install({ firstInstall: false, recoveryHandle: new MemoryFile() }), /changed after review/); assert.equal(radio.writes.length, 0);
  }
});
test('a failed save/reopen, occupied filename or cancelled save cannot start migration', async () => {
  for (const failure of ['write', 'reopen', 'occupied']) {
    const { radio, engine } = await setup(), file = new MemoryFile();
    if (failure === 'write') file.createWritable = async () => { throw new Error('Disk unavailable'); };
    if (failure === 'reopen') { const original = file.getFile.bind(file); file.getFile = async () => file.bytes.length ? new Blob([Uint8Array.of(3)]) : original(); }
    if (failure === 'occupied') file.bytes = Uint8Array.of(4);
    await assert.rejects(engine.install({ firstInstall: false, recoveryHandle: file })); assert.equal(radio.writes.length, 0);
  }
});
test('power loss in contacts, channels, RFKV, application body and entry is recoverable after a fresh connection', async () => {
  const completed = await setup();
  const successful = await completed.engine.install({ firstInstall: false, recoveryHandle: new MemoryFile() });
  const total = successful.sectors.length;
  for (const failure of [0, 1, 2, 3, 20, total - 1]) {
    const { radio, journal, engine } = await setup(), originalProgram = radio.program.slice(), originalData = radio.data.slice(), file = new MemoryFile();
    radio.failAt = failure;
    await assert.rejects(engine.install({ firstInstall: false, recoveryHandle: file }), /power interruption/);
    assert.equal(engine.state.connected, false); assert.equal(radio.resets.length, 0); assert.equal((await journal.latest()).state, 'interrupted');
    await assert.rejects(engine.completeWrite(await journal.latest()), /current completed/);
    const reconnected = new MigrationRadio({ program: radio.program, data: radio.data });
    const recovery = new Installer({ journal: new MemoryJournal() }); await recovery.attach(reconnected);
    await assert.rejects(recovery.restore(file.bytes, false), /physical radio/);
    const receipt = await recovery.restore(file.bytes, true, file.name);
    assert.equal(receipt.operation, 'recovery'); assert.equal(receipt.verificationMethod, 'sector-readback');
    assert(equal(reconnected.program, originalProgram), `program restored after interruption at ${failure}`);
    assert(equal(reconnected.data, originalData), `data restored after interruption at ${failure}`);
    assert(reconnected.writes.every(({ memory, address }) => memory !== 'program' || address >= APP_START));
    if (reconnected.writes.some(({ memory, address }) => memory === 'program' && address === APP_START))
      assert.deepEqual(reconnected.writes.at(-1), { memory: 'program', address: APP_START });
    assert.equal((await recovery.completeWrite(receipt)).state, 'complete');
  }
});
test('recovery verifies archive contents and rejects a different boot or calibration fingerprint', async () => {
  const { engine } = await setup(), file = new MemoryFile(); await engine.install({ firstInstall: false, recoveryHandle: file });
  const files = unzip(file.bytes), program = files.get('program-before.bin'); program[100] ^= 1; files.set('program-before.bin', program);
  await assert.rejects(verifyMigrationArchive(zip(files)), /hash/);
  for (const memory of ['program', 'data']) {
    const radio = new MigrationRadio(); radio[memory][memory === 'program' ? 0 : 0x710000] ^= 1;
    const recovery = new Installer({ journal: new MemoryJournal() }); await recovery.attach(radio);
    await assert.rejects(recovery.restore(file.bytes, true), /match this radio|fingerprint differs/); assert.equal(radio.writes.length, 0);
  }
});


test('attribution notices remain in firmware ZIPs and unexpected payloads are rejected', async () => {
  const files = unzip(await packageBytes());
  for (const name of ['LICENSE', 'AUTHORS', 'CONTRIBUTORS', 'LICENSES/MIT.txt', 'LICENSES/newlib-COPYING.NEWLIB.txt', 'platform/hrc7000/THIRD_PARTY', 'core/mbe/THIRD_PARTY', 'third_party/FreeRTOS-Kernel/LICENSE.md', 'fonts/spleen_5x8.inc.txt', 'fonts/jbmono_6x12.inc.txt'])
    files.set('notices/' + name, new TextEncoder().encode('Copyright and permission notice.\n'));
  assert.equal((await readFirmware(zip(files))).manifest.programming.schema, NATIVE_SCHEMA);
  for (const name of ['script.js', 'notices/script.js', 'notices/LICENSES/run.mjs', 'notices/unknown/LICENSE', 'notices/fonts/font.c']) {
    const bad = new Map(files); bad.set(name, new TextEncoder().encode('unexpected'));
    await assert.rejects(readFirmware(zip(bad)), /supported attribution files/);
  }
  files.set('notices/LICENSE', Uint8Array.of(255));
  await assert.rejects(readFirmware(zip(files)), /UTF-8/);
});
test('current Classic builder package retains legal notices and declares the native schema', { skip: !process.env.CLASSIC_CANDIDATE_ZIP }, async () => {
  const bytes = new Uint8Array(await readFile(process.env.CLASSIC_CANDIDATE_ZIP)), files = unzip(bytes);
  assert(files.has('notices/LICENSE')); assert(files.has('notices/fonts/spleen_5x8.inc.txt'));
  const firmware = await readFirmware(bytes); assert.equal(firmware.manifest.target, 'dm32-048');
  assert.equal(firmware.manifest.programming.schema, NATIVE_SCHEMA);
});


test('recovery itself can be interrupted and repeated from the same saved archive', async () => {
  const { engine, radio } = await setup(), originalProgram = radio.program.slice(), originalData = radio.data.slice(), file = new MemoryFile();
  await engine.install({ firstInstall: false, recoveryHandle: file });
  const interruptedRadio = new MigrationRadio({ program: radio.program, data: radio.data }); interruptedRadio.failAt = 1;
  const interrupted = new Installer({ journal: new MemoryJournal() }); await interrupted.attach(interruptedRadio);
  await assert.rejects(interrupted.restore(file.bytes, true), /power interruption/); assert.equal(interruptedRadio.resets.length, 0);
  const connected = new MigrationRadio({ program: radio.program, data: radio.data });
  const retry = new Installer({ journal: new MemoryJournal() }); await retry.attach(connected);
  const receipt = await retry.restore(file.bytes, true);
  assert(equal(connected.program, originalProgram)); assert(equal(connected.data, originalData));
  assert.equal((await retry.completeWrite(receipt)).state, 'complete');
});
