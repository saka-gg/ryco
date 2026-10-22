// At the repo root, not in a workspace, so that `--affected` runs every suite
// it configures (see turbo.json globalDependencies).

/** Machine-readable reports in CI; local runs retain the normal compact output. */
export function ciTestReporting() {
  if (!process.env.CI) return {};
  const reporters: Array<"default" | "json" | "junit"> = ["default", "json", "junit"];
  return {
    reporters,
    outputFile: {
      json: "test-results/results.json",
      junit: "test-results/junit.xml",
    },
  };
}
