import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ClaudeSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderRateLimits,
} from "@ryco/contracts";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";

import type { ClaudeCredentialStore } from "./ClaudeUsage.ts";
import { refreshClaudeProviderUsage } from "./ClaudeProvider.ts";

const settings = Schema.decodeSync(ClaudeSettings)({});
const FRESH_USAGE: ServerProviderRateLimits = {
  limitId: "claude-oauth",
  primary: { usedPercent: 12, windowDurationMins: 300 },
};

const loginSnapshot: ServerProvider = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  version: "2.1.296",
  status: "ready",
  auth: { status: "authenticated", type: "max", label: "Claude Max Subscription" },
  checkedAt: "2026-10-01T00:00:00.000Z",
  models: [],
  slashCommands: [{ name: "review" }],
  skills: [],
  rateLimits: { limitId: "claude-oauth", primary: { usedPercent: 90 } },
};

function refresh(snapshot: ServerProvider, environment: NodeJS.ProcessEnv) {
  const reads: Array<{ readonly store: ClaudeCredentialStore; readonly version: string | null }> =
    [];
  const resolveRateLimits = (store: ClaudeCredentialStore, version: string | null) =>
    Effect.sync(() => {
      reads.push({ store, version });
      return FRESH_USAGE;
    });
  return Effect.runPromise(
    refreshClaudeProviderUsage(settings, snapshot, environment, resolveRateLimits).pipe(
      Effect.provide(NodeServices.layer),
    ),
  ).then((result) => ({ result, reads }));
}

describe("refreshClaudeProviderUsage", () => {
  it("re-reads only the usage of a snapshot that runs on its claude.ai login", async () => {
    const { result, reads } = await refresh(loginSnapshot, {});

    expect(reads).toHaveLength(1);
    expect(reads[0]?.version).toBe("2.1.296");
    expect(reads[0]?.store.credentialsPath).toMatch(/\.credentials\.json$/);
    expect(result).toEqual({ ...loginSnapshot, rateLimits: FRESH_USAGE });
  });

  it("never reads a login's usage for an instance routed through a proxy", async () => {
    // CLIProxyAPI-style routing: the local login's usage would describe another account.
    const { result, reads } = await refresh(loginSnapshot, {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:8317",
      ANTHROPIC_AUTH_TOKEN: "proxy-token",
    });

    expect(reads).toHaveLength(0);
    expect(result.rateLimits).toBeUndefined();
    expect(result.slashCommands).toEqual(loginSnapshot.slashCommands);
  });

  it("never starts reading a login's usage for a snapshot probed without limits", async () => {
    // The probe attaches limits only when Claude Code reported its claude.ai login; a snapshot
    // without them ran on another token source, so the local login is not this instance's.
    const { rateLimits: _probedLimits, ...withoutLimits } = loginSnapshot;
    const { result, reads } = await refresh(withoutLimits, {});

    expect(reads).toHaveLength(0);
    expect(result).toEqual(withoutLimits);
  });

  it("drops stale limits when the snapshot has no subscription login", async () => {
    const { result, reads } = await refresh(
      { ...loginSnapshot, auth: { status: "authenticated", type: "apiKey" } },
      {},
    );

    expect(reads).toHaveLength(0);
    expect(result.rateLimits).toBeUndefined();
  });
});
