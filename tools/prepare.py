#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Fetch hash-pinned public dependencies; never connects to a radio."""
import argparse, ast, base64, hashlib, json, zlib
from pathlib import Path
from urllib.request import Request, urlopen
ROOT=Path(__file__).resolve().parents[1]
LOCK=json.loads((ROOT/'dependencies.json').read_text())
def checked(data,wanted):
    if hashlib.sha256(data).hexdigest()!=wanted:raise SystemExit('Dependency hash mismatch; refusing replacement')
    return data
def fetch(record):
    request=Request(record['source'],headers={'User-Agent':'Open25-DM32-source-setup'})
    with urlopen(request,timeout=30) as response:data=response.read(4*1024*1024+1)
    if len(data)>4*1024*1024:raise SystemExit('Dependency is larger than expected')
    return checked(data,record.get('source_sha256',record['sha256']))
def save(record,data):
    checked(data,record['sha256']);target=ROOT/record['path']
    if target.exists():checked(target.read_bytes(),record['sha256']);return
    target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(data)
def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--tests',action='store_true',help='Also retrieve the current catalog Classic test package')
    args=parser.parse_args();monitor=LOCK['monitor']
    if (ROOT/monitor['path']).exists():checked((ROOT/monitor['path']).read_bytes(),monitor['sha256'])
    else:
        # Parse literal constants only. Do not import or execute downloaded code.
        tree=ast.parse(fetch(monitor).decode());values={}
        for node in tree.body:
            if isinstance(node,ast.Assign) and len(node.targets)==1 and isinstance(node.targets[0],ast.Name) and node.targets[0].id in ('STUB_UNIV_B64','STUB_UNIV_SHA256'):
                values[node.targets[0].id]=ast.literal_eval(node.value)
        if values['STUB_UNIV_SHA256']!=monitor['sha256']:raise SystemExit('Monitor pin differs')
        packed=values['STUB_UNIV_B64'];packed=''.join(packed) if not isinstance(packed,str) else packed
        save(monitor,zlib.decompress(base64.b64decode(packed)))
    if args.tests:
        record=LOCK['test_firmware'];target=ROOT/record['path']
        save(record,target.read_bytes() if target.exists() else fetch(record))
    print('Verified pinned public dependencies. No radio accessed.')
if __name__=='__main__':main()
