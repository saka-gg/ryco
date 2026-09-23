/** Read-only source overlay for the SQLite fixture. No checkout/worktree is created.
 * Use Node --import with RYCO_SQLITE_FIXTURE_REF set to a local commit. Only server
 * src modules come from that commit; the fixture, runtime and dependencies stay fixed.
 */
import { execFileSync } from "node:child_process";
import { registerHooks } from "node:module";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";

const requested = process.env.RYCO_SQLITE_FIXTURE_REF;
if (requested) {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const ref = execFileSync("git", ["rev-parse", "--verify", `${requested}^{commit}`], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  registerHooks({
    load(url, context, nextLoad) {
      const path = url.startsWith("file:") ? relative(root, fileURLToPath(url)) : "";
      if (!path.startsWith("apps/server/src/") || !path.endsWith(".ts"))
        return nextLoad(url, context);
      return {
        format: "module-typescript",
        source: execFileSync("git", ["show", `${ref}:${path}`], {
          cwd: root,
          encoding: "utf8",
          maxBuffer: 8 * 1024 * 1024,
        }),
        shortCircuit: true,
      };
    },
  });
}
