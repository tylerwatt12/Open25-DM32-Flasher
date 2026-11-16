import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserSerial } from '../lib/serial.mjs';

const turn = () => new Promise(resolve => setImmediate(resolve));
class Port {
  options = []; closes = 0; writes = []; signals = 0;
  getInfo() { return { usbVendorId: 0x067b, usbProductId: 0x2303, serialNumber: 'private-cable-id', displayName: 'private cable name' }; }
  async open(options) {
    this.options.push(options);
    this.readable = new ReadableStream({ start: controller => { this.controller = controller; } });
    this.writable = new WritableStream({ write: data => { this.writes.push(data.slice()); } });
  }
  async setSignals() { this.signals++; throw new Error('Control lines are not needed'); }
  async close() {
    assert.equal(this.readable?.locked, false, 'release the input reader before closing');
    assert.equal(this.writable?.locked, false, 'release the output writer before closing');
    this.closes++;
  }
  readFailure(error) {
    const previous = this.controller;
    this.readable = new ReadableStream({ start: controller => { this.controller = controller; } });
    previous.error(error);
  }
}

test('connection counters distinguish pending writes, retain read activity and reset on reopen', async t => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const port = new Port(), serial = new BrowserSerial(port);
  await serial.open();
  const empty = { rxBytes: 0, txBytes: 0, writesStarted: 0, writesCompleted: 0, readErrors: 0, maxWriteMs: 0,
    usbVendorId: 0x067b, usbProductId: 0x2303 };
  assert.deepEqual(serial.diagnostics, empty);
  port.controller.enqueue(new Uint8Array([7, 8, 9])); await turn();
  serial.take(1); serial.discard();
  let finish;
  port.writable = new WritableStream({ write: () => new Promise(resolve => { finish = resolve; }) });
  const pending = serial.write(new Uint8Array([2, 0x14, 0, 3])); await turn();
  assert.equal(serial.diagnostics.writesStarted, 1);
  assert.equal(serial.diagnostics.writesCompleted, 0);
  assert.equal(serial.diagnostics.txBytes, 0);
  now = 42; finish(); await pending;
  port.readFailure(new DOMException('private error details', 'BreakError')); await turn();
  assert.deepEqual(serial.diagnostics, { ...empty, rxBytes: 3, txBytes: 4, writesStarted: 1, writesCompleted: 1,
    readErrors: 1, lastReadError: 'BreakError', maxWriteMs: 42 });
  const snapshot = serial.diagnostics; snapshot.rxBytes = 999;
  assert.equal(serial.diagnostics.rxBytes, 3, 'callers cannot change transport-owned counters');
  await serial.close(); await serial.open();
  assert.deepEqual(serial.diagnostics, empty);
  await serial.close();
});

test('diagnostics exclude arbitrary adapter fields and error contents, and tolerate unavailable IDs', async () => {
  const port = new Port(), serial = new BrowserSerial(port);
  await serial.open();
  const failure = new Error('private radio data'); failure.name = '/Users/private/radio.zip';
  port.controller.error(failure); await turn();
  assert.equal(serial.diagnostics.readErrors, 1);
  assert.equal(serial.diagnostics.lastReadError, 'Error');
  assert.doesNotMatch(JSON.stringify(serial.diagnostics), /private|serialNumber|displayName/);
  port.getInfo = () => ({ usbVendorId: -1, usbProductId: 'private' });
  assert.equal(serial.diagnostics.usbVendorId, undefined); assert.equal(serial.diagnostics.usbProductId, undefined);
  let reads = 0;
  port.getInfo = () => ({ get usbVendorId() { return ++reads === 1 ? 0x067b : 'private'; } });
  assert.equal(serial.diagnostics.usbVendorId, 0x067b); assert.equal(reads, 1);
  port.getInfo = () => { throw new Error('Unavailable'); };
  assert.equal(serial.diagnostics.rxBytes, 0);
  await serial.close();
});

test('a non-string error name cannot enter the diagnostic snapshot or change the original failure', async () => {
  const port = new Port(), reports = [], serial = new BrowserSerial(port, error => reports.push(error));
  await serial.open();
  const failure = new Error('private details'); failure.name = { toString() { return 'BreakError'; } };
  port.controller.error(failure); await turn();
  assert.equal(serial.diagnostics.lastReadError, 'Error');
  assert.equal(serial.diagnostics.readErrors, 1);
  assert.deepEqual(reports, [failure]);
  assert.throws(() => serial.buf, error => error === failure);
  await serial.close();
});

test('a rejected write is counted as started but never as completed traffic', async () => {
  const port = new Port(), serial = new BrowserSerial(port);
  await serial.open();
  port.writable = new WritableStream({ write() { throw new Error('Write refused'); } });
  await assert.rejects(serial.write(new Uint8Array([1, 2])), /Write refused/);
  assert.equal(serial.diagnostics.writesStarted, 1);
  assert.equal(serial.diagnostics.writesCompleted, 0);
  assert.equal(serial.diagnostics.txBytes, 0);
  await serial.close();
});

test('one fixed 115200-baud open keeps burst headroom and releases each write lock', async () => {
  const port = new Port(), rates = [], reports = [], serial = new BrowserSerial(port, error => reports.push(error), rate => rates.push(rate));
  await serial.open();
  assert.deepEqual(port.options, [{ baudRate: 115200, bufferSize: 131072 }]);
  assert.equal(port.signals, 0);
  assert.equal(serial.setBaudRate, undefined);
  assert.equal(port.writable.locked, false);
  await serial.write(new Uint8Array([1])); assert.equal(port.writable.locked, false);
  await serial.write(new Uint8Array([2])); assert.equal(port.writable.locked, false);
  assert.equal(port.writes.length, 2); assert.deepEqual(rates, [115200]);
  await serial.close();
  assert.equal(port.closes, 1); assert.deepEqual(reports, []);
});

for (const name of ['FramingError', 'ParityError', 'BreakError', 'BufferOverrunError']) {
  test(name + ' preserves buffered bytes and the fresh reader’s ROM greeting', async () => {
    const port = new Port(), reports = [], serial = new BrowserSerial(port, error => reports.push(error));
    await serial.open();
    port.controller.enqueue(new Uint8Array([7, 8])); await turn();
    port.readFailure(new DOMException('Recoverable input error', name));
    // The new greeting can arrive before the protocol consumes the old reader’s error.
    port.controller.enqueue(new Uint8Array([2, 0x24, 0, 3]));
    await turn();
    assert.deepEqual(serial.buf, new Uint8Array([7, 8, 2, 0x24, 0, 3]));
    assert.deepEqual(serial.take(2), new Uint8Array([7, 8]));
    assert.deepEqual(await serial.readExact(4), new Uint8Array([2, 0x24, 0, 3]));
    await serial.write(new Uint8Array([2, 0x14, 0, 3]));
    assert.deepEqual(reports, []);
    await serial.close(); assert.equal(port.readable.locked, false);
  });
}

test('a pending read continues through repeated power-cycle breaks', async () => {
  const port = new Port(), reports = [], serial = new BrowserSerial(port, error => reports.push(error));
  await serial.open();
  const pending = serial.readExact(4);
  for (let index = 0; index < 30; index++) {
    port.readFailure(new DOMException('Power-cycle break', 'BreakError'));
    await turn();
  }
  port.controller.enqueue(new Uint8Array([2, 0x24, 0, 3]));
  assert.deepEqual(await pending, new Uint8Array([2, 0x24, 0, 3]));
  assert.deepEqual(reports, []); await serial.close();
});

test('a recoverable input fault does not replay or fail a pending write', async () => {
  const port = new Port(), reports = [], serial = new BrowserSerial(port, error => reports.push(error));
  await serial.open();
  let finish, writes = 0;
  const gate = new Promise(resolve => { finish = resolve; });
  port.writable = new WritableStream({ write() { writes++; return gate; } });
  const pending = serial.write(new Uint8Array([1]));
  port.readFailure(new DOMException('Input framing error', 'FramingError'));
  port.controller.enqueue(new Uint8Array([2, 0x24, 0, 3]));
  await turn(); finish(); await pending;
  assert.equal(writes, 1); assert.equal(port.writable.locked, false);
  assert.deepEqual(await serial.readExact(4), new Uint8Array([2, 0x24, 0, 3]));
  assert.deepEqual(reports, []); await serial.close();
});

test('fatal input errors take precedence over buffered data and remain unchanged after discard or close', async () => {
  const port = new Port(), reports = [], serial = new BrowserSerial(port, error => reports.push(error));
  await serial.open();
  port.controller.enqueue(new Uint8Array([1, 2, 3])); await turn();
  const failure = new DOMException('Device removed', 'NetworkError');
  port.controller.error(failure); await turn();
  assert.throws(() => serial.buf, error => error === failure);
  assert.throws(() => serial.take(3), error => error === failure);
  await assert.rejects(serial.readExact(3), error => error === failure);
  await assert.rejects(serial.write(new Uint8Array([4])), error => error === failure);
  serial.discard(); await serial.close();
  await assert.rejects(serial.readExact(3), error => error === failure);
  assert.deepEqual(reports, [failure]);
});

test('a write rejection wakes pending input, releases its lock and is never retried', async () => {
  const port = new Port(), reports = [], serial = new BrowserSerial(port, error => reports.push(error));
  await serial.open();
  const failure = new DOMException('USB write failed', 'NetworkError');
  let writes = 0;
  port.writable = new WritableStream({ write() { writes++; throw failure; } });
  const rejectedRead = assert.rejects(serial.readExact(1), error => error === failure);
  await assert.rejects(serial.write(new Uint8Array([2])), error => error === failure);
  await rejectedRead;
  assert.equal(port.writable.locked, false);
  await assert.rejects(serial.write(new Uint8Array([3])), error => error === failure);
  assert.equal(writes, 1); assert.deepEqual(reports, [failure]);
  await serial.close();
});

test('a writer FramingError is fatal even though input FramingErrors are recoverable', async () => {
  const port = new Port(), reports = [], serial = new BrowserSerial(port, error => reports.push(error));
  await serial.open();
  const failure = new DOMException('Write framing error', 'FramingError');
  let writes = 0;
  port.writable = new WritableStream({ write() { writes++; throw failure; } });
  await assert.rejects(serial.write(new Uint8Array([1])), error => error === failure);
  serial.discard();
  await assert.rejects(serial.write(new Uint8Array([2])), error => error === failure);
  assert.equal(writes, 1); assert.deepEqual(reports, [failure]); await serial.close();
});

test('fatal input during an asynchronous write retains the first error and reports once', async () => {
  const port = new Port(), reports = [], serial = new BrowserSerial(port, error => reports.push(error));
  await serial.open();
  const failure = new DOMException('Device removed', 'NetworkError');
  let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  port.writable = new WritableStream({ write: () => gate });
  const pending = serial.write(new Uint8Array([1]));
  port.controller.error(failure); await turn(); finish();
  await assert.rejects(pending, error => error === failure);
  assert.deepEqual(reports, [failure]); assert.equal(port.writable.locked, false); await serial.close();
});

test('an aborted read does not consume even a completely buffered result', async () => {
  const port = new Port(), serial = new BrowserSerial(port);
  await serial.open();
  port.controller.enqueue(new Uint8Array([1, 2, 3])); await turn();
  const controller = new AbortController(); controller.abort();
  await assert.rejects(serial.readExact(3, 3000, controller.signal), { name: 'AbortError' });
  assert.deepEqual(await serial.readExact(3), new Uint8Array([1, 2, 3])); await serial.close();
});

test('cancellation is checked again when new bytes wake a pending read', async () => {
  const port = new Port(), serial = new BrowserSerial(port);
  await serial.open();
  const controller = new AbortController(), pending = serial.readExact(3, 3000, controller.signal);
  port.controller.enqueue(new Uint8Array([1, 2, 3])); controller.abort();
  await assert.rejects(pending, { name: 'AbortError' }); await serial.close();
});

test('read timeout retains its diagnostic code and explicit discard alone clears bytes', async () => {
  const port = new Port(), serial = new BrowserSerial(port);
  await serial.open();
  await assert.rejects(serial.readExact(1, 1), error => error.code === 'serial_timeout' && /radio did not answer in time/.test(error.message));
  port.controller.enqueue(new Uint8Array([42])); await turn();
  assert.deepEqual(serial.buf, new Uint8Array([42])); serial.discard(); assert.equal(serial.buf.length, 0);
  await serial.close();
});

test('unexpected traffic stays memory-bounded and wakes an active read with the original failure', async () => {
  const port = new Port(), reports = [], serial = new BrowserSerial(port, error => reports.push(error));
  await serial.open();
  const rejected = assert.rejects(serial.readExact(131073), /Unexpected serial traffic/);
  port.controller.enqueue(new Uint8Array(131073));
  await rejected; assert.equal(reports.length, 1); await serial.close();
});

test('a refused open does not close an unopened port or replace its error', async () => {
  const port = new Port(), rates = [], failure = new DOMException('Serial access refused', 'NetworkError');
  port.open = async () => { throw failure; };
  const serial = new BrowserSerial(port, undefined, rate => rates.push(rate));
  await assert.rejects(serial.open(), error => error === failure); await serial.close();
  assert.equal(port.closes, 0); assert.deepEqual(rates, []);
});

test('an unlocked stale port is reopened once at 115200', async () => {
  const port = new Port(), open = port.open.bind(port);
  let stale = true, opens = 0, closes = 0;
  port.open = async options => { opens++; if (stale) throw new DOMException('Already open', 'InvalidStateError'); await open(options); };
  port.close = async () => { closes++; stale = false; };
  const serial = new BrowserSerial(port);
  await serial.open();
  assert.equal(opens, 2); assert.equal(closes, 1);
  assert.deepEqual(port.options, [{ baudRate: 115200, bufferSize: 131072 }]);
  await serial.close(); assert.equal(closes, 2);
});

test('an already-owned port keeps its original open error when close refuses', async () => {
  const port = new Port(), failure = new DOMException('Already open', 'InvalidStateError');
  let opens = 0, closes = 0;
  port.open = async () => { opens++; throw failure; };
  port.close = async () => { closes++; throw new Error('Stream is locked'); };
  const serial = new BrowserSerial(port);
  await assert.rejects(serial.open(), error => error === failure); await serial.close();
  assert.equal(opens, 1); assert.equal(closes, 1);
});

test('port chooser runs directly in the click without awaiting grant discovery', async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const secure = Object.getOwnPropertyDescriptor(globalThis, 'isSecureContext');
  const selected = {}; let requests = 0;
  Object.defineProperty(globalThis, 'isSecureContext', { value: true, configurable: true });
  Object.defineProperty(globalThis, 'navigator', { value: { serial: {
    getPorts() { throw new Error('A grant lookup can expire the user gesture'); },
    requestPort() { requests++; return Promise.resolve(selected); },
  } }, configurable: true });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'navigator', previous); else delete globalThis.navigator;
    if (secure) Object.defineProperty(globalThis, 'isSecureContext', secure); else delete globalThis.isSecureContext;
  });
  const choice = BrowserSerial.choose();
  assert.equal(requests, 1, 'permission must be requested before yielding');
  assert.equal(await choice, selected);
});

for (const userAgent of ['Windows Firefox/159', 'Windows Chrome/157']) {
  test('ended input reports browser closure accurately for ' + userAgent, async t => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', { value: { userAgent }, configurable: true });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, 'navigator', previous); else delete globalThis.navigator;
    });
    const port = new Port(), reports = [], serial = new BrowserSerial(port, error => reports.push(error));
    await serial.open(); port.controller.close(); await turn();
    assert.equal(reports.length, 1);
    assert.match(reports[0].message, /browser closed the programming connection/);
    assert.equal(reports[0].message.includes('try Chrome or Edge'), userAgent.includes('Firefox'));
    await assert.rejects(serial.readExact(1), error => error === reports[0]);
    await serial.close();
  });
}
