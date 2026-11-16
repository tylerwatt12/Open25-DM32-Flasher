// SPDX-License-Identifier: GPL-3.0-or-later
import { APP_START, assert, sha256 } from './bytes.mjs';
import { MAX_ARCHIVE, readJSON, unzip } from './zip.mjs';
import { DM32_CODEC, usesDm32Codec } from './policy.mjs';

export async function readFirmware(bytes) {
  const files = unzip(bytes), application = files.get('application.bin');
  assert(files.size === 2 && application && files.has('firmware.json'), 'The ZIP must contain only firmware.json and application.bin.');
  const manifest = readJSON(files, 'firmware.json');
  assert(manifest && ['format', 'version', 'target', 'release', 'applicationSha256'].every(key => Object.hasOwn(manifest, key)) && Object.keys(manifest).every(key => ['format', 'version', 'target', 'release', 'applicationSha256', 'codecTablesEnd'].includes(key)) &&
    manifest.format === 'open25-dm32-firmware' && manifest.version === 2,
    'Choose a version 2 firmware ZIP. Older package formats are not supported.');
  assert(typeof manifest.release === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(manifest.release), 'Invalid firmware version.');
  assert(manifest.codecTablesEnd === undefined || usesDm32Codec(manifest) && [0x18003e28, 0x18003e38].includes(manifest.codecTablesEnd), 'Unsupported firmware codec memory limit.');
  assert(application.length > 0, 'Empty application image.');
  assert(manifest.applicationSha256 === await sha256(application), 'Application SHA-256 does not match the manifest.');
  assert(!usesDm32Codec(manifest) || APP_START + application.length <= DM32_CODEC.start,
    'This firmware image overlaps the reserved DMR codec area. Choose an application-only Classic or Next ZIP.');
  return { manifest, application };
}

export function packageURL(file, catalogURL) {
  assert(typeof file === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._/-]*\.zip$/.test(file) &&
    !file.split('/').some(part => !part || part === '.' || part === '..'), 'Invalid firmware package path.');
  return new URL(file, catalogURL);
}

export function validateCatalog(catalog, catalogURL) {
  assert(catalog?.format === 'open25-dm32-catalog' && catalog.version === 1 &&
    Array.isArray(catalog.channels), 'Firmware catalog is unavailable. Use a firmware ZIP instead.');
  const ids = new Set();
  for (const channel of catalog.channels) {
    assert(['classic', 'next'].includes(channel.id) && !ids.has(channel.id) &&
      typeof channel.name === 'string' && typeof channel.description === 'string' &&
      typeof channel.enabled === 'boolean' && Array.isArray(channel.variants), 'Invalid firmware channel.');
    ids.add(channel.id);
    const variants = new Set();
    for (const variant of channel.variants) {
      assert(typeof variant.id === 'string' && variant.id && !variants.has(variant.id) &&
        typeof variant.name === 'string' && Array.isArray(variant.releases), 'Invalid firmware variant.');
      variants.add(variant.id);
      const versions = new Set();
      for (const release of variant.releases) {
        assert(typeof release.version === 'string' && release.version && !versions.has(release.version) &&
          /^[a-f0-9]{64}$/.test(release.sha256) && typeof release.notes === 'string', 'Invalid firmware release.');
        versions.add(release.version);
        packageURL(release.file, catalogURL);
      }
    }
  }
  assert(ids.has('classic') && ids.has('next'), 'Missing firmware channel.');
  return catalog;
}

export async function downloadPackage(release, catalogURL) {
  const response = await fetch(packageURL(release.file, catalogURL), { cache: 'no-store', redirect: 'error' });
  assert(response.ok, 'The firmware package could not be downloaded. Try again or upload a ZIP.');
  assert(Number(response.headers.get('Content-Length') || 0) <= MAX_ARCHIVE, 'This archive is too large.');
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert(bytes.length <= MAX_ARCHIVE, 'This archive is too large.');
  assert(await sha256(bytes) === release.sha256, 'Downloaded firmware does not match the catalog. Try again.');
  return bytes;
}
