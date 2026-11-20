// SPDX-License-Identifier: GPL-3.0-or-later
// Reviewed source images, identified by complete application content and erased
// application padding. Release labels and files supplied as migration scripts
// cannot authorize a programming transition.
import { assert, sha256 } from './bytes.mjs';
import { CLASSIC_R13_SCHEMA, NATIVE_SCHEMA } from './programming.mjs';
export const PROGRAMMING_SOURCES = Object.freeze([
  Object.freeze({ schema: CLASSIC_R13_SCHEMA, applicationBytes: 315648,
    applicationSha256: 'fc2ccc27576e5d002bc51ecf547bc81960fc329b51f511dcf547f4ed9dd53347' }),
]);
export async function identifyProgrammingSource({ application, targetManifest, sources = PROGRAMMING_SOURCES }) {
  assert(application instanceof Uint8Array, 'A complete application-slot snapshot is required.');
  const candidates = [...sources];
  if (targetManifest?.programming?.schema === NATIVE_SCHEMA)
    candidates.push({ schema: NATIVE_SCHEMA, applicationBytes: targetManifest.applicationBytes,
      applicationSha256: targetManifest.applicationSha256 });
  for (const identity of candidates) {
    const { applicationBytes: length, applicationSha256 } = identity;
    if (!Number.isSafeInteger(length) || length < 1 || length > application.length ||
      !application.subarray(length).every(byte => byte === 255)) continue;
    if (await sha256(application.subarray(0, length)) === applicationSha256)
      return { schema: identity.schema, applicationBytes: length, applicationSha256 };
  }
  return null;
}
