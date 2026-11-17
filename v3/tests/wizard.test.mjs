// SPDX-License-Identifier: GPL-3.0-or-later
// Exercise the shipped app handlers with real package/backup/engine code; no radio or browser storage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { readFactoryFirmware, buildFactoryUpdate } from '../lib/factory.mjs';
import { syntheticCodec } from './codec-fixture.mjs';
import { captureBackup } from '../lib/archive.mjs';
import { Installer, radioRegions } from '../lib/engine.mjs';
import { Journal } from '../lib/journal.mjs';
import { MONITOR_SHA256, DM32_CODEC } from '../lib/policy.mjs';
import { APP_START, sha256 } from '../lib/bytes.mjs';
import { MAX_ARCHIVE, jsonBytes, zip } from '../lib/zip.mjs';
import { verifyArchive } from '../lib/archive.mjs';
import { readFirmware, validateCatalog, downloadPackage, packageURL } from '../lib/firmware.mjs';
import { SimulatedRadio } from './simulator.mjs';
import { MemoryFile } from './helpers.mjs';

const application = new Uint8Array(4097).fill(0x53);
const firmware = zip(new Map([
  ['firmware.json', jsonBytes({ format: 'open25-dm32-firmware', version: 2, target: 'dm32-048',
    release: 'ui-current', applicationSha256: await sha256(application) })],
  ['application.bin', application],
]));
function localFactoryFile({ codec = true } = {}) {
  const bytes = new Uint8Array(0x100 + DM32_CODEC.end - APP_START).fill(0x53);
  bytes.fill(255, 0, 0x100);
  bytes.set(new TextEncoder().encode('BFUV32-V2'));
  bytes.set(new TextEncoder().encode('END'), 0xfd);
  bytes.set(new TextEncoder().encode('PRIVATE_OEM_DIAGNOSTIC_SENTINEL'), 0x200);
  if (codec) bytes.set(syntheticCodec(), 0x100 + DM32_CODEC.start - APP_START);
  return bytes;
}
const catalog = { format: 'open25-dm32-catalog', version: 1, channels: [
  { id: 'classic', name: 'Classic', description: 'DMR/FM/P25', enabled: true, variants: [
    { id: 'standard', name: 'Standard', releases: [
      { version: 'current', file: 'classic/standard/current.zip', sha256: await sha256(firmware), notes: 'Test package' },
    ] },
  ] },
  { id: 'next', name: 'Next', description: 'FM/P25', enabled: false, releaseDate: 'TBD', variants: [] },
] };

async function wizard(t, { failStarts = 0, startGate, verificationGate, hosted = false, privacy = {}, physical = false,
  prepared = true, confirmSkip = true, failWrites = false, failVerify = false, restartFault, diagnosticResponse = 'ok', serialSupported = true,
  chooseError, saveError, copyError, controlAppTimers = false, startError, serialDiagnostics = {}, chips, onProgress, hash = '', noticeStorage = new Map(), noticeStorageUnavailable = false } = {}) {
  const calls = { files: 0, downloads: 0, exports: [], ports: 0, saves: 0, radios: [], transports: [], reads: [], progress: [], writes: 0, diagnostics: [], diagnosticRequests: [], confirms: [], copied: [] };
  const elements = new Map();
  const objectURLs = new Map(); let objectURL = 0;
  class BrowserURL extends URL {
    static createObjectURL(blob) { const href = `blob:test/${++objectURL}`; objectURLs.set(href, blob); return href; }
    static revokeObjectURL(href) { objectURLs.delete(href); }
  }
  let nextFile, inGesture = false;
  const appTimers = new Map(); let timerId = 0;
  const appSetTimeout = controlAppTimers ? (callback, delay, ...args) => {
    const id = ++timerId; appTimers.set(id, { callback, delay, args }); return id;
  } : setTimeout;
  const appClearTimeout = controlAppTimers ? id => appTimers.delete(id) : clearTimeout;
  t.after(() => appTimers.clear());
  class Element {
    constructor(tag = 'div') { this.tagName = tag.toUpperCase(); }
    innerHTML = ''; textContent = ''; hidden = false; disabled = false; checked = false;
    dataset = {}; attributes = {}; listeners = new Map(); style = { setProperty() {} };
    addEventListener(name, handler) { this.listeners.set(name, handler); }
    setAttribute(name, value) { this.attributes[name] = value; }
    removeAttribute(name) { delete this.attributes[name]; }
    closest() { return this; }
    querySelectorAll() { return tabs; }
    close() { this.open = false; this.listeners.get('close')?.(); }
    showModal() { this.open = true; }
    click() {
      if (this.tagName === 'A') { calls.exports.push({ filename: this.download, blob: objectURLs.get(this.href) }); return; }
      calls.files++;
      assert(inGesture, 'file chooser must open directly from the click');
      this.files = nextFile ? [nextFile] : [];
      return this.listeners.get('change')?.({ target: this });
    }
  }
  const get = id => { if (!elements.has(id)) { const element = new Element(); element.id = id; elements.set(id, element); } return elements.get(id); };
  const tabs = ['first', 'update', 'archive', 'factory', 'info', 'package'].map(mode => {
    const element = new Element(); element.dataset.mode = mode; return element;
  });
  const fetch = async (url, options) => {
    const path = String(url);
    if (path.endsWith('hardware-report.php')) {
      const event = JSON.parse(options.body);
      calls.diagnostics.push(event); calls.diagnosticRequests.push({ event, options });
      if (typeof diagnosticResponse === 'function') return diagnosticResponse(event, options);
      if (diagnosticResponse === 'fail') throw new Error('Diagnostics unavailable');
      if (diagnosticResponse === 'pending') return new Promise((resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
      return new Response(null, { status: 204 });
    }
    if (path.includes('catalog.json')) return Response.json(catalog);
    if (path.includes('monitor.bin')) return new Response(new Uint8Array([1]));
    if (path.endsWith('current.zip')) { calls.downloads++; return new Response(firmware); }
    throw new Error(`Unexpected request: ${path}`);
  };
  t.mock.method(globalThis, 'fetch', fetch); // downloadPackage uses its real module's global fetch.
  class BrowserSerial {
    constructor(port, onDisconnect) { this.disconnect = onDisconnect; calls.transports.push(this); }
    get diagnostics() { return { ...serialDiagnostics }; }
    static supported() { return serialSupported; }
    static choose() { assert(inGesture); calls.ports++; return chooseError ? Promise.reject(chooseError) : Promise.resolve({}); }
    async open() {}
  }
  class Monitor extends SimulatedRadio {
    constructor() { super(); calls.radios.push(this); }
    get simulated() { return !physical; }
    get chips() { return chips ? structuredClone(chips) : super.chips; }
    async start(image, progress) {
      progress({ phase: 'connect', waitingForPowerCycle: true, message: 'Switch the radio off and on.' });
      if (startGate) await startGate;
      if (startError) { this.failed = true; throw startError; }
      if (failStarts-- > 0) { this.failed = true; throw new Error('Connection interrupted'); }
    }
    async read(memory, address, length, progress, ...rest) {
      calls.reads.push({ memory, address, length });
      const report = value => { progress?.(value); calls.progress.push({ ...value }); onProgress?.(value); };
      if (calls.writes > 0 && verificationGate && !calls.heldVerify) {
        calls.heldVerify = true; report({ activity: 'read', memory, start: address, length, done: 0, total: length });
        await verificationGate;
      }
      if (calls.writes > 0 && failVerify) throw new Error('Final read failed');
      const bytes = await super.read(memory, address, length, report, ...rest);
      if (prepared && memory === 'program' && address <= 0xe8000 && address + bytes.length >= 0x100000) bytes.set(syntheticCodec(), 0xe8000 - address);
      return bytes;
    }
    async writeProgram(plan, progress) {
      calls.writes++;
      if (failWrites) throw new Error('Cable failed /Users/private/owner-radio-backup.zip at https://private.example/key with 0123456789abcdef0123456789abcdef');
      const checked = [];
      for (const sector of plan) checked.push({ ...sector, memory: 'program', before: await super.read('program', sector.address, sector.data.length) });
      return super.applyPlan(checked, async value => { await progress?.(value); calls.progress.push({ ...value }); onProgress?.(value); });
    }
    async applyPlan(plan, progress) {
      calls.writes++;
      if (failWrites) throw new Error('Cable failed /Users/private/owner-radio-backup.zip at https://private.example/key with 0123456789abcdef0123456789abcdef');
      return super.applyPlan(plan, async value => { await progress?.(value); calls.progress.push({ ...value }); onProgress?.(value); });
    }
    async restartVerified() {
      if (restartFault === 'disconnect') calls.transports.at(-1).disconnect(new DOMException('Break received', 'BreakError'));
      if (restartFault === 'throw') throw new DOMException('Reset reply lost', 'NetworkError');
    }
  }
  const file = new MemoryFile('my-radio-backup.zip');
  const sandbox = {
    Installer, radioRegions, BrowserSerial, Monitor, Journal, MONITOR_SHA256, sha256,
    MAX_ARCHIVE, jsonBytes, verifyArchive, readFirmware, validateCatalog, downloadPackage, packageURL, readFactoryFirmware, buildFactoryUpdate,
    document: { getElementById: get, createElement: tag => new Element(tag),
      createRange: () => ({ selectNodeContents(element) { calls.selected = element.textContent; } }) },
    location: { href: (hosted ? 'https://kd8zmm.com/open25-dm32/v3/firmware.html' : 'http://localhost/v3/firmware.html') + hash, hash, origin: hosted ? 'https://kd8zmm.com' : 'http://localhost', assign() {} },
    navigator: { ...privacy, clipboard: { async writeText(value) { if (copyError) throw copyError; calls.copied.push(value); } } },
    crypto: webcrypto, fetch, URL: BrowserURL, Blob, Uint8Array, AbortController, structuredClone, setTimeout: appSetTimeout, clearTimeout: appClearTimeout,
    getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
    addEventListener() {}, confirm: message => { calls.confirms.push(message); return message.includes('finished-image') ? confirmSkip : true; },
    showSaveFilePicker() {
      assert(inGesture, 'Save As must open directly from the backup click');
      calls.saves++; calls.readsBeforeSave = calls.reads.length;
      return saveError ? Promise.reject(saveError) : Promise.resolve(file);
    },
  };
  Object.defineProperty(sandbox, 'localStorage', { get() {
    if (noticeStorageUnavailable) throw new Error('Storage unavailable');
    return {
      getItem(key) { assert.equal(key, 'open25-dm32-v3-regulatory-v1', 'only regulatory acceptance may be read'); return noticeStorage.get(key) ?? null; },
      setItem(key, value) { assert.equal(key, 'open25-dm32-v3-regulatory-v1', 'only regulatory acceptance may be saved'); noticeStorage.set(key, value); },
    };
  } });
  for (const name of ['sessionStorage', 'indexedDB']) {
    Object.defineProperty(sandbox, name, { get() { throw new Error(`Previous-session storage accessed: ${name}`); } });
  }
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  const source = (await readFile(new URL('../app.mjs', import.meta.url), 'utf8')).replace(/^import .+;\r?\n/gm, '');
  vm.runInContext(source, context, { filename: 'app.mjs' });
  async function settled() {
    await new Promise(resolve => setImmediate(resolve));
    const deadline = Date.now() + 10000;
    while (vm.runInContext('busy', context)) {
      assert(Date.now() < deadline, 'wizard operation did not finish');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }
  function click(action) {
    assert.match(get('screen').innerHTML + get('file-summary').innerHTML, new RegExp(`data-action="${action}"`));
    const target = new Element(); target.dataset.action = action;
    inGesture = true;
    let result;
    try { result = get('work-card').listeners.get('click')({ target, preventDefault() {} }); }
    finally { inGesture = false; }
    return Promise.resolve(result).then(settled);
  }
  async function mode(value) {
    if (vm.runInContext('mode !== null', context)) { await get('all-tools').listeners.get('click')(); await settled(); }
    await click(`mode-${value}`);
  }
  async function upload(bytes = firmware, filename = 'my-firmware.zip') {
    get('screen').listeners.get('change')({ target: { name: 'firmware-source', value: 'upload' } });
    nextFile = { name: filename, size: bytes.length, arrayBuffer: async () => bytes.slice().buffer };
    await click('firmware');
  }
  await settled();
  return { calls, get, click, mode, upload, settled, file, html: () => get('screen').innerHTML,
    elementClick: (id, event) => get(id).listeners.get('click')?.(event),
    evaluate: code => vm.runInContext(code, context),
    expireAppTimers() {
      const pending = [...appTimers.values()]; appTimers.clear();
      for (const timer of pending) timer.callback(...timer.args);
      return pending.map(timer => timer.delay);
    },
    fileUpload: async (action, bytes, filename = 'chosen.bin') => { nextFile = { name: filename, size: bytes.length, arrayBuffer: async () => bytes.slice().buffer }; await click(action); },
    confirmSameRadio: () => get('screen').listeners.get('change')({ target: { id: 'same-radio', checked: true } }),
    disconnect: () => calls.transports.at(-1).disconnect(new Error('Programming cable disconnected')) };
}

test('v3 begins with six deliberate tools and no connection or write', async t => {
  const ui = await wizard(t);
  for (const mode of ['first', 'update', 'archive', 'factory', 'info', 'package']) assert.match(ui.html(), new RegExp(`data-action="mode-${mode}"`));
  assert.equal(ui.calls.ports, 0); assert.equal(ui.calls.writes, 0); assert.equal(ui.calls.reads.length, 0);
  await ui.mode('first');
  assert.match(ui.html(), /Choose your firmware/);
  assert.equal(ui.calls.ports, 0); assert.equal(ui.calls.writes, 0);
});

test('a waiting connection logs activity once after five seconds without changing the restart prompt', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const ui = await wizard(t, { startGate: gate, controlAppTimers: true,
    serialDiagnostics: { usbVendorId: 0x067b, usbProductId: 0x2303, rxBytes: 0, txBytes: 660,
      writesStarted: 165, writesCompleted: 165, readErrors: 1, lastReadError: 'BreakError', maxWriteMs: 2 } });
  await ui.mode('info'); const connecting = ui.click('connect');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ui.get('work-heading').textContent, 'Restart your radio');
  assert.deepEqual(ui.expireAppTimers(), [5000]);
  assert.match(ui.get('activity').textContent, /Connection check: USB 067b:2303 RX=0 TX=660 W=165:165 E=1:BreakError maxW=2ms/);
  assert.deepEqual(ui.expireAppTimers(), [], 'the activity check does not repeat');
  assert.equal(ui.get('work-heading').textContent, 'Restart your radio');
  release(); await connecting;
  assert.deepEqual(ui.expireAppTimers(), []);
});

test('a fast connection clears its activity timer', async t => {
  const ui = await wizard(t, { controlAppTimers: true });
  await ui.mode('info'); await ui.click('connect');
  assert.deepEqual(ui.expireAppTimers(), []);
  assert.doesNotMatch(ui.get('activity').textContent, /Connection check/);
});

test('only the power-on timeout adds bounded connection context to the existing support report', async t => {
  const ui = await wizard(t, { hosted: true, physical: true, controlAppTimers: true,
    startError: new Error('No power-on handshake. Check the cable and switch the radio off and on.'),
    serialDiagnostics: { usbVendorId: 0x067b, usbProductId: 0x2303, rxBytes: Number.MAX_SAFE_INTEGER,
      txBytes: Number.MAX_SAFE_INTEGER, writesStarted: Number.MAX_SAFE_INTEGER, writesCompleted: Number.MAX_SAFE_INTEGER,
      readErrors: Number.MAX_SAFE_INTEGER, lastReadError: 'BufferOverrunError', maxWriteMs: Number.MAX_SAFE_INTEGER,
      serialNumber: 'private-cable-id', rawBytes: 'private radio data' } });
  await ui.mode('info'); await ui.click('connect');
  const event = ui.calls.diagnostics.find(event => event.workflow === 'connect' && event.event === 'operation_failed');
  assert.equal(event.appVersion, '2026-11-16-flasher-v3-4');
  assert.equal(event.error.code, 'rom_no_handshake');
  assert.match(event.error.message, /USB 067b:2303 RX=9999999 TX=9999999 W=9999999:9999999 E=9999999:BufferOverrunError maxW=9999999ms/);
  assert.match(event.error.message, /Restart radio and retry\.$/);
  assert(event.error.message.length < 160);
  assert.equal(ui.get('error-message').textContent, event.error.message);
  assert.equal(ui.get('error-support-id').textContent, event.operationId);
  assert.doesNotMatch(JSON.stringify(event), /private|rawBytes|serialNumber/);
  assert.deepEqual(ui.expireAppTimers(), [], 'a failed connection clears its activity timer');
});

test('other connection errors keep their original support message and clear the activity timer', async t => {
  const ui = await wizard(t, { hosted: true, physical: true, controlAppTimers: true,
    startError: new Error('Connection interrupted') });
  await ui.mode('info'); await ui.click('connect');
  const event = ui.calls.diagnostics.find(event => event.workflow === 'connect' && event.event === 'operation_failed');
  assert.equal(event.error.message, 'Connection interrupted');
  assert.equal(event.error.code, undefined);
  assert.deepEqual(ui.expireAppTimers(), []);
});

test('first install uses the existing ZIP and waits for an explicit write without a backup stage', async t => {
  const ui = await wizard(t);
  await ui.mode('first'); await ui.click('download-firmware');
  assert.match(ui.html(), /Connect your radio/);
  assert.equal(ui.calls.ports, 0);
  await ui.click('connect');
  assert.match(ui.html(), /Ready to install/);
  assert.match(ui.html(), /This release uses the new Classic CPS/);
  assert.match(ui.html(), /Retired Classic formats are not imported; existing RFKV programming is preserved/);
  assert.doesNotMatch(ui.html(), /Save a full backup|Skip backup/);
  assert.equal(ui.calls.writes, 0); assert.equal(ui.calls.saves, 0);
  await ui.click('flash');
  assert.equal(ui.calls.writes, 1); assert.equal(ui.calls.saves, 0);
  assert.match(ui.html(), /Flash complete!/);
  assert.match(ui.html(), /href="\.\.\/classic-cps\/">Open Classic CPS/);
  assert.doesNotMatch(ui.html(), /Both complete flash chips|Firmware verified/);
  assert.equal(ui.calls.reads.filter(read => read.memory === 'data').length, 0);
});

test('update reads the prepared slot and does not fall back to a full program capture', async t => {
  const ui = await wizard(t);
  await ui.mode('update'); await ui.upload(); await ui.click('connect'); await ui.click('flash');
  assert.equal(ui.calls.writes, 1);
  assert(ui.calls.reads.some(read => read.memory === 'program' && read.address === 0xe8000 && read.length === 0x18000));
  assert(!ui.calls.reads.some(read => read.memory === 'program' && read.length === 0x100000));
  assert(!ui.calls.reads.some(read => read.memory === 'data'));
});

test('an update with no prepared codec fails before writes and gives a support ID', async t => {
  const ui = await wizard(t, { prepared: false });
  await ui.mode('update'); await ui.upload(); await ui.click('connect'); await ui.click('flash');
  assert.equal(ui.calls.writes, 0);
  assert.match(ui.get('error-message').textContent, /First install/i);
  assert.match(ui.get('error-support-id').textContent, /^[0-9a-f-]{36}$/);
  assert.match(ui.get('error-support-help').textContent, /sharing is off/);
});

test('Next manual ZIP retains an explicit notice about runtime programming initialization', async t => {
  const app = new Uint8Array(4097).fill(0x53);
  const next = zip(new Map([
    ['firmware.json', jsonBytes({ format: 'open25-dm32-firmware', version: 2, target: 'dm32-operator', release: 'next-local', applicationSha256: await sha256(app) })],
    ['application.bin', app],
  ]));
  const ui = await wizard(t);
  await ui.mode('first'); await ui.upload(next); await ui.click('connect');
  assert.match(ui.html(), /Next may replace stored radio programming/);
  assert.equal(ui.calls.writes, 0);
});

test('backup remains a separate two-pass operation and Save As precedes capture', async t => {
  const ui = await wizard(t, { physical: true });
  await ui.mode('archive');
  assert.match(ui.html(), /Back up this radio/); assert.match(ui.html(), /Restore a backup/);
  await ui.click('choose-backup'); await ui.click('connect');
  assert.equal(ui.calls.saves, 0); assert.equal(ui.calls.writes, 0);
  const before = ui.calls.reads.length;
  await ui.click('backup');
  assert.equal(ui.calls.readsBeforeSave, before);
  assert.equal(ui.calls.saves, 1); assert.equal(ui.calls.writes, 0);
  assert.equal(ui.calls.reads.slice(before).filter(read => read.memory === 'data' && read.length === 0x1000000).length, 2);
  assert.match(ui.html(), /Backup saved and checked/);
});

test('full restore requires its own action and physical-radio confirmation', async t => {
  const ui = await wizard(t, { physical: true });
  await ui.mode('archive'); await ui.click('choose-backup'); await ui.click('connect'); await ui.click('backup');
  const archive = ui.file.bytes.slice();
  await ui.mode('archive'); await ui.click('choose-restore');
  await ui.fileUpload('restore-file', archive, 'private-radio.zip'); await ui.click('connect');
  assert.match(ui.html(), /This backup belongs to this physical radio/);
  assert.match(ui.html(), /data-action="restore-write" disabled/);
  assert.equal(ui.calls.writes, 0);
  ui.confirmSameRadio();
  await ui.elementClick('disconnect'); await ui.settled(); await ui.click('connect');
  assert.match(ui.html(), /data-action="restore-write" disabled/, 'a new connection requires fresh physical-radio confirmation');
  ui.confirmSameRadio(); await ui.click('restore-write');
  assert.equal(ui.calls.writes, 1);
  assert.match(ui.html(), /Backup restored and checked/);
});

test('factory reversion accepts Baofeng input separately and never starts writing on selection or connection', async t => {
  const stock = new Uint8Array(0x1100).fill(255);
  stock.set(new TextEncoder().encode('BFUV32-V2')); stock.set(new TextEncoder().encode('END'), 0xfd); stock.fill(0x53, 0x100);
  const ui = await wizard(t);
  await ui.mode('factory'); await ui.fileUpload('factory-file', stock, 'untouched-stock.bin');
  assert.equal(ui.calls.writes, 0); assert.equal(ui.calls.ports, 0);
  await ui.click('connect');
  assert.match(ui.html(), /Ready to revert to Baofeng/); assert.equal(ui.calls.writes, 0);
  assert.match(ui.html(), /compatibility and completeness are not verified/);
  await ui.click('revert');
  assert.equal(ui.calls.writes, 1); assert.match(ui.html(), /Baofeng firmware written and checked/);
  assert(!ui.calls.reads.some(read => read.memory === 'data'));
});

test('radio info is read only and is never included in diagnostic payloads', async t => {
  const ui = await wizard(t, { hosted: true, physical: true });
  await ui.mode('info'); await ui.click('connect');
  assert.match(ui.html(), /Read radio information/); assert.equal(ui.calls.writes, 0);
  const reads = ui.calls.reads.length;
  await ui.click('inspect');
  assert(ui.calls.reads.length > reads); assert.equal(ui.calls.writes, 0);
  assert.match(ui.html(), /Radio information/); assert.match(ui.html(), /Memory regions/);
  const events = ui.calls.diagnostics.filter(event => event.workflow === 'info');
  assert(events.some(event => event.event === 'operation_succeeded'));
  for (const event of events) {
    assert.equal(event.codec, undefined); assert.equal(event.calibration, undefined); assert.equal(event.regions, undefined); assert.equal(event.info, undefined);
  }
});

test('hosted direct-write outcomes identify checksum verification without claiming complete image readback', async t => {
  const ui = await wizard(t, { hosted: true, physical: true, privacy: { doNotTrack: '1', globalPrivacyControl: true } });
  await ui.mode('update'); await ui.upload(); await ui.click('connect'); await ui.click('flash');
  const event = ui.calls.diagnostics.find(event => event.workflow === 'update' && event.event === 'operation_succeeded');
  assert(event); assert.equal(event.verificationMethod, 'sector-crc32');
  assert.equal(event.readbackVerified, false); assert.equal(event.verificationSkipped, false);
  assert.equal(event.appVersion, '2026-11-16-flasher-v3-4');
});

test('write failure diagnostics preserve received support ID and sanitize private file details', async t => {
  const ui = await wizard(t, { hosted: true, physical: true, failWrites: true });
  await ui.mode('update'); await ui.upload(); await ui.click('connect'); await ui.click('flash');
  const event = ui.calls.diagnostics.find(event => event.workflow === 'update' && event.event === 'operation_failed');
  assert(event); assert.equal(ui.get('error-support-id').textContent, event.operationId);
  assert.match(ui.get('error-support-help').textContent, /received/);
  assert.doesNotMatch(event.error.message, /owner-radio|private\.example|0123456789abcdef/);
  await ui.elementClick('copy-support-id');
  assert(ui.calls.copied[0].includes(event.operationId));
  assert(ui.calls.copied[0].includes('flasher-v3-4'));
});

test('restart failure preserves completed checksum result and reports manual power cycle', async t => {
  const ui = await wizard(t, { hosted: true, physical: true, restartFault: 'throw' });
  await ui.mode('update'); await ui.upload(); await ui.click('connect'); await ui.click('flash');
  assert.match(ui.html(), /Automatic restart was not confirmed/);
  const event = ui.calls.diagnostics.find(event => event.workflow === 'update' && event.event === 'operation_succeeded');
  assert.equal(event.verificationMethod, 'sector-crc32'); assert.equal(event.resetSent, false); assert(event.restartError);
});

test('localhost previews never send diagnostics and hosted opt-out stops uploads', async t => {
  const local = await wizard(t);
  await local.mode('factory'); await local.fileUpload('factory-file', new Uint8Array([1]), 'private.bin');
  assert.equal(local.calls.diagnostics.length, 0);
  const hosted = await wizard(t, { hosted: true });
  hosted.get('hardware-reporting').checked = false;
  const before = hosted.calls.diagnostics.length;
  await hosted.mode('factory'); await hosted.fileUpload('factory-file', new Uint8Array([1]), 'private.bin');
  assert.equal(hosted.calls.diagnostics.length, before);
  assert.match(hosted.get('error-support-help').textContent, /sharing is off/);
});

test('update chip activity follows the codec read and confirmed program writes without reading radio data', async t => {
  let ui;
  const frames = [];
  ui = await wizard(t, { onProgress: event => frames.push({ event: { ...event },
    program: ui.get('chip-program-state').textContent, data: ui.get('chip-data-state').textContent }) });
  await ui.mode('update'); await ui.upload(); await ui.click('connect');
  const before = frames.length;
  await ui.click('flash');
  const operation = frames.slice(before);
  const codec = operation.find(frame => frame.event.activity === 'read' && frame.event.memory === 'program' && frame.event.start === 0xe8000);
  assert(codec, 'the actual prepared-codec read reaches the activity view');
  assert.equal(codec.program, 'Reading'); assert.equal(codec.data, 'Not written');
  const writes = operation.filter(frame => frame.event.activity === 'write');
  assert(writes.length > 0);
  for (const frame of writes) {
    assert.equal(frame.event.memory, 'program');
    assert.equal(frame.program, 'Writing & checking'); assert.equal(frame.data, 'Not written');
  }
  assert.equal(ui.calls.reads.some(read => read.memory === 'data'), false);
  assert.equal(ui.get('chip-program-state').textContent, 'Written & checked');
  assert.equal(ui.get('chip-data-state').textContent, 'Not written');
});

test('chip sizes come from the connected radio and map hover text has no memory addresses', async t => {
  const chips = { program: { jedec: 'c84015', size: 0x200000 }, data: { jedec: 'ef4017', size: 0x800000 } };
  const ui = await wizard(t, { chips });
  await ui.mode('info'); await ui.click('connect');
  assert.match(ui.get('chip-program-size').textContent, /^2\s*MiB$/);
  assert.match(ui.get('chip-data-size').textContent, /^8\s*MiB$/);
  const map = ui.get('chip-activity-grid').innerHTML;
  assert.doesNotMatch(map, /0x[0-9a-f]+/i);
  assert.match(map, /Starts the radio and holds factory information/);
  assert.match(map, /calibration/i);
  assert.match(map, /not yet classified|not fully mapped|unknown/i);
  assert.doesNotMatch(map, /(?:Unmapped|Unknown)[^<]*(?:empty|unused)/i);
  assert.equal(ui.calls.writes, 0);
});

test('failed writes stop the activity display and choosing another tool clears the prior view', async t => {
  const ui = await wizard(t, { failWrites: true });
  await ui.mode('update'); await ui.upload(); await ui.click('connect'); await ui.click('flash');
  assert.match(ui.get('error-message').textContent, /Cable failed/);
  assert.equal(ui.get('chip-program-state').textContent, 'Stopped');
  assert.equal(ui.get('chip-data-state').textContent, 'Not written');
  assert.doesNotMatch(ui.html(), /Flash complete!/);
  await ui.elementClick('all-tools'); await ui.settled();
  assert.equal(ui.get('chip-activity').hidden, true);
  await ui.mode('info');
  assert.equal(ui.get('chip-activity').hidden, true, 'a previous radio is not shown before the new connection');
});

test('cancelling a backup clears active reads without claiming a checked backup', async t => {
  let ui, cancelled = false;
  ui = await wizard(t, { onProgress: event => {
    if (!cancelled && event.activity === 'read' && event.memory === 'data' && event.done === 0) {
      cancelled = true; ui.elementClick('cancel-read');
    }
  } });
  await ui.mode('archive'); await ui.click('choose-backup'); await ui.click('connect'); await ui.click('backup');
  assert.equal(cancelled, true);
  assert.equal(ui.get('chip-data-state').textContent, 'Stopped');
  assert.doesNotMatch(ui.get('chip-program-state').textContent, /^(?:Reading|Checking|Writing & checking)$/);
  assert.doesNotMatch(ui.html(), /Backup saved and checked/);
  assert.equal(ui.calls.writes, 0);
});

test('skipping final restore verification cannot turn preflight reads into checked chip results', async t => {
  let release;
  const verificationGate = new Promise(resolve => { release = resolve; });
  const ui = await wizard(t, { physical: true, prepared: false, verificationGate });
  const backupRadio = new (class extends SimulatedRadio { get simulated() { return false; } })({ open25: true });
  const { bytes: archive } = await captureBackup(backupRadio);
  await backupRadio.close();
  await ui.mode('archive'); await ui.click('choose-restore');
  await ui.fileUpload('restore-file', archive, 'private-radio.zip'); await ui.click('connect'); ui.confirmSameRadio();
  const restoring = ui.click('restore-write');
  const until = Date.now() + 10000;
  while (!ui.calls.heldVerify && ui.evaluate('busy')) {
    assert(Date.now() < until, 'final verification did not start');
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(ui.calls.heldVerify, true, ui.get('error-message').textContent);
  assert(ui.calls.progress.some(event => event.activity === 'write'), 'the restore performs confirmed writes before its final check');
  assert.equal(ui.get('chip-program-state').textContent, 'Checking');
  await ui.elementClick('skip-verification'); release(); await restoring;
  assert.match(ui.html(), /final check skipped/, ui.get('error-message').textContent);
  assert.equal(ui.get('chip-program-state').textContent, 'Written');
  assert.notEqual(ui.get('chip-data-state').textContent, 'Checked');
  for (const memory of ['program', 'data']) assert.doesNotMatch(ui.get(`chip-${memory}-state`).textContent, /^(?:Reading|Checking|Writing & checking)$/);
});

test('Create update file exports a public build with a locally supplied codec without connecting a radio', async t => {
  const ui = await wizard(t, { hosted: true, controlAppTimers: true });
  await ui.mode('package');
  assert.match(ui.html(), /Choose your firmware/);
  assert.doesNotMatch(ui.html(), /value="upload"|data-action="firmware"/);
  await ui.click('download-firmware');
  assert.equal(ui.calls.downloads, 1);
  assert.match(ui.html(), /Choose Baofeng firmware/);
  assert.match(ui.html(), /href="https:\/\/baofeng\.s3\.amazonaws\.com\/Baofeng_DM-32UV_Firmware_v1\.01\.048\.zip"/);
  assert.doesNotMatch(ui.html(), /class="updater-guide"/);
  await ui.fileUpload('package-oem', localFactoryFile(), 'owner-private-stock-image.bin');
  assert.match(ui.html(), /Update file created/);
  assert.match(ui.html(), /class="updater-guide"/);
  assert.match(ui.html(), /Open25 \.bin you downloaded above/);
  assert.equal(ui.calls.exports.length, 0, 'validation alone does not trigger a download');
  await ui.click('package-download');
  assert.equal(ui.calls.exports.length, 1);
  const exported = ui.calls.exports[0];
  assert.match(exported.filename, /\.bin$/i);
  assert.doesNotMatch(exported.filename, /owner-private/);
  const bytes = new Uint8Array(await exported.blob.arrayBuffer());
  const parsed = await readFactoryFirmware(bytes);
  assert.equal(parsed.format, 'BFUV32-V2');
  assert.equal(parsed.application.length, DM32_CODEC.end - APP_START);
  assert.equal(ui.calls.ports, 0); assert.equal(ui.calls.radios.length, 0);
  assert.equal(ui.calls.reads.length, 0); assert.equal(ui.calls.writes, 0); assert.equal(ui.calls.saves, 0);
  assert.equal(ui.get('chip-activity').hidden, true);
  assert(ui.calls.diagnostics.length > 0);
  for (const event of ui.calls.diagnostics) {
    const payload = JSON.stringify(event);
    assert.doesNotMatch(payload, /owner-private|PRIVATE_OEM_DIAGNOSTIC_SENTINEL|BFUV32-V2/);
    assert(payload.length < 2000, 'diagnostics contain bounded metadata, not input file contents');
    assert.equal(event.hardware, undefined);
  }
  await ui.mode('package'); await ui.click('download-firmware');
  assert.doesNotMatch(ui.html(), /data-action="package-download"/, 'a new tool session cannot download the previous generated file');
});

test('an incoming package link opens the builder without Web Serial', async t => {
  const ui = await wizard(t, { hash: '#package', serialSupported: false });
  assert.match(ui.html(), /Choose your firmware/);
  assert.equal(ui.evaluate('mode'), 'package');
  await ui.click('download-firmware');
  assert.match(ui.html(), /Choose Baofeng firmware/);
  assert.equal(ui.calls.ports, 0); assert.equal(ui.calls.reads.length, 0); assert.equal(ui.calls.writes, 0);
});

test('regulatory acceptance survives reload and the compatibility popup follows it', async t => {
  const noticeStorage = new Map();
  const first = await wizard(t, { noticeStorage });
  assert.equal(first.get('usage-dialog').open, true);
  assert.notEqual(first.get('compatibility-dialog').open, true);
  first.elementClick('usage-dismiss');
  assert.equal(first.get('usage-dialog').open, false);
  assert.equal(first.get('compatibility-dialog').open, true);
  first.elementClick('compatibility-dismiss');
  assert.equal(first.get('compatibility-dialog').open, false);
  const reload = await wizard(t, { noticeStorage });
  assert.notEqual(reload.get('usage-dialog').open, true);
  assert.equal(reload.get('compatibility-dialog').open, true);
  assert.equal(noticeStorage.size, 1);
  assert.equal(reload.calls.ports, 0); assert.equal(reload.calls.writes, 0);
});

test('unavailable notice storage still permits both popups and tool selection', async t => {
  const ui = await wizard(t, { noticeStorageUnavailable: true });
  assert.equal(ui.get('usage-dialog').open, true);
  ui.elementClick('usage-dismiss');
  assert.equal(ui.get('compatibility-dialog').open, true);
  ui.elementClick('compatibility-dismiss');
  await ui.mode('package');
  assert.match(ui.html(), /Choose your firmware/);
  assert.equal(ui.calls.ports, 0);
});

test('cable guidance follows the OS without reading USB devices or treating iPad as Mac', async t => {
  for (const [privacy, expected] of [
    [{ platform: 'MacIntel', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)', maxTouchPoints: 0 }, 'mac'],
    [{ userAgentData: { platform: 'macOS' } }, 'mac'],
    [{ userAgentData: { platform: 'Windows' }, platform: 'MacIntel' }, 'windows'],
    [{ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }, 'windows'],
    [{ platform: 'MacIntel', userAgent: 'Mozilla/5.0 (Macintosh)', maxTouchPoints: 5 }, 'other'],
    [{ platform: 'Linux x86_64' }, 'other'],
  ]) {
    const ui = await wizard(t, { privacy });
    assert.equal(ui.get('cable-mac-example').hidden, expected !== 'mac');
    assert.equal(ui.get('cable-windows-example').hidden, expected !== 'windows');
    if (expected === 'mac') assert.match(ui.get('cable-platform-help').innerHTML, /System Information/);
    if (expected === 'windows') {
      assert.match(ui.get('cable-platform-help').innerHTML, /Device Manager/);
      assert.match(ui.get('cable-driver-note').innerHTML, /3\.8\.31\.0/);
    }
    assert.equal(ui.get('prolific-support').textContent, expected === 'windows' ? '✓' : '△');
    assert.equal(ui.calls.ports, 0); assert.equal(ui.calls.radios.length, 0);
  }
});

test('Create update file rejects invalid Baofeng input before exposing a downloadable file', async t => {
  const ui = await wizard(t, { hosted: true, controlAppTimers: true });
  await ui.mode('package'); await ui.click('download-firmware');
  for (const bytes of [new Uint8Array([1]), localFactoryFile({ codec: false })]) {
    await ui.fileUpload('package-oem', bytes, 'owner-private-bad-file.bin');
    assert.match(ui.get('error-message').textContent, /Baofeng|codec|firmware/i);
    assert.doesNotMatch(ui.html(), /data-action="package-download"/);
    assert.equal(ui.calls.exports.length, 0);
  }
  assert.equal(ui.calls.ports, 0); assert.equal(ui.calls.reads.length, 0); assert.equal(ui.calls.writes, 0);
  for (const event of ui.calls.diagnostics) assert.doesNotMatch(JSON.stringify(event), /owner-private|PRIVATE_OEM_DIAGNOSTIC_SENTINEL/);
});



test('update codec failures report header and fingerprint without any extra radio reads', async t => {
  const ui = await wizard(t, { hosted: true, physical: true, prepared: false });
  await ui.mode('update'); await ui.click('download-firmware'); await ui.click('connect');
  const reads = ui.calls.reads.length;
  await ui.click('flash');
  const failed = ui.calls.diagnostics.find(event => event.workflow === 'update' && event.event === 'operation_failed');
  assert.equal(failed.error.code, 'codec_slot_header');
  assert.equal(failed.error.codec.nativeMatch, 'not-searched');
  assert.equal(typeof failed.error.codec.headerMarker, 'number');
  assert.equal(typeof failed.error.codec.headerVersion, 'number');
  assert.match(failed.error.codec.slotSha256, /^[0-9a-f]{64}$/);
  assert.equal(ui.calls.reads.length - reads, 1);
  assert.equal(ui.calls.writes, 0);
  const safe = ui.evaluate("diagnosticError({code:'codec_slot_header',message:'No codec',codec:{nativeMatch:'not-searched',rawBytes:'PRIVATE_CODEC'}})");
  assert.equal(safe.codec, undefined); assert.equal(safe.code, 'codec_slot_header');
});
