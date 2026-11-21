# Open25-DM32 Flasher

Source for the current [Flasher v3](https://kd8zmm.com/open25-dm32/v3/firmware.html),
supporting Open25-DM32 Classic and Next packages on supported HR_C7000 hardware.
The Classic catalog offers r14 with Flasher
`2026-11-20-flasher-v3-r14-1`. `LIVE-SNAPSHOT.json` records the reviewed runtime,
catalog and shared-asset hashes. This release includes the external r13-to-r14
programming conversion; the radio does not run a legacy-format migrator.

The tools homepage lists Flasher v3, Classic CPS and Next CPS. Use the Classic
CPS profile matched to the installed legacy or native firmware. Retired Flasher v1/v2
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

The reviewed release catalog is checked in as metadata. Only Classic r14 is
selectable for Classic; earlier hosted package URLs remain available without
returning old versions to the release picker.
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

`prepare:tests` retrieves both the current r14 catalog target and the exact public
r13 migration source. Their separate URLs and SHA-256 hashes are pinned in
`dependencies.json`; both ZIPs stay ignored. Legacy app-only/offline-export tests
retain r13 coverage; r14 tests exercise declared-schema migration and refuse an
offline export that would bypass the programming check. PHP 8.1+ is
needed for collector tests; those tests skip when PHP is unavailable. Two
optional OEM-fixture tests skip unless `DM32_OEM_BACKUP` names a private compatible
backup outside this repository. Do not commit such a backup. Tests use synthetic
radios and local temporary logs; they do not access physical serial ports.

`verify` compares source and assets with the recorded live hashes, checks any
prepared dependency hashes, verifies the derived codec metadata and checks that
every local runtime import is included in the reviewed package file list. `package`
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

Classic r9 and newer use RFKV programming with the matching CPS. Admitted native
updates preserve programming; the flasher still verifies the source image
identity. An explicitly planned schema
migration converts only declared programming regions after saving and reopening
a verified recovery ZIP; see [Programming format upgrades](#programming-format-upgrades).
Unsupported older formats require reprogramming with the matching CPS. The flasher
shows the programming requirements before a listed Classic install and links to
Classic CPS after a successful install. Full-radio backup, full restore and
factory recovery keep their existing independent behavior.

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

Ordinary app-only firmware writes preserve the bootloader/data chip and check
each written sector through the existing helper CRC response. Declared programming
conversions also write their reviewed data sectors with full sector readback.
Full restore intentionally
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
retained the r11 fix in r13; previously hosted package URLs remain available.

## Classic r12 speaker playback fix

Classic r12 introduced independent 2 ms speaker FIFO servicing. The existing
codec and gain are preserved in r13.

## Classic r13 P25 transmit and cleanup fixes

The r13 catalog release included two Classic P25 fixes: separate the native P25
guard from the upstream PCM refill timer, and finish hardware ownership release
when radio-task cleanup takes longer than 500 ms. The existing speaker playback
fix, codec/gain, RFKV programming and supported modes are preserved.

Software regression, target stack/ABI and reproducible-build checks pass. A test
build containing these fixes passed installation/startup and saved-channel
checks. Manual on-air PTT/audio qualification remains pending; the DMR-only
endurance report is not established as resolved. PL/CTCSS can still drop during
DTMF.

That r13 release changed metadata only. Its hosted package URL remains available
as the pinned migration source for r14.

## Classic r14 upstream refresh and upgrade paths

The r14 application is built from the reviewed Classic source based on current
RadioFoundry upstream. It supports FM, DMR, conventional P25 and NXDN, retains the
reserved codec layout, and identifies Classic with its own Open25 boot emblem
and persistent home banner. The picker preview comes from the native Classic
home renderer. It applies our band policy: extended reception is always
enabled; FM/DMR/NXDN transmit within 136–174 and 400–480 MHz; P25 transmission uses
the narrower documented service/amateur ranges. Use the matched Classic CPS for
r14. A native r14 CPS backup and an older r13 explicit-talkgroup backup are not
interchangeable; do not write an old backup over migrated programming.

Direct admitted paths are the exact published r13 application, the exact selected
r14 application already installed, and genuinely erased programming. The known
r13 source is 315648 bytes with SHA-256
`fc2ccc27576e5d002bc51ecf547bc81960fc329b51f511dcf547f4ed9dd53347`.
The source application and FF padding are checked together. Nonblank programming
from an unknown OEM, older Classic, other native or privately modified image is
refused before writes. The r14 listing is not a universal first-install or
any-version upgrade claim. Earlier releases remain at their original URLs; the
[published r13 ZIP](https://kd8zmm.com/open25-dm32/releases/classic/standard/Open25-DM32-Classic-0.1.0-rc1-r13-p25-tx-cleanup-application.zip)
is the available intermediate firmware for an admitted r13-to-r14 update. Check
compatibility before using an older firmware as an intermediate; this release
does not add converters for unsupported older codeplugs.

The r13 conversion changes only the required contact, channel and RFKV sectors.
It preserves supported talkgroups, IDs, NACs and opaque/settings records, or
refuses the update if that cannot be done losslessly. The Install screen presents
the plan before the browser asks where to save a new recovery ZIP. Cancellation,
an existing nonempty destination, a failed save or a failed reopen leaves flash
unwritten. This required scoped recovery file is distinct from the optional
complete-radio backup and the CPS codeplug file. File access is requested within
the Install click; no recovery file is uploaded or automatically restored later.

Regression and cross-language format checks cover damaged/unsupported records,
contact exhaustion, lossless chain capacity, interruption and repeated recovery.
On one physical radio, the unchanged production Installer/Monitor converted one
prepared synthetic r13 channel, recovered its original r13 state, restored all
affected original user-data sectors and installed exact r14 with boot/codec/
calibration retained. This is bounded migration/recovery qualification, not a
physical power-cut test or proof that every user's r13 codeplug will fit. The
synthetic programming never booted. Recovery identity uses non-unique
fingerprints plus explicit same-physical-radio confirmation. Long-term endurance
and physical microphone loudness parity are not established by these checks.
