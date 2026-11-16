// SPDX-License-Identifier: GPL-3.0-or-later
// Deterministic synthetic data only. No stock codec, contacts or calibration.
import { APP_START, SECTOR, assert, equal, filled, sha256, sleep, range } from '../lib/bytes.mjs';
import { WRITE_PROFILE } from '../lib/policy.mjs';
import { jsonBytes, zip } from '../lib/zip.mjs';

function pattern(size, seed) {
  const a = filled(size);
  for (let i = 0; i < size; i += 8192) for (let j = 0; j < 128 && i + j < size; j++) a[i + j] = (i / 8192 + (i >>> 21) * 7 + j * 31 + seed) & 255;
  return a;
}
const application = () => pattern(WRITE_PROFILE.programBytes - APP_START, 77);
const DEMO_RELEASE = 'dm32-demo';
export class SimulatedRadio {
  #program; #data; #closed = false; #failAfter; #written = 0;
  constructor({ open25 = false, failAfter = Infinity, blank = false } = {}) {
    this.#program = pattern(0x100000, 3); this.#data = pattern(0x1000000, 8);
    if (open25) this.#program.set(application(), APP_START);
    if (blank) { this.#program.fill(255); this.#data.fill(255); }
    this.#failAfter = failAfter;
  }
  get simulated() { return true; }
  get chips() { return { program: { jedec: 'c84014', size: 0x100000 }, data: { jedec: 'ef4018', size: 0x1000000 } }; }
  async firmwarePackage() {
    const app = application();
    const manifest = { format: 'open25-dm32-firmware', version: 2, target: 'dm32-demo',
      release: DEMO_RELEASE, applicationSha256: await sha256(app) };
    return zip(new Map([['firmware.json', jsonBytes(manifest)], ['application.bin', app]]));
  }
  async read(memory, address, length, progress = () => {}, signal, stopRequested) {
    assert(!this.#closed, 'Simulated radio disconnected.'); signal?.throwIfAborted();
    const source = memory === 'program' ? this.#program : memory === 'data' ? this.#data : null;
    assert(source, 'Unknown flash chip.'); range(address, length, source.length);
    progress({ activity: 'read', memory, start: address, length, done: 0, total: length });
    if (stopRequested?.()) return source.slice(address, address);
    // Yield to the UI for long operations without artificial real-radio timings.
    for (let offset = 0; offset < length; offset += 0x100000) {
      signal?.throwIfAborted();
      const done = Math.min(length, offset + 0x100000);
      progress({ activity: 'read', memory, start: address, length, done, total: length }); await sleep(0);
      if (done < length && stopRequested?.()) return source.slice(address, address + done);
    }
    return source.slice(address, address + length);
  }
  async applyPlan(plan, checkpoint = () => {}) {
    assert(!this.#closed, 'Simulated radio disconnected.');
    for (let i = 0; i < plan.length; i++) {
      const { memory, address, data, before } = plan[i];
      const target = memory === 'program' ? this.#program : this.#data;
      assert(address % SECTOR === 0 && data.length === SECTOR, 'Invalid simulated sector.');
      range(address, SECTOR, target.length);
      assert(equal(target.subarray(address, address + SECTOR), before), 'Sector changed since preflight.');
      if (this.#written++ >= this.#failAfter) {
        target.fill(255, address, address + SECTOR / 2); throw new Error('Simulated cable interruption during erase.');
      }
      target.fill(255, address, address + SECTOR); target.set(data, address);
      assert(equal(target.subarray(address, address + SECTOR), data), 'Simulated readback failure.');
      await checkpoint({ activity: 'write', done: i + 1, total: plan.length, memory, address, length: SECTOR });
    }
  }
  async writeProgram(plan, checkpoint = () => {}) {
    assert(!this.#closed, 'Simulated radio disconnected.');
    assert(Array.isArray(plan) && plan.length > 0, 'A program write plan is required.');
    const seen = new Set();
    const sectors = plan.map(({ address, data }) => {
      assert(Number.isInteger(address) && address >= APP_START && address % SECTOR === 0 &&
        data instanceof Uint8Array && data.length === SECTOR && !seen.has(address), 'Invalid simulated program sector.');
      range(address, SECTOR, this.#program.length); seen.add(address);
      return { address, data: data.slice() };
    }).sort((a, b) => (a.address === APP_START) - (b.address === APP_START) || a.address - b.address);
    for (let i = 0; i < sectors.length; i++) {
      const { address, data } = sectors[i];
      if (this.#written++ >= this.#failAfter) {
        this.#program.fill(255, address, address + SECTOR / 2);
        throw new Error('Simulated cable interruption during erase.');
      }
      this.#program.fill(255, address, address + SECTOR); this.#program.set(data, address);
      assert(equal(this.#program.subarray(address, address + SECTOR), data), 'Simulated write checksum failure.');
      await checkpoint({ activity: 'write', done: i + 1, total: sectors.length, memory: 'program', address, length: SECTOR });
    }
  }
  async close() { this.#closed = true; }
}
