// SPDX-License-Identifier: GPL-3.0-or-later
import { readFactoryFirmware, buildFactoryUpdate } from './lib/factory.mjs';
import { Installer, radioRegions } from './lib/engine.mjs';
import { BrowserSerial } from './lib/serial.mjs';
import { Monitor } from './lib/monitor.mjs';
import { Journal } from './lib/journal.mjs';
import { MONITOR_SHA256 } from './lib/policy.mjs';
import { MAX_ARCHIVE, jsonBytes } from './lib/zip.mjs';
import { verifyArchive } from './lib/archive.mjs';
import { readFirmware, validateCatalog, downloadPackage, packageURL } from './lib/firmware.mjs';
import { sha256 } from './lib/bytes.mjs';

const $ = id => document.getElementById(id);
const screen = $('screen');
const journal = new Journal();
const hardwareReporting = $('hardware-reporting');
const hosted = location.origin === 'https://kd8zmm.com';
const sentHardwareReports = new Set();
hardwareReporting.checked = hosted;
hardwareReporting.disabled = !hosted;
$('hardware-report-option').hidden = !hosted;
const randomId = () => {
  if (globalThis.crypto.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = bytes[6] & 15 | 64; bytes[8] = bytes[8] & 63 | 128;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
const pageId = randomId();
const APP_VERSION = '2026-11-16-flasher-v3-5';
// Bump this key if the regulatory notice changes and needs fresh acceptance.
const usageAcceptanceKey = 'open25-dm32-v3-regulatory-v1';
let diagnosticHardware, diagnosticAttempt;
const diagnosticPhases = new Set(['connect', 'identify', 'archive', 'backup', 'save', 'preflight', 'install', 'restore', 'verify', 'restart', 'complete', 'serial-supported', 'serial-unavailable']);

function diagnosticFirmware() {
  const manifest = (mode === 'factory' ? factorySelection?.manifest : firmwareSelection?.manifest) || completedFirmware;
  if (!manifest) return undefined;
  // Generic manual ZIP targets are not constrained by the package format.
  // Diagnostics keep only a short target identifier, never arbitrary manifest data.
  const target = typeof manifest.target === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(manifest.target)
    ? manifest.target : 'unspecified';
  return { target, release: manifest.release, sha256: manifest.applicationSha256 };
}
function rememberDiagnostics(attempt = diagnosticAttempt, includeFirmware = true) {
  if (!attempt) return;
  attempt.hardware = diagnosticHardware || attempt.hardware;
  if (includeFirmware) attempt.firmware = diagnosticFirmware() || attempt.firmware;
  attempt.simulated ||= engine.state.simulated;
}
function sendDiagnostic(event, attempt = diagnosticAttempt, extra = {}) {
  if (!hosted || !hardwareReporting.checked || attempt?.simulated || engine.state.simulated) return Promise.resolve('off');
  const body = JSON.stringify({ version: 2, pageId, appVersion: APP_VERSION, operationId: attempt?.operationId,
    event, workflow: attempt?.workflow || 'connect',
    phase: diagnosticPhases.has(lastProgress?.phase) ? lastProgress.phase : undefined,
    firmware: attempt ? attempt.firmware : diagnosticFirmware(), hardware: attempt ? attempt.hardware : diagnosticHardware, ...extra });
  // Delivery stays in the background; a Support ID is received only after the collector confirms its append.
  return (async () => {
    for (let tries = 0; tries < 2; tries++) {
      if (!hardwareReporting.checked) return 'off';
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 5000);
      try {
        const response = await fetch('./hardware-report.php', {
          method: 'POST', body, headers: { 'Content-Type': 'application/json' },
          keepalive: true, credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', signal: controller.signal,
        });
        if (response.status === 204) return 'sent';
        if (response.status < 500) return 'failed';
      } catch { /* retry one transient delivery failure */ }
      finally { clearTimeout(timer); }
    }
    return 'failed';
  })();
}
function diagnosticCodec(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'nativeMatch')) return undefined;
  const keys = ['nativeMatch', 'headerMarker', 'headerVersion', 'slotBlank', 'slotSha256',
    'nativeSignatures', 'candidateCodeSha256', 'candidateCodeBytes', 'matchedProfile', 'tableCandidates'];
  if (Object.keys(value).some(key => !keys.includes(key)) ||
      !['not-searched', 'no-signature', 'code-mismatch', 'tables-mismatch', 'matched'].includes(value.nativeMatch)) return undefined;
  const integer = (key, max) => value[key] === undefined || Number.isInteger(value[key]) && value[key] >= 0 && value[key] <= max;
  const hash = key => value[key] === undefined || typeof value[key] === 'string' && /^[0-9a-f]{64}$/.test(value[key]);
  const header = ['headerMarker', 'headerVersion', 'slotBlank', 'slotSha256'];
  if (header.some(key => value[key] !== undefined) && !header.every(key => value[key] !== undefined)) return undefined;
  if (!integer('headerMarker', 0xffffffff) || !integer('headerVersion', 0xffffffff) ||
      value.slotBlank !== undefined && typeof value.slotBlank !== 'boolean' || !hash('slotSha256') ||
      value.slotBlank === true && (value.headerMarker !== 0xffffffff || value.headerVersion !== 0xffffffff) ||
      !integer('nativeSignatures', 4194304) || !integer('tableCandidates', 4194304) ||
      !integer('matchedProfile', 65535) || !integer('candidateCodeBytes', 98304) || !hash('candidateCodeSha256') ||
      (value.candidateCodeSha256 === undefined) !== (value.candidateCodeBytes === undefined) || value.candidateCodeBytes === 0) return undefined;
  return { ...value };
}
function diagnosticError(error) {
  const name = /^[A-Za-z]{1,70}Error$/.test(error?.name || '') ? error.name : 'Error';
  const message = String(error?.message || error || 'Unknown error')
    .replace(/https?:\/\/\S+/gi, '[URL]')
    .replace(/(?:[A-Za-z]:[\\/]|\/)(?:[^\s<>"']+[\\/])*[^\s<>"']*/g, '[path]')
    .replace(/\b[^\s<>"']+\.(?:zip|bin|rom|json|dm32cps)\b/gi, '[file]')
    .replace(/\b[0-9a-f]{32,}\b/gi, '[hash]')
    .replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').slice(0, 160);
  const code = typeof error?.code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(error.code) ? error.code : undefined;
  const codec = code?.startsWith('codec_') ? diagnosticCodec(error?.codec) : undefined;
  return { name, message, ...(code ? { code } : {}), ...(codec ? { codec } : {}) };
}
function outsideDiagnosticError(workflow, error) {
  const attempt = { workflow, operationId: randomId(), hardware: diagnosticHardware,
    firmware: diagnosticFirmware(), simulated: engine.state.simulated };
  attempt.delivery = sendDiagnostic(error?.name === 'AbortError' ? 'operation_cancelled' : 'operation_failed', attempt,
    error?.name === 'AbortError' ? {} : { error: diagnosticError(error) });
  return attempt;
}

function sendHardwareReport(report, attempt = diagnosticAttempt) {
  diagnosticHardware = report;
  rememberDiagnostics(attempt);
  const body = JSON.stringify(report);
  if (sentHardwareReports.has(body)) return;
  sentHardwareReports.add(body);
  sendDiagnostic('hardware', attempt, { hardware: report });
}

let engine = new Installer({ journal, progress });
let radio, transport, mode = null, archiveAction = null, busy = false, receipt, info;
let firmwareSelection, stockSelection, factorySelection, restoreArchive, restoreBytes;
let sameRadio = false, choosingPackage = true, lastProgress;
let wakeLock, operationAbort, lastProgressLog = '';
const catalogURL = new URL('../releases/catalog.json', location.href);
let catalog, catalogMessage = 'Loading available releases…';
let firmwareSource = 'classic', firmwareVariant = '', firmwareVersion = '';
let completedFirmware, localUpdate;
// A display projection of this operation's progress; reset for a new operation,
// connection or tool. The monitor owns I/O facts and radioRegions owns the map.
let chipPanels, chipPanelKey = '', chipStopped = false;
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const button = (action, label, disabled = false) => `<button type="button" class="button" data-action="${action}" ${disabled ? 'disabled' : ''}>${label}</button>`;
const link = (action, label) => `<button type="button" class="text-button" data-action="${action}">${label}</button>`;
const names = { first: 'First install', update: 'Update firmware', archive: 'Backup / Restore', factory: 'Revert to factory', info: 'Radio info', package: 'offline installer' };
const baofengFirmwareURL = 'https://baofeng.s3.amazonaws.com/Baofeng_DM-32UV_Firmware_v1.01.048.zip';
const baofengCpsURL = 'https://baofeng.s3.amazonaws.com/BAOFENG_DM-32UV_CPS_v1.60_20260608.zip';
const workflow = () => mode === 'first' ? 'first_install' : mode === 'factory' ? 'revert' : mode === 'archive' ? archiveAction : mode;
const isFirmware = () => mode === 'first' || mode === 'update' || mode === 'package';
const isWrite = value => ['first_install', 'update', 'restore', 'revert'].includes(value);
const hex = value => Number.isInteger(value) ? `0x${value.toString(16).toUpperCase().padStart(6, '0')}` : 'Unknown';
const size = value => `${(value / 1048576).toLocaleString(undefined, { maximumFractionDigits: 2 })} MiB`;
function selectedPackage() {
  const channel = catalog?.channels.find(item => item.id === firmwareSource);
  const variant = channel?.variants.find(item => item.id === firmwareVariant) || channel?.variants[0];
  const release = variant?.releases.find(item => item.version === firmwareVersion) || variant?.releases[0];
  return { channel, variant, release };
}
function firmwarePicker() {
  const { variant, release } = selectedPackage(), manual = firmwareSource === 'upload';
  const selected = firmwareSelection && (manual ? firmwareSelection.source === 'upload' : firmwareSelection.sha256 === release?.sha256);
  const channels = catalog?.channels || [
    { id: 'classic', name: 'Open25-DM32 Classic', description: 'RadioFoundry UI · DMR, FM and conventional P25', enabled: true, variants: [] },
    { id: 'next', name: 'Open25-DM32 Next', description: 'New UI · FM and conventional / trunked P25', enabled: false, releaseDate: 'TBD', variants: [] },
  ];
  const pictures = { classic: 'classic-home.png', next: 'next-home.png', upload: 'firmware-file.svg' };
  const choice = (id, name, description, enabled, tag = '') => `<label class="firmware-source ${enabled ? '' : 'unavailable'}"><span class="source-preview"><img src="../assets/${pictures[id]}" width="240" height="320" alt=""></span><span class="source-heading"><input type="radio" name="firmware-source" value="${escape(id)}" ${id === firmwareSource ? 'checked' : ''} ${enabled ? '' : 'disabled'}><strong>${escape(name)}</strong></span><small class="source-description">${escape(description)}</small>${tag ? `<small class="release-tag">${escape(tag)}</small>` : ''}</label>`;
  const options = (items, selected, label) => items.map((item, index) => `<option value="${escape(item.id || item.version)}" ${(item.id || item.version) === selected ? 'selected' : ''}>${escape(label(item, index))}</option>`).join('');
  const channel = selectedPackage().channel;
  return `<div class="firmware-picker"><h2>Choose your firmware</h2>
    <fieldset class="firmware-sources${mode === 'package' ? ' public-builds' : ''}"><legend class="visually-hidden">Firmware source</legend>${channels.map(item => choice(item.id, item.name, item.description, item.enabled, item.enabled ? '' : 'Coming soon')).join('')}${mode === 'package' ? '' : choice('upload', 'Upload a ZIP', 'Use a firmware file from your computer.', true)}</fieldset>
    ${manual ? '' : `${variant ? `<div class="package-fields">${channel.variants.length > 1 ? `<label>Variant<select id="firmware-variant">${options(channel.variants, variant.id, item => item.name)}</select></label>` : `<div><span class="field-label">Variant</span><p>${escape(variant.name)}</p></div>`}${variant.releases.length ? `<label>Version<select id="firmware-version">${options(variant.releases, release.version, (item, index) => index ? item.version : `Latest available · ${item.version}`)}</select></label>` : ''}</div>` : ''}${release ? `<details class="release-notes"><summary>Release notes</summary><p>${escape(release.notes)}</p></details>` : `<p class="catalog-message" role="status">${escape(catalogMessage || 'No public releases are available for this variant yet. You can upload a firmware ZIP from your computer.')}</p>`}`}
    <div class="package-actions">${manual && selected ? `<p class="file-meta">${escape(firmwareSelection.filename)}</p>` : ''}${manual ? selected ? button('continue-firmware', 'Continue') + '<button type="button" class="text-button" data-action="firmware">Choose another ZIP…</button>' : button('firmware', 'Choose firmware ZIP…') : button('download-firmware', 'Continue', !release || !channel?.enabled)}</div></div>`;
}

function log(message) {
  $('activity').textContent = `${new Date().toLocaleTimeString()}  ${message}\n` + $('activity').textContent.slice(0, 12000);
}
function serialActivity(serial) {
  const info = serial.diagnostics;
  const count = value => Math.min(9999999, Math.max(0, Number.isFinite(value) ? Math.round(value) : 0));
  const id = value => Number.isInteger(value) && value >= 0 && value <= 65535 ? value.toString(16).padStart(4, '0') : '????';
  const readError = info.lastReadError ? `:${info.lastReadError.slice(0, 20)}` : '';
  return `USB ${id(info.usbVendorId)}:${id(info.usbProductId)} RX=${count(info.rxBytes)} TX=${count(info.txBytes)} W=${count(info.writesCompleted)}:${count(info.writesStarted)} E=${count(info.readErrors)}${readError} maxW=${count(info.maxWriteMs)}ms`;
}
function report(error, attempt = diagnosticAttempt) {
  if (error?.name === 'AbortError') { log('Selection or read cancelled.'); return; }
  chipStopped = true;
  $('error-message').textContent = error?.message || String(error);
  $('error-support').hidden = !attempt?.operationId;
  $('error-support-id').textContent = attempt?.operationId || '';
  $('copy-support-id').textContent = 'Copy';
  $('error-support-help').textContent = 'Sending diagnostic report…';
  if (attempt?.delivery) void attempt.delivery.then(status => {
    if ($('error-support-id').textContent !== attempt.operationId) return;
    $('error-support-help').textContent = {
      sent: 'Diagnostic report received. Include this ID when reporting the problem.',
      off: 'Diagnostics sharing is off. Copy the details when reporting the problem.',
      failed: 'Diagnostic report could not be sent. Copy the details when reporting the problem.',
    }[status];
  });
  $('error').hidden = false; log(`Stopped: ${error?.message || error}`);
}
function progress(p) {
  lastProgress = p;
  $('progress-area').hidden = false;
  const waiting = p.phase === 'connect' && p.waitingForPowerCycle;
  const headings = {
    archive: 'Checking your backup', identify: mode === 'info' ? 'Reading radio information' : 'Checking your radio',
    backup: 'Backing up your radio', save: 'Saving your backup',
    preflight: mode === 'first' ? 'Preparing the voice codec' : 'Checking the voice codec',
    install: mode === 'factory' ? 'Writing Baofeng firmware' : mode === 'update' ? 'Updating firmware' : 'Installing firmware',
    restore: 'Restoring your backup', verify: 'Checking the restored backup', restart: 'Restarting your radio', complete: 'Finishing…',
  };
  const heading = $('work-heading');
  if (heading) heading.textContent = waiting ? 'Restart your radio' : headings[p.phase] || p.message || 'Working…';
  $('progress-help').textContent = waiting ? 'Turn it off, wait two seconds, then turn it on. Leave the cable connected. Don’t hold any buttons.' : 'Keep the radio on and connected.';
  $('restart-illustration').hidden = !waiting;
  $('cancel-read').hidden = !operationAbort || p.phase === 'save';
  $('skip-verification').hidden = workflow() !== 'restore' || p.phase !== 'verify' || !engine.state.canSkipVerification;
  const percent = p.total ? Math.max(0, Math.min(100, Math.floor(p.done * 100 / p.total))) : 0;
  const memory = { program: 'Firmware', data: 'Radio data' }[p.memory] || '';
  $('progress-caption').textContent = p.pass ? `Read ${p.pass} of 2 · ${memory}` : memory;
  $('progress-number').textContent = p.total ? `${percent}%` : '';
  if (p.total) $('progress').value = percent; else $('progress').removeAttribute('value');
  const key = `${p.message}-${p.pass}-${p.memory}-${Math.floor(percent / 10)}`;
  if (key !== lastProgressLog) { lastProgressLog = key; log(`${p.message || 'Working'}${p.total ? ` · ${percent}%` : ''}`); }
  renderChipActivity(p);
}
function resetChipActivity(clear = false) {
  chipStopped = false;
  if (clear) {
    chipPanels = undefined; chipPanelKey = '';
    $('chip-activity').hidden = true; $('chip-activity-grid').innerHTML = '';
  } else if (chipPanels) {
    for (const panel of Object.values(chipPanels)) {
      panel.read = undefined; panel.written.clear();
      for (const region of panel.regions) region.written = 0;
    }
  }
}
function renderChipActivity(p) {
  const chips = radio?.chips || engine.state.identity?.chips || receipt?.identity?.chips;
  if (chips?.program && chips?.data) {
    const key = `${chips.program.size}:${chips.data.size}`;
    if (key !== chipPanelKey) {
      chipPanelKey = key; chipPanels = {};
      for (const memory of ['program', 'data']) {
        const capacity = chips[memory].size, regions = [];
        let end = 0;
        const addGap = stop => {
          if (stop > end) regions.push({ start: end, end: stop, name: 'Unmapped area', contents: 'Contents not yet identified.', written: 0 });
        };
        for (const region of radioRegions().filter(r => r.memory === memory && !r.overlay && r.start < capacity).sort((a, b) => a.start - b.start)) {
          addGap(region.start);
          regions.push({ ...region, end: Math.min(region.end, capacity), written: 0 });
          end = Math.min(region.end, capacity);
        }
        addGap(capacity);
        chipPanels[memory] = { size: capacity, regions, written: new Set(), read: undefined };
      }
      $('chip-activity-grid').innerHTML = ['program', 'data'].map(memory => {
        const panel = chipPanels[memory];
        return `<section class="chip" id="chip-${memory}" aria-label="${memory === 'program' ? 'Firmware chip' : 'Storage chip'}"><div class="chip-heading"><span class="chip-icon" aria-hidden="true"></span><h3>${memory === 'program' ? 'Firmware chip' : 'Storage chip'} <span id="chip-${memory}-size"></span></h3><span class="chip-state" id="chip-${memory}-state" role="status"></span></div><div class="chip-map" id="chip-${memory}-map" role="group" aria-label="${memory === 'program' ? 'Firmware' : 'Storage'} memory map">${panel.regions.map((r, i) => `<button type="button" class="memory-region" id="chip-${memory}-region-${i}" style="flex:${r.end - r.start}" aria-label="${escape(r.name + '. ' + r.contents)}"><span class="memory-tooltip" role="tooltip"><strong>${escape(r.name)}</strong>${escape(r.contents)}</span></button>`).join('')}</div></section>`;
      }).join('');
    }
  }
  $('chip-activity').hidden = !mode || !chipPanels;
  if (!mode || !chipPanels) return;
  const panel = chipPanels[p?.memory];
  if (panel && p.activity === 'read' && Number.isSafeInteger(p.start) && Number.isSafeInteger(p.length)) {
    panel.read = { start: p.start, length: p.length, done: p.done, phase: p.phase };
  } else if (panel && p.activity === 'write' && Number.isSafeInteger(p.address) && p.length > 0 && !panel.written.has(p.address)) {
    panel.read = undefined; panel.written.add(p.address);
    for (const region of panel.regions)
      region.written += Math.max(0, Math.min(region.end, p.address + p.length) - Math.max(region.start, p.address));
  }
  for (const memory of ['program', 'data']) {
    const view = chipPanels[memory], read = view.read;
    const active = busy && !chipStopped && lastProgress?.memory === memory && ['read', 'write'].includes(lastProgress.activity);
    const fullCheck = read?.phase === 'verify' && read.start === 0 && read.length === view.size && read.done === view.size;
    let status = memory === 'data' && ['first', 'update', 'factory'].includes(mode) ? 'Not written' : 'Ready';
    if (read?.done > 0) status = 'Read';
    if (view.written.size) status = receipt?.verificationSkipped ? 'Written' : 'Written & checked';
    if (fullCheck && !receipt?.verificationSkipped) status = 'Checked';
    if (active) status = lastProgress.activity === 'write' ? 'Writing & checking' : lastProgress.phase === 'verify' ? 'Checking' : 'Reading';
    if (chipStopped && (read || view.written.size)) status = 'Stopped';
    const statusLabel = $('chip-' + memory + '-state'), sizeLabel = $('chip-' + memory + '-size');
    if (statusLabel.textContent !== status) statusLabel.textContent = status;
    if (sizeLabel.textContent !== size(view.size)) sizeLabel.textContent = size(view.size);
    const action = active ? lastProgress.activity : '';
    $('chip-' + memory).setAttribute('data-activity', action);
    view.regions.forEach((region, i) => {
      const length = region.end - region.start;
      const readBytes = read ? Math.max(0, Math.min(region.end, read.start + read.done) - Math.max(region.start, read.start)) : 0;
      const written = Math.min(100, region.written * 100 / length);
      const readPercent = Math.min(100, readBytes * 100 / length);
      const coverage = Math.max(written, readPercent);
      const color = written > 0 || read?.phase === 'verify' ? 'var(--green)' : 'var(--blue)';
      const targeted = active && (lastProgress.activity === 'read'
        ? read && read.start < region.end && read.start + read.length > region.start
        : lastProgress.address < region.end && lastProgress.address + lastProgress.length > region.start);
      const background = targeted ? (action === 'write' ? 'var(--chip-writing)' : 'var(--soft)') : 'var(--chip-track)';
      const mark = $('chip-' + memory + '-region-' + i);
      mark.style.setProperty('background', `linear-gradient(to right, ${color} 0% ${coverage}%, ${background} ${coverage}% 100%)`);
    });
  }
}
function home() {
  const choices = [
    ['first', 'First install', 'For a radio running Baofeng firmware.'],
    ['update', 'Update firmware', 'For a radio already running RadioFoundry or Open25.'],
    ['archive', 'Backup / Restore', 'Save or restore everything on this radio.'],
    ['factory', 'Revert to factory', 'Reinstall original Baofeng firmware.'],
    ['info', 'Radio info', 'View hardware, codec and memory details.'],
    ['package', 'offline installer', "create an offline firmware package for Baofeng's updater"],
  ];
  return `<h2>What would you like to do?</h2><div class="v3-tools">${choices.map(([id, name, description]) => `<button type="button" class="v3-tool" data-action="mode-${id}"><strong>${name}</strong><span>${description}</span>${id === 'package' ? '<small class="tool-tag">Windows only</small>' : ''}</button>`).join('')}</div>`;
}
function connectScreen() {
  return `<h2>Connect your radio</h2><p class="description">Plug in the programming cable, then choose Connect and select your cable.</p><img class="connection-illustration" src="../assets/connect-cable.svg" width="760" height="300" alt="Plug the programming connector into the radio, then connect USB to your computer."><div class="actions">${button('connect', 'Connect', !BrowserSerial.supported())}</div>${!BrowserSerial.supported() ? '<p class="note">Open this page in Chrome or Edge to connect.</p>' : ''}`;
}
function baofengGuide() {
  return `<section class="updater-guide" aria-labelledby="updater-guide-title"><h3 id="updater-guide-title">Flash with Baofeng’s updater</h3>
    <ol>
      <li><p>Download the update .bin above.</p></li>
      <li><p>Open Baofeng CPS on Windows. Choose <strong>Setting → COM Setting</strong>: select <strong>USB</strong>, your cable’s <strong>COM port</strong> and <strong>115200</strong>, then click <strong>OK</strong>.</p><a class="button secondary" href="${baofengCpsURL}" target="_blank" rel="noopener noreferrer"><span class="cps-icon" aria-hidden="true"><img src="assets/baofeng-cps-icon.png" width="142" height="168" alt=""></span>Download Baofeng CPS <span aria-hidden="true">↗</span></a><a href="assets/baofeng-com-settings.png" target="_blank" rel="noopener" aria-label="Enlarge Baofeng COM settings screenshot"><img src="assets/baofeng-com-settings.png" width="786" height="494" loading="lazy" alt="Baofeng COM settings with USB selected and 115200 baud. Choose your cable’s COM port."></a></li>
      <li><p>Choose <strong>Tool → Firmware Upgrade</strong>.</p></li>
      <li><p>Click <strong>Open</strong> and choose the <strong>Open25 .bin you downloaded above</strong>.</p><a href="assets/baofeng-upgrade-file.png" target="_blank" rel="noopener" aria-label="Enlarge Baofeng updater screenshot"><img src="assets/baofeng-upgrade-file.png" width="1000" height="436" loading="lazy" alt="Baofeng firmware updater with Open and Upgrade buttons. The screenshot shows an OEM filename; select your generated Open25 file."></a></li>
      <li><p>Turn the radio off. Hold <strong>PTT + SK1</strong> (the button just below PTT) while turning it on. <strong>The screen stays blank; this is normal.</strong></p></li>
      <li><p>Click <strong>Upgrade once</strong>. The progress bar may take a few seconds to appear. Wait for completion, then turn the radio off and on.</p></li>
    </ol>
    <details class="updater-help"><summary>“Communication failed!”?</summary><p>Check that you selected the right COM port and entered upgrade mode by holding PTT + SK1 while turning the radio on.</p><img src="assets/baofeng-communication-failed.png" width="446" height="320" loading="lazy" alt="Baofeng error dialog: Communication failed!"></details>
  </section>`;
}
function infoView() {
  if (!info) return `<h2>Read radio information</h2><p class="description">View hardware, codec and calibration details. This does not change the radio.</p><div class="actions">${button('inspect', 'Read radio info')}</div>`;
  const chips = info.chips || {}, codec = info.codec || {}, calibration = info.calibration || {}, validation = codec.validation;
  const row = (name, value) => `<div><dt>${escape(name)}</dt><dd>${escape(value)}</dd></div>`;
  return `<h2>Radio information</h2><dl class="info-facts">${row('Program chip', chips.program ? `${chips.program.jedec} · ${size(chips.program.size)}` : 'Unknown')}${row('Data chip', chips.data ? `${chips.data.jedec} · ${size(chips.data.size)}` : 'Unknown')}${row('Hardware profile', info.modelRecognized ? 'Recognized profile' : 'Not recognized; diagnostic information only')}${row('Boot-code fingerprint', info.bootPrefixSha256 || 'Unknown')}${row('DMR codec', `${codec.status || 'Unknown'}${codec.profile != null ? ` · profile ${codec.profile}` : ''}`)}${row('Prepared codec slot', `${hex(codec.slotStart)}–${hex(codec.slotEnd - 1)}`)}${validation?.slotSha256 ? row('Codec header', validation.slotBlank ? 'Blank' : `${hex(validation.headerMarker)} · version ${validation.headerVersion}`) + row('Codec slot fingerprint', validation.slotSha256) + row('Native codec search', validation.nativeMatch.replaceAll('-', ' ')) : ''}${codec.codeOffset !== undefined ? row('Native codec code', hex(codec.codeOffset)) : ''}${codec.tablesOffset !== undefined ? row('Native codec tables', hex(codec.tablesOffset)) : ''}${row('Factory calibration', `${calibration.status || 'Unknown'}${calibration.pages?.length ? ` · ${calibration.pages.map(hex).join(', ')}` : ''}`)}${row('Fallback calibration copy', calibration.fallbackPresent ? 'Present' : 'Not found')}</dl>${codec.note ? `<p class="note">${escape(codec.note)}</p>` : ''}<h3 class="info-heading">Memory regions</h3><div class="info-regions">${(info.regions || []).map(region => `<section><h3>${escape(region.label)}</h3><p class="file-meta">${escape(region.memory)} · ${hex(region.start)}–${hex(region.end - 1)}${region.known ? '' : ' · Not fully understood'}</p><p>${escape(region.description)}</p></section>`).join('')}</div>${(info.notes || []).map(note => `<p class="note">${escape(note)}</p>`).join('')}<p class="note">This information stays on this computer. Firmware identity cannot be inferred from a codec profile alone.</p><div class="actions">${button('inspect', 'Read again')}${link('save-info', 'Save radio info')}</div>`;
}
function render() {
  const state = engine.state;
  $('connection-label').textContent = state.connected ? 'Radio connected · 115,200 baud' : 'Not connected';
  $('disconnect').hidden = !radio || busy;
  $('all-tools').hidden = !mode;
  $('all-tools').disabled = busy;
  $('export-receipt').disabled = busy;
  $('current-stage').hidden = !mode;
  $('current-stage').textContent = names[mode] || '';
  $('file-summary').hidden = true;
  let html;
  if (!mode) html = home();
  else if (busy) html = '<h2 id="work-heading">Working…</h2>';
  else if (receipt) {
    const skipped = receipt.verificationSkipped;
    html = `<h2>${receipt.operation === 'restore' ? skipped ? 'Backup restored · final check skipped' : 'Backup restored and checked' : mode === 'factory' ? 'Baofeng firmware written and checked' : 'Flash complete!'}</h2><p class="description">${receipt.operation !== 'restore' && mode !== 'factory' ? 'Your new firmware is installed. Enjoy your radio!' : `${skipped ? 'Only the written sections were checked. ' : ''}Check that your radio starts normally.`}</p>${receipt.restartError ? '<p class="change-note" role="status">Automatic restart was not confirmed. Turn the radio off, then on.</p>' : ''}<div class="actions">${completedFirmware?.target === 'dm32-048' ? '<a class="button secondary" href="../classic-cps/">Open Classic CPS</a>' : ''}${button('finish', 'Back to tools')}</div>`;
  } else if (isFirmware() && (!firmwareSelection || choosingPackage)) html = firmwarePicker();
  else if (mode === 'package') html = localUpdate
    ? `<h2>Update file created</h2><p class="file-meta">Voice codec from ${escape(stockSelection.filename)}</p><div class="actions">${button('package-download', 'Download update .bin')}</div>${baofengGuide()}`
    : `<h2>Choose Baofeng firmware</h2><p class="description">Unzip the Baofeng download, then choose its .bin file for the voice codec. The file stays on your computer.</p><div class="actions"><a class="button secondary" href="${baofengFirmwareURL}" target="_blank" rel="noopener noreferrer">Download Baofeng firmware <span aria-hidden="true">↗</span></a>${button('package-oem', 'Choose OEM file…')}</div>`;
  else if (mode === 'archive' && !archiveAction) html = `<h2>Backup / Restore</h2><p class="description">Save a complete copy of this radio, or restore one you saved earlier.</p><div class="actions">${button('choose-backup', 'Back up this radio')}${button('choose-restore', 'Restore a backup')}</div>`;
  else if (mode === 'factory' && !factorySelection) html = `<h2>Choose Baofeng firmware</h2><p class="description">Restore original Baofeng firmware for this radio. Download a zip, and provide a .bin firmware file below</p><div class="actions"><a class="button secondary" href="${baofengFirmwareURL}" target="_blank" rel="noopener noreferrer">Download Baofeng firmware <span aria-hidden="true">↗</span></a>${button('factory-file', 'Choose Baofeng file…')}</div>`;
  else if (workflow() === 'restore' && !restoreArchive) html = `<h2>Choose a backup</h2><p class="description">Use a full backup made from this radio. Restoring it replaces firmware, settings and factory calibration.</p><div class="actions">${button('restore-file', 'Choose backup ZIP…')}</div>`;
  else if (!state.connected) html = connectScreen();
  else if (isFirmware()) html = `<h2>${mode === 'first' ? 'Ready to install' : 'Ready to update'}</h2><p class="description">Install the selected firmware. A full backup is optional.</p>${firmwareSelection?.manifest.target === 'dm32-operator' ? '<p class="change-note">Next may replace stored radio programming when it starts.</p>' : firmwareSource === 'classic' ? '<p class="change-note">This release uses the new Classic CPS. Retired Classic formats are not imported; existing RFKV programming is preserved.</p>' : ''}<div class="actions">${button('flash', mode === 'first' ? 'Install firmware' : 'Update firmware')}</div>`;
  else if (workflow() === 'backup') html = `<h2>${state.backup ? 'Backup saved and checked' : 'Back up your radio'}</h2><p class="description">${state.backup ? 'Keep this file private; it may contain programming and keys.' : 'Save a complete copy of this radio. This may take several minutes.'}</p><div class="actions">${state.backup ? button('finish', 'Back to tools') : button('backup', 'Save backup…')}</div>`;
  else if (workflow() === 'restore') html = `<h2>Ready to restore</h2><p class="description">This replaces firmware, settings, the bootloader and factory calibration with the backup.</p><label class="check"><input id="same-radio" type="checkbox" ${sameRadio ? 'checked' : ''}><span>This backup belongs to this physical radio.</span></label><div class="actions">${button('restore-write', 'Restore backup', !sameRadio)}${link('restore-file', 'Choose another backup…')}</div>`;
  else if (mode === 'factory') html = `<h2>Ready to revert to Baofeng</h2><p class="description">Reinstall Baofeng firmware. This cannot recover erased settings or calibration.</p><p class="change-note">Use an original file for this radio. The file format was checked; compatibility and completeness are not verified.</p><div class="actions">${button('revert', 'Revert to Baofeng')}${link('factory-file', 'Choose another file…')}</div>`;
  else if (mode === 'info') html = infoView();
  screen.innerHTML = html || home();
  renderChipActivity();
  if (!busy && mode && !receipt) {
    const selected = isFirmware() ? firmwareSelection : mode === 'factory' ? factorySelection : workflow() === 'restore' ? restoreArchive : null;
    if (selected && !choosingPackage || selected && !isFirmware()) {
      $('file-summary').hidden = false;
      $('file-summary').innerHTML = `<h3>${isFirmware() ? 'Selected firmware' : mode === 'factory' ? 'Baofeng firmware' : 'Selected backup'}</h3><p class="filename">${escape(selected.filename)}</p>${selected.manifest?.release ? `<p class="file-meta">${escape(selected.manifest.release)}</p>` : ''}`;
    }
  }
}
async function run(work, { cancellable = false, workflow: action } = {}) {
  if (busy) return;
  const attempt = action ? { workflow: action, operationId: randomId(), startedAt: Date.now(), hardware: action === 'connect' ? undefined : diagnosticHardware, firmware: action === 'package' ? undefined : diagnosticFirmware(), simulated: engine.state.simulated } : undefined;
  diagnosticAttempt = attempt; busy = true; lastProgress = undefined;
  resetChipActivity(action === 'connect');
  operationAbort = cancellable ? new AbortController() : undefined;
  $('error').hidden = true; $('journal-status').textContent = 'In progress…';
  $('cancel-read').hidden = !cancellable; $('cancel-read').disabled = false; $('skip-verification').hidden = true;
  render();
  if (attempt) sendDiagnostic('operation_started', attempt);
  try {
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* advisory only */ }
    const result = await work();
    rememberDiagnostics(attempt);
    if (attempt && action === 'restore' && receipt?.verificationSkipped)
      sendDiagnostic('verification_skipped', attempt, { phase: 'verify', readbackVerified: false, verificationSkipped: true, verificationMethod: 'skipped' });
    if (attempt) sendDiagnostic(result === false ? 'operation_cancelled' : 'operation_succeeded', attempt, isWrite(action) && result !== false ? {
      phase: 'complete', readbackVerified: receipt?.readbackVerified === true, verificationSkipped: receipt?.verificationSkipped === true,
      verificationMethod: receipt?.verificationMethod || (receipt?.verificationSkipped ? 'skipped' : 'full-byte-readback'),
      resetSent: receipt?.resetSent === true, ...(receipt?.restartError ? { restartError: diagnosticError(receipt.restartError) } : {}),
    } : {});
  } catch (error) {
    chipStopped = true;
    rememberDiagnostics(attempt, action !== 'package');
    const last = isWrite(action) ? await journal.latest().catch(() => undefined) : undefined;
    const current = last && Date.parse(last.startedAt) >= attempt.startedAt ? last : undefined;
    if (attempt) attempt.delivery = sendDiagnostic(error?.name === 'AbortError' ? 'operation_cancelled' : 'operation_failed', attempt, error?.name === 'AbortError' ? {} : {
      error: diagnosticError(error), ...(current ? { readbackVerified: current.readbackVerified === true, verificationSkipped: current.verificationSkipped === true, ...(current.verificationMethod ? { verificationMethod: current.verificationMethod } : {}), resetSent: current.resetSent === true } : {}),
    });
    report(error, attempt);
    if (radio?.failed || transport && !engine.state.connected) await closeRadio({ keepActivity: true });
  } finally {
    busy = false; operationAbort = undefined; diagnosticAttempt = undefined;
    $('cancel-read').hidden = true; $('skip-verification').hidden = true; $('progress-area').hidden = true;
    try { await wakeLock?.release(); } catch { /* already released */ }
    wakeLock = undefined; render();
    const current = receipt || await journal.latest();
    $('journal-status').textContent = current ? `${current.operation}: ${current.state} (${current.done}/${current.sectors.length} sectors).` : 'None.';
  }
}
async function closeRadio({ keepActivity = false } = {}) {
  rememberDiagnostics(); engine.invalidate();
  try { await (radio || transport)?.close(); } catch { /* disconnected already */ }
  radio = transport = undefined; diagnosticHardware = undefined;
  engine = new Installer({ journal, progress });
  if (!keepActivity) resetChipActivity(true);
}
async function chooseMode(next) {
  if (busy) return;
  busy = true; render();
  try {
    await closeRadio();
    mode = next; archiveAction = null; firmwareSelection = stockSelection = factorySelection = restoreArchive = restoreBytes = localUpdate = undefined;
    sameRadio = false; choosingPackage = true; receipt = completedFirmware = info = undefined;
    firmwareSource = 'classic'; firmwareVariant = firmwareVersion = ''; journal.clear();
    $('error').hidden = true; $('journal-status').textContent = 'None.';
  } finally { busy = false; render(); }
}
async function connect(port) {
  if (radio) await closeRadio();
  receipt = info = undefined; sameRadio = false; journal.clear();
  transport = new BrowserSerial(port, error => {
    const attempt = !busy ? outsideDiagnosticError('connect', error) : undefined;
    engine.invalidate(error);
    if (!busy) { report(error, attempt); render(); }
  }, rate => log(`Serial port: ${rate.toLocaleString()} baud.`));
  const response = await fetch(`../assets/monitor.bin?v=${MONITOR_SHA256}`, { cache: 'no-store', signal: operationAbort?.signal });
  if (!response.ok) throw new Error('The radio connection helper could not be loaded. Reload and try again.');
  const image = new Uint8Array(await response.arrayBuffer());
  operationAbort?.signal.throwIfAborted();
  await transport.open(); radio = new Monitor(transport);
  const connectionTimer = setTimeout(() => log(`Connection check: ${serialActivity(transport)}.`), 5000);
  try { await radio.start(image, progress, operationAbort?.signal); }
  catch (error) {
    if (error?.message === 'No power-on handshake. Check the cable and switch the radio off and on.') {
      error.code = 'rom_no_handshake';
      error.message = `No power-on handshake. ${serialActivity(transport)}. Restart radio and retry.`;
    }
    throw error;
  } finally { clearTimeout(connectionTimer); }
  await engine.attach(radio, operationAbort?.signal, value => sendHardwareReport(value, diagnosticAttempt));
  const identity = engine.state.identity;
  if (!engine.state.simulated && identity?.bootPrefixSha256) {
    diagnosticHardware = { program: identity.chips.program, data: identity.chips.data, bootPrefixSha256: identity.bootPrefixSha256, qualified: engine.state.modelRecognized };
    rememberDiagnostics();
  }
  if (isFirmware() && firmwareSelection) await engine.selectFirmware(firmwareSelection.bytes);
  log('Connected. Choose the operation button to continue.');
}
function selectFile(accept, callback) {
  const input = document.createElement('input'); input.type = 'file'; input.accept = accept;
  input.addEventListener('change', () => { const file = input.files[0]; if (file) run(() => callback(file), { workflow: 'package' }); }, { once: true }); input.click();
}
async function fileBytes(file) {
  if (file.size > MAX_ARCHIVE) throw new Error('This file is too large.');
  return new Uint8Array(await file.arrayBuffer());
}
async function selectFirmware(bytes, filename) {
  const { manifest } = await readFirmware(bytes), digest = await sha256(bytes);
  if (engine.state.connected) await engine.selectFirmware(bytes);
  firmwareSelection = { bytes, filename, manifest, sha256: digest, source: firmwareSource };
  if (mode === 'package') { localUpdate = stockSelection = undefined; }
  choosingPackage = false; receipt = undefined; log('Firmware ZIP checked.');
}
async function finishWrite(result) {
  const complete = await engine.completeWrite(result);
  completedFirmware = isFirmware() ? firmwareSelection?.manifest : undefined;
  await closeRadio({ keepActivity: true }); receipt = complete;
  log(receipt.verificationMethod === 'sector-crc32' ? 'Written sectors passed radio-side flash checksums. Check normal startup.' : receipt.verificationSkipped ? 'Complete-image verification was skipped. Check normal startup.' : 'Both complete chips match the backup. Check normal startup.');
  if (receipt.restartError) log(`Restart was not confirmed: ${receipt.restartError.message}`);
}
function downloadFile(bytes, filename, type) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function saveReport() {
  const data = receipt || await journal.latest();
  if (!data) throw new Error('No operation report is available yet.');
  downloadFile(jsonBytes(data), 'DM32-operation-report.json', 'application/json');
}
async function backUpRadio() {
  if (!window.showSaveFilePicker) throw new Error('Saving backups is unavailable in this browser.');
  const handle = await window.showSaveFilePicker({ suggestedName: `Radio-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`, types: [{ description: 'DM32 radio backup', accept: { 'application/zip': ['.zip'] } }] });
  await run(async () => { await engine.backupToDisk(handle, operationAbort?.signal); log(`Backup saved and checked: ${handle.name}`); }, { cancellable: true, workflow: 'backup' });
}
screen.addEventListener('change', event => {
  if (event.target.id === 'same-radio') { sameRadio = event.target.checked; render(); }
  if (event.target.name === 'firmware-source') { firmwareSource = event.target.value; firmwareVariant = firmwareVersion = ''; render(); }
  if (event.target.id === 'firmware-variant') { firmwareVariant = event.target.value; render(); }
  if (event.target.id === 'firmware-version') { firmwareVersion = event.target.value; render(); }
});
$('work-card').addEventListener('click', async event => {
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (!action || busy) return;
  if (action.startsWith('mode-')) { await chooseMode(action.slice(5)); return; }
  if (action === 'connect') {
    try { const port = await BrowserSerial.choose(); await run(() => connect(port), { cancellable: true, workflow: 'connect' }); }
    catch (error) { report(error, outsideDiagnosticError('connect', error)); }
    return;
  }
  if (action === 'firmware') { selectFile('.zip', async file => selectFirmware(await fileBytes(file), file.name)); return; }
  if (action === 'continue-firmware') { if (firmwareSelection) await run(() => selectFirmware(firmwareSelection.bytes, firmwareSelection.filename), { workflow: 'package' }); return; }
  if (action === 'download-firmware') {
    const { channel, release } = selectedPackage(); if (!channel?.enabled || !release) return;
    await run(async () => {
      if (firmwareSelection?.sha256 === release.sha256) return selectFirmware(firmwareSelection.bytes, firmwareSelection.filename);
      await selectFirmware(await downloadPackage(release, catalogURL), packageURL(release.file, catalogURL).pathname.split('/').at(-1));
    }, { workflow: 'package' }); return;
  }
  if (action === 'package-oem') {
    selectFile('.bin', async file => {
      localUpdate = stockSelection = undefined;
      const bytes = await fileBytes(file);
      const result = await buildFactoryUpdate(firmwareSelection.bytes, bytes);
      stockSelection = { filename: file.name };
      localUpdate = { bytes: result.bytes, filename: firmwareSelection.filename.replace(/\.zip$/i, '') + '-baofeng.bin' };
    }); return;
  }
  if (action === 'package-download') {
    if (localUpdate) downloadFile(localUpdate.bytes, localUpdate.filename, 'application/octet-stream');
    return;
  }
  if (action === 'factory-file') {
    selectFile('.bin', async file => {
      const bytes = await fileBytes(file), parsed = await readFactoryFirmware(bytes);
      const selected = { bytes, filename: file.name, sha256: parsed.sha256, validation: parsed.validation, manifest: { target: 'baofeng', release: 'BFUV32-V2', applicationSha256: parsed.applicationSha256 } };
      factorySelection = selected;
      log('Baofeng firmware file format checked.');
    }); return;
  }
  if (action === 'choose-backup' || action === 'choose-restore') { archiveAction = action === 'choose-backup' ? 'backup' : 'restore'; render(); return; }
  if (action === 'restore-file') {
    selectFile('.zip', async file => {
      sameRadio = false; restoreArchive = restoreBytes = undefined;
      progress({ phase: 'archive', message: 'Checking backup ZIP' });
      const bytes = await fileBytes(file), archive = await verifyArchive(bytes);
      if (archive.manifest.simulated) throw new Error('Simulation archives cannot restore a physical radio.');
      restoreArchive = { ...archive, filename: file.name }; restoreBytes = bytes;
    }); return;
  }
  if (action === 'backup') { try { await backUpRadio(); } catch (error) { report(error, outsideDiagnosticError('backup', error)); } return; }
  if (action === 'flash') { await run(async () => finishWrite(await engine.install({ firstInstall: mode === 'first' })), { workflow: workflow() }); return; }
  if (action === 'restore-write') { await run(async () => finishWrite(await engine.restore(restoreBytes, sameRadio, restoreArchive.filename)), { workflow: 'restore' }); return; }
  if (action === 'revert') { await run(async () => finishWrite(await engine.revertFactory(factorySelection.bytes)), { workflow: 'revert' }); return; }
  if (action === 'inspect') { await run(async () => { info = await engine.inspect(operationAbort?.signal); }, { cancellable: true, workflow: 'info' }); return; }
  if (action === 'save-info') { if (info) downloadFile(jsonBytes(info), 'DM32-radio-info.json', 'application/json'); return; }
  if (action === 'finish') await chooseMode(null);
});
$('all-tools').addEventListener('click', () => { if (!busy) void chooseMode(null); });
$('disconnect').addEventListener('click', () => run(closeRadio));
$('copy-support-id').addEventListener('click', async () => {
  const reference = $('error-support-id'), id = reference.textContent; if (!id) return;
  try {
    await navigator.clipboard.writeText(`Support ID: ${id}\nFlasher: ${APP_VERSION}\nError: ${diagnosticError({ message: $('error-message').textContent }).message}`);
    if (reference.textContent === id) $('copy-support-id').textContent = 'Copied';
  } catch {
    if (reference.textContent !== id) return;
    const range = document.createRange(); range.selectNodeContents(reference);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    $('error-support-help').textContent = 'ID selected. Use your browser’s Copy command.';
  }
});
$('export-receipt').addEventListener('click', () => { saveReport().catch(report); });
$('cancel-read').addEventListener('click', () => { operationAbort?.abort(); $('cancel-read').disabled = true; log('Read cancellation requested.'); });
$('skip-verification').addEventListener('click', () => {
  if (!busy || workflow() !== 'restore' || lastProgress?.phase !== 'verify' || !engine.state.canSkipVerification) return;
  if (!window.confirm('Skipping the finished-image check is not recommended. The complete restored image will not be checked. Skip the remaining check?')) return;
  if (engine.requestSkipVerification()) { $('skip-verification').disabled = true; log('Waiting for the current response to finish before skipping.'); }
});
window.addEventListener('beforeunload', event => { if (busy) { event.preventDefault(); event.returnValue = ''; } });
$('diagnostics-details').addEventListener('click', () => $('diagnostics-dialog').showModal());
$('diagnostics-close').addEventListener('click', () => $('diagnostics-dialog').close());
$('usage-dismiss').addEventListener('click', () => {
  try { localStorage.setItem(usageAcceptanceKey, '1'); } catch { /* storage may be unavailable */ }
  $('usage-dialog').close();
});
$('usage-dialog').addEventListener('close', () => $('compatibility-dialog').showModal());
$('compatibility-dismiss').addEventListener('click', () => $('compatibility-dialog').close());
const platform = navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || '';
const mobile = /Android|iPad|iPhone|iPod/i.test(`${platform} ${navigator.userAgent || ''}`)
  || /Mac/i.test(platform) && navigator.maxTouchPoints > 1;
const mac = !mobile && /Mac/i.test(platform), windows = !mobile && /Win/i.test(platform);
if (mac) {
  $('cable-platform-help').innerHTML = 'Mac: check <strong>System Information → Hardware → USB</strong>.';
  $('cable-driver-note').textContent = 'Prolific can have trouble with the built-in Mac driver.';
} else if (windows) {
  $('cable-platform-help').innerHTML = 'Windows: check <strong>Device Manager → Ports (COM &amp; LPT)</strong>.';
  $('cable-driver-note').innerHTML = 'Prolific is reported working with Windows driver <strong>3.8.31.0</strong>.';
}
$('prolific-support').textContent = windows ? '✓' : '△';
$('prolific-support').className = windows ? 'compatibility-good' : 'compatibility-warning';
$('prolific-support').setAttribute('aria-label', windows ? 'Reported working with driver 3.8.31.0' : mac ? 'May need a different driver' : 'Driver-dependent');
$('cable-mac-example').hidden = !mac;
$('cable-windows-example').hidden = !windows;
render();
sendDiagnostic('page_view', { workflow: 'info' }, { phase: BrowserSerial.supported() ? 'serial-supported' : 'serial-unavailable' });
fetch(catalogURL, { cache: 'no-store', redirect: 'error' }).then(async response => {
  if (!response.ok) throw new Error('The catalog could not be loaded. You can still upload a firmware ZIP.');
  catalog = validateCatalog(await response.json(), catalogURL); catalogMessage = '';
}).catch(error => { catalogMessage = error.message; }).finally(() => { if (!busy) render(); });
$('journal-status').textContent = 'None.';
let usageAccepted = false;
try { usageAccepted = localStorage.getItem(usageAcceptanceKey) === '1'; } catch { /* show the notice without storage */ }
$(usageAccepted ? 'compatibility-dialog' : 'usage-dialog').showModal();
if (location.hash === '#package') void chooseMode('package');
