// Synthetic slot metadata and bytes only; no OEM codec implementation.
import { concat, crc32, filled, u32 } from '../lib/bytes.mjs';
import { DM32_CODEC } from '../lib/policy.mjs';

export function syntheticCodec() {
  const slot = filled(DM32_CODEC.end - DM32_CODEC.start), view = new DataView(slot.buffer);
  const word = (index, value) => view.setUint32(index * 4, value, true);
  const codeRam = 0x16cdc;
  [0x43524444, 2, 128, 32, codeRam, 160, 16, DM32_CODEC.tablesLo,
    0, 2, 4, 6, 8, 10, 12, 48, 0, 176, 1].forEach((value, index) => word(index, value));
  slot.set(u32(0x152514d8, true), 128); slot.set(u32(0x74c776cd, true), 132);
  slot.set(u32(codeRam + 12, true), 136); slot.set(u32(8, true), 176);
  word(16, crc32(concat(slot.subarray(128, 160), slot.subarray(160, 176), slot.subarray(176, 180))));
  return slot;
}
