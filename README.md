# Open25-DM32 Flasher

Source for the current [Flasher v3](https://kd8zmm.com/open25-dm32/v3/firmware.html),
supporting Open25-DM32 Classic and Next packages on supported HR_C7000 hardware.
The initial source release preserves live version `2026-11-16-flasher-v3-2`.
`LIVE-SNAPSHOT.json` records exact deployed runtime and shared-asset hashes.
No runtime code, flash policy or radio protocol is changed by this extraction.

The tools provide First install, Update firmware, Backup / Restore, Revert to
factory, Radio info and Create update file. Use desktop Chrome or Edge for Web
Serial. Choose the intended operation before connecting; writing requires its
own explicit action. A full backup and a CPS codeplug are different files.
Preserve a full backup belonging to the same radio before changing firmware.

## Run locally

Use Node 22+ and Python 3.10+. No npm runtime dependencies are required.

```sh
npm run prepare
npm start
```

Open `http://127.0.0.1:8326/v3/firmware.html`. The server binds only to loopback.
`prepare` downloads the exact public RadioFoundry host file named in
`dependencies.json`, verifies its SHA-256, parses its embedded universal RAM
helper without executing the downloaded Python, and verifies the helper hash.
The generated `assets/monitor.bin` is ignored and is never a Git input.
The helper's device-side source is absent from the pinned upstream tree; this
is a pinned binary dependency, not a source-reproducible helper build.

The unchanged live release catalog is checked in as metadata. Firmware ZIPs are
not included. For local catalog installs, obtain a chosen public ZIP from
`https://kd8zmm.com/open25-dm32/releases/` at its catalog-relative path and verify
its catalog SHA-256, then place it under the corresponding ignored `releases/`
path. Manual ZIP selection is available. Classic/Next target names and a Next
preview screenshot are public interface/assets; no Next firmware or CPS
implementation is included.

## Tests and initial release verification

```sh
npm run prepare:tests
npm test
npm run verify
npm run package
```

`prepare:tests` additionally retrieves the exact public Classic r7 package used
by the existing installation/protocol and update-file builder tests. Its URL
and SHA-256 are pinned in `dependencies.json`; it stays ignored. PHP 8.1+ is
needed for collector tests; those tests skip when PHP is unavailable. Two
optional OEM-fixture tests skip unless `DM32_OEM_BACKUP` names a private compatible
backup outside this repository. Do not commit such a backup. Tests use synthetic
radios and local temporary logs; they do not access physical serial ports.

`verify` compares source and assets with the recorded live hashes, checks any
prepared dependency hashes and verifies the derived codec metadata. `package`
writes only the initial flasher payload under ignored `build/site/`, including
the locally prepared monitor. It refuses to replace an existing output. It
includes no firmware ZIPs, homepage, CPS, v1/v2, deployment credentials or Git
database. Keep existing hosted firmware packages/catalog paths when overlaying
this payload. Packaging never uploads or deploys anything.

Codec metadata is owned by `lib/dm32-codec-profiles.mjs`. The unchanged runtime
copy under `v3/lib/` is derived. `tools/refresh_codec_profiles.py` refreshes both
from the exact RadioFoundry pin identified in that tool. An intentional update
needs refreshed initial-release manifests and qualification; do not edit the
derived copy independently.

## Hosted diagnostics and qualification

The unchanged PHP collector targets `https://kd8zmm.com` and writes logs outside
the document root under `/var/lib/open25-dm32`. Localhost and simulated radios
do not submit diagnostics. Other hosts must deliberately configure their origin
and private log directory. Server configuration, log contents and administrator
deployment tooling are excluded from this source release.

Sharing follows the on-page checkbox. Reports can include temporary IDs,
operation outcomes, hardware fingerprints, bounded errors and package metadata;
the server adds timestamp, IP and User-Agent. Raw radio bytes, codeplugs,
calibration, keys and backups are not diagnostic uploads. Radio info is local.

Direct firmware writes preserve the bootloader/data chip and check each written
sector through the existing helper CRC response. Full restore intentionally
replaces both main flash arrays, with the existing complete readback or explicit
skip behavior. Software success does not establish radio startup or RF
qualification. The update-file builder uses codec bytes from a locally supplied
compatible OEM file; no proprietary codec or OEM firmware is bundled here.

## License and source release

Project flasher source retains GPL-3.0-or-later notices and the root LICENSE.
RadioFoundry-derived portions and existing MIT tools retain their MIT notices;
see [THIRD_PARTY.md](v3/THIRD_PARTY.md) and [the MIT tool notice](LICENSES/MIT.txt).
Browser icons, Baofeng screenshots and
other third-party artwork retain their stated ownership and are not relicensed
under GPL. The deployed provenance file is preserved verbatim; historical
parent-tool references now refer to this standalone repository.

The intended public repository name is `Open25-DM32-Flasher`. This is a local
source-release preparation. No GitHub repository or release has been created,
and no site deployment is performed by this repository's commands. GitHub is
source-only; firmware packages continue to be hosted on kd8zmm.com.
