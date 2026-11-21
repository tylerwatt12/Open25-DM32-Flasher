// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {readFirmware} from '../lib/firmware.mjs';
import {sha256} from '../lib/bytes.mjs';
import {PROGRAMMING_SOURCES} from '../lib/programming-source.mjs';
import {OEM_CODECS} from '../lib/dm32-codec-profiles.mjs';
import {OEM_CODECS as canonicalProfiles} from '../../lib/dm32-codec-profiles.mjs';
test('v3 codec metadata remains derived from authoritative metadata',()=>{
  assert.deepEqual(OEM_CODECS,canonicalProfiles);
});
test('release runtime and assets match the reviewed deployment manifest',()=>{
  assert.match(execFileSync('python3',['tools/verify_release.py'],{cwd:new URL('../../',import.meta.url),encoding:'utf8'}),/Verified/);
});
test('the flasher retains its GPL license and upstream notices',async()=>{
  assert.match(await readFile(new URL('../../LICENSE',import.meta.url),'utf8'),/GNU GENERAL PUBLIC LICENSE\s+Version 3, 29 June 2007/);
  assert.match(await readFile(new URL('../THIRD_PARTY.md',import.meta.url),'utf8'),/The RadioFoundry Authors/);
});
test('Classic exposes only its coordinated release and tests pin that same package',async()=>{
  const root=new URL('../../',import.meta.url);
  const catalog=JSON.parse(await readFile(new URL('releases/catalog.json',root),'utf8'));
  const releases=catalog.channels.find(c=>c.id==='classic').variants.flatMap(v=>v.releases);
  assert.equal(releases.length,1,'Earlier Classic releases must not remain selectable');
  const dependencies=JSON.parse(await readFile(new URL('dependencies.json',root),'utf8'));
  const fixture=dependencies.test_firmware;
  assert.equal(releases[0].version,'0.1.0-rc1-r14');
  assert.equal(fixture.path,'releases/'+releases[0].file);
  assert.equal(fixture.sha256,releases[0].sha256);
  assert.equal(fixture.source,'https://kd8zmm.com/open25-dm32/'+fixture.path);
  const target=await readFirmware(new Uint8Array(await readFile(new URL(fixture.path,root))));
  assert.equal(target.manifest.programming.schema,'rfkv-p25-contact-v1');
  const legacy=dependencies.migration_source_firmware;
  assert.equal(legacy.sha256,'62298c88923ffd621aa590e409e619ca3beaf94432a468668ff9aa44553974d0');
  const sourceBytes=new Uint8Array(await readFile(new URL(legacy.path,root)));
  assert.equal(await sha256(sourceBytes),legacy.sha256);
  const source=await readFirmware(sourceBytes);
  assert(PROGRAMMING_SOURCES.some(row=>row.applicationBytes===source.application.length&&row.applicationSha256===source.manifest.applicationSha256));
  assert(!catalog.channels.find(c=>c.id==='next').enabled);
});
