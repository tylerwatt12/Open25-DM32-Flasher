// SPDX-License-Identifier: GPL-3.0-or-later
// Monitor protocol and ROM entry adapted from MIT RadioFoundry; see THIRD_PARTY.md.
import { APP_START, PAGE, SECTOR, assert, concat, crc32, equal, filled, get16, get32, hex, range, sha256, sleep, sum8, u16, u32 } from './bytes.mjs';
import { MONITOR_SHA256, DM32_CODEC } from './policy.mjs';
import { PROGRAMMING_WRITE_RANGES } from './programming.mjs';

export const memorySelector = memory => {
  assert(memory === 'program' || memory === 'data', 'Unknown flash chip.');
  return memory === 'program' ? new Uint8Array([4, 0, 0, 0, 1, 0]) : new Uint8Array([0x14, 0x0a, 0, 0, 3, 18]);
};
export const monitorFrame = (op, payload = new Uint8Array()) => concat(new Uint8Array([2, op]), u16(payload.length), new Uint8Array([sum8(payload), 3]), payload);
const romFrame = (op, payload) => concat(new Uint8Array([2, op, sum8(payload), 3]), payload);
const ROM_HELLO = new Uint8Array([2, 0x24, 0, 3]), ROM_ACK = new Uint8Array([2, 5, 0, 3]);
const ROM_REPLY = new Uint8Array([2, 0x14, 0, 3]), ROM_NAK = new Uint8Array([2, 0x0a, 0, 3]), ROM_GAVE_UP = new Uint8Array([0, 0x10, 0, 3]);
function find(buf, pattern) {
  outer: for (let i = 0; i + pattern.length <= buf.length; i++) {
    for (let k = 0; k < pattern.length; k++) if (buf[i + k] !== pattern[k]) continue outer;
    return i;
  }
  return -1;
}
const READ_ATTEMPTS = 3;
class ReadFrameError extends Error {}
const frameCheck = (condition, message) => { if (!condition) throw new ReadFrameError(message); };
const recoverableRead = error => error instanceof ReadFrameError || error?.code === 'serial_timeout';

export function decodeSector(method, packed) {
  if (method === 2) { assert(packed.length === 0, 'Malformed blank sector.'); return filled(SECTOR); }
  if (method === 0) { assert(packed.length === SECTOR, 'Short raw sector.'); return packed; }
  assert(method === 1, 'Unsupported sector encoding.');
  const out = new Uint8Array(SECTOR); let i = 0, o = 0;
  function extended(n) {
    if (n === 15) { let b; do { assert(i < packed.length, 'Truncated compressed sector.'); b = packed[i++]; n += b; } while (b === 255); }
    return n;
  }
  while (i < packed.length) {
    const token = packed[i++], literals = extended(token >>> 4);
    assert(i + literals <= packed.length && o + literals <= SECTOR, 'Compressed sector exceeds bounds.');
    out.set(packed.subarray(i, i + literals), o); i += literals; o += literals;
    if (i === packed.length) break;
    assert(i + 2 <= packed.length, 'Truncated match offset.');
    const offset = get16(packed, i, true); i += 2;
    const length = extended(token & 15) + 4;
    assert(offset > 0 && offset <= o && o + length <= SECTOR, 'Invalid compressed sector match.');
    for (let n = 0; n < length; n++) { out[o] = out[o - offset]; o++; }
  }
  assert(o === SECTOR, 'Incomplete compressed sector.'); return out;
}

export class Monitor {
  #io; #configured = false; #chips; #started = false; #failed = false; #full = {}; #target; #verified = new Set(); #writing = false;
  #writeCompleted = false; #readbackSkipped = false; #sectorCrcVerified = false; #sectorReadbackVerified = false;
  constructor(io) { this.#io = io; }
  get simulated() { return false; }
  get failed() { return this.#failed; }
  get chips() { return this.#chips ? structuredClone(this.#chips) : undefined; }
  async #response(timeout = 4000, signal) {
    const header = await this.#io.readExact(6, timeout, signal);
    frameCheck(header[0] === 2 && header[5] === 3, 'Malformed monitor reply.');
    const length = get16(header, 2);
    frameCheck(length <= 8192, 'Excessive monitor reply.');
    const payload = await this.#io.readExact(length, timeout, signal);
    frameCheck(sum8(payload) === header[4], 'Serial reply checksum failed.');
    frameCheck(header[1] !== 10, 'Radio received a damaged request.');
    assert(header[1] === 5, `Radio refused the operation (status ${header[1]}).`);
    return payload;
  }
  async #request(op, payload = new Uint8Array(), timeout, signal) {
    assert(!this.#failed, 'Session stopped after an error. Reconnect before continuing.');
    signal?.throwIfAborted();
    await this.#io.write(monitorFrame(op, payload)); return this.#response(timeout, signal);
  }
  async #drain(signal, pendingBytes = 0) {
    // A cut-short burst may still be arriving. Wait for a quiet line before
    // another read; its independent sector sums will also catch stale records.
    const notBefore = performance.now() + Math.ceil(pendingBytes * 10000 / 115200) + (pendingBytes ? 100 : 0);
    const until = Math.max(performance.now() + 8000, notBefore + 1000);
    for (;;) {
      signal?.throwIfAborted();
      frameCheck(performance.now() < until, 'Serial traffic did not become quiet. Reconnect and try again.');
      this.#io.discard();
      try { await this.#io.readExact(1, 100, signal); }
      catch (error) {
        signal?.throwIfAborted();
        if (error?.code === 'serial_timeout') {
          if (performance.now() >= notBefore) { this.#io.discard(); return; }
          await sleep(Math.min(100, notBefore - performance.now()), signal);
          continue;
        }
        throw error;
      }
    }
  }
  async #waitForRom(signal) {
    const until = performance.now() + 120000;
    this.#io.discard();
    // RadioFoundry sends ahead in the background: awaiting a write here can
    // stretch the 30 ms cadence past the ROM's approximately 48 ms window.
    let sending = Promise.resolve(), next = 0, heard, failed;
    try {
      while (performance.now() < until) {
        signal?.throwIfAborted();
        if (performance.now() >= next) {
          next = performance.now() + 30;
          sending = sending.then(() => { signal?.throwIfAborted(); return this.#io.write(ROM_REPLY); }).catch(error => { failed ||= error; });
        }
        if (failed) throw failed;
        const b = this.#io.buf, at = find(b, ROM_HELLO);
        if (at >= 0) {
          this.#io.take(at + ROM_HELLO.length); heard = performance.now(); continue;
        }
        // A NAK of a repeated answer proves the ROM accepted an earlier one,
        // including when its greeting was lost on the way back through USB.
        if (find(b, ROM_NAK) >= 0 || (heard !== undefined && find(b, ROM_GAVE_UP) < 0 && performance.now() - heard >= 150)) {
          this.#io.take(b.length); return;
        }
        if (find(b, ROM_GAVE_UP) >= 0) {
          this.#io.take(b.length);
          throw new Error('Radio left its power-on loader. Switch it off and on, then reconnect.');
        }
        if (b.length > 64) this.#io.take(b.length - 3);
        await sleep(1, signal);
      }
      throw new Error('No power-on handshake. Check the cable and switch the radio off and on.');
    } finally {
      await sending;
      if (failed) throw failed;
    }
  }
  async #romAck(sent, signal) {
    const until = performance.now() + 1000;
    for (;;) {
      signal?.throwIfAborted();
      const b = this.#io.buf, n = Math.min(b.length, sent.length);
      const echo = n > 0 && equal(b.subarray(0, n), sent.subarray(0, n));
      if (echo && b.length >= sent.length && !equal(b.subarray(0, 4), ROM_ACK)) {
        this.#io.take(sent.length); continue;
      }
      const ends = pattern => b.length >= 4 && equal(b.subarray(b.length - 4), pattern);
      if (ends(ROM_ACK) && !(echo && b.length < sent.length)) { this.#io.take(b.length); return true; }
      if (!echo && find(b, ROM_GAVE_UP) >= 0)
        throw new Error('Radio left its power-on loader. Switch it off and on, then reconnect.');
      if ((!echo && ends(ROM_NAK)) || performance.now() >= until) return false;
      await sleep(1, signal);
    }
  }
  async #sendRom(frame, attempts, signal) {
    for (let attempt = 0; attempt < attempts; attempt++) {
      signal?.throwIfAborted();
      this.#io.discard();
      await this.#io.write(frame);
      if (await this.#romAck(frame, signal)) return;
    }
    throw new Error('RAM-loader acknowledgement failed.');
  }
  async start(image, progress = () => {}, signal) {
    assert(!this.#started, 'Monitor already started.');
    try {
      assert(await sha256(image) === MONITOR_SHA256, 'RAM monitor failed its pinned integrity check.');
      progress({ phase: 'connect', waitingForPowerCycle: true, message: 'Turn the radio OFF, then ON normally with the cable seated. Do not hold any buttons.' });
      await this.#waitForRom(signal);
      progress({ phase: 'connect', message: 'Radio detected. Keep it powered on and connected.' });
      // Repeated greeting answers can leave NAKs or cable echoes in flight.
      // The accepted ROM has no timeout: wait for a quiet line before block 0.
      await sleep(50, signal);
      let reply = this.#io.take(this.#io.buf.length);
      for (let quiet = 0, until = performance.now() + 1500; quiet < 100 && performance.now() < until; quiet += 10) {
        await sleep(10, signal);
        if (this.#io.buf.length) { reply = concat(reply, this.#io.take(this.#io.buf.length)); quiet = -10; }
      }
      assert(find(reply, ROM_GAVE_UP) < 0, 'Radio left its power-on loader. Switch it off and on, then reconnect.');
      const padded = filled(Math.ceil(image.length / PAGE) * PAGE); padded.set(image);
      for (let offset = 0; offset < padded.length; offset += PAGE) {
        signal?.throwIfAborted();
        await this.#sendRom(romFrame(0x18, concat(u32(0x10000 + offset), u32(64), padded.subarray(offset, offset + PAGE))), 3, signal);
      }
      // Fixed-address RAM blocks may be resent. An uncertain jump is not replayed.
      await this.#sendRom(romFrame(0x1b, u32(0x10000)), 1, signal); this.#started = true;
      const helloDeadline = performance.now() + 3000;
      for (;;) {
        signal?.throwIfAborted();
        try { await this.#hello(signal, 1000); break; }
        catch (error) {
          signal?.throwIfAborted();
          if (performance.now() >= helloDeadline) throw error;
          this.#io.discard();
          await sleep(1, signal);
        }
      }
      const before = performance.now(); const v0 = get32(await this.#request(2, concat(u32(0x14000018), u16(4))), 0, true);
      await sleep(300);
      const after = performance.now(); const v1 = get32(await this.#request(2, concat(u32(0x14000018), u16(4))), 0, true);
      const hz = Math.round(((v0 - v1) >>> 0) / ((after - before) / 1000) / 1e6) * 1e6;
      assert(hz > 1e6 && hz < 4e8, 'Radio timer measurement failed.');
      await this.#request(0x0d, concat(u32(hz), u32(hz), new Uint8Array([255, 255, 33, 32, 1, 0, 3, 0])));
      const hello = await this.#hello();
      assert(hello[17] === 1 && hello[18] === 0, 'DM32 monitor configuration was not confirmed.');
      this.#configured = true; this.#chips = {};
      for (const memory of ['program', 'data']) {
        const id = await this.#spi(memory, new Uint8Array([0x9f]), 3);
        assert(id[0] !== 0 && id[0] !== 255 && id[1] !== 0 && id[1] !== 255 && (id[2] >= 12 && id[2] <= 24), 'Unsupported or missing flash chip.');
        this.#chips[memory] = { jedec: hex(id), size: 2 ** id[2] };
      }
      return this.chips;
    } catch (error) { this.#configured = false; this.#failed = true; throw error; }
  }
  async #hello(signal, timeout) {
    const r = await this.#request(1, new Uint8Array(), timeout, signal);
    assert(r.length >= 43 && equal(r.subarray(0, 6), new TextEncoder().encode('C7STUB')) && r[6] === 7 && get32(r, 9) === 0x10000, 'Unexpected RAM monitor.');
    return r;
  }
  async #spi(memory, tx, rx = 0) {
    const r = await this.#request(5, concat(memorySelector(memory), u16(tx.length), u16(rx), tx));
    assert(r.length === rx, 'Short SPI response.'); return r;
  }
  async #sectorSums(memory, address, count, signal) {
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      try {
        const sums = await this.#request(7, concat(memorySelector(memory), u32(address), u16(count)), 4000, signal);
        frameCheck(sums.length === count * 5, 'Malformed sector checksum reply.');
        return Array.from({ length: count }, (_, index) => get32(sums, index * 5));
      } catch (error) {
        signal?.throwIfAborted();
        if (!recoverableRead(error) || attempt + 1 >= READ_ATTEMPTS) throw error;
        await this.#drain(signal);
      }
    }
  }
  async #readSectors(memory, address, count, out, offset, signal, compressed = true) {
    let done = 0, failures = 0;
    while (done < count) {
      signal?.throwIfAborted();
      try {
        await this.#io.write(monitorFrame(9, concat(memorySelector(memory), u32(address + done * SECTOR), new Uint8Array([count - done, compressed && failures === 0 ? 1 : 0]))));
        while (done < count) {
          const record = await this.#response(undefined, signal);
          frameCheck(record.length >= 7 && record.length === 7 + get16(record, 5), 'Malformed sector record.');
          let sector;
          try { sector = decodeSector(record[4], record.subarray(7)); }
          catch (error) { throw new ReadFrameError(error.message); }
          frameCheck(crc32(sector) === get32(record), `Sector CRC failed at 0x${(address + done * SECTOR).toString(16)}.`);
          out.set(sector, offset + done * SECTOR);
          done++; failures = 0;
        }
      } catch (error) {
        signal?.throwIfAborted();
        if (!recoverableRead(error) || ++failures >= READ_ATTEMPTS) throw error;
        await this.#drain(signal, (count - done) * (SECTOR + 13));
      }
    }
  }
  async #checkedRead(memory, address, count, out, offset, signal) {
    await this.#readSectors(memory, address, count, out, offset, signal);
    // Streamed records carry no address. A stale but internally valid record
    // must never stand in for another sector, even after a recovered burst.
    for (let pass = 0; ; pass++) {
      const sums = await this.#sectorSums(memory, address, count, signal);
      const bad = sums.flatMap((sum, index) => crc32(out.subarray(offset + index * SECTOR, offset + (index + 1) * SECTOR)) === sum ? [] : [index]);
      if (!bad.length) return;
      frameCheck(pass + 1 < READ_ATTEMPTS, `Read does not match the radio's sector checksums at 0x${(address + bad[0] * SECTOR).toString(16)}.`);
      for (const index of bad) await this.#readSectors(memory, address + index * SECTOR, 1, out, offset + index * SECTOR, signal, false);
    }
  }
  async read(memory, address, length, progress = () => {}, signal, stopRequested) {
    assert(this.#configured && this.#chips && !this.#failed, 'Monitor session is not ready.');
    range(address, length, this.#chips[memory]?.size || 0);
    assert(address % SECTOR === 0 && length % SECTOR === 0, 'Sector-aligned read required.');
    const finalRead = this.#target && !this.#writing && address === 0 && length === this.#chips[memory].size;
    // Installer owns the user's skip choice. Monitor owns draining each wire
    // response and the completed-write gate; cancellation cannot leave queued sectors.
    assert(stopRequested === undefined || typeof stopRequested === 'function' && finalRead && this.#writeCompleted,
      'Only the finished-image read after a completed write plan can be skipped.');
    const out = new Uint8Array(length);
    try {
    // Read progress names the requested span; done counts only checked bytes.
    progress({ activity: 'read', memory, start: address, length, done: 0, total: length });
    if (stopRequested?.()) { this.#readbackSkipped = true; return out.slice(0, 0); }
    for (let offset = 0; offset < length; offset += 16 * SECTOR) {
      signal?.throwIfAborted();
      const count = Math.min(16, (length - offset) / SECTOR);
      await this.#checkedRead(memory, address + offset, count, out, offset, signal);
      const done = Math.min(length, offset + count * SECTOR);
      if (finalRead)
        assert(equal(out.subarray(offset, done), this.#target[memory].subarray(offset, done)), 'Complete chip differs from the authorized target. Restart refused.');
      progress({ activity: 'read', memory, start: address, length, done, total: length });
      if (done < length && stopRequested?.()) { this.#readbackSkipped = true; return out.slice(0, done); }
    }
    if (address === 0 && length === this.#chips[memory].size) {
      this.#full[memory] = out.slice();
      if (this.#target && !this.#writing) {
        assert(equal(out, this.#target[memory]), 'Complete chip differs from the authorized target. Restart refused.');
        this.#verified.add(memory);
      }
    }
    return out;
    } catch (error) { this.#failed = true; throw error; }
  }
  // A deliberate firmware operation owns these complete program sectors. The
  // helper reads each programmed sector locally and returns its CRC32; no old
  // image or downloaded readback is needed. Full-image restores use applyPlan.
  async writeProgram(plan, progress = () => {}) {
    assert(this.#configured && !this.#failed && !this.#writing, 'Monitor session is not ready.');
    // A new attempt revokes every previous completion, including bad input that
    // is rejected before the first write. Cached full images are now stale.
    this.#writeCompleted = this.#readbackSkipped = this.#sectorCrcVerified = this.#sectorReadbackVerified = false;
    this.#verified.clear(); this.#target = undefined; this.#full = {};
    assert(Array.isArray(plan) && plan.length > 0, 'A nonempty program sector plan is required.');
    const seen = new Set();
    const sectors = plan.map(sector => {
      assert(sector && (sector.memory === undefined || sector.memory === 'program'), 'Direct firmware writes are program-only.');
      const { address, data } = sector;
      assert(Number.isSafeInteger(address) && address >= APP_START && address % SECTOR === 0 &&
        data instanceof Uint8Array && data.length === SECTOR, 'Invalid program sector plan.');
      range(address, SECTOR, this.#chips.program.size);
      assert(!seen.has(address), 'Duplicate program sector plan.'); seen.add(address);
      return { address, data: data.slice() };
    });
    // Publishing the application entry last reduces the chance of starting a
    // half-written image. Copying above prevents callers changing later bytes.
    const entry = sectors.findIndex(sector => sector.address === APP_START);
    if (entry !== -1) sectors.push(...sectors.splice(entry, 1));
    this.#writing = true;
    try {
      for (let index = 0; index < sectors.length; index++) {
        const { address, data } = sectors[index];
        const result = await this.#request(14, concat(memorySelector('program'), u32(address),
          data.every(byte => byte === 255) ? new Uint8Array() : data), 6000);
        assert(result.length === 4 && get32(result) === crc32(data), 'Written sector CRC failed. Stopped without retry.');
        await progress({ activity: 'write', done: index + 1, total: sectors.length, memory: 'program', address, length: SECTOR });
      }
      this.#writeCompleted = this.#sectorCrcVerified = true;
    } catch (error) { this.#failed = true; throw error; }
    finally { this.#writing = false; }
  }
  // Only the bundled programming registry may supply data sectors. Each old
  // sector is checked before any write, then checked again immediately before
  // erase; each new sector is downloaded and compared after the helper CRC.
  async writeMigration(plan, progress = () => {}) {
    assert(this.#configured && !this.#failed && !this.#writing, 'Monitor session is not ready.');
    this.#writeCompleted = this.#readbackSkipped = this.#sectorCrcVerified = this.#sectorReadbackVerified = false;
    this.#verified.clear(); this.#target = undefined; this.#full = {};
    assert(Array.isArray(plan) && plan.length > 0, 'A nonempty migration sector plan is required.');
    const seen = new Set();
    const sectors = plan.map(({ memory, address, before, data }) => {
      assert(Number.isSafeInteger(address) && address % SECTOR === 0 && before instanceof Uint8Array &&
        data instanceof Uint8Array && before.length === SECTOR && data.length === SECTOR, 'Invalid migration sector.');
      const permitted = memory === 'program' ? address >= APP_START && address + SECTOR <= DM32_CODEC.end :
        memory === 'data' && PROGRAMMING_WRITE_RANGES.some(({ start, end }) => address >= start && address + SECTOR <= end);
      assert(permitted, 'Migration sector is outside the bundled programming layout.');
      range(address, SECTOR, this.#chips[memory]?.size || 0);
      const key = `${memory}:${address}`; assert(!seen.has(key), 'Duplicate migration sector.'); seen.add(key);
      return { memory, address, before: before.slice(), data: data.slice() };
    });
    const entry = sectors.findIndex(sector => sector.memory === 'program' && sector.address === APP_START);
    if (entry !== -1) sectors.push(...sectors.splice(entry, 1));
    this.#writing = true;
    try {
      for (const { memory, address, before } of sectors)
        assert(equal(await this.read(memory, address, SECTOR), before), 'Radio changed after migration preflight. No sector was written.');
      for (let index = 0; index < sectors.length; index++) {
        const { memory, address, before, data } = sectors[index];
        assert(equal(await this.read(memory, address, SECTOR), before), 'Radio changed during migration. Use the saved recovery archive.');
        const result = await this.#request(14, concat(memorySelector(memory), u32(address), data.every(byte => byte === 255) ? new Uint8Array() : data), 6000);
        assert(result.length === 4 && get32(result) === crc32(data), 'Migration sector CRC failed. Stopped without retry. Use the saved recovery archive.');
        assert(equal(await this.read(memory, address, SECTOR), data), 'Migration sector readback failed. Stopped without retry. Use the saved recovery archive.');
        await progress({ activity: 'write', done: index + 1, total: sectors.length, memory, address, length: SECTOR });
      }
      this.#writeCompleted = this.#sectorReadbackVerified = true;
    } catch (error) { this.#failed = true; throw error; }
    finally { this.#writing = false; }
  }
  async applyPlan(plan, progress = () => {}) {
    assert(this.#configured && !this.#failed, 'Monitor session is not ready.');
    assert(!this.#writing, 'Another write is already running.');
    this.#writeCompleted = this.#readbackSkipped = this.#sectorCrcVerified = this.#sectorReadbackVerified = false; this.#verified.clear(); this.#target = undefined;
    assert(this.#full.program && this.#full.data, 'Complete pre-write images are required.');
    const seen = new Set();
    for (const { memory, address, data, before } of plan) {
      range(address, SECTOR, this.#chips[memory]?.size || 0);
      assert(address % SECTOR === 0 && data.length === SECTOR && before.length === SECTOR, 'Invalid sector plan.');
      const key = `${memory}:${address}`; assert(!seen.has(key), 'Duplicate sector plan.'); seen.add(key);
    }
    this.#target = { program: this.#full.program.slice(), data: this.#full.data.slice() };
    this.#verified.clear(); this.#writing = true;
    for (const { memory, address, data, before } of plan) {
      assert(equal(this.#target[memory].subarray(address, address + SECTOR), before), 'Plan differs from the complete pre-write image.');
      this.#target[memory].set(data, address);
    }
    try {
      for (let index = 0; index < plan.length; index++) {
        const { memory, address, data, before } = plan[index];
        range(address, SECTOR, this.#chips[memory]?.size || 0);
        assert(address % SECTOR === 0 && data.length === SECTOR && before.length === SECTOR, 'Invalid sector plan.');
        assert(equal(await this.read(memory, address, SECTOR), before), 'Radio changed after preflight.');
        const result = await this.#request(14, concat(memorySelector(memory), u32(address), data.every(b => b === 255) ? new Uint8Array() : data), 6000);
        assert(result.length === 4 && get32(result) === crc32(data), 'Written sector CRC failed. Stopped without retry.');
        assert(equal(await this.read(memory, address, SECTOR), data), 'Written sector failed readback. Stopped without retry.');
        await progress({ activity: 'write', done: index + 1, total: plan.length, memory, address, length: SECTOR });
      }
      this.#writeCompleted = true;
    } catch (error) { this.#failed = true; throw error; }
    finally { this.#writing = false; }
  }
  async restartVerified({ verificationSkipped = false, verificationMethod } = {}) {
    const verified = this.#verified.has('program') && this.#verified.has('data');
    const skipped = verificationSkipped === true && this.#writeCompleted && this.#readbackSkipped;
    const sectorsVerified = verificationMethod === 'sector-crc32' && this.#writeCompleted && this.#sectorCrcVerified;
    const scopedVerified = verificationMethod === 'sector-readback' && this.#writeCompleted && this.#sectorReadbackVerified;
    assert(!this.#failed && !this.#writing && (verified || skipped || sectorsVerified || scopedVerified), 'Both complete chips must match, final verification must be explicitly skipped after completed writes, or the current program sectors must pass CRC32 checks before restart.');
    // Restart authorization is one-use even if a reset request loses its reply.
    this.#verified.clear(); this.#writeCompleted = this.#readbackSkipped = this.#sectorCrcVerified = this.#sectorReadbackVerified = false;
    // Pinned stubtool.reset_chip sequence: crash mark, watchdog off, XIP off,
    // boot-ROM flash divider, then SoC reset. No caller-supplied register writes.
    const writes = [[0x18007ef4, 0x54464f53], [0x14010000, 0x5ada7200], [0x14010010, 0], [0x14010000, 0], [0x1100005c, 0], [0x11000030, 4]];
    for (const [address, value] of writes) await this.#request(3, concat(u32(address), u32(value, true)));
    await this.#io.write(monitorFrame(3, concat(u32(0x11000000), u32(0, true))));
    await sleep(100);
    this.#configured = false; this.#verified.clear(); this.#writeCompleted = this.#readbackSkipped = this.#sectorCrcVerified = this.#sectorReadbackVerified = false;
    await sleep(2500); this.#io.discard();
  }
  async close() { this.#configured = false; await this.#io.close(); }
}
