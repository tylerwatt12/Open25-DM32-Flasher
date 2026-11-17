# Open25-DM32 Flasher source

This repository owns Flasher v3 source, its current release catalog metadata,
standalone tools and tests. Keep firmware ZIPs, RAM-helper binaries, radio
backups, keys, captures, private configuration and Next firmware/CPS
implementation out of Git. Preserve GPL and MIT notices and asset provenance.
lib/dm32-codec-profiles.mjs owns metadata; refresh its derived v3 copy with
tools/refresh_codec_profiles.py from the exact reviewed upstream pin.

LIVE-SNAPSHOT.json pins the reviewed release payload. Update it deliberately
with each reviewed release; never auto-approve files merely because tracked.
The former web-installer copy under the private Next worktree is derived and
must be refreshed and hash-checked from this owner when needed, never edited
as an independent source of truth.

Classic r9 uses RFKV programming only. Do not restore old Classic codeplug
compatibility or earlier selectable Classic catalog releases. Full-radio
backup/restore and factory recovery remain separate generic flasher operations.
Local preparation and tests never authorize opening a radio. Pushes, releases
and site deployment require an explicit user request; existing session
authorization takes precedence over the default local publication block.
