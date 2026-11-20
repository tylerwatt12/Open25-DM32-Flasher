# Flasher v3

This directory contains the Flasher v3 runtime source. See the
[root README](../README.md) for standalone setup, testing, dependencies,
licensing, diagnostics and release scope. Run `npm start` from either this
directory or the repository root; open `/v3/firmware.html` on port 8326.

The public [Flasher v3](https://kd8zmm.com/open25-dm32/v3/firmware.html) is the
only flasher listed on the tools homepage. Former v1/v2 entry URLs redirect to
v3. Classic CPS supports Open25-DM32 Classic firmware R9 and newer.

The original notices in THIRD_PARTY.md are retained. Ownership refers to this
repository: `lib/dm32-codec-profiles.mjs` owns codec
metadata, and `tools/refresh_codec_profiles.py` refreshes the derived v3 copy.
The RAM helper is obtained by the standalone `tools/prepare.py`.
