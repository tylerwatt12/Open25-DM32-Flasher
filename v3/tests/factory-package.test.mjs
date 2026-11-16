import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { APP_START, SECTOR, equal, filled, sha256 } from '../lib/bytes.mjs';
import { buildFactoryUpdate, readFactoryFirmware } from '../lib/factory.mjs';
import { readFirmware } from '../lib/firmware.mjs';
import { DM32_CODEC, checkDm32Codec, codecTablesEnd, prepareDm32Codec } from '../lib/policy.mjs';
import { verifyArchive } from '../lib/archive.mjs';
import { jsonBytes, zip } from '../lib/zip.mjs';
import { syntheticCodec } from './codec-fixture.mjs';

const catalog = JSON.parse(await readFile(new URL('../../releases/catalog.json', import.meta.url)));
const release = catalog.channels.find(channel => channel.id === 'classic').variants[0].releases.find(item => item.version === '0.1.0-rc1-r7');
assert(release, 'The public Classic r7 fixture must remain available.');
const publicZip = new Uint8Array(await readFile(new URL('../../releases/' + release.file, import.meta.url)));
assert.equal(await sha256(publicZip), release.sha256);

function oemFile(program) {
  const bytes = filled(0x100 + program.length - APP_START);
  bytes.set(new TextEncoder().encode('BFUV32-V2'));
  bytes.set(new TextEncoder().encode('END'), 0xfd);
  bytes.set(program.subarray(APP_START), 0x100);
  return bytes;
}
function syntheticOem() {
  const program = filled(DM32_CODEC.end, 0x53);
  program.set(syntheticCodec(), DM32_CODEC.start);
  return oemFile(program);
}
async function firmware({ target = 'dm32-operator', length = SECTOR + 1, tablesEnd = DM32_CODEC.tablesHi } = {}) {
  const application = filled(length, 0x17);
  const manifest = { format: 'open25-dm32-firmware', version: 2, target, release: 'package-test', applicationSha256: await sha256(application),
    ...(tablesEnd == null ? {} : { codecTablesEnd: tablesEnd }) };
  return zip(new Map([['firmware.json', jsonBytes(manifest)], ['application.bin', application]]));
}
function programFromOutput(bytes) {
  const program = filled(DM32_CODEC.end);
  program.set(bytes.subarray(0x100), APP_START);
  return program;
}
function assertCandidate(result, selected, expectedSlot) {
  const { bytes } = result;
  assert.equal(bytes.length, 0x100 + DM32_CODEC.end - APP_START, 'export covers only application space, including its codec slot');
  assert.equal(new TextDecoder().decode(bytes.subarray(0, 9)), 'BFUV32-V2');
  assert(bytes.subarray(9, 0xfd).every(byte => byte === 255));
  assert.equal(new TextDecoder().decode(bytes.subarray(0xfd, 0x100)), 'END');
  assert(equal(bytes.subarray(0x100, 0x100 + selected.application.length), selected.application), 'selected firmware bytes must be exact');
  assert(bytes.subarray(0x100 + selected.application.length, 0x100 + DM32_CODEC.start - APP_START).every(byte => byte === 255), 'old OEM application bytes must not leak into padding');
  const program = programFromOutput(bytes);
  assert(program.subarray(0, APP_START).every(byte => byte === 255), 'output reconstruction must not populate bootloader space');
  assert(equal(program.subarray(DM32_CODEC.start), expectedSlot), 'the complete validated codec slot must be present');
  assert.equal(checkDm32Codec(program, codecTablesEnd(selected.manifest)).tag, result.codec.profile);
  assert.deepEqual(result.firmware, selected.manifest);
}

test('actual public Classic r7 exports exact application, codec and deterministic padding without changing either input', async () => {
  const oem = syntheticOem(), oemHash = await sha256(oem), zipHash = await sha256(publicZip);
  const selected = await readFirmware(publicZip), result = await buildFactoryUpdate(publicZip, oem);
  assertCandidate(result, selected, syntheticCodec());
  assert.equal(result.codec.prepared, false, 'a validated prepared source still gets included on every export');
  assert.equal(result.sha256, await sha256(result.bytes));
  const parsed = await readFactoryFirmware(result.bytes);
  assert.equal(parsed.validation, 'format-only', 'packaging does not claim updater compatibility qualification');
  assert.equal(parsed.application.length, DM32_CODEC.end - APP_START);
  assert.equal(await sha256(oem), oemHash); assert.equal(await sha256(publicZip), zipHash);
  assert(equal((await buildFactoryUpdate(publicZip, oem)).bytes, result.bytes), 'same inputs produce the same local candidate');
});

test('Next and an application exactly ending at the codec boundary retain the codec in every exported payload', async () => {
  for (const length of [SECTOR + 1, DM32_CODEC.start - APP_START]) {
    const source = await firmware({ length }), selected = await readFirmware(source);
    const result = await buildFactoryUpdate(source, syntheticOem());
    assertCandidate(result, selected, syntheticCodec());
    assert.equal(result.firmware.target, 'dm32-operator');
  }
});

test('unused bytes after a prepared codec do not enter the exported padding', async () => {
  const oem = syntheticOem(); oem[oem.length - 1] = 0x39;
  const result = await buildFactoryUpdate(publicZip, oem);
  assertCandidate(result, await readFirmware(publicZip), syntheticCodec());
});

test('invalid firmware, OEM format and unsupported codec sources cannot produce an output candidate', async () => {
  await assert.rejects(buildFactoryUpdate(await firmware({ target: 'manual-target', tablesEnd: null }), syntheticOem()), /Choose an Open25-DM32 Classic or Next/);
  await assert.rejects(buildFactoryUpdate(await firmware({ length: SECTOR - 1 }), syntheticOem()), /entry sector/);
  await assert.rejects(buildFactoryUpdate(await firmware({ length: DM32_CODEC.start - APP_START + 1 }), syntheticOem()), /overlaps/);
  const invalidWrapper = syntheticOem(); invalidWrapper[0] ^= 1;
  await assert.rejects(buildFactoryUpdate(publicZip, invalidWrapper), /header/);
  const unknownCodec = filled(DM32_CODEC.end, 0x53); unknownCodec.fill(255, DM32_CODEC.start);
  await assert.rejects(buildFactoryUpdate(publicZip, oemFile(unknownCodec)), error => error.code === 'codec_oem_unknown');
  const badSlot = syntheticOem(); badSlot[0x100 + DM32_CODEC.start - APP_START + 160] ^= 1;
  await assert.rejects(buildFactoryUpdate(publicZip, badSlot), error => error.code === 'codec_slot_crc');
  const invalidHashFiles = zip(new Map([
    ['firmware.json', jsonBytes({ format: 'open25-dm32-firmware', version: 2, target: 'dm32-048', release: 'bad-hash', applicationSha256: '0'.repeat(64) })],
    ['application.bin', filled(SECTOR, 0x17)],
  ]));
  await assert.rejects(buildFactoryUpdate(invalidHashFiles, syntheticOem()), /SHA-256/);
});

test('the selected firmware codec-table limit is enforced before export', async () => {
  const program = filled(DM32_CODEC.end, 0x53), slot = syntheticCodec();
  new DataView(slot.buffer).setUint32(7 * 4, 0x18003e28, true);
  program.set(slot, DM32_CODEC.start);
  const source = oemFile(program);
  await assert.rejects(buildFactoryUpdate(await firmware({ tablesEnd: 0x18003e28 }), source), error => error.code === 'codec_firmware_bounds');
  const result = await buildFactoryUpdate(await firmware(), source);
  assertCandidate(result, await readFirmware(await firmware()), slot);
});

test('actual private OEM firmware supplies a recognized native codec for the public Classic candidate', { skip: !process.env.DM32_OEM_BACKUP }, async () => {
  const backup = await verifyArchive(new Uint8Array(await readFile(process.env.DM32_OEM_BACKUP)));
  const prepared = await prepareDm32Codec(backup.images.program);
  assert.equal(prepared.prepared, true, 'this fixture must exercise native codec extraction');
  const result = await buildFactoryUpdate(publicZip, oemFile(backup.images.program));
  assert.equal(result.codec.prepared, true);
  assertCandidate(result, await readFirmware(publicZip), prepared.slot);
});
