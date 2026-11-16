// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Monitor, memorySelector } from '../lib/monitor.mjs';
import { BrowserSerial } from '../lib/serial.mjs';
import { Installer } from '../lib/engine.mjs';
import { readFirmware } from '../lib/firmware.mjs';
import { DM32_CODEC } from '../lib/policy.mjs';
import { APP_START, SECTOR, concat, crc32, equal, filled, get16, get32, sha256, sum8, u16, u32 } from '../lib/bytes.mjs';
import { MemoryJournal } from './helpers.mjs';
import { syntheticCodec } from './codec-fixture.mjs';

const image = new Uint8Array(await readFile(new URL('../../assets/monitor.bin', import.meta.url)));

// A packet-level radio, using synthetic bytes only. Every request is parsed;
// actual Monitor and BrowserSerial perform the host protocol and proof gating.
class WireRadio {
  queue = new Uint8Array(); monitor = false; configured = false; frames = []; loaded = []; replies = 0;
  images = { program: filled(0x100000, 3), data: filled(0x1000000, 7) };
  writes = 0; badCRCAt = Infinity; loseACKAt = Infinity; booted = false;
  get buf() { return this.queue; }
  take(count) { const bytes = this.queue.slice(0, count); this.queue = this.queue.slice(count); return bytes; }
  discard() { this.queue = new Uint8Array(); }
  reply(bytes) { this.queue = concat(this.queue, bytes); }
  response(body) { this.reply(concat(new Uint8Array([2, 5]), u16(body.length), new Uint8Array([sum8(body), 3]), body)); }
  async readExact(count, _timeout, signal) {
    signal?.throwIfAborted();
    if (this.queue.length < count) throw Object.assign(new Error('Radio reply timed out'), { code: 'serial_timeout' });
    return this.take(count);
  }
  async write(frame) {
    assert(!this.booted, 'No query after a completed reset.');
    this.frames.push(frame.slice());
    const op = frame[1];
    if (!this.monitor) {
      if (equal(frame, new Uint8Array([2, 0x14, 0, 3]))) {
        this.reply(new Uint8Array(++this.replies === 1 ? [2, 0x24, 0, 3] : [2, 0x0a, 0, 3])); return;
      }
      assert.equal(sum8(frame.subarray(4)), frame[2]);
      if (op === 0x18) {
        assert.equal(get32(frame, 8), 64);
        const offset = get32(frame, 4) - 0x10000;
        this.loaded[offset / 256] = frame.slice(12);
      } else {
        assert.equal(op, 0x1b);
        assert.equal(get32(frame, 4), 0x10000);
        assert(equal(concat(...this.loaded).subarray(0, image.length), image));
        this.monitor = true;
      }
      this.reply(new Uint8Array([2, 5, 0, 3])); return;
    }
    const p = frame.subarray(6);
    assert.equal(sum8(p), frame[4]); assert.equal(get16(frame, 2), p.length);
    assert(![11, 12].includes(op), 'The link must stay at 115200.');
    if (op === 1) {
      const hello = new Uint8Array(43);
      hello.set(new TextEncoder().encode('C7STUB')); hello[6] = 7; hello.set(u32(0x10000), 9);
      hello[17] = this.configured ? 1 : 0; this.response(hello);
    } else if (op === 2) {
      assert.equal(get32(p), 0x14000018);
      this.response(u32((0xffffffff - Math.floor(performance.now() * 24000)) >>> 0, true));
    } else if (op === 0x0d) {
      assert(equal(p.subarray(8), new Uint8Array([255, 255, 33, 32, 1, 0, 3, 0])));
      this.configured = true; this.response(new Uint8Array());
    } else if (op === 5) {
      assert.equal(p[10], 0x9f);
      this.response(new Uint8Array(p[0] === 4 ? [0xc8, 0x40, 20] : [0xef, 0x40, 24]));
    } else if (op === 7) {
      const mem = p[0] === 4 ? 'program' : 'data', address = get32(p, 6);
      this.response(concat(...Array.from({ length: get16(p, 10) }, (_, n) => concat(
        u32(crc32(this.images[mem].subarray(address + n * SECTOR, address + (n + 1) * SECTOR))), new Uint8Array([0])))));
    } else if (op === 9) {
      const mem = p[0] === 4 ? 'program' : 'data', address = get32(p, 6);
      for (let n = 0; n < p[10]; n++) {
        const bytes = this.images[mem].slice(address + n * SECTOR, address + (n + 1) * SECTOR);
        this.response(concat(u32(crc32(bytes)), new Uint8Array([0]), u16(bytes.length), bytes));
      }
    } else if (op === 14) {
      const mem = p[0] === 4 ? 'program' : 'data', address = get32(p, 6);
      assert(equal(p.subarray(0, 6), memorySelector(mem)));
      const bytes = p.length === 10 ? filled(SECTOR) : p.slice(10);
      assert.equal(bytes.length, SECTOR); assert.equal(address % SECTOR, 0);
      assert(address >= 0 && address + SECTOR <= this.images[mem].length);
      this.images[mem].set(bytes, address);
      this.writes++;
      // Like helper protocol 7, report a checksum of actual stored bytes.
      if (this.writes !== this.loseACKAt)
        this.response(u32((crc32(this.images[mem].subarray(address, address + SECTOR)) + (this.writes === this.badCRCAt ? 1 : 0)) >>> 0));
    } else if (op === 3) {
      if (get32(p) === 0x11000000) this.booted = true;
      else this.response(new Uint8Array());
    } else assert.fail(`Unexpected monitor operation ${op}`);
  }
}
function clockFor(t) {
  let now = 0;
  const descriptor = Object.getOwnPropertyDescriptor(performance, 'now');
  Object.defineProperty(performance, 'now', { value: () => now, configurable: true });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => { if (descriptor) Object.defineProperty(performance, 'now', descriptor); else delete performance.now; });
  return { async run(operation) {
    let settled = false, value, error;
    operation.then(result => { value = result; settled = true; }, reason => { error = reason; settled = true; });
    const deadline = Date.now() + 10000;
    while (!settled && Date.now() < deadline) {
      await new Promise(setImmediate);
      if (!settled) { now += 100; t.mock.timers.tick(100); }
    }
    assert(settled, 'Protocol did not settle.'); if (error) throw error; return value;
  } };
}
async function setup(t) {
  const clock = clockFor(t), wire = new WireRadio(), monitor = new Monitor(wire);
  await clock.run(monitor.start(image));
  return { clock, wire, monitor };
}
const sector = (address = APP_START, value = 9) => ({ address, data: filled(SECTOR, value) });
const writeFrames = wire => wire.frames.filter(frame => frame[1] === 14);
const resetFrames = wire => wire.frames.filter(frame => frame[1] === 3);

test('real read progress identifies each requested chip span and only advances after checked chunks', async t => {
  const { wire, monitor } = await setup(t);
  for (const [memory, start, length] of [
    ['program', DM32_CODEC.start, 0x18000],
    ['data', 0x150000, 0x26000],
  ]) {
    const events = [], framesBefore = wire.frames.length;
    const bytes = await monitor.read(memory, start, length, p => {
      if (p.done === 0) assert.equal(wire.frames.length, framesBefore, 'report the read target before any flash request');
      events.push(p);
    });
    assert(equal(bytes, wire.images[memory].subarray(start, start + length)));
    const expectedDone = [0];
    for (let done = 16 * SECTOR; done < length; done += 16 * SECTOR) expectedDone.push(done);
    expectedDone.push(length);
    assert.deepEqual(events, expectedDone.map(done => ({ activity: 'read', memory, start, length, done, total: length })));
    const frames = wire.frames.slice(framesBefore);
    assert.deepEqual(frames.filter(frame => frame[1] === 9).map(frame => get32(frame, 12)),
      expectedDone.slice(0, -1).map(done => start + done));
    assert(frames.every(frame => [7, 9].includes(frame[1])), 'progress metadata must not introduce additional radio operations');
  }
});

test('failed read progress retains only the checked prefix without reporting the requested span complete', async t => {
  const { wire, monitor } = await setup(t);
  const fault = new DOMException('Cable lost during the next read chunk', 'NetworkError');
  const start = DM32_CODEC.start, length = 0x18000, write = wire.write.bind(wire), events = [];
  wire.write = async frame => {
    if (frame[1] === 9 && get32(frame, 12) === start + 16 * SECTOR) throw fault;
    return write(frame);
  };
  await assert.rejects(monitor.read('program', start, length, p => events.push(p)), error => error === fault);
  assert.deepEqual(events, [0, 16 * SECTOR].map(done => ({ activity: 'read', memory: 'program', start, length, done, total: length })));
  assert.equal(monitor.failed, true);
  assert.equal(writeFrames(wire).length, 0);
});

// A successful direct flash checks bytes on the radio without any op09 transfer.
test('direct program writes require no snapshots or downloaded readbacks, preserve boot/data/omitted codec, and publish entry last', async t => {
  const { clock, wire, monitor } = await setup(t);
  const boot = wire.images.program.slice(0, APP_START), data = wire.images.data.slice(), codec = wire.images.program.slice(0xe8000);
  const phases = [];
  await monitor.writeProgram([sector(APP_START), sector(APP_START + SECTOR, 10), sector(APP_START + 2 * SECTOR, 255)], p => phases.push(p));
  assert.deepEqual(writeFrames(wire).map(frame => get32(frame, 12)), [APP_START + SECTOR, APP_START + 2 * SECTOR, APP_START]);
  assert.equal(writeFrames(wire)[1].length, 16, 'An erased sector uses the helper blank-write form.');
  assert(wire.frames.every(frame => ![7, 9].includes(frame[1])), 'No preflight or host readback request is allowed.');
  assert(equal(wire.images.program.subarray(0, APP_START), boot)); assert(equal(wire.images.data, data));
  assert(equal(wire.images.program.subarray(0xe8000), codec));
  assert.deepEqual(phases, [APP_START + SECTOR, APP_START + 2 * SECTOR, APP_START].map((address, index) =>
    ({ activity: 'write', done: index + 1, total: 3, memory: 'program', address, length: SECTOR })));
  await assert.rejects(monitor.restartVerified(), /current program sectors/);
  await clock.run(monitor.restartVerified({ verificationMethod: 'sector-crc32' }));
  assert.equal(wire.booted, true);
});

test('complete plan validation prevents every write if a later sector is invalid', async t => {
  const { wire, monitor } = await setup(t);
  const bad = [
    [sector(), sector(0x100000)], [sector(), sector(0)], [sector(), sector(APP_START + 1)],
    [sector(), sector(APP_START)], [sector(), { ...sector(APP_START + SECTOR), memory: 'data' }],
    [sector(), { address: APP_START + SECTOR, data: new Uint8Array(3) }],
    [sector(), { address: APP_START + SECTOR, data: new Array(SECTOR).fill(1) }],
    [sector(), null], [], null,
  ];
  for (const plan of bad) await assert.rejects(monitor.writeProgram(plan));
  assert.equal(writeFrames(wire).length, 0); assert.equal(monitor.failed, false);
  await assert.rejects(monitor.restartVerified({ verificationMethod: 'sector-crc32' }), /current program sectors/);
  assert.equal(resetFrames(wire).length, 0);
});

test('the direct plan owns copied bytes before the first mutation', async t => {
  const { wire, monitor } = await setup(t);
  const entry = sector(APP_START, 19), other = sector(APP_START + SECTOR, 20);
  await monitor.writeProgram([entry, other], p => { if (p.done === 1) entry.data.fill(99); });
  assert(wire.images.program.subarray(APP_START, APP_START + SECTOR).every(byte => byte === 19));
});

test('bad actual-flash CRC stops before the next sector, is never replayed, and cannot restart', async t => {
  const { wire, monitor } = await setup(t);
  wire.badCRCAt = 1; const events = [];
  await assert.rejects(monitor.writeProgram([sector(), sector(APP_START + SECTOR)], p => events.push(p)), /CRC failed/);
  assert.deepEqual(events, [], 'a failed sector CRC must never be shown as a confirmed write');
  assert.equal(writeFrames(wire).length, 1); assert.equal(monitor.failed, true);
  await assert.rejects(monitor.restartVerified({ verificationMethod: 'sector-crc32' }), /current program sectors/);
  assert.equal(resetFrames(wire).length, 0);
});

test('a lost direct write acknowledgement is not replayed or mistaken for completion', async t => {
  const { wire, monitor } = await setup(t);
  wire.loseACKAt = 1;
  await assert.rejects(monitor.writeProgram([sector(), sector(APP_START + SECTOR)]), error => error.code === 'serial_timeout');
  assert.equal(writeFrames(wire).length, 1); assert.equal(monitor.failed, true);
  await assert.rejects(monitor.restartVerified({ verificationMethod: 'sector-crc32' }), /current program sectors/);
});

test('fatal direct write errors preserve their original exception and never retry', async t => {
  const { wire, monitor } = await setup(t);
  const fault = new DOMException('USB device lost', 'NetworkError'), write = wire.write.bind(wire);
  wire.write = async frame => { await write(frame); if (frame[1] === 14) throw fault; };
  await assert.rejects(monitor.writeProgram([sector()]), error => error === fault);
  assert.equal(writeFrames(wire).length, 1); assert.equal(monitor.failed, true);
});

test('restart method flags cannot create direct-write proof', async t => {
  const { wire, monitor } = await setup(t);
  for (const options of [{ verificationMethod: 'sector-crc32' }, { verificationSkipped: true }, {}])
    await assert.rejects(monitor.restartVerified(options), /current program sectors/);
  assert.equal(resetFrames(wire).length, 0);
});

test('an invalid new direct attempt revokes a previous successful direct result', async t => {
  const { wire, monitor } = await setup(t);
  await monitor.writeProgram([sector()]);
  await assert.rejects(monitor.writeProgram([sector(0)]), /Invalid program/);
  await assert.rejects(monitor.restartVerified({ verificationMethod: 'sector-crc32' }), /current program sectors/);
  assert.equal(writeFrames(wire).length, 1); assert.equal(resetFrames(wire).length, 0);
});

test('a new full-image restore attempt cannot reuse direct-write proof or old snapshots', async t => {
  const { wire, monitor } = await setup(t);
  await monitor.read('program', 0, wire.images.program.length); await monitor.read('data', 0, wire.images.data.length);
  await monitor.writeProgram([sector()]);
  await assert.rejects(monitor.applyPlan([]), /Complete pre-write images/);
  await assert.rejects(monitor.restartVerified({ verificationMethod: 'sector-crc32' }), /current program sectors/);
  assert.equal(resetFrames(wire).length, 0);
});

test('in-progress direct writes cannot be restarted or concurrently replaced', async t => {
  const { wire, monitor } = await setup(t);
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const writing = monitor.writeProgram([sector(), sector(APP_START + SECTOR)], async p => {
    if (p.done === 1) {
      await assert.rejects(monitor.restartVerified({ verificationMethod: 'sector-crc32' }), /current program sectors/);
      await assert.rejects(monitor.writeProgram([sector()]), /session is not ready/);
      release();
    }
  });
  await pending; await writing;
  assert.equal(writeFrames(wire).length, 2); assert.equal(resetFrames(wire).length, 0);
});

test('full restore retains old-sector checks, downloaded readback, and both-chip final proof', async t => {
  const { clock, wire, monitor } = await setup(t);
  await monitor.read('program', 0, wire.images.program.length); await monitor.read('data', 0, wire.images.data.length);
  const plan = [
    { memory: 'program', address: 0, before: filled(SECTOR, 3), data: filled(SECTOR, 21) },
    { memory: 'data', address: 0x1000, before: filled(SECTOR, 7), data: filled(SECTOR, 22) },
  ];
  const before = wire.frames.filter(frame => frame[1] === 9).length;
  const events = [];
  await monitor.applyPlan(plan, p => events.push(p));
  assert.deepEqual(events, plan.map(({ memory, address }, index) =>
    ({ activity: 'write', done: index + 1, total: plan.length, memory, address, length: SECTOR })));
  assert.equal(wire.frames.filter(frame => frame[1] === 9).length - before, 4);
  await assert.rejects(monitor.restartVerified({ verificationMethod: 'sector-crc32' }), /current program sectors/);
  await monitor.read('program', 0, wire.images.program.length);
  await assert.rejects(monitor.restartVerified(), /Both complete/);
  await monitor.read('data', 0, wire.images.data.length);
  await clock.run(monitor.restartVerified());
  assert.equal(wire.booted, true);
  assert(wire.images.program.subarray(0, SECTOR).every(byte => byte === 21));
  assert(wire.images.data.subarray(0x1000, 0x2000).every(byte => byte === 22));
});

test('full-image corruption cannot be converted into a direct or skipped restart', async t => {
  const { wire, monitor } = await setup(t);
  await monitor.read('program', 0, wire.images.program.length); await monitor.read('data', 0, wire.images.data.length);
  await monitor.applyPlan([{ memory: 'program', address: APP_START, before: filled(SECTOR, 3), data: filled(SECTOR, 21) }]);
  wire.images.data[0x710000] ^= 1;
  await monitor.read('program', 0, wire.images.program.length);
  await assert.rejects(monitor.read('data', 0, wire.images.data.length), /authorized target/);
  await assert.rejects(monitor.restartVerified({ verificationMethod: 'sector-crc32', verificationSkipped: true }), /current program sectors/);
  assert.equal(resetFrames(wire).length, 0);
});

test('BrowserSerial uses 115200 for a real Monitor direct flash with no readback downloads', async t => {
  const clock = clockFor(t), wire = new WireRadio(), rates = [], disconnected = [];
  const port = {
    async open({ baudRate }) {
      rates.push(baudRate);
      this.readable = new ReadableStream({ start: controller => { this.controller = controller; } });
      this.writable = new WritableStream({ write: frame => wire.write(frame) });
    },
    async close() {},
  };
  wire.reply = bytes => port.controller.enqueue(bytes);
  const serial = new BrowserSerial(port, error => disconnected.push(error)), monitor = new Monitor(serial);
  await serial.open(); t.after(() => serial.close());
  await clock.run(monitor.start(image));
  await clock.run(monitor.writeProgram([sector(), sector(APP_START + SECTOR)]));
  await clock.run(monitor.restartVerified({ verificationMethod: 'sector-crc32' }));
  assert.deepEqual(rates, [115200]); assert.deepEqual(disconnected, []);
  assert(wire.frames.every(frame => ![7, 9, 11, 12].includes(frame[1])));
  assert.equal(writeFrames(wire).length, 2);
});

const catalog = JSON.parse(await readFile(new URL('../../releases/catalog.json', import.meta.url), 'utf8'));
const publicR7 = catalog.channels.find(channel => channel.id === 'classic').variants
  .flatMap(variant => variant.releases).find(release => release.version === '0.1.0-rc1-r7');
assert(publicR7, 'The actual public Classic r7 package is required for owner-boundary tests.');
const publicR7Zip = new Uint8Array(await readFile(new URL(`../../releases/${publicR7.file}`, import.meta.url)));
assert.equal(await sha256(publicR7Zip), publicR7.sha256, 'Public r7 ZIP must match its catalog SHA256.');

async function ownerSetup(t) {
  const { clock, wire, monitor } = await setup(t);
  wire.images.program.set(syntheticCodec(), DM32_CODEC.start);
  const journal = new MemoryJournal(), engine = new Installer({ journal });
  await engine.attach(monitor);
  return { clock, wire, monitor, journal, engine };
}
function assertProgramTrafficOnly(wire) {
  for (const frame of wire.frames.filter(frame => [7, 9, 14].includes(frame[1])))
    assert.equal(frame[6], 4, 'Array reads, sector sums and writes must address the program chip only.');
  assert(writeFrames(wire).every(frame => get32(frame, 12) >= APP_START), 'No direct flash writes may reach the bootloader.');
}
function factoryFile(payload) {
  const bytes = filled(0x100 + payload.length);
  bytes.set(new TextEncoder().encode('BFUV32-V2'));
  bytes.set(new TextEncoder().encode('END'), 0xfd);
  bytes.set(payload, 0x100); return bytes;
}

test('actual Installer and Monitor update the catalog-verified public r7 package with program-only CRC proof', async t => {
  const { clock, wire, monitor, journal, engine } = await ownerSetup(t);
  const boot = wire.images.program.slice(0, APP_START), codec = wire.images.program.slice(DM32_CODEC.start), data = wire.images.data.slice();
  const { application, manifest } = await readFirmware(publicR7Zip);
  await engine.selectFirmware(publicR7Zip);
  const receipt = await clock.run(engine.install({ firstInstall: false }));
  assertProgramTrafficOnly(wire);
  assert.deepEqual(wire.frames.filter(frame => frame[1] === 9).map(frame => [get32(frame, 12), frame[16]]),
    [[0, APP_START / SECTOR], [DM32_CODEC.start, 16], [DM32_CODEC.start + 16 * SECTOR, 8]],
    'Only boot identification and the prepared codec slot are downloaded.');
  const firstWrite = wire.frames.findIndex(frame => frame[1] === 14);
  assert(wire.frames.slice(firstWrite).every(frame => ![7, 9].includes(frame[1])), 'There must be no downloaded or final-sweep readback.');
  assert.equal(writeFrames(wire).length, (DM32_CODEC.start - APP_START) / SECTOR);
  assert.equal(get32(writeFrames(wire).at(-1), 12), APP_START);
  assert(equal(wire.images.program.subarray(0, APP_START), boot)); assert(equal(wire.images.data, data));
  assert(equal(wire.images.program.subarray(DM32_CODEC.start), codec));
  assert(equal(wire.images.program.subarray(APP_START, APP_START + application.length), application));
  assert(wire.images.program.subarray(APP_START + application.length, DM32_CODEC.start).every(byte => byte === 255));
  assert.equal(receipt.firmware.release, manifest.release); assert.equal(receipt.state, 'sector-crc32-verified');
  assert.equal(receipt.done, receipt.sectors.length); assert.equal(receipt.verificationMethod, 'sector-crc32');
  assert.equal(receipt.readbackVerified, false); assert.equal(receipt.verificationSkipped, false);
  assert.equal(receipt.resetSent, true); assert.equal(wire.booted, true); assert.equal(monitor.failed, false);
  assert.equal(journal.records.at(-1).state, 'sector-crc32-verified');
  const complete = await engine.completeWrite(receipt);
  assert.equal(complete.state, 'complete'); assert.equal(complete.readbackVerified, false);
  assert.equal(complete.verificationMethod, 'sector-crc32');
  await assert.rejects(engine.completeWrite(receipt), /current completed write/);
});

test('actual Installer and Monitor revert a factory-format image without pre-reading application or writing boot/data', async t => {
  const { clock, wire, engine } = await ownerSetup(t);
  const boot = wire.images.program.slice(0, APP_START), data = wire.images.data.slice();
  const payload = Uint8Array.from({ length: 9001 }, (_, index) => index * 17 % 251);
  const receipt = await clock.run(engine.revertFactory(factoryFile(payload)));
  assertProgramTrafficOnly(wire);
  assert.deepEqual(wire.frames.filter(frame => frame[1] === 9).map(frame => [get32(frame, 12), frame[16]]), [[0, APP_START / SECTOR]],
    'Factory revert performs only initial boot identification, with no full preflight or final download.');
  assert.equal(writeFrames(wire).length, (DM32_CODEC.end - APP_START) / SECTOR);
  assert.equal(get32(writeFrames(wire).at(-1), 12), APP_START);
  assert(equal(wire.images.program.subarray(0, APP_START), boot)); assert(equal(wire.images.data, data));
  assert(equal(wire.images.program.subarray(APP_START, APP_START + payload.length), payload));
  assert(wire.images.program.subarray(APP_START + payload.length).every(byte => byte === 255),
    'Stock revert erases the remaining application tail, including the former Open25 codec slot.');
  assert.equal(receipt.operation, 'factory'); assert.equal(receipt.state, 'sector-crc32-verified');
  assert.equal(receipt.verificationMethod, 'sector-crc32'); assert.equal(receipt.readbackVerified, false);
  assert.equal(receipt.resetSent, true); assert.equal(wire.booted, true);
  assert.deepEqual(receipt.writtenRanges, [{ memory: 'program', start: APP_START, end: DM32_CODEC.end }]);
  assert.equal((await engine.completeWrite(receipt)).state, 'complete');
});

test('actual Installer cannot complete or restart after Monitor rejects a written-sector CRC', async t => {
  const { clock, wire, monitor, engine, journal } = await ownerSetup(t);
  const boot = wire.images.program.slice(0, APP_START), data = wire.images.data.slice();
  await engine.selectFirmware(publicR7Zip); wire.badCRCAt = 2;
  await assert.rejects(clock.run(engine.install({ firstInstall: false })), /CRC failed/);
  assertProgramTrafficOnly(wire);
  assert.equal(writeFrames(wire).length, 2, 'A failed flash write is not retried.');
  assert.equal(resetFrames(wire).length, 0); assert.equal(wire.booted, false);
  assert.equal(engine.state.connected, false); assert.equal(monitor.failed, true);
  assert(equal(wire.images.program.subarray(0, APP_START), boot)); assert(equal(wire.images.data, data));
  const interrupted = journal.records.at(-1);
  assert.equal(interrupted.state, 'interrupted'); assert.equal(interrupted.done, 1);
  assert.equal(interrupted.readbackVerified, false); assert.match(interrupted.error, /CRC failed/);
  await assert.rejects(engine.completeWrite(interrupted), /current completed write/);
  await assert.rejects(monitor.restartVerified({ verificationMethod: 'sector-crc32' }), /current program sectors/);
});

test('actual Installer preserves earned Monitor CRC results across reset loss without replaying writes', async t => {
  const { clock, wire, engine, journal } = await ownerSetup(t);
  await engine.selectFirmware(publicR7Zip);
  const write = wire.write.bind(wire), fault = new DOMException('USB device vanished during reset', 'NetworkError');
  wire.write = async frame => {
    await write(frame);
    if (frame[1] === 3 && get32(frame, 6) === 0x11000000) throw fault;
  };
  const receipt = await clock.run(engine.install({ firstInstall: false }));
  assert.equal(receipt.state, 'sector-crc32-verified'); assert.equal(receipt.readbackVerified, false);
  assert.equal(receipt.resetSent, false); assert.equal(receipt.restartError.name, 'NetworkError');
  assert.match(receipt.restartError.message, /vanished during reset/);
  assert.equal(engine.state.connected, false); assert.equal(wire.booted, true);
  const writes = writeFrames(wire).length, frames = wire.frames.length;
  const complete = await engine.completeWrite(receipt);
  assert.equal(complete.state, 'complete'); assert.equal(complete.verificationMethod, 'sector-crc32');
  assert.equal(complete.resetSent, false); assert.equal(journal.records.at(-1).state, 'complete');
  assert.equal(writeFrames(wire).length, writes); assert.equal(wire.frames.length, frames);
});
