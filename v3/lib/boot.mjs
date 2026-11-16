// SPDX-License-Identifier: GPL-3.0-or-later
// Pinned RadioFoundry debug-link framing. Only read-only boot queries exist.
import { assert, concat, decoder, encoder, equal, get16, u16 } from './bytes.mjs';
export function crc16(bytes) {
  let crc = 0xffff;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let n = 0; n < 8; n++) crc = ((crc << 1) ^ ((crc & 0x8000) ? 0x1021 : 0)) & 0xffff;
  }
  return crc;
}
export function debugFrame(command, sequence, payload = new Uint8Array()) {
  const body = concat(new Uint8Array([command, sequence]), u16(payload.length, true), payload);
  return concat(new Uint8Array([0xa5, 0x5a]), body, u16(crc16(body), true));
}
export class BootQueries {
  #io; #sequence = 0;
  constructor(io) { this.#io = io; }
  async query(command, payload = new Uint8Array()) {
    assert((command === 1 && payload.length <= 32) || (command === 2 && payload.length === 0), 'Only read-only boot queries are permitted.');
    const sequence = ++this.#sequence & 255;
    await this.#io.write(debugFrame(command, sequence, payload));
    const deadline = performance.now() + 10000;
    let previous = 0;
    for (let scanned = 0; scanned < 4096; scanned++) {
      const byte = (await this.#io.readExact(1, Math.max(1, deadline - performance.now())))[0];
      assert(performance.now() <= deadline, 'Boot query timed out.');
      if (previous !== 0xa5 || byte !== 0x5a) { previous = byte; continue; }
      const header = await this.#io.readExact(4, 3000), size = get16(header, 2, true);
      assert(size > 0 && size <= 1024, 'Malformed boot reply length.');
      const rest = await this.#io.readExact(size + 2, 10000);
      assert(crc16(concat(header, rest.subarray(0, size))) === get16(rest, size, true), 'Boot reply CRC failed.');
      if (header[1] !== sequence) { previous = 0; continue; }
      assert(header[0] === (command | 0x80) && rest[0] === 0, 'Radio refused the boot query.');
      return rest.slice(1, size);
    }
    throw new Error('No matching firmware boot reply.');
  }
  async verifyFirmware(expectedVersion) {
    const ping = encoder.encode('INSTALLER-HEALTH');
    assert(equal(await this.query(1, ping), ping), 'Boot cable echo failed.');
    const text = decoder.decode(await this.query(2)), version = Object.create(null);
    for (const line of text.split('\n')) {
      const split = line.indexOf('='); if (split < 1) continue;
      const key = line.slice(0, split); assert(!Object.hasOwn(version, key), 'Duplicate firmware identity field.'); version[key] = line.slice(split + 1);
    }
    assert(expectedVersion && version.git === expectedVersion && version.board === 'DM-32UV',
      'The running firmware does not match the installed package.');
    return { board: version.board, reportedVersion: version.git };
  }
}
