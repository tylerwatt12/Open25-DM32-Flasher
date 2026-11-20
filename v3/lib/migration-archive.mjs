// SPDX-License-Identifier: GPL-3.0-or-later
// A private, scoped rollback image. It never authorizes automatic resume.
import { APP_START, SECTOR, assert, concat, sha256 } from './bytes.mjs';
import { DM32_CODEC, MONITOR_SHA256 } from './policy.mjs';
import { validateChips } from './archive.mjs';
import { CLASSIC_R13_SCHEMA, NATIVE_SCHEMA, PROGRAMMING_WRITE_RANGES } from './programming.mjs';
import { jsonBytes, readJSON, unzip, zip } from './zip.mjs';

export const isProgrammingSector = address => Number.isSafeInteger(address) && address % SECTOR === 0 &&
  PROGRAMMING_WRITE_RANGES.some(({ start, end }) => address >= start && address + SECTOR <= end);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export async function createMigrationArchive({ identity, simulated, program, changes, sourceSchema, targetSchema, firmwareSha256, sourceSha256, sourceIdentity, targetProgramSha256, summary }) {
  assert(program instanceof Uint8Array && program.length === DM32_CODEC.end - APP_START, 'Incomplete original firmware recovery image.');
  const sectors = await Promise.all(changes.map(async ({ address, before, after }) => ({ address,
    beforeSha256: await sha256(before), afterSha256: await sha256(after) })));
  const data = concat(...changes.map(change => change.before));
  const manifest = { format: 'open25-dm32-migration-recovery', version: 1, createdAt: new Date().toISOString(),
    simulated: simulated === true, monitorSha256: MONITOR_SHA256, identity, sourceSchema, targetSchema,
    firmwareSha256, sourceSha256, sourceIdentity, targetProgramSha256, summary, programSha256: await sha256(program), dataSha256: await sha256(data), sectors };
  const bytes = zip(new Map([['manifest.json', jsonBytes(manifest)], ['program-before.bin', program], ['data-before.bin', data],
    ['README.txt', new TextEncoder().encode('Open25 programming migration recovery\n\nKeep this file private; it can contain identifiers, contacts and keys.\nIf installation is interrupted, reconnect the SAME radio in the flasher and choose Backup / Restore, then this ZIP.\nRecovery restores its original application and voice codec, and only the programming sectors changed by this migration. Bootloader and calibration are not written.\nThe identity uses flash type/capacity, boot and calibration fingerprints, not a unique serial number. Confirm the same physical radio; fingerprints can be shared or cloned.\nRecovery rolls back the installation; it does not resume it. The archive is not an automatically running transaction.\n')]]));
  await verifyMigrationArchive(bytes);
  return { bytes, manifest };
}
export async function verifyMigrationArchive(bytes) {
  const files = unzip(bytes), m = readJSON(files, 'manifest.json');
  assert(m?.format === 'open25-dm32-migration-recovery' && m.version === 1 && typeof m.simulated === 'boolean', 'Not a supported migration recovery archive.');
  assert(files.size === 4 && files.has('README.txt') && files.has('program-before.bin') && files.has('data-before.bin'), 'Unexpected migration recovery contents.');
  validateChips(m.identity?.chips);
  assert(m.identity.chips.program.size >= DM32_CODEC.end && m.identity.uniqueHardwareIdentity === false && digest(m.identity.bootSha256) && digest(m.identity.calibrationPageSha256), 'Incomplete recovery radio identity.');
  assert([CLASSIC_R13_SCHEMA, NATIVE_SCHEMA, 'blank'].includes(m.sourceSchema) && m.targetSchema === NATIVE_SCHEMA &&
    [m.firmwareSha256, m.sourceSha256, m.targetProgramSha256, m.programSha256, m.dataSha256].every(digest), 'Invalid recovery programming metadata.');
  assert(m.sourceSchema === 'blank' || m.sourceIdentity?.schema === m.sourceSchema && digest(m.sourceIdentity.applicationSha256) &&
    Number.isSafeInteger(m.sourceIdentity.applicationBytes) && m.sourceIdentity.applicationBytes > 0 && m.sourceIdentity.applicationBytes <= DM32_CODEC.start - APP_START, 'Invalid recovery source image identity.');
  assert(Array.isArray(m.sectors) && m.sectors.length > 0, 'Missing recovery programming sectors.');
  const seen = new Set();
  for (const sector of m.sectors) {
    assert(isProgrammingSector(sector.address) && sector.address + SECTOR <= m.identity.chips.data.size && !seen.has(sector.address) &&
      digest(sector.beforeSha256) && digest(sector.afterSha256), 'Invalid or duplicate recovery sector.');
    seen.add(sector.address);
  }
  const program = files.get('program-before.bin'), data = files.get('data-before.bin');
  assert(program.length === DM32_CODEC.end - APP_START && data.length === m.sectors.length * SECTOR &&
    await sha256(program) === m.programSha256 && await sha256(data) === m.dataSha256, 'Recovery image hashes do not match.');
  if (m.sourceSchema !== 'blank') assert(await sha256(program.subarray(0, m.sourceIdentity.applicationBytes)) === m.sourceIdentity.applicationSha256 &&
    program.subarray(m.sourceIdentity.applicationBytes, DM32_CODEC.start - APP_START).every(byte => byte === 255), 'Recovery source image differs from its reviewed identity.');
  const changes = [];
  for (let index = 0; index < m.sectors.length; index++) {
    const sector = m.sectors[index], before = data.slice(index * SECTOR, (index + 1) * SECTOR);
    assert(await sha256(before) === sector.beforeSha256, 'Recovery sector hash does not match.');
    changes.push({ address: sector.address, before });
  }
  return { manifest: m, program, changes, sha256: await sha256(bytes) };
}
export async function readRestoreArchive(bytes) {
  const files = unzip(bytes), m = readJSON(files, 'manifest.json');
  if (m?.format === 'open25-dm32-migration-recovery') return verifyMigrationArchive(bytes);
  const { verifyArchive } = await import('./archive.mjs');
  return verifyArchive(bytes);
}
