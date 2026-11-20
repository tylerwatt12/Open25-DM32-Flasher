# Open25-DM32 Flasher

Source for the current [Flasher v3](https://kd8zmm.com/open25-dm32/v3/firmware.html),
supporting Open25-DM32 Classic and Next packages on supported HR_C7000 hardware.
The Classic r13 catalog uses the existing flasher version
`2026-11-17-flasher-v3-6`. `LIVE-SNAPSHOT.json` records the reviewed runtime,
catalog and shared-asset hashes. The reviewed catalog remains unchanged. Source changes for programming migration
are separate from that deployed snapshot.

The tools homepage lists Flasher v3, Classic CPS and Next CPS. Classic CPS
supports Open25-DM32 Classic firmware R9 and newer. Retired Flasher v1/v2
choices are removed from the homepage; their former public entry URLs redirect
to [Flasher v3](https://kd8zmm.com/open25-dm32/v3/firmware.html).

The tools provide First install, Update firmware, Backup / Restore, Revert to
factory, Radio info and offline installer. Update firmware accepts a radio
already running RadioFoundry or Open25, with the existing prepared-codec check.
Use desktop Chrome or Edge for Web
Serial. Choose the intended operation before connecting; writing requires its
own explicit action. A full backup and a CPS codeplug are different files.
Preserve a full backup belonging to the same radio before changing firmware.

## Programming format upgrades

A firmware ZIP can declare its target programming schema in `firmware.json` as
`"programming": {"schema": "rfkv-p25-contact-v1"}`. The flasher uses a bundled,
versioned converter; packages cannot supply migration scripts. The initial
registered source is the exact published Classic r13 application. The flasher
checks its full application hash and erased padding, then validates programming
and any pending journal before offering the update. Unknown modified firmware
with nonblank programming is refused; similar records or version names are not
proof of compatibility. An already installed exact target image is also admitted.
Future native-to-native upgrades must add reviewed prior application identities to
`PROGRAMMING_SOURCES`; publishing a new target alone does not admit every older native image.

The r13 conversion preserves P25 talkgroups by reusing suitable group contacts or
creating unused contacts, and converts the channel links. Other IDs, NACs, channel
settings and RFKV records are preserved. Chained settings are compacted only when
they fit the native root without dropping records. Unsupported or previously
parked channel semantics, a full contact table, damaged records and an unfinished
firmware journal stop the upgrade before writes.

The Install screen shows the conversion counts. A conversion requires choosing
a new recovery ZIP; the flasher saves and reopens it before writing. This private
archive holds the original complete application and codec plus every changed data
sector. After interruption, reconnect the same radio and choose Backup / Restore
with that ZIP to roll back both firmware and affected programming. Recovery does
not resume an old write automatically. Each changed sector is checked before
erase and downloaded after writing; the application entry is written last.

The recovery identity uses chip capacities, boot and calibration fingerprints,
not a unique hardware serial number. Those fingerprints can be shared or cloned,
so the physical-radio confirmation remains necessary. Keep the recovery file
private and available until normal operation has been checked. Full backups and
factory restores remain separate tools. Packages requiring a programming check
must use the connected flasher rather than the offline Baofeng `.bin` builder.
Firmware packages may include plain-text attribution under supported `notices/`
paths; those entries are retained and never executed.

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

The reviewed release catalog is checked in as metadata. Only Classic r13 is
selectable for Classic; earlier Classic releases are removed from the catalog.
Firmware ZIPs are
not included. For local catalog installs, obtain a chosen public ZIP from
`https://kd8zmm.com/open25-dm32/releases/` at its catalog-relative path and verify
its catalog SHA-256, then place it under the corresponding ignored `releases/`
path. Manual ZIP selection is available. Classic/Next target names and a Next
preview screenshot are public interface/assets; no Next firmware or CPS
implementation is included.

## Tests and release verification

```sh
npm run prepare:tests
npm test
npm run verify
npm run package
```

`prepare:tests` additionally retrieves the exact public current Classic package used
by the existing installation/protocol and update-file builder tests. Its URL
and SHA-256 are pinned in `dependencies.json`; it stays ignored. PHP 8.1+ is
needed for collector tests; those tests skip when PHP is unavailable. Two
optional OEM-fixture tests skip unless `DM32_OEM_BACKUP` names a private compatible
backup outside this repository. Do not commit such a backup. Tests use synthetic
radios and local temporary logs; they do not access physical serial ports.

`verify` compares source and assets with the recorded live hashes, checks any
prepared dependency hashes and verifies the derived codec metadata. `package`
writes only the reviewed flasher payload under ignored `build/site/`, including
the locally prepared monitor. It refuses to replace an existing output; pass
`python3 tools/package.py --out <fresh-directory>` for another destination. It
includes no firmware ZIPs, homepage, CPS, v1/v2, deployment credentials or Git
database. Keep existing hosted firmware packages/catalog paths when overlaying
this payload. Packaging never uploads or deploys anything.

Codec metadata is owned by `lib/dm32-codec-profiles.mjs`. The runtime
copy under `v3/lib/` is derived. `tools/refresh_codec_profiles.py` refreshes both
from the exact RadioFoundry pin identified in that tool. An intentional update
needs refreshed release manifests and qualification; do not edit the
derived copy independently.

## Classic r9 and newer programming

Classic r9 and newer use RFKV programming with the current CPS. Older Classic
programming is not imported; recreate it in the new Classic CPS. The flasher
shows this before a listed Classic install and links to Classic CPS after a
successful install. Full-radio backup, full restore and factory recovery keep
their existing independent behavior. The flasher does not rewrite codeplug
records as part of an application update.

## Hosted diagnostics and qualification

The PHP collector targets `https://kd8zmm.com` and writes logs outside
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
under GPL. Original copyright and permission notices are retained. The root metadata
owner and tools now belong to this standalone repository.

Source code is published in
[Open25-DM32-Flasher](https://github.com/tylerwatt12/Open25-DM32-Flasher).
Source publication and this repository's commands do not deploy or change the
live site. GitHub is source-only; firmware packages continue to be hosted on
kd8zmm.com.

## Classic r10 RX-only defaults

Classic r10 and the matching Classic CPS default new/copied channels and edits
that change the actual transmit frequency outside 144–148 or 420–450 MHz to
RX-only. Turning RX-only off outside those bands requires an explicit
**Enable TX** confirmation; **Keep RX-only** is selected by default. Existing
RFKV programming is retained. The independent P25 transmit-band restriction
still applies. This is an editor default and confirmation, not a new radio
unlock or a prompt on every PTT press.

## Classic r11 P25 capability fix

Classic r11 advertises saved conventional P25 support in the firmware VERSION
response, restoring the P25 mode choice in Classic CPS after connecting. It
preserves existing RFKV programming and the r10 RX-only defaults. The catalog
retains the r11 fix in r13; previously hosted package URLs remain available.

## Classic r12 speaker playback fix

Classic r12 introduced independent 2 ms speaker FIFO servicing. The existing
codec and gain are preserved in r13.

## Classic r13 P25 transmit and cleanup fixes

The catalog offers r13 with two Classic P25 fixes: separate the native P25
guard from the upstream PCM refill timer, and finish hardware ownership release
when radio-task cleanup takes longer than 500 ms. The existing speaker playback
fix, codec/gain, RFKV programming and supported modes are preserved.

Software regression, target stack/ABI and reproducible-build checks pass. A test
build containing these fixes passed installation/startup and saved-channel
checks. Manual on-air PTT/audio qualification remains pending; the DMR-only
endurance report is not established as resolved. PL/CTCSS can still drop during
DTMF.

This update changes release metadata only. Flasher v3 runtime and both CPS
applications are unchanged; old hosted package URLs remain available.
