// SPDX-License-Identifier: GPL-3.0-or-later
import { assert, concat } from './bytes.mjs';

// RadioFoundry's native WebSerial reader recovery and per-write locking.
const SOFT_READ_ERRORS = new Set(['FramingError', 'ParityError', 'BreakError', 'BufferOverrunError']);

export class BrowserSerial {
  #port; #reader; #buffer = new Uint8Array(); #waiting; #error; #pump; #stopping = false; #opened = false; #statistics;
  constructor(port, onDisconnect = () => {}, onBaudRate = () => {}) { this.#port = port; this.onDisconnect = onDisconnect; this.onBaudRate = onBaudRate; }
  static supported() { return !!(globalThis.isSecureContext && globalThis.navigator?.serial); }
  static async choose() {
    assert(BrowserSerial.supported(), 'Open this app in Chrome or Edge on a secure page or localhost.');
    return navigator.serial.requestPort();
  }
  async open() {
    const options = { baudRate: 115200, bufferSize: 131072 };
    try { await this.#port.open(options); }
    catch (error) {
      if (error?.name !== 'InvalidStateError') throw error;
      // Reclaim a stale, unlocked port from this page; an active stream still refuses close.
      try { await this.#port.close(); } catch { throw error; }
      await this.#port.open(options);
    }
    this.#opened = true; this.#stopping = false; this.#error = undefined; this.#buffer = new Uint8Array();
    this.#statistics = { rxBytes: 0, txBytes: 0, writesStarted: 0, writesCompleted: 0, readErrors: 0, maxWriteMs: 0 };
    this.#pump = this.#readPump();
    this.onBaudRate(115200);
  }
  get diagnostics() {
    const result = { ...this.#statistics };
    try {
      const info = this.#port.getInfo?.();
      for (const key of ['usbVendorId', 'usbProductId']) {
        const value = info?.[key];
        if (Number.isInteger(value) && value >= 0 && value <= 65535) result[key] = value;
      }
    } catch { /* adapter details are optional */ }
    return result;
  }
  #checkError() { if (this.#error) throw this.#error; }
  #fail(error) {
    const first = !this.#error;
    this.#error ||= error; this.#buffer = new Uint8Array(); this.#waiting?.();
    if (first) this.onDisconnect(this.#error);
  }
  async #readPump() {
    let glitches = 0;
    while (!this.#stopping && this.#port.readable) {
      let reader;
      try {
        reader = this.#port.readable.getReader(); this.#reader = reader;
        for (;;) {
          const { value, done } = await reader.read();
          if (done) {
            if (!this.#stopping) {
              const userAgent = globalThis.navigator?.userAgent || '';
              const firefoxWindows = /Windows/.test(userAgent) && /Firefox\//.test(userAgent);
              this.#fail(new Error('The browser closed the programming connection. Reconnect the same radio.' +
                (firefoxWindows ? ' On Windows Firefox, try Chrome or Edge; some USB drivers close serial input immediately.' : '')));
            }
            return;
          }
          if (value?.length) {
            glitches = 0;
            this.#statistics.rxBytes += value.length;
            assert(this.#buffer.length + value.length <= 131072, 'Unexpected serial traffic. Close other radio software and reconnect.');
            this.#buffer = concat(this.#buffer, value); this.#waiting?.();
          }
        }
      } catch (error) {
        if (this.#stopping) return;
        this.#statistics.readErrors++;
        const name = error?.name;
        this.#statistics.lastReadError = typeof name === 'string' && /^[A-Za-z]{1,70}Error$/.test(name) ? name : 'Error';
        if (!SOFT_READ_ERRORS.has(name)) { this.#fail(error); return; }
        // A power-cycle break ends this reader, not the port or the next ROM greeting.
        glitches++;
      } finally {
        try { reader?.releaseLock(); } catch { /* detached by the browser */ }
        if (this.#reader === reader) this.#reader = undefined;
      }
      if (glitches > 20) await new Promise(resolve => setTimeout(resolve, 20));
    }
    if (!this.#stopping) this.#fail(new DOMException('The device has been lost.', 'NetworkError'));
  }
  get buf() { this.#checkError(); return this.#buffer; }
  take(count) {
    this.#checkError();
    const data = this.#buffer.slice(0, count); this.#buffer = this.#buffer.slice(count); return data;
  }
  async readExact(count, timeout = 3000, signal) {
    const deadline = performance.now() + timeout;
    for (;;) {
      signal?.throwIfAborted(); this.#checkError();
      if (this.#buffer.length >= count) return this.take(count);
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw Object.assign(new Error('The radio did not answer in time. Reconnect and try again.'), { code: 'serial_timeout' });
      await new Promise(resolve => {
        const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); this.#waiting = undefined; resolve(); };
        const timer = setTimeout(finish, remaining);
        signal?.addEventListener('abort', finish, { once: true }); this.#waiting = finish;
      });
    }
  }
  discard() { this.#buffer = new Uint8Array(); }
  async write(data) {
    this.#checkError();
    assert(this.#opened, 'Cable is not open.');
    let writer, started;
    try {
      if (!this.#port.writable) throw new DOMException('The device has been lost.', 'NetworkError');
      writer = this.#port.writable.getWriter();
      started = performance.now(); this.#statistics.writesStarted++;
      await writer.write(data);
      this.#statistics.writesCompleted++; this.#statistics.txBytes += data.byteLength;
      this.#checkError();
    } catch (error) { this.#fail(error); throw this.#error; }
    finally {
      if (started !== undefined) this.#statistics.maxWriteMs = Math.max(this.#statistics.maxWriteMs, Math.round(performance.now() - started));
      writer?.releaseLock();
    }
  }
  async close() {
    this.#stopping = true; this.#error ||= new Error('Connection closed.'); this.#buffer = new Uint8Array(); this.#waiting?.();
    try { await this.#reader?.cancel(); } catch { /* already detached */ }
    let timer;
    try {
      if (this.#pump) await Promise.race([this.#pump, new Promise(resolve => { timer = setTimeout(resolve, 2000); })]);
    } finally { clearTimeout(timer); }
    if (this.#opened) {
      this.#opened = false;
      try { await this.#port.close(); } catch { /* lost device or a driver still releasing its reader */ }
    }
  }
}
