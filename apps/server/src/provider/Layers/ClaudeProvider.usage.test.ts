import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ClaudeSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderRateLimits,
} from "@ryco/contracts";
import { Duration, Effect, Layer, Schema } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";

import { makeUsageReadGate } from "../usageReadGate.ts";
import { type ClaudeCredentialStore, planClaudeUsageRead } from "./ClaudeUsage.ts";
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

describe("refreshClaudeProviderUsage behind a usage read gate", () => {
  it("keeps the last good limits through a throttled read and reads again after it", async () => {
    // A separate HOME with its own credential file: no Keychain item and no real login is read.
    const home = await mkdtemp(NodePath.join(NodeOS.tmpdir(), "ryco-claude-refresh-"));
    const startMs = Date.parse("2026-10-28T12:00:00.000Z");
    try {
      await mkdir(NodePath.join(home, ".claude"));
      await writeFile(
        NodePath.join(home, ".claude", ".credentials.json"),
        JSON.stringify({
          claudeAiOauth: {
            accessToken: "mock-access",
            refreshToken: "mock-refresh",
            expiresAt: startMs + 86_400_000,
          },
        }),
      );
      const responses: Array<() => Response> = [];
      let requests = 0;
      const fetchImpl = (async () => {
        requests += 1;
        const response = responses.shift();
        if (!response) throw new Error("Unexpected usage request.");
        return response();
      }) as unknown as typeof globalThis.fetch;
      const usage = (utilization: number) => () =>
        Response.json({ five_hour: { utilization }, seven_day: { utilization: 20 } });

      const result = await Effect.gen(function* () {
        yield* TestClock.setTime(startMs);
        const gate = yield* makeUsageReadGate();
        const resolveRateLimits = (store: ClaudeCredentialStore, version: string | null) =>
          gate.read(planClaudeUsageRead(store, version, fetchImpl));
        const refreshOnce = (snapshot: ServerProvider) =>
          refreshClaudeProviderUsage(settings, snapshot, { HOME: home }, resolveRateLimits);

        responses.push(usage(30));
        const fresh = yield* refreshOnce(loginSnapshot);

        yield* TestClock.adjust(Duration.minutes(5));
        responses.push(() => new Response("", { status: 429, headers: { "Retry-After": "120" } }));
        const throttled = yield* refreshOnce(fresh);

        yield* TestClock.adjust(Duration.minutes(1));
        const duringCooldown = yield* refreshOnce(throttled);
        const requestsDuringCooldown = requests;

        yield* TestClock.adjust(Duration.minutes(1));
        responses.push(usage(35));
        const afterCooldown = yield* refreshOnce(duringCooldown);
        return { fresh, throttled, duringCooldown, requestsDuringCooldown, afterCooldown };
      }).pipe(
        Effect.provide(Layer.merge(NodeServices.layer, TestClock.layer())),
        Effect.runPromise,
      );

      expect(result.fresh.rateLimits?.primary?.usedPercent).toBe(30);
      expect(result.fresh.rateLimits?.observedAt).toBe("2026-10-28T12:00:00.000Z");
      // The throttled read keeps the snapshot's limits, dated by the read that produced them.
      expect(result.throttled.rateLimits).toEqual({
        ...result.fresh.rateLimits,
        stale: true,
        staleReason: "rateLimited",
      });
      expect(result.duringCooldown.rateLimits).toEqual(result.throttled.rateLimits);
      expect(result.requestsDuringCooldown).toBe(2);
      expect(requests).toBe(3);
      expect(result.afterCooldown.rateLimits?.primary?.usedPercent).toBe(35);
      expect(result.afterCooldown.rateLimits?.observedAt).toBe("2026-10-28T12:07:00.000Z");
      expect(result.afterCooldown.rateLimits?.stale).toBeUndefined();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
