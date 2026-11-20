// SPDX-License-Identifier: GPL-3.0-or-later
import { APP_START, SECTOR, assert, equal, filled, sha256 } from './bytes.mjs';
import { captureBackup, saveAndVerify } from './archive.mjs';
import { readFirmware } from './firmware.mjs';
import { inspectProgramming, planProgrammingMigration, PROGRAMMING_RANGES } from './programming.mjs';
import { identifyProgrammingSource } from './programming-source.mjs';
import { createMigrationArchive, verifyMigrationArchive, readRestoreArchive, isProgrammingSector } from './migration-archive.mjs';
import { readFactoryFirmware } from './factory.mjs';
import { bootCompatibilityHash, recognizesDm32, codecTablesEnd, DM32_CODEC, usesDm32Codec, checkDm32Codec, prepareDm32Codec, codecDiagnosticInfo } from './policy.mjs';

export class Installer {
  #radio; #connected = false; #epoch = 0; #busy = false; #backup; #firmware; #identity; #journal; #operation;
  #programming;
  #verifying = false; #skipVerification = false; #operationResult; #connectionError;
  constructor({ journal, progress = () => {} } = {}) {
    this.#journal = journal; this.progress = progress;
  }
  get state() {
    return Object.freeze({ connected: this.#connected, busy: this.#busy, simulated: this.#radio?.simulated === true,
      firmware: this.#firmware?.manifest.release, identity: this.#identity ? structuredClone(this.#identity) : null,
      modelRecognized: this.#radio?.simulated === true || !!this.#identity && recognizesDm32(this.#identity.chips, this.#identity.bootPrefixSha256),
      canSkipVerification: this.#verifying && !this.#skipVerification,
      programming: this.#programming ? { sourceSchema: this.#programming.plan.sourceSchema, targetSchema: this.#programming.plan.targetSchema, changed: this.#programming.plan.changes.length > 0, summary: structuredClone(this.#programming.plan.summary) } : null,
      firmwareSha256: this.#firmware?.manifest.applicationSha256, backup: this.#backup?.filename || null });
  }
  async #exclusive(work) {
    assert(!this.#busy, 'Another radio operation is already running.'); this.#busy = true;
    const epoch = this.#epoch;
    try { const result = await work(() => {
      if (epoch !== this.#epoch || !this.#connected)
        throw this.#connectionError || new Error('Connection changed. Reconnect before continuing.');
    }); return result; }
    finally { this.#busy = false; }
  }
  invalidate(error) {
    if (error && !this.#connectionError) this.#connectionError = error;
    this.#connected = false; this.#epoch++; this.#backup = undefined; this.#firmware = undefined; this.#programming = undefined; this.#identity = undefined;
    // An earned write result remains reportable after disconnect; it never
    // authorizes another write. A new connection, file selection or write
    // attempt revokes it.
    if (!this.#operationResult) this.#operation = undefined;
    this.#verifying = this.#skipVerification = false;
  }
  requestSkipVerification() {
    if (!this.state.canSkipVerification) return false;
    this.#skipVerification = true;
    return true;
  }
  clearFiles() {
    assert(!this.#busy, 'Wait for the current operation.');
    this.#backup = undefined; this.#firmware = undefined; this.#programming = undefined; this.#operation = undefined; this.#operationResult = undefined;
  }
  async attach(radio, signal, reportHardware) {
    assert(!this.#busy, 'Wait for the current operation.');
    this.#operation = this.#operationResult = this.#connectionError = undefined;
    this.invalidate(); this.#radio = radio; this.#connected = true;
    try {
      return await this.#exclusive(async check => {
        const boot = await radio.read('program', 0, Math.min(APP_START, radio.chips.program.size), p => this.progress({ ...p, phase: 'identify', message: 'Checking radio hardware' }), signal);
        const [bootSha256, bootPrefixSha256] = await Promise.all([sha256(boot), bootCompatibilityHash(boot)]);
        check();
        this.#identity = { chips: radio.chips, bootSha256, bootPrefixSha256 };
        if (reportHardware && radio.simulated !== true) {
          const { chips } = this.#identity;
          // The final boot sector contains factory settings. Hash only the prefix for reporting.
          void Promise.resolve().then(() => reportHardware({
            program: { jedec: chips.program.jedec, size: chips.program.size },
            data: { jedec: chips.data.jedec, size: chips.data.size },
            bootPrefixSha256,
            qualified: recognizesDm32(chips, bootPrefixSha256),
          })).catch(() => { /* optional reporting */ });
        }
        return this.state;
      });
    } catch (error) { this.invalidate(error); throw error; }
  }
  async selectFirmware(bytes) {
    return this.#exclusive(async check => {
      this.#firmware = undefined; this.#programming = undefined; this.#backup = undefined; this.#operation = undefined; this.#operationResult = undefined;
      const firmware = await readFirmware(bytes); check();
      assert(APP_START + firmware.application.length <= Math.min(this.#radio.chips.program.size, DM32_CODEC.start), 'This application overlaps the reserved codec area. Choose an application-only firmware ZIP.');
      if (firmware.manifest.programming) {
        const data = await this.#readProgramming(check);
        const application = await this.#radio.read('program', APP_START, DM32_CODEC.start - APP_START,
          progress => this.progress({ ...progress, phase: 'preflight', message: 'Identifying the installed programming format' })); check();
        assert(application.length === DM32_CODEC.start - APP_START, 'Incomplete source application read.');
        const sourceIdentity = await identifyProgrammingSource({ application,
          targetManifest: { ...firmware.manifest, applicationBytes: firmware.application.length } }); check();
        const inspected = inspectProgramming({ data, sourceIdentity });
        assert(inspected.schema, 'Stored programming format is not recognized. No flash was written.');
        const plan = planProgrammingMigration({ data, sourceIdentity, sourceSchema: inspected.schema, targetSchema: firmware.manifest.programming.schema });
        this.#programming = { data, plan, sourceIdentity, applicationSha256: await sha256(application), sourceSha256: await sha256(data) }; check();
      }
      this.#firmware = firmware; return firmware.manifest;
    });
  }
  async #readProgramming(check) {
    const data = filled(this.#radio.chips.data.size);
    for (const { start, end } of PROGRAMMING_RANGES) {
      assert(end <= data.length, 'Data flash is too small for this programming layout.');
      const bytes = await this.#radio.read('data', start, end - start,
        progress => this.progress({ ...progress, phase: 'preflight', message: 'Checking stored radio programming' })); check();
      assert(bytes.length === end - start, 'Incomplete programming-memory read.'); data.set(bytes, start);
    }
    return data;
  }
  async backupToDisk(handle, signal) {
    return this.#exclusive(async check => {
      check(); this.#backup = undefined;
      assert(handle?.getFile && (await handle.getFile()).size === 0, 'Choose a new filename. An existing backup or other file will not be overwritten.');
      const capture = await captureBackup(this.#radio, this.progress, signal); check();
      signal?.throwIfAborted();
      this.progress({ phase: 'save', message: 'Saving and checking the backup file on your drive' });
      const saved = await saveAndVerify(capture, handle); check(); this.#backup = saved; return saved;
    });
  }
  async #snapshot(check, phase) {
    const images = {};
    for (const memory of ['program', 'data']) {
      const size = this.#radio.chips[memory].size;
      images[memory] = await this.#radio.read(memory, 0, size,
        p => this.progress({ ...p, phase, memory, message: `Checking ${memory === 'program' ? 'firmware' : 'radio data'}` }),
        undefined, phase === 'verify' ? () => this.#skipVerification : undefined); check();
      if (phase === 'verify' && this.#skipVerification && images[memory].length < size) break;
      assert(images[memory].length === size, 'The radio returned an incomplete flash image.');
    }
    return images;
  }
  async #writeAndVerify(before, target, operation, check, archiveSha256, archiveFilename) {
    this.#skipVerification = false; this.#operationResult = undefined;
    const plan = [];
    for (const memory of ['data', 'program']) {
      const start = 0;
      for (let address = start; address < target[memory].length; address += SECTOR) {
        const old = before[memory].slice(address, address + SECTOR), data = target[memory].slice(address, address + SECTOR);
        if (!equal(old, data)) {
          plan.push({ memory, address, before: old, data });
        }
      }
    }
    // Publish the application's entry sector after the other changed sectors.
    // Full restores still include every changed bootloader and data sector.
    const entry = plan.findIndex(p => p.memory === 'program' && p.address === APP_START);
    if (entry !== -1) plan.push(...plan.splice(entry, 1));
    const receipt = { version: 1, operation, simulated: this.#radio.simulated === true, startedAt: new Date().toISOString(), identity: this.#identity, targetSha256: { program: await sha256(target.program), data: await sha256(target.data) }, sectors: plan.map(p => ({ memory: p.memory, address: p.address })), done: 0, state: 'prepared', backup: archiveSha256 || this.#backup?.sha256 || null, backupFilename: archiveSha256 ? archiveFilename || null : this.#backup?.filename || null, readbackVerified: false, verificationSkipped: false };
    // Keep a report for this operation; never use a prior session to authorize writes.
    assert(this.#journal?.write, 'A current operation report is required.');
    await this.#journal.write(receipt); check(); this.#operation = receipt;
    try {
      receipt.state = 'writing'; await this.#journal.write(receipt); check();
      await this.#radio.applyPlan(plan, async p => {
        check(); receipt.done = p.done; await this.#journal.write(receipt);
        this.progress({ ...p, phase: operation, message: operation === 'restore' ? 'Restoring original radio' : 'Installing firmware' });
      });
      check();
      let readback;
      this.#verifying = true;
      try { readback = await this.#snapshot(check, 'verify'); }
      finally { this.#verifying = false; }
      // A skip cannot suppress corruption in bytes that were already read.
      for (const [memory, bytes] of Object.entries(readback))
        assert(equal(bytes, target[memory].subarray(0, bytes.length)), 'Complete flash readback differs from the installation plan. Leave the radio connected.');
      receipt.readbackVerified = ['program', 'data'].every(memory => readback[memory]?.length === target[memory].length);
      assert(receipt.readbackVerified || this.#skipVerification, 'Complete flash readback is required before completion.');
      receipt.verificationSkipped = !receipt.readbackVerified;
      receipt.state = receipt.readbackVerified ? 'readback-verified' : 'verification-skipped';
      this.#operationResult = receipt.state;
      await this.#journal.write(receipt);
      receipt.resetSent = false;
      if (this.#radio.restartVerified) {
        this.progress({ phase: 'restart', message: 'Restarting the radio' });
        try {
          check();
          await this.#radio.restartVerified({ verificationSkipped: receipt.verificationSkipped });
          check(); receipt.resetSent = true;
        } catch (error) {
          // Full readback (or the explicit skip) already finished. Preserve
          // that result and report the separate restart problem to the caller.
          receipt.restartError = { name: String(error?.name || 'Error').slice(0, 80), message: String(error?.message || error).slice(0, 500) };
          this.invalidate(error);
        }
        await this.#journal.write(receipt);
      }
      this.progress({ phase: 'complete', message: receipt.restartError ? 'Image written. Switch the radio off and on.' : 'Image operation finished', done: 1, total: 1 });
      return receipt;
    } catch (error) {
      receipt.state = 'interrupted'; receipt.error = error.message;
      try { await this.#journal.write(receipt); } catch { /* retain last committed checkpoint */ }
      // A partial write invalidates the session and its backup authorization.
      this.#operationResult = undefined;
      this.invalidate(error); throw error;
    }
  }
  async #writeProgram(plan, operation, check, metadata = {}) {
    this.#operation = this.#operationResult = undefined;
    this.#skipVerification = false;
    const scoped = metadata.migration === true;
    const method = scoped ? 'sector-readback' : 'sector-crc32';
    const entry = plan.findIndex(sector => (sector.memory === undefined || sector.memory === 'program') && sector.address === APP_START);
    if (entry !== -1) plan.push(...plan.splice(entry, 1));
    const receipt = { version: 2, operation, simulated: this.#radio.simulated === true,
      startedAt: new Date().toISOString(), identity: this.#identity,
      verificationMethod: method, readbackVerified: false, sectorReadbackVerified: false, verificationSkipped: false,
      writtenRanges: metadata.writtenRanges || plan.map(({ memory = 'program', address }) => ({ memory, start: address, end: address + SECTOR })), firmware: metadata.firmware,
      codec: metadata.codec, sourceSha256: metadata.sourceSha256, programming: metadata.programming,
      recovery: metadata.recovery,
      sectors: plan.map(({ address, memory = 'program' }) => ({ memory, address })), done: 0, state: 'prepared' };
    assert(this.#journal?.write, 'A current operation report is required.');
    await this.#journal.write(receipt); check(); this.#operation = receipt;
    try {
      receipt.state = 'writing'; await this.#journal.write(receipt); check();
      const writer = scoped ? this.#radio.writeMigration : this.#radio.writeProgram;
      assert(typeof writer === 'function', 'This radio connection cannot perform verified programming migration.');
      await writer.call(this.#radio, plan, async progress => {
        check(); receipt.done = progress.done; await this.#journal.write(receipt);
        this.progress({ ...progress, phase: operation === 'factory' ? 'install' : operation === 'recovery' ? 'restore' : operation,
          message: scoped ? operation === 'recovery' ? 'Restoring original firmware and programming' : 'Updating firmware and converting programming' : operation === 'factory' ? 'Writing Baofeng firmware' : 'Writing firmware and checking sector checksums' });
      });
      check();
      receipt.sectorReadbackVerified = scoped;
      receipt.state = `${method}-verified`; this.#operationResult = receipt.state;
      await this.#journal.write(receipt);
      receipt.resetSent = false;
      if (this.#radio.restartVerified) {
        this.progress({ phase: 'restart', message: 'Restarting the radio' });
        try {
          check();
          await this.#radio.restartVerified({ verificationMethod: method });
          check(); receipt.resetSent = true;
        } catch (error) {
          receipt.restartError = { name: String(error?.name || 'Error').slice(0, 80), message: String(error?.message || error).slice(0, 500) };
          this.invalidate(error);
        }
        await this.#journal.write(receipt);
      }
      this.progress({ phase: 'complete', message: receipt.restartError ? 'Firmware written. Switch the radio off and on.' : 'Written sectors passed their radio-side checksums', done: 1, total: 1 });
      return receipt;
    } catch (error) {
      receipt.state = 'interrupted'; receipt.error = error.message;
      try { await this.#journal.write(receipt); } catch { /* retain the last checkpoint */ }
      this.#operationResult = undefined; this.invalidate(error); throw error;
    }
  }
  async install({ firstInstall, recoveryHandle } = {}) {
    return this.#exclusive(async check => {
      check(); this.#operation = this.#operationResult = undefined;
      assert(typeof firstInstall === 'boolean', 'Choose First install or Update before flashing.');
      assert(this.#firmware, 'Choose a validated firmware package first.');
      assert(this.#radio.chips.program.size >= DM32_CODEC.end, 'Program flash is too small for this application layout.');
      if (this.#programming) {
        assert(await sha256(await this.#readProgramming(check)) === this.#programming.sourceSha256, 'Programming changed after review. Reconnect and select the firmware again. No flash was written.'); check();
        const application = await this.#radio.read('program', APP_START, DM32_CODEC.start - APP_START,
          progress => this.progress({ ...progress, phase: 'preflight', message: 'Rechecking the installed firmware identity' })); check();
        assert(application.length === DM32_CODEC.start - APP_START && await sha256(application) === this.#programming.applicationSha256, 'Source firmware changed after review. No flash was written.');
        if (this.#programming.plan.changes.length)
          assert(recoveryHandle?.getFile && (await recoveryHandle.getFile()).size === 0, 'Save a new migration recovery ZIP before installing. No flash was written.');
      }
      const plan = [], writtenRanges = [{ memory: 'program', start: APP_START, end: DM32_CODEC.start }];
      let codecInfo, codecWritten = false;
      if (usesDm32Codec(this.#firmware.manifest)) {
        let program, codec;
        if (firstInstall) {
          program = await this.#radio.read('program', 0, DM32_CODEC.end,
            progress => this.progress({ ...progress, phase: 'preflight', message: 'Reading program memory to locate the existing voice codec' })); check();
          assert(program.length === DM32_CODEC.end, 'Incomplete program-memory read.');
          codecInfo = { source: 'radio' };
          codec = await prepareDm32Codec(program, codecTablesEnd(this.#firmware.manifest)); check();
          if (codec.prepared) {
            const slot = codec.slot;
            for (let at = DM32_CODEC.start; at < DM32_CODEC.end; at += SECTOR)
              plan.push({ address: at, data: slot.slice(at - DM32_CODEC.start, at - DM32_CODEC.start + SECTOR) });
            writtenRanges.push({ memory: 'program', start: DM32_CODEC.start, end: DM32_CODEC.end });
            codecWritten = true;
          }
        } else {
          program = filled(DM32_CODEC.end);
          const slot = await this.#radio.read('program', DM32_CODEC.start, DM32_CODEC.end - DM32_CODEC.start,
            progress => this.progress({ ...progress, phase: 'preflight', message: 'Checking the prepared voice codec' })); check();
          assert(slot.length === DM32_CODEC.end - DM32_CODEC.start, 'Incomplete codec-slot read.');
          program.set(slot, DM32_CODEC.start);
          try { codec = checkDm32Codec(program, codecTablesEnd(this.#firmware.manifest)); }
          catch (error) {
            try { error.codec = await codecDiagnosticInfo(program); } catch { /* retain the validation error */ }
            error.message += ' Choose First install to prepare a codec. No flash was written.';
            throw error;
          }
          codecInfo = { source: 'prepared-slot' };
        }
        codecInfo = { ...codecInfo, profile: codec.tag, prepared: codec.prepared === true, preserved: !codecWritten };
      }
      const application = filled(DM32_CODEC.start - APP_START);
      application.set(this.#firmware.application);
      for (let offset = 0; offset < application.length; offset += SECTOR)
        plan.push({ address: APP_START + offset, data: application.slice(offset, offset + SECTOR) });
      if (this.#programming?.plan.changes.length) {
        const original = await this.#radio.read('program', APP_START, DM32_CODEC.end - APP_START,
          progress => this.progress({ ...progress, phase: 'preflight', message: 'Reading original firmware for migration recovery' })); check();
        assert(original.length === DM32_CODEC.end - APP_START, 'Incomplete original firmware image.');
        const repeated = await this.#radio.read('program', APP_START, original.length,
          progress => this.progress({ ...progress, phase: 'preflight', message: 'Checking original firmware recovery image' })); check();
        assert(equal(original, repeated), 'Original firmware changed during recovery capture. No flash was written.');
        assert(await sha256(original.subarray(0, DM32_CODEC.start - APP_START)) === this.#programming.applicationSha256, 'Source firmware changed after review. No flash was written.');
        const { plan: conversion, sourceSha256 } = this.#programming;
        const combined = conversion.changes.map(({ address, before, after }) => {
          assert(isProgrammingSector(address) && equal(before, this.#programming.data.subarray(address, address + SECTOR)), 'Migration plan differs from reviewed programming.');
          return { memory: 'data', address, before, data: after };
        });
        const targetProgram = original.slice();
        for (const sector of plan) {
          const before = original.slice(sector.address - APP_START, sector.address - APP_START + SECTOR);
          targetProgram.set(sector.data, sector.address - APP_START);
          if (!equal(before, sector.data)) combined.push({ ...sector, memory: 'program', before });
        }
        const calibration = await this.#radio.read('data', 0x710000, SECTOR); check();
        assert(calibration.length === SECTOR, 'Incomplete calibration identity read.');
        const identity = { ...this.#identity, uniqueHardwareIdentity: false, calibrationPageSha256: await sha256(calibration) };
        const capture = await createMigrationArchive({ identity, simulated: this.#radio.simulated,
          program: original, changes: conversion.changes, sourceSchema: conversion.sourceSchema,
          targetSchema: conversion.targetSchema, summary: conversion.summary, sourceSha256, sourceIdentity: this.#programming.sourceIdentity,
          firmwareSha256: this.#firmware.manifest.applicationSha256, targetProgramSha256: await sha256(targetProgram) }); check();
        this.progress({ phase: 'save', message: 'Saving and reopening the migration recovery ZIP' });
        const saved = await saveAndVerify(capture, recoveryHandle, verifyMigrationArchive); check();
        return this.#writeProgram(combined, 'install', check, { migration: true, writtenRanges: [...writtenRanges, ...conversion.changes.map(({ address }) => ({ memory: 'data', start: address, end: address + SECTOR }))],
          firmware: this.#firmware.manifest, codec: codecInfo, sourceSha256,
          programming: { sourceIdentity: this.#programming.sourceIdentity, sourceSchema: conversion.sourceSchema, targetSchema: conversion.targetSchema, summary: conversion.summary },
          recovery: { filename: saved.filename, sha256: saved.sha256 } });
      }
      return this.#writeProgram(plan, 'install', check, { writtenRanges, firmware: this.#firmware.manifest, codec: codecInfo });
    });
  }
  async revertFactory(bytes) {
    return this.#exclusive(async check => {
      check(); this.#operation = this.#operationResult = undefined;
      const stock = await readFactoryFirmware(bytes, this.#radio.chips.program.size); check();
      const application = filled(DM32_CODEC.end - APP_START); application.set(stock.application);
      const plan = [];
      for (let offset = 0; offset < application.length; offset += SECTOR)
        plan.push({ address: APP_START + offset, data: application.slice(offset, offset + SECTOR) });
      return this.#writeProgram(plan, 'factory', check, { sourceSha256: stock.sha256,
        writtenRanges: [{ memory: 'program', start: APP_START, end: DM32_CODEC.end }] });
    });
  }
  async inspect(signal) {
    return this.#exclusive(async check => {
      check(); signal?.throwIfAborted();
      const program = await this.#radio.read('program', 0, DM32_CODEC.end,
        progress => this.progress({ ...progress, phase: 'identify', message: 'Reading program memory and identifying the codec' }), signal); check();
      assert(program.length === DM32_CODEC.end, 'Incomplete program-memory read.');
      let codec;
      try {
        const found = await prepareDm32Codec(program); check();
        codec = { status: found.prepared ? 'native' : 'prepared', profile: found.tag,
          validation: await codecDiagnosticInfo(program, found.prepared ? { nativeMatch: 'matched', matchedProfile: found.tag } : {}),
          slotStart: DM32_CODEC.start, slotEnd: DM32_CODEC.end,
          ...(found.source ? { codeOffset: found.source.codeOffset, tablesOffset: found.source.tablesOffset } : {}),
          note: found.prepared ? 'Recognized native OEM codec. First install can copy it into the prepared slot.' : 'A prepared codec slot passed its structural and checksum checks.' };
      } catch (error) {
        codec = { status: error.code?.startsWith('codec_oem_') ? 'unrecognized' : 'invalid-slot', profile: null,
          slotStart: DM32_CODEC.start, slotEnd: DM32_CODEC.end, note: error.message, reason: error.code, validation: error.codec };
      }
      signal?.throwIfAborted();
      const pages = [], pageIds = new Set(), pagesEnd = Math.min(0xc9000, this.#radio.chips.data.size);
      let repeatedPageId = false;
      const stockPages = pagesEnd > 0x1000 ? await this.#radio.read('data', 0x1000, pagesEnd - 0x1000,
        progress => this.progress({ ...progress, phase: 'identify', message: 'Checking the stock codeplug page map and calibration-page presence' }), signal) : new Uint8Array(); check();
      for (let offset = 0; offset + SECTOR <= stockPages.length; offset += SECTOR) {
        const id = stockPages[offset + SECTOR - 1];
        if (id === 0 || id === 255) continue;
        repeatedPageId ||= pageIds.has(id); pageIds.add(id);
        if (id === 2) pages.push(0x1000 + offset);
      }
      const fallback = this.#radio.chips.data.size >= 0x711000
        ? await this.#radio.read('data', 0x710000, SECTOR,
          progress => this.progress({ ...progress, phase: 'identify', message: 'Checking calibration backup' }), signal) : new Uint8Array(); check();
      const fallbackHeader = [0, 0x40, 0, 0x47, 255, 255, 255, 255];
      const info = { chips: structuredClone(this.#radio.chips), bootPrefixSha256: this.#identity.bootPrefixSha256,
        modelRecognized: this.state.modelRecognized, codec,
        calibration: { status: repeatedPageId || pages.length > 1 ? 'ambiguous' : pages.length === 1 ? 'found' : 'not-found', pages,
          pageMapConsistent: !repeatedPageId,
          fallbackPresent: fallbackHeader.every((byte, i) => fallback[i] === byte) },
        regions: radioRegions(),
        notes: ['Calibration-page presence is not a validation of its RF values.',
          'The codec profile does not establish the exact installed firmware version or every hardware variant.',
          'Upper OEM storage is incompletely mapped. Stock firmware reinstalls cannot recreate overwritten individual data.',
          'This inventory is read-only and remains in this page; radio contents are not diagnostic uploads.'] };
      return info;
    });
  }
  async restore(bytes, sameRadioConfirmed, archiveFilename) {
    return this.#exclusive(async check => {
      check(); this.#operation = this.#operationResult = undefined;
      assert(sameRadioConfirmed === true, 'Confirm that this archive belongs to the connected physical radio.');
      const saved = await readRestoreArchive(bytes); check();
      assert(saved.manifest.simulated === (this.#radio.simulated === true), 'Simulation archives cannot restore a physical radio.');
      if (saved.manifest.format === 'open25-dm32-migration-recovery') {
        assert(JSON.stringify(saved.manifest.identity.chips) === JSON.stringify(this.#radio.chips) && saved.manifest.identity.bootSha256 === this.#identity.bootSha256, 'Recovery archive does not match this radio.');
        const calibration = await this.#radio.read('data', 0x710000, SECTOR); check();
        assert(await sha256(calibration) === saved.manifest.identity.calibrationPageSha256, 'Recovery calibration fingerprint differs. No flash was written.');
        const plan = [];
        for (const { address, before: data } of saved.changes) {
          const before = await this.#radio.read('data', address, SECTOR); check();
          if (!equal(before, data)) plan.push({ memory: 'data', address, before, data });
        }
        const current = await this.#radio.read('program', APP_START, saved.program.length); check();
        assert(current.length === saved.program.length, 'Incomplete recovery preflight.');
        for (let offset = 0; offset < current.length; offset += SECTOR) {
          const before = current.slice(offset, offset + SECTOR), data = saved.program.slice(offset, offset + SECTOR);
          if (!equal(before, data)) plan.push({ memory: 'program', address: APP_START + offset, before, data });
        }
        // Even an already-restored image earns fresh sector readback proof.
        if (!plan.length) plan.push({ memory: 'program', address: APP_START, before: current.slice(0, SECTOR), data: saved.program.slice(0, SECTOR) });
        return this.#writeProgram(plan, 'recovery', check, { migration: true,
          programming: { sourceSchema: saved.manifest.targetSchema, targetSchema: saved.manifest.sourceSchema },
          recovery: { filename: archiveFilename || null, sha256: saved.sha256 } });
      }
      for (const memory of ['program', 'data'])
        assert(saved.images[memory].length === this.#radio.chips[memory].size, 'Backup image does not fit the connected flash chip.');
      const before = await this.#snapshot(check, 'preflight');
      return this.#writeAndVerify(before, saved.images, 'restore', check, saved.sha256, typeof archiveFilename === 'string' ? archiveFilename.slice(0, 255) : undefined);
    });
  }
  async completeWrite(receipt) {
    return this.#exclusive(async () => {
      const verified = this.#operationResult === 'readback-verified' && receipt?.readbackVerified === true && receipt?.verificationSkipped === false;
      const checksum = this.#operationResult === 'sector-crc32-verified' && receipt?.verificationMethod === 'sector-crc32' && receipt?.readbackVerified === false && receipt?.verificationSkipped === false;
      const scoped = this.#operationResult === 'sector-readback-verified' && receipt?.verificationMethod === 'sector-readback' && receipt?.sectorReadbackVerified === true && receipt?.verificationSkipped === false;
      const skipped = this.#operationResult === 'verification-skipped' && receipt?.readbackVerified === false && receipt?.verificationSkipped === true;
      assert(receipt && receipt === this.#operation && receipt.state === this.#operationResult && (verified || checksum || scoped || skipped), 'A current completed write result is required before completion.');
      const complete = { ...receipt, state: 'complete' };
      await this.#journal.write(complete); this.#operation = this.#operationResult = undefined; return complete;
    });
  }
}

// The inspector and chip activity view share these ranges. Overlay entries
// describe selected parts of a broader region, not additional chip capacity.
export function radioRegions() {
  return [
    { id: 'bootloader', name: 'Bootloader', contents: 'Starts the radio and holds factory information.', memory: 'program', start: 0, end: APP_START, label: 'Bootloader and factory information', description: 'Preserved by First install, Update and Revert to factory. A full backup restore may replace it.', known: true },
    { id: 'firmware', name: 'Firmware', contents: 'The application your radio runs. Stock firmware also keeps its voice codec here.', memory: 'program', start: APP_START, end: DM32_CODEC.start, label: 'Application', description: 'Open25 application area. OEM firmware embeds its native codec code and tables within the application at version-specific positions.', known: true },
    { id: 'codec', name: 'Voice codec', contents: 'Digital voice code and tables prepared for compatible firmware.', memory: 'program', start: DM32_CODEC.start, end: DM32_CODEC.end, label: 'Prepared DMR codec slot', description: 'Preserved by Open25 updates. A first install prepares it if necessary; a stock firmware revert replaces the full application layout.', known: true },
    { id: 'stock-programming', name: 'Programming & calibration', contents: 'Stock channels, settings and factory calibration. Calibration locations vary.', memory: 'data', start: 0x1000, end: 0xc9000, label: 'Stock codeplug and factory calibration pages', description: 'Channels, zones, contacts, IDs and settings in a paged layout. Calibration is logical page 2. Ordinary firmware flashing does not write the data chip.', known: true },
    { id: 'startup-image', name: 'Startup image', contents: 'The original Baofeng startup-screen picture.', memory: 'data', start: 0x150000, end: 0x176000, label: 'Stock startup image', description: 'The OEM boot-screen bitmap.', known: true },
    { id: 'stock-contacts', name: 'Contacts', contents: 'The stock DMR ID and name database, separate from programmed contacts.', memory: 'data', start: 0x278000, end: 0x6dc000, label: 'Stock contact database', description: 'Large OEM DMR ID/name database, separate from codeplug contacts.', known: true },
    { id: 'upper-storage', name: 'Other storage', contents: 'Open25 uses selected parts for programming and other records. Some factory uses are unknown.', memory: 'data', start: 0x6dc000, end: 0x1000000, label: 'Partly unknown OEM upper storage', description: 'Some overlaps Open25/RadioFoundry runtime storage. Recordings or extended databases are possible OEM uses, not confirmed.', known: false },
    { id: 'runtime-storage', name: 'Open25 storage', contents: 'Programming, preferences and other records used by the installed firmware.', overlay: true, memory: 'data', start: 0x700000, end: 0x1000000, label: 'Open25 / RadioFoundry runtime storage', description: 'Selected portions hold programming, preferences, journals and other records. Actual writable ranges depend on the installed edition; this whole range is not necessarily written.', known: false },
    { id: 'calibration-copy', name: 'Calibration backup', contents: 'A decoded calibration copy for compatible firmware, separate from the factory original.', overlay: true, memory: 'data', start: 0x710000, end: 0x711000, label: 'Fallback decoded calibration copy', description: 'Used by compatible firmware only when no original calibration page is available. This is not the original factory calibration.', known: true },
  ];
}
