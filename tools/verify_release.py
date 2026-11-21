#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Check the reviewed release snapshot and prepared external dependencies."""
from pathlib import Path
import hashlib,json,posixpath,re
ROOT=Path(__file__).resolve().parents[1]
snapshot=json.loads((ROOT/'LIVE-SNAPSHOT.json').read_text())
for name,wanted in snapshot['files_sha256'].items():
    path=ROOT/name
    if path.is_symlink() or hashlib.sha256(path.read_bytes()).hexdigest()!=wanted:raise SystemExit('Live snapshot mismatch: '+name)
# Packaging copies only this manifest. Refuse missing imports before it can
# produce a site whose entry module loads but its dependency graph returns 404.
reviewed=snapshot['files_sha256']
for name in reviewed:
    if name.startswith('v3/') and name.endswith('.mjs'):
        for specifier in re.findall(r'''\b(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]''',(ROOT/name).read_text()):
            if not specifier.startswith('.'):
                raise SystemExit('Unexpected external runtime import: '+name)
            target=posixpath.normpath(posixpath.join(posixpath.dirname(name),specifier.split('?',1)[0].split('#',1)[0]))
            if target not in reviewed:raise SystemExit('Runtime import absent from release payload: '+target)
for entry in re.findall(r'<script[^>]+type="module"[^>]+src="([^"]+)"',(ROOT/'v3/firmware.html').read_text()):
    target=posixpath.normpath(posixpath.join('v3',entry.split('?',1)[0]))
    if target not in reviewed:raise SystemExit('Runtime entry absent from release payload: '+target)
for record in json.loads((ROOT/'dependencies.json').read_text()).values():
    path=ROOT/record['path']
    if path.exists() and (path.is_symlink() or hashlib.sha256(path.read_bytes()).hexdigest()!=record['sha256']):raise SystemExit('Dependency mismatch: '+record['path'])
if (ROOT/'lib/dm32-codec-profiles.mjs').read_bytes()!=(ROOT/'v3/lib/dm32-codec-profiles.mjs').read_bytes():raise SystemExit('Refresh the derived v3 codec metadata from lib/')
print(f"Verified {len(snapshot['files_sha256'])} live source/assets and prepared dependencies")
