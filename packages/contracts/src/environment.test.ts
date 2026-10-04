import { describe, expect, it } from "vite-plus/test";
import { Schema } from "effect";

import { ExecutionEnvironmentDescriptor } from "./environment.ts";

const decodeDescriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);

function descriptor(capabilities: Record<string, unknown>) {
  return {
    environmentId: "environment-1",
    label: "Local",
    platform: {
      os: "darwin",
      arch: "arm64",
    },
    serverVersion: "0.1.8",
    capabilities,
  };
}

describe("ExecutionEnvironmentCapabilities.threadSettlement", () => {
  it("decodes missing support as false for older servers", () => {
    expect(decodeDescriptor(descriptor({ repositoryIdentity: true })).capabilities).toEqual({
      repositoryIdentity: true,
      threadSettlement: false,
      threadPriorityRanking: false,
    });
  });

  it("preserves advertised settlement support", () => {
    expect(
      decodeDescriptor(descriptor({ repositoryIdentity: true, threadSettlement: true }))
        .capabilities.threadSettlement,
    ).toBe(true);
  });

  it("decodes missing ranking support as false and preserves explicit support", () => {
    expect(decodeDescriptor(descriptor({})).capabilities.threadPriorityRanking).toBe(false);
    expect(
      decodeDescriptor(descriptor({ threadPriorityRanking: true })).capabilities
        .threadPriorityRanking,
    ).toBe(true);
  });
});

describe("ExecutionEnvironmentCapabilities.fileAttachments", () => {
  it("stays absent for older servers and decodes when advertised", () => {
    const absent = decodeDescriptor(descriptor({})).capabilities;
    expect("fileAttachments" in absent).toBe(false);

    const advertised = decodeDescriptor(
      descriptor({ fileAttachments: { maxUploadBytes: 50 * 1024 * 1024 } }),
    ).capabilities;
    expect(advertised.fileAttachments).toEqual({ maxUploadBytes: 50 * 1024 * 1024 });
  });

  it("rejects a malformed capability payload", () => {
    expect(() =>
      decodeDescriptor(descriptor({ fileAttachments: { maxUploadBytes: -1 } })),
    ).toThrow();
  });
});

describe("ExecutionEnvironmentCapabilities.worktreeSubmoduleSettings", () => {
  it("does not infer support from older nodes or schema defaults", () => {
    expect(decodeDescriptor(descriptor({})).capabilities.worktreeSubmoduleSettings).toBeUndefined();
    expect(
      decodeDescriptor(descriptor({ worktreeSubmoduleSettings: false })).capabilities
        .worktreeSubmoduleSettings,
    ).toBe(false);
    expect(
      decodeDescriptor(descriptor({ worktreeSubmoduleSettings: true })).capabilities
        .worktreeSubmoduleSettings,
    ).toBe(true);
    expect(() => decodeDescriptor(descriptor({ worktreeSubmoduleSettings: "true" }))).toThrow();
  });
});

it("requires explicit required-worktree bootstrap support from the node", () => {
  expect(decodeDescriptor(descriptor({})).capabilities.requiredWorktreeBootstrap).toBeUndefined();
  expect(
    decodeDescriptor(descriptor({ requiredWorktreeBootstrap: true })).capabilities
      .requiredWorktreeBootstrap,
  ).toBe(true);
});

describe("ExecutionEnvironmentCapabilities.usageLimitRecovery", () => {
  it("stays absent for older servers and decodes when advertised", () => {
    expect(decodeDescriptor(descriptor({})).capabilities.usageLimitRecovery).toBeUndefined();
    expect(
      decodeDescriptor(descriptor({ usageLimitRecovery: true })).capabilities.usageLimitRecovery,
    ).toBe(true);
  });
});
