import {
  decodeThirdPartyLicenseManifest,
  type ThirdPartyLicenseManifest,
} from "@ryco/shared/thirdPartyLicenses";
import { inflateSync, strFromU8 } from "fflate";

import { decodeBase64Bytes } from "../../lib/base64";

/**
 * The generated module holds the manifest JSON raw-deflated and base64-encoded
 * (`scripts/generate-third-party-licenses.mts`), which keeps ~480 KB of notice
 * text to ~55 KB of bundle.
 */
export function unpackMobileThirdPartyLicenses(packed: unknown): ThirdPartyLicenseManifest {
  const deflated = (packed as { readonly deflateRawBase64?: unknown } | null)?.deflateRawBase64;
  if (typeof deflated !== "string") throw new Error("The license manifest is not packed.");
  return decodeThirdPartyLicenseManifest(
    JSON.parse(strFromU8(inflateSync(decodeBase64Bytes(deflated)))),
  );
}

let cached: ThirdPartyLicenseManifest | null | undefined;

/**
 * The app's open source license manifest, or null when this build has none. The generated module
 * (the packed notice text) is required here, on the first license screen, never at
 * startup, and decoded once.
 */
export function loadMobileThirdPartyLicenses(): ThirdPartyLicenseManifest | null {
  if (cached !== undefined) return cached;
  try {
    cached = unpackMobileThirdPartyLicenses(require("@ryco/mobile-third-party-licenses"));
  } catch {
    cached = null;
  }
  return cached;
}
