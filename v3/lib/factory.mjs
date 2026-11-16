// SPDX-License-Identifier: GPL-3.0-or-later
import { APP_START, SECTOR, assert, equal, filled, sha256 } from './bytes.mjs';
import { DM32_CODEC, codecTablesEnd, prepareDm32Codec, usesDm32Codec } from './policy.mjs';
import { readFirmware } from './firmware.mjs';

const HEADER_SIZE = 0x100;
const HEADER_MAGIC = new TextEncoder().encode('BFUV32-V2');
const HEADER_END = new TextEncoder().encode('END');
const HEADER_END_AT = HEADER_SIZE - HEADER_END.length;

// Baofeng DM32 BFUV32-V2 is a 256-byte wrapper around a plain application.
// This parser does not authorize bootloader/data writes or infer radio variants.
export async function readFactoryFirmware(bytes, programSize = DM32_CODEC.end) {
  assert(bytes instanceof Uint8Array && bytes.length > HEADER_SIZE, 'Choose an untouched Baofeng BFUV32-V2 firmware file.');
  assert(equal(bytes.subarray(0, HEADER_MAGIC.length), HEADER_MAGIC) &&
    bytes.subarray(HEADER_MAGIC.length, HEADER_END_AT).every(byte => byte === 255) &&
    equal(bytes.subarray(HEADER_END_AT, HEADER_SIZE), HEADER_END),
  'This file does not have the supported Baofeng BFUV32-V2 header.');
  const application = bytes.slice(HEADER_SIZE);
  assert(application.length >= SECTOR, 'The Baofeng application is incomplete; its entry sector is missing.');
  assert(Number.isSafeInteger(programSize) && programSize >= DM32_CODEC.end &&
    application.length <= DM32_CODEC.end - APP_START,
  'The Baofeng application does not fit the supported program-memory layout.');
  assert(!application.subarray(0, Math.min(16, application.length)).every(byte => byte === 255) &&
    !application.subarray(0, Math.min(16, application.length)).every(byte => byte === 0),
  'The Baofeng application has no usable entry code.');
  assert(!(application[0] === 0x7f && application[1] === 0x45 && application[2] === 0x4c && application[3] === 0x46),
    'An ELF executable is not a Baofeng application image.');
  return { format: 'BFUV32-V2', validation: 'format-only', application,
    sha256: await sha256(bytes), applicationSha256: await sha256(application) };
}

// The OEM update path may erase the full application area. Include the codec
// on every export; never depend on a slot left behind by an earlier install.
// This builds a local candidate file, not proof of Windows updater compatibility.
export async function buildFactoryUpdate(firmwareZip, oemBytes) {
  const { manifest, application } = await readFirmware(firmwareZip);
  assert(usesDm32Codec(manifest), 'Choose an Open25-DM32 Classic or Next firmware package.');
  assert(application.length >= SECTOR, 'The firmware application is incomplete; its entry sector is missing.');
  const oem = await readFactoryFirmware(oemBytes);
  const source = filled(DM32_CODEC.end);
  source.set(oem.application, APP_START);
  const codec = await prepareDm32Codec(source, codecTablesEnd(manifest));
  const slot = filled(DM32_CODEC.end - DM32_CODEC.start);
  slot.set((codec.slot || source.subarray(DM32_CODEC.start, DM32_CODEC.end)).subarray(0, codec.bytes));

  // Payload byte zero maps to APP_START. The bootloader and data chip cannot
  // enter this output; the remaining application space is deterministic padding.
  const bytes = filled(HEADER_SIZE + DM32_CODEC.end - APP_START);
  bytes.set(HEADER_MAGIC);
  bytes.set(HEADER_END, HEADER_END_AT);
  bytes.set(application, HEADER_SIZE);
  bytes.set(slot, HEADER_SIZE + DM32_CODEC.start - APP_START);
  const checked = await readFactoryFirmware(bytes);
  return { bytes, firmware: manifest, codec: { profile: codec.tag, prepared: codec.prepared === true }, sha256: checked.sha256 };
}
