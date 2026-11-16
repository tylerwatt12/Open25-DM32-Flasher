// SPDX-License-Identifier: GPL-3.0-or-later
// Exercise the shipped PHP endpoint over HTTP with logs isolated in a temporary directory.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, symlink, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';

const sourceURL = new URL('../hardware-report.php', import.meta.url);
const phpAvailable = spawnSync('php', ['-v']).status === 0;
const pageId = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const operationId = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const hardware = {
  program: { jedec: 'c84014', size: 1048576 },
  data: { jedec: 'ef4018', size: 16777216 },
  bootPrefixSha256: 'a'.repeat(64), qualified: true,
};
const event = (extra = {}) => ({ version: 2, pageId, operationId,
  event: 'operation_succeeded', workflow: 'install', phase: 'verify',
  appVersion: '2026-11-14-loader-diagnostics-1',
  firmware: { target: 'dm32-048', release: 'open25-classic-test', sha256: 'b'.repeat(64) },
  hardware, readbackVerified: true, verificationSkipped: false, ...extra });

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'dm32-diagnostics-'));
  const endpoint = (await readFile(sourceURL, 'utf8')).replaceAll('/var/lib/open25-dm32', root);
  await writeFile(path.join(root, 'hardware-report.php'), endpoint);
  // Test-only router supplies transport peer addresses that HTTP clients cannot choose in production.
  await writeFile(path.join(root, 'router.php'), `<?php
$_SERVER['REMOTE_ADDR'] = $_SERVER['HTTP_TEST_TRANSPORT_PEER'] ?? '198.51.100.20';
require __DIR__ . '/hardware-report.php';
`);
  await writeFile(path.join(root, 'diagnostics.jsonl'), '');
  await writeFile(path.join(root, 'hardware-reports.jsonl'), '');
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const child = spawn('php', ['-S', `127.0.0.1:${port}`, path.join(root, 'router.php')], { cwd: root, stdio: 'ignore' });
  t.after(async () => {
    child.kill();
    await new Promise(resolve => child.exitCode !== null || child.signalCode !== null ? resolve() : child.once('exit', resolve));
    await rm(root, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${port}/hardware-report.php`;
  for (let attempt = 0; ; attempt++) {
    try { await fetch(url); break; }
    catch (error) { if (attempt > 40) throw error; await new Promise(resolve => setTimeout(resolve, 20)); }
  }
  async function send(body, headers = {}, method = 'POST') {
    return fetch(url, { method,
      headers: { Origin: 'https://kd8zmm.com', 'Content-Type': 'application/json',
        'User-Agent': 'DM32 diagnostic endpoint test', ...headers },
      ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
    });
  }
  async function rows(name = 'diagnostics.jsonl') {
    return (await readFile(path.join(root, name), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  }
  return { root, send, rows };
}

test('diagnostic endpoint stores verified, skipped, failed and hardware events with server metadata', { skip: !phpAvailable }, async t => {
  const f = await fixture(t);
  assert.equal((await f.send(event())).status, 204);
  assert.equal((await f.send(event({ event: 'verification_skipped', readbackVerified: false, verificationSkipped: true }))).status, 204);
  assert.equal((await f.send(event({ event: 'operation_succeeded', readbackVerified: false, verificationSkipped: true }))).status, 204);
  assert.equal((await f.send({ version: 2, pageId, operationId, event: 'operation_failed', workflow: 'connect',
    error: { name: 'NetworkError', message: 'The programming cable disconnected.' } })).status, 204);
  assert.equal((await f.send({ version: 2, pageId, event: 'hardware', workflow: 'connect', hardware })).status, 204);
  assert.equal((await f.send({ version: 2, pageId, event: 'page_view', workflow: 'install', phase: 'serial-unavailable' })).status, 204);
  const rows = await f.rows();
  assert.equal(rows.length, 6);
  assert.match(rows[0].timestamp, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.equal(rows[0].ip, '198.51.100.20');
  assert.equal(rows[0].userAgent, 'DM32 diagnostic endpoint test');
  assert.deepEqual(rows[0].hardware, hardware);
  assert.equal(rows[1].readbackVerified, false);
  assert.equal(rows[2].verificationSkipped, true);
  assert.deepEqual(await f.rows('hardware-reports.jsonl'), []);
});

test('collector stores codec reasons and verified writes with distinct restart failures', { skip: !phpAvailable }, async t => {
  const f = await fixture(t);
  assert.equal((await f.send(event({ phase: 'complete', resetSent: false,
    restartError: { name: 'BreakError', message: 'Break received' } }))).status, 204);
  assert.equal((await f.send(event({ event: 'operation_failed', phase: 'preflight',
    readbackVerified: false, verificationSkipped: false, resetSent: false,
    error: { name: 'Error', message: 'Codec slot checksum does not match. No flash was written.', code: 'codec_slot_crc' } }))).status, 204);
  assert.equal((await f.send(event({ event: 'operation_failed', phase: 'restart',
    resetSent: false, error: { name: 'NetworkError', message: 'Device lost' } }))).status, 204);
  const rows = await f.rows();
  assert.equal(rows[0].readbackVerified, true); assert.equal(rows[0].resetSent, false);
  assert.equal(rows[0].restartError.name, 'BreakError');
  assert.equal(rows[1].error.code, 'codec_slot_crc');
  assert.equal((await f.send(event({ resetSent: true, restartError: { name: 'Error', message: 'Lost' } }))).status, 400);
  assert.equal((await f.send(event({ error: { name: 'Error', message: 'Bad', code: 'x'.repeat(65) } }))).status, 400);
  assert.equal((await f.send(event({ error: { name: 'Error', message: 'Bad', code: { bytes: 'private' } } }))).status, 400);
  assert.equal((await f.rows()).length, 3);
});

test('visitor IP trusts Cloudflare peers only, including IPv6; UA is bounded', { skip: !phpAvailable }, async t => {
  const f = await fixture(t);
  const body = { version: 2, pageId, event: 'page_view', workflow: 'install' };
  for (const [peer, forwarded, expected] of [
    ['198.51.100.20', '203.0.113.7', '198.51.100.20'],
    ['104.16.1.1', '203.0.113.7', '203.0.113.7'],
    ['2606:4700::1', '2001:db8::7', '2001:db8::7'],
    ['104.16.1.1', '203.0.113.7, 10.0.0.1', '104.16.1.1'],
    ['104.15.255.255', '203.0.113.7', '104.15.255.255'],
  ]) {
    assert.equal((await f.send(body, { 'Test-Transport-Peer': peer, 'CF-Connecting-IP': forwarded,
      'X-Forwarded-For': '192.0.2.100', 'User-Agent': 'x'.repeat(1000) })).status, 204);
    const row = (await f.rows()).at(-1);
    assert.equal(row.ip, expected);
    assert.equal(row.userAgent.length, 512);
  }
});

test('legacy hardware pages keep their existing log; diagnostic requests are stored regardless of DNT or GPC headers', { skip: !phpAvailable }, async t => {
  const f = await fixture(t);
  assert.equal((await f.send(hardware)).status, 204);
  assert.deepEqual(await f.rows('hardware-reports.jsonl'), [{ day: new Date().toISOString().slice(0, 10), ...hardware }]);
  assert.equal((await f.send(event(), { 'Sec-GPC': '1' })).status, 204);
  assert.equal((await f.send(event(), { DNT: '1' })).status, 204);
  assert.equal((await f.send(event(), { 'Sec-GPC': '1', DNT: '1' })).status, 204);
  const rows = await f.rows();
  assert.equal(rows.length, 3);
  assert.ok(rows.every(row => row.event === 'operation_succeeded'));
});

test('endpoint rejects malformed, extra, oversized and inconsistent data before logging', { skip: !phpAvailable }, async t => {
  const f = await fixture(t);
  for (const body of [
    event({ serialNumber: 'not-allowed' }), event({ ip: '203.0.113.8' }), event({ userAgent: 'client-value' }),
    event({ firmware: { target: 'dm32-048', release: 'test', sha256: 'b'.repeat(64), filename: 'private.zip' } }),
    event({ hardware: { ...hardware, bootBytes: 'private' } }),
    event({ hardware: { ...hardware, data: { jedec: 'ef4018', size: 4096 } } }),
    event({ readbackVerified: true, verificationSkipped: true }),
    event({ readbackVerified: false, verificationSkipped: false }),
    event({ event: 'verification_skipped' }),
    event({ event: 'operation_failed' }),
    event({ pageId: '../unsafe' }), event({ operationId: null }),
    event({ error: { name: 'Error', message: 'x'.repeat(501) } }),
    event({ error: { name: 'Error', message: 'line\nbreak' } }),
    '[]', '{"version":',
  ]) assert.equal((await f.send(body)).status, 400, JSON.stringify(body));
  assert.equal((await f.send('x'.repeat(4097))).status, 413);
  assert.equal((await f.send(event(), { Origin: 'https://unrelated.example' })).status, 403);
  assert.equal((await f.send(event(), { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await f.send(null, {}, 'GET')).status, 405);
  assert.deepEqual(await f.rows(), []);
});

test('missing, symlinked and full logs fail closed without changing other files', { skip: !phpAvailable }, async t => {
  const f = await fixture(t);
  const log = path.join(f.root, 'diagnostics.jsonl'), other = path.join(f.root, 'other');
  await rm(log);
  assert.equal((await f.send(event())).status, 503);
  await writeFile(other, 'preserve');
  await symlink(other, log);
  assert.equal((await f.send(event())).status, 503);
  assert.equal(await readFile(other, 'utf8'), 'preserve');
  await rm(log); await writeFile(log, ''); await truncate(log, 16 * 1024 * 1024);
  assert.equal((await f.send(event())).status, 503);
});

test('a concurrent diagnostic append waits for the log lock and records the event once', { skip: !phpAvailable }, async t => {
  const f = await fixture(t);
  const holder = spawn('php', ['-r', `
$log = fopen($argv[1], 'ab');
if (!flock($log, LOCK_EX)) exit(2);
fwrite(STDOUT, "locked\\n");
fgets(STDIN);
flock($log, LOCK_UN);
fclose($log);
`, path.join(f.root, 'diagnostics.jsonl')], { stdio: ['pipe', 'pipe', 'ignore'] });
  const exited = new Promise(resolve => holder.once('exit', resolve));
  t.after(async () => { holder.kill(); await exited; });
  const ready = await new Promise((resolve, reject) => {
    holder.once('error', reject);
    holder.once('exit', code => reject(new Error(`Log-lock holder exited early (${code}).`)));
    holder.stdout.once('data', data => resolve(data.toString()));
  });
  assert.equal(ready, 'locked\n');
  let settled = false;
  const sending = f.send(event()).then(response => { settled = true; return response; });
  let waited;
  try {
    await new Promise(resolve => setTimeout(resolve, 100));
    waited = !settled;
  } finally { holder.stdin.end('\n'); }
  const response = await sending;
  await exited;
  assert.equal(waited, true, 'The report should wait instead of failing while another append holds the lock.');
  assert.equal(response.status, 204);
  const rows = await f.rows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].operationId, operationId);
});

test('v3 logs each deliberate action and distinguishes sector checks from full byte readback', { skip: !phpAvailable }, async t => {
  const f = await fixture(t);
  for (const workflow of ['first_install', 'update', 'revert']) {
    assert.equal((await f.send(event({ workflow, phase: 'complete',
      appVersion: '2026-11-15-flasher-v3-local-1', readbackVerified: false,
      verificationSkipped: false, verificationMethod: 'sector-crc32', resetSent: true }))).status, 204);
  }
  assert.equal((await f.send(event({ workflow: 'restore', verificationMethod: 'full-byte-readback' }))).status, 204);
  for (const workflow of ['backup', 'info']) {
    assert.equal((await f.send({ version: 2, pageId, operationId, workflow,
      event: 'operation_succeeded', phase: workflow === 'info' ? 'info' : 'save' })).status, 204);
  }
  const rows = await f.rows();
  assert.deepEqual(rows.map(r => r.workflow), ['first_install', 'update', 'revert', 'restore', 'backup', 'info']);
  assert(rows.slice(0, 3).every(r => r.verificationMethod === 'sector-crc32' &&
    r.readbackVerified === false && r.verificationSkipped === false));
});

test('v3 rejects false proof and private inspector contents before storing', { skip: !phpAvailable }, async t => {
  const f = await fixture(t);
  for (const extra of [
    { workflow: 'update', readbackVerified: false, verificationSkipped: false },
    { workflow: 'update', verificationMethod: 'sector-crc32' },
    { workflow: 'restore', verificationMethod: 'sector-crc32', readbackVerified: false, verificationSkipped: false },
    { workflow: 'update', verificationMethod: 'full-byte-readback', readbackVerified: false, verificationSkipped: false },
    { workflow: 'info', verificationMethod: 'sector-crc32', readbackVerified: false, verificationSkipped: false },
    { workflow: 'info', calibration: { raw: 'private' } },
    { workflow: 'info', codecBytes: 'private' },
    { workflow: 'info', radioId: 1234567 },
    { workflow: 'info', keys: 'private' },
  ]) assert.equal((await f.send(event(extra))).status, 400, JSON.stringify(extra));
  assert.deepEqual(await f.rows(), []);
});

test('codec failure details are preserved, bounded and optional for older clients', { skip: !phpAvailable }, async t => {
  const f = await fixture(t);
  const codec = { nativeMatch: 'code-mismatch', headerMarker: 0xffffffff, headerVersion: 0xffffffff,
    slotBlank: true, slotSha256: 'c'.repeat(64), nativeSignatures: 1,
    candidateCodeSha256: 'd'.repeat(64), candidateCodeBytes: 83456 };
  const failed = detail => event({ event: 'operation_failed', phase: 'preflight', readbackVerified: false,
    verificationSkipped: false, resetSent: false, error: { name: 'Error', message: 'No supported codec.',
      code: 'codec_oem_unknown', ...(detail ? { codec: detail } : {}) } });
  assert.equal((await f.send(failed(codec))).status, 204);
  assert.deepEqual((await f.rows())[0].error.codec, codec);
  assert.equal((await f.send(failed())).status, 204, 'older clients need no new fields');
  for (const invalid of [
    { ...codec, nativeMatch: 'anything' }, { ...codec, headerMarker: 4294967296 },
    { ...codec, headerVersion: -1 }, { ...codec, headerMarker: 0 }, { ...codec, slotBlank: 'yes' },
    { ...codec, slotSha256: 'C'.repeat(64) }, { ...codec, nativeSignatures: 4194305 },
    { ...codec, candidateCodeBytes: 98305 }, { ...codec, candidateCodeBytes: 0 },
    { ...codec, candidateCodeSha256: undefined }, { ...codec, matchedProfile: 65536 },
    { ...codec, tableCandidates: 1.5 }, { ...codec, codecBytes: 'PRIVATE_RAW_CODEC' },
  ]) assert.equal((await f.send(failed(invalid))).status, 400, JSON.stringify(invalid));
  const notCodec = failed(codec); notCodec.error.code = 'serial_timeout';
  assert.equal((await f.send(notCodec)).status, 400);
  assert.equal((await f.rows()).length, 2);
});
