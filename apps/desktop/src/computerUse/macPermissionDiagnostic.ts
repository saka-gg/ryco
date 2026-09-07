import { execFile } from "node:child_process";
import { promisify } from "node:util";

const verifySignature = async (path: string): Promise<void> => {
  await promisify(execFile)(
    "/usr/bin/codesign",
    ["--verify", "--all-architectures", "--strict", path],
    {
      timeout: 5000,
      maxBuffer: 64 * 1024,
    },
  );
};

/** Verify only code identity, without reading TCC databases or requesting permissions.
 * Cached for this app process so focusing settings cannot repeatedly scan a large bundle. */
export function createMacPermissionDiagnostic(
  appPath: string,
  helperPath: string,
  verify: (path: string) => Promise<void> = verifySignature,
): () => Promise<string | null> {
  let pending: Promise<string | null> | undefined;
  return () =>
    (pending ??= (async () => {
      const results = await Promise.allSettled([verify(appPath), verify(helperPath)]);
      const invalid = results.some(
        (result) =>
          result.status === "rejected" &&
          typeof result.reason?.code === "number" &&
          !result.reason?.killed,
      );
      return invalid
        ? "This Ryco build has an invalid macOS code signature. A permission shown for Ryco may not apply to its native helper. Install a correctly signed build, then grant permissions to that build. Restarting this build alone will not repair its signature."
        : null;
    })());
}
