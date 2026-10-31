import { DEFAULT_SERVER_SETTINGS, type ServerConfig } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { automaticUpdatesView } from "./AutomaticUpdatesSettings.logic";

function config(input: {
  readonly capability?: boolean;
  readonly automaticUpdates?: boolean;
  readonly enableProviderUpdateChecks?: boolean;
}): ServerConfig {
  return {
    environment: {
      capabilities: input.capability === undefined ? {} : { automaticUpdates: input.capability },
    },
    settings: {
      ...DEFAULT_SERVER_SETTINGS,
      automaticUpdates: input.automaticUpdates ?? false,
      enableProviderUpdateChecks: input.enableProviderUpdateChecks ?? true,
    },
  } as unknown as ServerConfig;
}

describe("automaticUpdatesView", () => {
  it("shows the node's setting to its owner", () => {
    expect(automaticUpdatesView({ config: config({ capability: true }), owner: true })).toBe("off");
    expect(
      automaticUpdatesView({
        config: config({ capability: true, automaticUpdates: true }),
        owner: true,
      }),
    ).toBe("on");
  });

  it("never offers it to a session that does not own the node", () => {
    expect(
      automaticUpdatesView({
        config: config({ capability: true, automaticUpdates: true }),
        owner: false,
      }),
    ).toBe("hidden");
  });

  it("hides it on nodes too old to update unattended, or not known yet", () => {
    expect(automaticUpdatesView({ config: config({}), owner: true })).toBe("hidden");
    expect(automaticUpdatesView({ config: null, owner: true })).toBe("hidden");
  });

  it("is unavailable while provider update checks are off", () => {
    expect(
      automaticUpdatesView({
        config: config({
          capability: true,
          automaticUpdates: true,
          enableProviderUpdateChecks: false,
        }),
        owner: true,
      }),
    ).toBe("checks-off");
  });
});
