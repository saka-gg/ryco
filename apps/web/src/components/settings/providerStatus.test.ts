import { describe, expect, it } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderCompatibilityAdvisory,
  type ServerProviderVersionAdvisory,
} from "@ryco/contracts";

import {
  getProviderCompatibilityNotice,
  getProviderVersionAdvisoryPresentation,
} from "./providerStatus";

const checkedAt = "2026-10-04T00:00:00.000Z";

const behindLatest: ServerProviderVersionAdvisory = {
  status: "behind_latest",
  currentVersion: "0.199.0",
  latestVersion: "0.200.1",
  updateCommand: "npm install -g @openai/codex@latest",
  canUpdate: true,
  checkedAt,
  message: null,
};

function provider(overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: "0.199.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

describe("getProviderVersionAdvisoryPresentation", () => {
  it("hides the update offer when the latest version is rated broken", () => {
    expect(
      getProviderVersionAdvisoryPresentation(behindLatest, {
        status: "supported",
        latestVersionStatus: "broken",
        message: null,
      }),
    ).toBeNull();
  });

  it("is unchanged for a supported latest version or without a compatibility advisory", () => {
    const supported = getProviderVersionAdvisoryPresentation(behindLatest, {
      status: "supported",
      latestVersionStatus: "supported",
      message: null,
    });
    const withoutAdvisory = getProviderVersionAdvisoryPresentation(behindLatest);

    expect(withoutAdvisory).toEqual({
      detail: "Update available: install v0.200.1.",
      updateCommand: "npm install -g @openai/codex@latest",
      emphasis: "normal",
    });
    expect(supported).toEqual(withoutAdvisory);
  });
});

describe("getProviderCompatibilityNotice", () => {
  const advisory = (
    value: ServerProviderCompatibilityAdvisory,
  ): Pick<ServerProvider, "compatibilityAdvisory"> => ({ compatibilityAdvisory: value });

  it("stays silent without a provider or an advisory", () => {
    expect(getProviderCompatibilityNotice(undefined)).toBeNull();
    expect(getProviderCompatibilityNotice(provider())).toBeNull();
  });

  it("does not repeat a gate message the error summary already shows", () => {
    expect(
      getProviderCompatibilityNotice(
        provider({
          status: "error",
          ...advisory({ status: "unsupported", message: "Ryco works with OpenCode 1.x." }),
        }),
      ),
    ).toBeNull();
  });

  it("stays silent for a disabled provider", () => {
    expect(
      getProviderCompatibilityNotice(
        provider({
          enabled: false,
          ...advisory({ status: "broken", message: "Known to break Ryco." }),
        }),
      ),
    ).toBeNull();
  });

  it("warns about an installed version rated unsupported", () => {
    expect(
      getProviderCompatibilityNotice(
        provider(advisory({ status: "unsupported", message: "Outside the supported range." })),
      ),
    ).toEqual({ tone: "warning", text: "Outside the supported range." });
  });

  it("mutes a graceful rating", () => {
    expect(
      getProviderCompatibilityNotice(
        provider(advisory({ status: "graceful", message: "Limited compatibility." })),
      ),
    ).toEqual({ tone: "muted", text: "Limited compatibility." });
  });

  it("explains a blocked latest version only while the provider is behind latest", () => {
    const blockedLatest = advisory({
      status: "supported",
      latestVersionStatus: "broken",
      message: null,
    });

    expect(
      getProviderCompatibilityNotice(provider({ versionAdvisory: behindLatest, ...blockedLatest })),
    ).toEqual({
      tone: "muted",
      text: "v0.200.1 is available, but it is not compatible with this Ryco release, so Ryco won't offer it.",
    });
    expect(
      getProviderCompatibilityNotice(
        provider({
          versionAdvisory: { ...behindLatest, status: "current" },
          ...blockedLatest,
        }),
      ),
    ).toBeNull();
  });
});
