import test from 'node:test';
import assert from 'node:assert/strict';
import { APP_START, filled, equal } from '../lib/bytes.mjs';
import { readFactoryFirmware } from '../lib/factory.mjs';

function file(length = 8192) {
  const bytes = filled(0x100 + length); bytes.fill(0x47, 0x100);
  bytes.set(new TextEncoder().encode('BFUV32-V2')); bytes.set(new TextEncoder().encode('END'), 0xfd);
  return bytes;
}
test('OEM parser accepts only the exact BFUV32-V2 wrapper and returns an isolated application', async () => {
  const bytes = file(), result = await readFactoryFirmware(bytes);
  assert.equal(result.format, 'BFUV32-V2'); assert.equal(result.application.length, 8192);
  assert(equal(result.application, bytes.subarray(0x100))); assert.match(result.sha256, /^[0-9a-f]{64}$/);
  result.application[0] ^= 1; assert.notEqual(result.application[0], bytes[0x100]);
  for (const at of [0, 8, 9, 0xfc, 0xfd, 0xff]) {
    const bad = bytes.slice(); bad[at] ^= 1;
    await assert.rejects(readFactoryFirmware(bad), /header/);
  }
});
test('OEM parser rejects truncated, blank, executable-container and oversized inputs before writes', async () => {
  await assert.rejects(readFactoryFirmware(file(1)), /incomplete/);
  for (const value of [0, 255]) {
    const bytes = file(); bytes.fill(value, 0x100);
    await assert.rejects(readFactoryFirmware(bytes), /entry code/);
  }
  const elf = file(); elf.set([0x7f, 0x45, 0x4c, 0x46], 0x100);
  await assert.rejects(readFactoryFirmware(elf), /ELF/);
  await readFactoryFirmware(file(0x100000 - APP_START));
  await assert.rejects(readFactoryFirmware(file(0x100000 - APP_START + 1)), /does not fit/);
  await assert.rejects(readFactoryFirmware(file(), 0x80000), /does not fit/);
});
