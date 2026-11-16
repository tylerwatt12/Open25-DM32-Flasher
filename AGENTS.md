# Open25-DM32 Flasher source

This repository stages the extracted live Flasher v3 initial source release. Runtime bytes
match LIVE-SNAPSHOT.json; preserve that initial release. Keep firmware ZIPs,
RAM-helper binaries, radio backups, keys, captures, private configuration and
Next firmware/CPS implementation out of Git. Preserve GPL and MIT notices and
asset provenance. lib/dm32-codec-profiles.mjs owns metadata; refresh the v3 copy
with tools/refresh_codec_profiles.py from its exact public source pin.
Local preparation and tests never authorize opening a radio. No push, release,
site deployment or remote mutation without an explicit user request.
Until a coordinated source-owner cutover, refresh this staging snapshot only
from a reviewed live deployment and its existing development owner. Do not
independently evolve it into a second development source of truth.
