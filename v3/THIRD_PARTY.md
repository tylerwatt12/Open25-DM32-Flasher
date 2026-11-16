# Third-party provenance

Flasher v3 carries forward v2's serial, ROM handshake and read recovery, adapted from
RadioFoundry's MIT browser `site/static/js/flasher/link.js` and `stub.js`,
commit `88283f6ce3aab4c5ff5c9995600de2acfa2c6f7b`.
Copyright (c) 2026 The RadioFoundry Authors. The permission notice below applies.
The RAM-helper binary and codec policy retain the original pins described below.

Web-installer source retains its GPL-3.0-or-later file notices. RadioFoundry's
MIT portions retain their original notices and the permission text below.

The monitor protocol implementation is adapted from RadioFoundry's MIT
`stub/stubtool.py`, commit `dfbaf20c400c73e2ccf6edb80af7d1d255bee418`.
Copyright (c) 2026 The RadioFoundry Authors.

DM32 codec-slot validation and first-install OEM codec preparation are adapted
from the same pin's MIT `tools/hrc7000_codec.py`, codec metadata and
`platform/hrc7000/codec_slot.h`. Only layout metadata, hashes and packing logic
are included; proprietary codec bytes come from the user's connected radio or
a compatible stock firmware file supplied locally by that user.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

The parent directory's `npm run prepare` extracts the existing hash-pinned universal RAM monitor into
ignored local assets. Its SHA-256 is
`eae5b98615d67ba465061c84a5fb209a902333dc700671ce4ca69a05eb4aaee9`.
The browser checks this hash before any RAM download. The monitor includes
device-side write operations; its source is absent from the pinned upstream
tree. Do not describe it as a source-audited, device-side read-only monitor.

No stock firmware, proprietary codec, radio dump, calibration values, contacts,
keys, or existing backup is included in tracked app assets. Demo flash contents
are generated mathematically. ZIP and checksums use local source with no CDN
or runtime dependency.

DM32 codec profiles, content-based discovery and the table memory window are
adapted from RadioFoundry MIT `tools/hrc7000_codec.py`, DM32 codec maps and
`boards/dm32/memory.ld` at `88283f6ce3aab4c5ff5c9995600de2acfa2c6f7b`.
The parent `tools/refresh_codec_profiles.py` owns the v1/v2 metadata refresh.
V3's frozen metadata copy is refreshed from the parent `lib/dm32-codec-profiles.mjs`
and checked for equality by `tests/publication.test.mjs`; it is not edited independently.
No codec bytes are included. Firmware packages own their
verified table limit; ZIPs without `codecTablesEnd` use the legacy limit.

The guide screenshots `assets/baofeng-com-settings.png`,
`assets/baofeng-upgrade-file.png` and `assets/baofeng-communication-failed.png`,
and the desktop shortcut image `assets/baofeng-cps-icon.png`, were supplied
by the user from Baofeng CPS.
They are used unchanged; the shortcut icon is displayed on the guide's CPS
download button. The updater screenshot shows an OEM firmware path;
the guide directs users to select the generated Open25 update file instead.
Baofeng firmware and CPS downloads link to Baofeng's external server; neither
binary is hosted in this app.

The compatibility popup uses unmodified browser icons from their official
vendor sites: [Google Chrome](https://www.google.com/chrome/static/images/chrome-logo-m100.svg),
[Microsoft Edge](https://edgecdn-embza6g8cacagcbn.z01.azurefd.net/welcome/static/favicon.png),
[Mozilla Firefox](https://www.firefox.com/media/img/favicons/firefox/browser/favicon-196x196.59e3822720be.png),
and [Apple Safari](https://www.apple.com/v/safari/u/images/overview/privacy_icon_safari__gdqq6axl0d6y_large_2x.png).
These product icons and trademarks remain their respective owners' property
and are not relicensed under the app's GPL license. Microsoft Edge is a
trademark of the Microsoft group of companies. Compatibility checks/crosses
are separate from the unchanged icon artwork. The Device Manager example
`assets/device-manager-ch340.png` was supplied by the user and is used unchanged.
The compact Mac USB example is native HTML text based on the user's System
Information screenshot. It retains the adapter name, manufacturer and vendor/
product IDs; the personal computer name, location and unrelated fields are
omitted. It is an illustrative example, not a live USB query or command output.
