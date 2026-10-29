import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { Duration, Effect } from "effect";
import { TestClock } from "effect/testing";
import { afterEach, describe, it } from "vite-plus/test";

import { makeUsageReadGate } from "../usageReadGate.ts";
import {
  parseOpenCodeGoUsageRateLimits,
  planOpenCodeGoUsageRead,
  resolveOpenCodeDataDirPath,
} from "./OpenCodeGoUsage.ts";

// One usage read through a fresh gate, so no earlier read is re-served.
const readOnce = (environment: NodeJS.ProcessEnv, fetchImpl: typeof globalThis.fetch) =>
  Effect.flatMap(makeUsageReadGate(), (gate) =>
    gate.read(planOpenCodeGoUsageRead(environment, fetchImpl)),
  );

const SAMPLE_USAGE_RESPONSE = {
  usage: {
    rolling: { status: "ok", percent: 0, resetsAt: "2026-09-05T15:23:42.082Z" },
    weekly: { status: "ok", percent: 11, resetsAt: "2026-09-07T00:00:00.082Z" },
    monthly: { status: "ok", percent: 11, resetsAt: "2026-09-30T19:14:54.082Z" },
  },
};

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("resolveOpenCodeDataDirPath", () => {
  it("prefers XDG_DATA_HOME when set", () => {
    assert.equal(
      resolveOpenCodeDataDirPath({ XDG_DATA_HOME: "/data", HOME: "/home/u" }),
      NodePath.join("/data", "opencode"),
    );
  });

  it("falls back to ~/.local/share/opencode", () => {
    assert.equal(
      resolveOpenCodeDataDirPath({ HOME: "/home/u" }),
      NodePath.join("/home/u", ".local", "share", "opencode"),
    );
  });
});

const READ_AT_MS = Date.parse("2026-09-05T12:00:00.000Z");

describe("parseOpenCodeGoUsageRateLimits", () => {
  it("maps rolling, weekly, and monthly windows onto the contract", () => {
    assert.deepEqual(parseOpenCodeGoUsageRateLimits(SAMPLE_USAGE_RESPONSE, READ_AT_MS), {
      limitId: "opencode-go",
      limitName: "OpenCode Go",
      planType: "go",
      primary: {
        usedPercent: 0,
        windowDurationMins: 300,
        resetsAt: Math.floor(Date.parse("2026-09-05T15:23:42.082Z") / 1000),
      },
      secondary: {
        usedPercent: 11,
        windowDurationMins: 7 * 24 * 60,
        resetsAt: Math.floor(Date.parse("2026-09-07T00:00:00.082Z") / 1000),
      },
      tertiary: {
        usedPercent: 11,
        windowDurationMins: 30 * 24 * 60,
        resetsAt: Math.floor(Date.parse("2026-09-30T19:14:54.082Z") / 1000),
      },
      observedAt: "2026-09-05T12:00:00.000Z",
    });
  });

  it("omits resetsAt for unparseable timestamps but keeps the window", () => {
    assert.deepEqual(
      parseOpenCodeGoUsageRateLimits(
        { usage: { rolling: { percent: 42, resetsAt: "not-a-date" } } },
        READ_AT_MS,
      ),
      {
        limitId: "opencode-go",
        limitName: "OpenCode Go",
        planType: "go",
        primary: { usedPercent: 42, windowDurationMins: 300 },
        observedAt: "2026-09-05T12:00:00.000Z",
      },
    );
  });

  it("returns undefined when no window carries a numeric percent", () => {
    assert.equal(
      parseOpenCodeGoUsageRateLimits({ usage: { rolling: { percent: "high" } } }, READ_AT_MS),
      undefined,
    );
    assert.equal(parseOpenCodeGoUsageRateLimits({}, READ_AT_MS), undefined);
    assert.equal(parseOpenCodeGoUsageRateLimits(null, READ_AT_MS), undefined);
  });
});

describe("Go usage reads", () => {
  it("reads the opencode-go key from auth.json, calls the usage API and stamps the read", async () => {
    const dataBase = await mkdtemp(NodePath.join(NodeOS.tmpdir(), "ryco-opencode-go-"));
    const dataDir = NodePath.join(dataBase, "opencode");
    await mkdir(dataDir, { recursive: true });
    temporaryDirectories.push(dataBase);
    await writeFile(
      NodePath.join(dataDir, "auth.json"),
      JSON.stringify({
        deepseek: { type: "api", key: "sk-other" },
        "opencode-go": { type: "api", key: "sk-go-key" },
      }),
    );

    const requested: Array<{ url: string; authorization: string | undefined }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      requested.push({
        url: String(url),
        authorization: new Headers(init?.headers).get("authorization") ?? undefined,
      });
      return new Response(JSON.stringify(SAMPLE_USAGE_RESPONSE), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const rateLimits = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(READ_AT_MS);
        return yield* readOnce({ XDG_DATA_HOME: dataBase }, fetchImpl);
      }).pipe(Effect.provide(TestClock.layer())),
    );

    assert.deepEqual(requested, [
      {
        url: "https://opencode.ai/zen/go/v1/usage",
        authorization: "Bearer sk-go-key",
      },
    ]);
    assert.equal(rateLimits?.limitId, "opencode-go");
    assert.equal(rateLimits?.primary?.usedPercent, 0);
    assert.equal(rateLimits?.tertiary?.usedPercent, 11);
    // The slots are complete; no separate window list.
    assert.equal(rateLimits?.windows, undefined);
    assert.equal(rateLimits?.observedAt, "2026-09-05T12:00:00.000Z");
  });

  it("degrades to undefined without an opencode-go key or on request failure", async () => {
    const dataBase = await mkdtemp(NodePath.join(NodeOS.tmpdir(), "ryco-opencode-go-"));
    const dataDir = NodePath.join(dataBase, "opencode");
    await mkdir(dataDir, { recursive: true });
    temporaryDirectories.push(dataBase);
    await writeFile(
      NodePath.join(dataDir, "auth.json"),
      JSON.stringify({ deepseek: { type: "api", key: "sk-other" } }),
    );

    const failingFetch = (async () =>
      new Response("nope", { status: 401 })) as unknown as typeof globalThis.fetch;

    assert.equal(
      await Effect.runPromise(readOnce({ XDG_DATA_HOME: dataBase }, failingFetch)),
      undefined,
    );
    assert.equal(
      await Effect.runPromise(
        readOnce({ XDG_DATA_HOME: NodePath.join(dataBase, "missing") }, failingFetch),
      ),
      undefined,
    );
  });
});

describe("planOpenCodeGoUsageRead", () => {
  const goDataHome = async (key: string) => {
    const dataBase = await mkdtemp(NodePath.join(NodeOS.tmpdir(), "ryco-opencode-go-"));
    await mkdir(NodePath.join(dataBase, "opencode"), { recursive: true });
    temporaryDirectories.push(dataBase);
    await writeFile(
      NodePath.join(dataBase, "opencode", "auth.json"),
      JSON.stringify({ "opencode-go": { type: "api", key } }),
    );
    return { XDG_DATA_HOME: dataBase };
  };

  it("keys the read on the Go key without exposing it and maps a 429 to a throttle", async () => {
    let requests = 0;
    const throttlingFetch = (async () => {
      requests += 1;
      return new Response("", { status: 429, headers: { "Retry-After": "60" } });
    }) as unknown as typeof globalThis.fetch;
    const environment = await goDataHome("sk-go-test");

    const read = await Effect.runPromise(planOpenCodeGoUsageRead(environment, throttlingFetch));
    assert.match(read?.accountKey ?? "", /^[0-9a-f]{64}$/);
    assert.ok(!read?.accountKey.includes("sk-go-test"));
    assert.equal(requests, 0);
    assert.deepEqual(await Effect.runPromise(read!.fetch), {
      _tag: "Throttled",
      retryAfterMs: 60_000,
    });

    const other = await Effect.runPromise(
      planOpenCodeGoUsageRead(await goDataHome("sk-go-other"), throttlingFetch),
    );
    assert.notEqual(other?.accountKey, read?.accountKey);
  });

  it("re-serves the last good read through a gate while the API throttles", async () => {
    const responses = [
      () => Response.json(SAMPLE_USAGE_RESPONSE),
      () => new Response("", { status: 429 }),
    ];
    let requests = 0;
    const fetchImpl = (async () => {
      requests += 1;
      const response = responses.shift();
      if (!response) throw new Error("Unexpected usage request.");
      return response();
    }) as unknown as typeof globalThis.fetch;
    const environment = await goDataHome("sk-go-test");

    const [fresh, throttled, duringCooldown] = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(READ_AT_MS);
        const gate = yield* makeUsageReadGate();
        const probe = () => gate.read(planOpenCodeGoUsageRead(environment, fetchImpl));
        const fresh = yield* probe();
        yield* TestClock.adjust(Duration.minutes(5));
        const throttled = yield* probe();
        yield* TestClock.adjust(Duration.minutes(4));
        return [fresh, throttled, yield* probe()] as const;
      }).pipe(Effect.provide(TestClock.layer())),
    );

    assert.equal(fresh?.observedAt, "2026-09-05T12:00:00.000Z");
    assert.deepEqual(throttled, { ...fresh, stale: true, staleReason: "rateLimited" });
    assert.deepEqual(duringCooldown, throttled);
    assert.equal(requests, 2);
  });
});
