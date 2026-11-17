#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Check the reviewed release snapshot and prepared external dependencies."""
from pathlib import Path
import hashlib,json
ROOT=Path(__file__).resolve().parents[1]
snapshot=json.loads((ROOT/'LIVE-SNAPSHOT.json').read_text())
for name,wanted in snapshot['files_sha256'].items():
    path=ROOT/name
    if path.is_symlink() or hashlib.sha256(path.read_bytes()).hexdigest()!=wanted:raise SystemExit('Live snapshot mismatch: '+name)
for record in json.loads((ROOT/'dependencies.json').read_text()).values():
    path=ROOT/record['path']
    if path.exists() and (path.is_symlink() or hashlib.sha256(path.read_bytes()).hexdigest()!=record['sha256']):raise SystemExit('Dependency mismatch: '+record['path'])
if (ROOT/'lib/dm32-codec-profiles.mjs').read_bytes()!=(ROOT/'v3/lib/dm32-codec-profiles.mjs').read_bytes():raise SystemExit('Refresh the derived v3 codec metadata from lib/')
print(f"Verified {len(snapshot['files_sha256'])} live source/assets and prepared dependencies")
