import type { ServerConfig } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { selectNodeRecordsThreadBranch } from "./threadBranchAdoption.ts";

const configWith = (capabilities: Record<string, unknown>) =>
  ({ environment: { capabilities } }) as unknown as ServerConfig;

describe("selectNodeRecordsThreadBranch", () => {
  it("leaves the branch to the node only where it advertises recording it", () => {
    expect(selectNodeRecordsThreadBranch(configWith({ threadBranchAdoption: true }))).toBe(true);
    expect(selectNodeRecordsThreadBranch(configWith({ threadBranchAdoption: false }))).toBe(false);
    expect(selectNodeRecordsThreadBranch(configWith({}))).toBe(false);
  });

  it("treats a config that has not arrived as an older node", () => {
    expect(selectNodeRecordsThreadBranch(null)).toBe(false);
    expect(selectNodeRecordsThreadBranch(undefined)).toBe(false);
  });
});
