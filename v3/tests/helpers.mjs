import { Installer } from '../lib/engine.mjs';
import { SimulatedRadio } from './simulator.mjs';

export class MemoryFile {
  constructor(name = 'DEMO-backup.zip') { this.name = name; this.bytes = new Uint8Array(); }
  async createWritable() {
    let staged;
    return { write: async bytes => { staged = bytes.slice(); }, close: async () => { this.bytes = staged; }, abort: async () => {} };
  }
  async getFile() { return new Blob([this.bytes]); }
}
export class MemoryJournal {
  records = [];
  async write(record) { this.records.push(structuredClone(record)); }
  async latest() { return this.records.at(-1); }
}
export async function setup(options = {}) {
  const radio = options.radio || new SimulatedRadio(options);
  const journal = options.journal || new MemoryJournal();
  const engine = new Installer({ journal });
  await engine.attach(radio);
  await engine.selectFirmware(await radio.firmwarePackage());
  return { engine, radio, journal };
}
