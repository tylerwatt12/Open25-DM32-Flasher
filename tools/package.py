#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Build a local flasher-only site payload; never uploads or deploys."""
from pathlib import Path
import argparse,json,shutil,subprocess
ROOT=Path(__file__).resolve().parents[1]
subprocess.run(['python3','tools/verify_release.py'],cwd=ROOT,check=True)
names=list(json.loads((ROOT/'LIVE-SNAPSHOT.json').read_text())['files_sha256'])
names.append('assets/monitor.bin')
for name in names:
    if not (ROOT/name).is_file():raise SystemExit('Run npm run prepare first: '+name)
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--out',type=Path,default=ROOT/'build/site')
args=parser.parse_args()
out=args.out.resolve()
if out.exists():raise SystemExit('Preserving existing payload; move build/site before packaging again')
for name in names:
    target=out/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(ROOT/name,target)
print(f'Prepared local payload in {out}. Firmware ZIPs remain on the existing host; no upload performed.')
