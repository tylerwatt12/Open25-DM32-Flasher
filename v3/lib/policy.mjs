// SPDX-License-Identifier: GPL-3.0-or-later
import { OEM_CODECS } from './dm32-codec-profiles.mjs';
import { APP_START, concat, crc32, filled, get32, sha256 } from './bytes.mjs';

// Derived from the pinned DM32 linker layout. Classic and Next share this slot.
export const DM32_CODEC = Object.freeze({ start: 0xe8000, end: 0x100000,
  runLo: 0x43a00, runHi: 0x58000, tablesLo: 0x18000e48, tablesHi: 0x18003e38 });
// Existing Classic and Next v2 ZIP targets; other manual packages stay generic.
export const usesDm32Codec = manifest => ['dm32-048', 'dm32-operator'].includes(manifest.target);

// Slot v2 validation follows RadioFoundry's MIT codec_slot.h and vocoder.c
// (Copyright (c) 2026 The RadioFoundry Authors). No codec bytes are shipped here.
function codecFailure(code, message) {
  return Object.assign(new Error(message), { code });
}

// The caller already owns this program read. Only fixed codec metadata is returned.
export async function codecDiagnosticInfo(program, search = {}) {
  const slot = program.subarray(DM32_CODEC.start, DM32_CODEC.end);
  const details = { nativeMatch: search.nativeMatch || 'not-searched' };
  if (slot.length === DM32_CODEC.end - DM32_CODEC.start) {
    Object.assign(details, { headerMarker: get32(slot, 0, true), headerVersion: get32(slot, 4, true),
      slotBlank: slot.every(byte => byte === 255), slotSha256: await sha256(slot) });
  }
  for (const key of ['nativeSignatures', 'candidateCodeSha256', 'candidateCodeBytes', 'matchedProfile', 'tableCandidates'])
    if (search[key] !== undefined) details[key] = search[key];
  return details;
}

export function checkDm32Codec(program, tablesEnd = DM32_CODEC.tablesHi) {
  if (program.length < DM32_CODEC.end)
    throw codecFailure('codec_flash_size', 'Program flash is too small for the DM32 codec layout.');
  const slot = program.subarray(DM32_CODEC.start, DM32_CODEC.end), word = i => get32(slot, i * 4, true);
  if (word(0) !== 0x43524444 || word(1) !== 2)
    throw codecFailure('codec_slot_header', 'The reserved codec area has no recognized version 2 codec header.');
  const code = word(2), codeLength = word(3), codeRam = word(4);
  const tables = word(5), tablesLength = word(6), tablesRam = word(7);
  const relocations = word(17), count = word(18);
  const within = (start, length, lo, hi) => start >= lo && start <= hi && length <= hi - start;
  if (!(code >= 128 && codeLength >= 8 && within(code, codeLength, 0, slot.length) &&
    within(tables, tablesLength, 0, slot.length) &&
    within(tablesRam, tablesLength, DM32_CODEC.tablesLo, tablesEnd) &&
    codeLength <= DM32_CODEC.runHi - DM32_CODEC.runLo &&
    ((DM32_CODEC.runLo - codeRam) & 3) === 0 && count <= 64 && !(relocations & 3) &&
    within(relocations, count * 4, 0, slot.length)))
    throw codecFailure('codec_slot_bounds', 'The reserved codec area has unsupported memory bounds.');
  for (let entry = 8; entry < 15; entry++) {
    if (!(word(entry) < codeLength && !(word(entry) & 1)))
      throw codecFailure('codec_slot_bounds', 'The reserved codec area has an invalid entry point.');
  }
  if (get32(slot, code, true) !== 0x152514d8 || get32(slot, code + 4, true) !== 0x74c776cd)
    throw codecFailure('codec_slot_signature', 'The reserved codec area has an unrecognized code signature.');
  for (let i = 0; i < count; i++) {
    const offset = get32(slot, relocations + i * 4, true);
    if (!(offset >= 8 && offset <= codeLength - 4 && !(offset & 3)) ||
        !within(get32(slot, code + offset, true), 1, codeRam, codeRam + codeLength))
      throw codecFailure('codec_slot_relocations', 'The reserved codec area has an invalid relocation.');
  }
  if (crc32(concat(slot.subarray(code, code + codeLength), slot.subarray(tables, tables + tablesLength),
    slot.subarray(relocations, relocations + count * 4))) !== word(16))
    throw codecFailure('codec_slot_crc', 'The reserved codec area failed its checksum check.');
  return { tag: word(15), bytes: Math.max(code + codeLength, tables + tablesLength, relocations + count * 4) };
}

// Locate known code and tables by content, as RadioFoundry does. Release names
// and flash offsets are hints; only complete code/table hashes authorize reuse.
async function locateDm32Codec(program, search) {
  search.nativeMatch = 'no-signature'; search.nativeSignatures = 0;
  let tableHeads;
  for (let at = 0; at + 8 <= program.length; at += 4) {
    if (get32(program, at, true) !== 0x152514d8 || get32(program, at + 4, true) !== 0x74c776cd) continue;
    search.nativeSignatures++; search.nativeMatch = 'code-mismatch';
    const hashes = new Map();
    const profiles = [...OEM_CODECS].sort((a, b) => Number(b.code === at) - Number(a.code === at));
    for (const profile of profiles) {
      const code = program.subarray(at, at + profile.codeLength);
      if (code.length !== profile.codeLength) continue;
      if (!hashes.has(code.length)) hashes.set(code.length, await sha256(code));
      if (!search.candidateCodeSha256) { search.candidateCodeSha256 = hashes.get(code.length); search.candidateCodeBytes = code.length; }
      if (hashes.get(code.length) !== profile.sha256) continue;
      search.nativeMatch = 'tables-mismatch'; search.matchedProfile = profile.tag;
      search.candidateCodeSha256 = hashes.get(code.length); search.candidateCodeBytes = code.length;
      if (!tableHeads) {
        tableHeads = [];
        for (let t = 0; t + 64 <= program.length; t += 4)
          if (crc32(program.subarray(t, t + 64)) === 0x11475389) tableHeads.push(t);
      }
      search.tableCandidates = tableHeads.length;
      for (const t of tableHeads) {
        const tables = program.subarray(t, t + profile.tablesLength);
        if (tables.length === profile.tablesLength && await sha256(tables) === profile.tablesSha256) {
          search.nativeMatch = 'matched';
          return { profile, code, tables, codeOffset: at, tablesOffset: t };
        }
      }
      throw codecFailure('codec_oem_tables', `OEM codec profile ${profile.tag} code matched, but its tables did not. No flash was written.`);
    }
  }
  return null;
}

const firmwareBounds = () => codecFailure('codec_firmware_bounds',
  'This codec needs newer firmware. Choose the latest Classic release. No flash was written.');
export const codecTablesEnd = manifest => manifest.codecTablesEnd ?? 0x18003e28;

export async function prepareDm32Codec(program, tablesEnd = DM32_CODEC.tablesHi) {
  const search = {};
  try {
    let slotError;
    try { return { ...checkDm32Codec(program, tablesEnd), prepared: false }; }
    catch (error) {
      slotError = error;
      if (error.code === 'codec_flash_size') { error.message += ' No flash was written.'; throw error; }
      if (tablesEnd < DM32_CODEC.tablesHi) {
        try { checkDm32Codec(program); throw firmwareBounds(); }
        catch (current) { if (current.code === 'codec_firmware_bounds') throw current; }
      }
    }
    const found = await locateDm32Codec(program, search);
    if (found) {
      const { profile, code, tables } = found;
      if (profile.tablesRam + tables.length > tablesEnd) throw firmwareBounds();
      const slot = filled(DM32_CODEC.end - DM32_CODEC.start), words = new DataView(slot.buffer);
      const codeAt = 128, tablesAt = codeAt + code.length, relocationsAt = tablesAt + tables.length;
      slot.fill(0, 0, codeAt); slot.set(code, codeAt); slot.set(tables, tablesAt);
      profile.relocations.forEach(([offset, value], index) => {
        if (get32(code, offset, true) !== value)
          throw codecFailure('codec_slot_relocations', 'OEM codec relocation does not match its profile. No flash was written.');
        words.setUint32(relocationsAt + index * 4, offset, true);
      });
      const end = relocationsAt + profile.relocations.length * 4;
      [0x43524444, 2, codeAt, code.length, profile.codeRam, tablesAt, tables.length, profile.tablesRam,
        ...profile.entries, profile.tag, crc32(slot.subarray(codeAt, end)), relocationsAt, profile.relocations.length]
        .forEach((value, index) => words.setUint32(index * 4, value, true));
      const checked = program.slice(); checked.set(slot, DM32_CODEC.start);
      return { ...checkDm32Codec(checked, tablesEnd), prepared: true, slot,
        source: { codeOffset: found.codeOffset, tablesOffset: found.tablesOffset, profileName: profile.name } };
    }
    if (!program.subarray(DM32_CODEC.start, DM32_CODEC.end).every(byte => byte === 255)) {
      slotError.message += ' No flash was written.'; throw slotError;
    }
    throw codecFailure('codec_oem_unknown', 'No supported DMR codec layout matched the radio’s native code. Supported OEM codecs: .032, .037/.039/.040, .046/HR, .047/.048/.049, NRF/fanti .049 and NRFB .050. No flash was written.');
  } catch (error) {
    if (error.code?.startsWith('codec_')) {
      try { error.codec = await codecDiagnosticInfo(program, search); } catch { /* retain the validation error */ }
    }
    throw error;
  }
}

// The RAM helper is pinned. The hardware profile is only a model-recognition hint.
export const MONITOR_SHA256 = 'eae5b98615d67ba465061c84a5fb209a902333dc700671ce4ca69a05eb4aaee9';
export const WRITE_PROFILE = Object.freeze({
  programJedec: 'c84014', programBytes: 0x100000,
  dataJedec: 'ef4018', dataBytes: 0x1000000,
  bootCompatibilitySha256: 'a8c96cf2faff7017e82046d85593a9fa321cf22d53f9bfac2bbb9234ac7de3d0'
});
export function bootCompatibilityHash(boot) {
  // The final 4 KiB sector contains per-radio factory settings, not a model ID.
  // Recognize the fixed boot code prefix instead; backups retain every byte.
  return sha256(boot.subarray(0, APP_START - 0x1000));
}

// Model recognition is diagnostic information, never permission to flash or restore.
export const recognizesDm32 = (chips, bootHash) =>
  chips?.program?.size === WRITE_PROFILE.programBytes && chips.program.jedec === WRITE_PROFILE.programJedec &&
  chips?.data?.size === WRITE_PROFILE.dataBytes && [WRITE_PROFILE.dataJedec, '852018'].includes(chips.data.jedec) &&
  bootHash === WRITE_PROFILE.bootCompatibilitySha256;
export const BACKUP_COVERAGE = 'Both complete main flash address spaces. Chip OTP/security registers are excluded.';
