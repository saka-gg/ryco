import { describe, expect, it } from "vitest";

import packageJson from "../../package.json" with { type: "json" };
import { RYCO_CODEX_CLIENT_NAME } from "./codexClientName.ts";
import { buildCodexInitializeParams } from "./codexInitializeParams.ts";

describe("buildCodexInitializeParams", () => {
  it("identifies Ryco as the originator and opts into the experimental API", () => {
    expect(buildCodexInitializeParams()).toEqual({
      clientInfo: {
        name: RYCO_CODEX_CLIENT_NAME,
        title: "Ryco Desktop",
        version: packageJson.version,
      },
      capabilities: { experimentalApi: true },
    });
    expect(buildCodexInitializeParams().clientInfo.name).toBe("ryco_desktop");
  });
});
