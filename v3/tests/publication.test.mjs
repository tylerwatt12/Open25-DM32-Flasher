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
test('initial runtime and assets match the recorded live deployment',()=>{
  assert.match(execFileSync('python3',['tools/verify_release.py'],{cwd:new URL('../../',import.meta.url),encoding:'utf8'}),/Verified/);
});
test('the flasher retains its GPL license and upstream notices',async()=>{
  assert.match(await readFile(new URL('../../LICENSE',import.meta.url),'utf8'),/GNU GENERAL PUBLIC LICENSE\s+Version 3, 29 June 2007/);
  assert.match(await readFile(new URL('../THIRD_PARTY.md',import.meta.url),'utf8'),/The RadioFoundry Authors/);
});
