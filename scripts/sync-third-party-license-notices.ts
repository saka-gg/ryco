// @effect-diagnostics nodeBuiltinImport:off - A build-time filesystem script.
/**
 * Downloads the SPDX license templates `third-party-licenses.config.json` names but
 * `third-party-licenses/spdx/` does not hold yet. Builds never fetch them; commit what this adds.
 *
 *   node scripts/sync-third-party-license-notices.ts
 */
import * as NodePath from "node:path";

import { syncThirdPartyLicenseNotices } from "./lib/third-party-licenses.ts";

await syncThirdPartyLicenseNotices(
  NodePath.resolve(import.meta.dirname, "..", "third-party-licenses.config.json"),
);
