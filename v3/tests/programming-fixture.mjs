// Synthetic serialized programming only; no firmware or real radio contents.
import { concat, crc32, filled, u16, u32 } from '../lib/bytes.mjs';

export function legacyProgrammingFixture() {
  const data = filled(0x1000000);
  for (let bank = 0; bank < 8; bank++) {
    const address = bank === 0 ? 0x703780 : 0x79b1b0 + (bank - 1) * 7184;
    data.fill(0, address, address + 16);
  }
  data[0x703780] = 1;
  const channel = filled(56, 0);
  channel.fill(255, 0, 16); channel.set(new TextEncoder().encode('P25 A'));
  channel.set([0, 0, 0x85, 0x43, 0, 0, 0x85, 0x43], 0x10);
  channel[0x18] = 1; channel[0x19] = 5; channel[0x26] = 0x80;
  channel.set([0x12, 0x34, 0x56], 0x27); channel[0x33] = 4;
  data.set(channel, 0x703790);
  // P25, conventional, FNV name check 1665, TX enabled, selective squelch,
  // RX NAC 0x123, TX NAC 0x456, explicit group 4242, no security flags.
  const tag = Uint8Array.of(2, 255, 0x81, 6, 1, 1, 0x23, 0x81, 0x56, 0x84, 1, 0x92, 0x10, 0);
  const payload = concat(u16(0x400, true), u16(tag.length, true), tag);
  const root = filled(4096); root.set(new TextEncoder().encode('RFKV'));
  root[4] = 1; root[5] = 16; root.set(u16(payload.length, true), 6);
  root.set(u32(crc32(payload), true), 8); root.set(u32(0, true), 12); root.set(payload, 16);
  data.set(root, 0x70e000); return data;
}
