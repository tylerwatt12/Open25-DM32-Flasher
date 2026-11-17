// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
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
  const fixture=JSON.parse(await readFile(new URL('dependencies.json',root),'utf8')).test_firmware;
  assert.equal(fixture.path,'releases/'+releases[0].file);
  assert.equal(fixture.sha256,releases[0].sha256);
  assert.equal(fixture.source,'https://kd8zmm.com/open25-dm32/'+fixture.path);
});
