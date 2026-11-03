import * as FS from "node:fs";
import * as Path from "node:path";

import {
  parseRycoDesktopFlavor,
  RYCO_DESKTOP_FLAVOR_METADATA_KEY,
  type RycoDesktopFlavor,
} from "@ryco/shared/desktopFlavor";

/**
 * Which app this is, Ryco or Ryco Nightly, from the field the build wrote into
 * the packaged `package.json`. The value is part of the signed bundle, so no
 * environment variable can turn one app into the other. Unpackaged (development) builds and
 * builds from before the split read as stable. Light enough for the launch entry:
 * `node:fs` and `node:path` only.
 */
export function readDesktopFlavor(input: {
  readonly appPath: string;
  /** Only a packaged app has a flavor; no environment variable (not even a dev server URL) changes it. */
  readonly isPackaged: boolean;
  readonly readFile?: (path: string) => string;
}): RycoDesktopFlavor {
  if (!input.isPackaged) return "stable";
  try {
    const packageJson: unknown = JSON.parse(
      (input.readFile ?? ((path) => FS.readFileSync(path, "utf8")))(
        Path.join(input.appPath, "package.json"),
      ),
    );
    return parseRycoDesktopFlavor(
      typeof packageJson === "object" && packageJson !== null
        ? (packageJson as Record<string, unknown>)[RYCO_DESKTOP_FLAVOR_METADATA_KEY]
        : undefined,
    );
  } catch {
    return "stable";
  }
}
