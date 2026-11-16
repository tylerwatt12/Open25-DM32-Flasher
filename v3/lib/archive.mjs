// SPDX-License-Identifier: GPL-3.0-or-later
import { APP_START, SECTOR, assert, equal, sha256, sectorHashes } from './bytes.mjs';
import { jsonBytes, readJSON, unzip, zip } from './zip.mjs';
import { MONITOR_SHA256, BACKUP_COVERAGE } from './policy.mjs';

export function validateChips(chips) {
  assert(chips?.program && chips?.data, 'Missing flash capacities.');
  for (const memory of ['program', 'data']) {
    const chip = chips[memory];
    assert(/^[0-9a-f]{6}$/.test(chip.jedec) && !['00', 'ff'].includes(chip.jedec.slice(0, 2)) && !['00', 'ff'].includes(chip.jedec.slice(2, 4)) && 2 ** parseInt(chip.jedec.slice(4), 16) === chip.size && chip.size >= SECTOR && chip.size <= 0x1000000, 'Chip identity and capacity disagree.');
  }
}
export async function fingerprint(chips, program, data) {
  return {
    chips: structuredClone(chips),
    bootSha256: await sha256(program.subarray(0, APP_START)),
    calibrationPageSha256: await sha256(data.subarray(0x710000, 0x711000)),
    // Not a silicon UID. Physical same-radio confirmation remains necessary.
    uniqueHardwareIdentity: false
  };
}
export async function captureBackup(radio, progress = () => {}, signal) {
  const chips = radio.chips; validateChips(chips);
  const images = {}, passes = [];
  for (let pass = 1; pass <= 2; pass++) {
    for (const memory of ['program', 'data']) {
      signal?.throwIfAborted();
      const data = await radio.read(memory, 0, chips[memory].size,
        p => progress({ ...p, phase: 'backup', pass, memory, message: `Reading ${memory === 'program' ? 'firmware' : 'radio data'} · pass ${pass} of 2` }), signal);
      assert(data.length === chips[memory].size, 'Incomplete flash capture.');
      const record = { memory, pass, bytes: data.length, sha256: await sha256(data), sectorSha256: await sectorHashes(data) };
      passes.push(record);
      if (pass === 1) images[memory] = data;
      else assert(equal(images[memory], data), `The two ${memory} captures differ. Installation remains locked.`);
    }
  }
  const manifest = {
    format: 'open25-dm32-backup', version: 1, createdAt: new Date().toISOString(),
    simulated: radio.simulated === true, verified: true, monitorSha256: MONITOR_SHA256,
    coverage: BACKUP_COVERAGE, chips, identity: await fingerprint(chips, images.program, images.data),
    files: { program: 'program.bin', data: 'data.bin' }, passes
  };
  const bytes = zip(new Map([['manifest.json', jsonBytes(manifest)], ['program.bin', images.program], ['data.bin', images.data], ['README.txt', new TextEncoder().encode(
    'open25-dm32 radio backup\n\n' + BACKUP_COVERAGE + '\n\nTwo complete matching reads are recorded in manifest.json.\nprogram.bin includes the bootloader; full restoration includes it.\ndata.bin includes codeplug, calibration and other data.\nKeep this archive private. It may contain identifiers, keys and contacts.\n' + (manifest.simulated ? '\nSIMULATED DATA: cannot restore a physical radio.\n' : '')
  )]]));
  return { bytes, manifest, images };
}
export async function verifyArchive(bytes) {
  const files = unzip(bytes), m = readJSON(files, 'manifest.json');
  assert(m.format === 'open25-dm32-backup' && m.version === 1 && m.verified === true && typeof m.simulated === 'boolean', 'Not a supported, verified radio backup.');
  validateChips(m.chips);
  assert(m.files?.program === 'program.bin' && m.files?.data === 'data.bin' && files.size === 4 && files.has('README.txt'), 'Unexpected backup contents.');
  assert(Array.isArray(m.passes) && m.passes.length === 4, 'Backup requires two complete passes of both chips.');
  const images = {};
  for (const memory of ['program', 'data']) {
    const data = files.get(m.files[memory]);
    assert(data?.length === m.chips[memory].size, 'Backup image has the wrong capacity.');
    const digest = await sha256(data), hashes = await sectorHashes(data);
    for (const pass of [1, 2]) {
      const records = m.passes.filter(r => r.memory === memory && r.pass === pass);
      assert(records.length === 1, 'Missing or duplicate backup pass.');
      const r = records[0];
      assert(r.bytes === data.length && r.sha256 === digest && Array.isArray(r.sectorSha256) && r.sectorSha256.length === hashes.length && r.sectorSha256.every((h, i) => h === hashes[i]), 'Backup hashes do not match its contents.');
    }
    images[memory] = data;
  }
  assert(JSON.stringify(await fingerprint(m.chips, images.program, images.data)) === JSON.stringify(m.identity), 'Backup identity does not match its contents.');
  return { manifest: m, images, sha256: await sha256(bytes) };
}

export async function saveAndVerify(capture, handle) {
  assert(handle?.createWritable && handle?.getFile, 'A disk save destination is required.');
  assert((await handle.getFile()).size === 0, 'Choose a new filename. An existing backup or other file will not be overwritten.');
  let writable;
  try {
    writable = await handle.createWritable();
    await writable.write(capture.bytes); await writable.close();
  } catch (error) { try { await writable?.abort(); } catch { /* preserve original error */ } throw error; }
  const saved = new Uint8Array(await (await handle.getFile()).arrayBuffer());
  assert(await sha256(saved) === await sha256(capture.bytes), 'The file saved on disk differs from the captured archive.');
  const verified = await verifyArchive(saved);
  return { ...verified, filename: handle.name || 'radio-backup.zip', handle };
}
