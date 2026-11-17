# Flasher v3

This directory contains the coordinated Classic r9 Flasher v3 runtime. See the
[root README](../README.md) for standalone setup, testing, dependencies,
licensing, diagnostics and release scope. Run `npm start` from either this
directory or the repository root; open `/v3/firmware.html` on port 8326.

The original notices in THIRD_PARTY.md are retained. Ownership refers to this
repository: `lib/dm32-codec-profiles.mjs` owns codec
metadata, and `tools/refresh_codec_profiles.py` refreshes the derived v3 copy.
The RAM helper is obtained by the standalone `tools/prepare.py`.
