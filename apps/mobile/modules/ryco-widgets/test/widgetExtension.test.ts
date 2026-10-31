// The app's `tsconfig` is the react-native one, which resolves no Node builtins;
// this test runs under Node, so it pulls the types in for itself.
/// <reference types="node" />
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

import {
  buildSubscriptionUsageSnapshot,
  buildSubscriptionUsageTimeline,
  TAP_TO_REFRESH,
} from "../../../src/widgets/subscriptionUsageSnapshot";
import {
  AGENT_ACTIVITY_MAX_STATE_BYTES,
  AGENT_ACTIVITY_STATE_BUDGET_BYTES,
  agentActivityContentState,
  encodeAgentActivityState,
} from "../../../src/liveActivity/agentActivityModel";
import { encodeWidgetTimeline } from "../../../src/widgets/widgetTimeline";

/**
 * The widget extension is Swift the app's TypeScript feeds. On a Mac this
 * typechecks every extension source against the iOS Simulator SDK, and
 * compiles the timeline reader for the Mac to read a timeline the TypeScript
 * encoded. Elsewhere (CI on Linux) it is skipped and the iOS build covers
 * compilation.
 */
const MODULE_DIR = fileURLToPath(new URL("..", import.meta.url));
const SHARED_SOURCES = [join(MODULE_DIR, "ios/WidgetGroupStore.swift")];
/** What the config plugin compiles into the extension: its sources and the app module's shared ones. */
const EXTENSION_SOURCES = (
  createRequire(import.meta.url)("../../../plugins/withIosWidgetExtension.cjs") as {
    readonly EXTENSION_SOURCES: readonly string[];
  }
).EXTENSION_SOURCES;
/** The extension's Foundation-only sources: what reads and selects, not what renders. */
const READER_SOURCES = [
  join(MODULE_DIR, "extension/WidgetTimelineStore.swift"),
  join(MODULE_DIR, "extension/SubscriptionUsageContent.swift"),
  ...SHARED_SOURCES,
];

const NOW = 1_700_000_000_000;

/** Two Claude accounts on a hub (one email-named) and a direct Codex account. */
function usageTimeline(): string {
  const window = (id: string, usedPercent: number, minutes: number, scope?: string) => ({
    id,
    usedPercent,
    windowDurationMins: minutes,
    resetsAt: NOW / 1000 + 3600,
    ...(scope ? { scope } : {}),
  });
  const hubAccount = (authIndex: string, name: string, windows: unknown[]) => ({
    authIndex,
    provider: "claude",
    name,
    status: "active",
    disabled: false,
    unavailable: false,
    cooldowns: [],
    requests: { success: 0, failed: 0, recent: [] },
    quota: { status: "ok", planType: "max", checkedAt: new Date(NOW).toISOString(), windows },
  });
  const snapshot = buildSubscriptionUsageSnapshot(
    [
      {
        environmentId: "env",
        label: "Mac",
        connected: true,
        providers: [
          {
            instanceId: "codex",
            driver: "codex",
            displayName: "Codex",
            enabled: true,
            status: "ready",
            auth: { status: "authenticated" },
            checkedAt: new Date(NOW).toISOString(),
            rateLimits: {
              planType: "plus",
              observedAt: new Date(NOW).toISOString(),
              windows: [window("five-hour", 30, 300), window("weekly", 10, 10_080)],
            },
          },
        ],
        hubs: [
          {
            hubId: "home",
            label: "Home",
            url: "https://hub.example.test",
            checkedAt: new Date(NOW).toISOString(),
            status: "ok",
            apiKeys: [],
            routedInstanceIds: [],
            accounts: [
              hubAccount("a", "alpha.json", [
                window("five-hour", 20, 300),
                window("weekly", 50, 10_080),
                window("weekly-opus", 70, 10_080, "Opus"),
              ]),
              hubAccount("b", ["claude-bob", "example.com.json"].join("@"), [
                window("five-hour", 60, 300),
                window("weekly", 30, 10_080),
              ]),
            ],
          },
        ],
      },
    ] as never,
    "ryco-dev://settings/statistics?tab=limits",
  );
  return encodeWidgetTimeline(buildSubscriptionUsageTimeline(snapshot, NOW));
}

/** The Live Activity's content state: Foundation only, so it runs on the Mac. */
const ACTIVITY_STATE_SOURCES = [
  join(MODULE_DIR, "ios/AgentActivityContentState.swift"),
  join(MODULE_DIR, "test/activityState/main.swift"),
];

/** Five rows as the app encodes them, of the given titles. */
function activityState(title: string): string {
  const id = (prefix: string, index: number) => `${prefix}-${index}-${"0".repeat(30)}`;
  return encodeAgentActivityState(
    agentActivityContentState(
      {
        counts: { running: 5, needsYou: 0, failed: 0, done: 0 },
        rows: Array.from({ length: 5 }, (_, index) => ({
          key: `${id("environment", index)}:${id("thread", index)}`,
          environmentId: id("environment", index),
          threadId: id("thread", index),
          title,
          projectName: "🧪".repeat(24),
          phase: "running" as const,
        })),
        settled: false,
      },
      {
        inbox: "ryco-dev://",
        thread: (environmentId, threadId) => `ryco-dev://threads/${environmentId}/${threadId}`,
      },
      1_700_000_000_000,
    ),
  );
}

const swiftcAvailable =
  process.platform === "darwin" &&
  spawnSync("xcrun", ["--sdk", "iphonesimulator", "--find", "swiftc"], { stdio: "ignore" })
    .status === 0;

function withTemporaryDirectory<T>(use: (directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), "ryco-widgets-"));
  try {
    return use(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe.skipIf(!swiftcAvailable)("the widget extension's Swift", () => {
  it("typechecks against the iOS Simulator SDK", () => {
    const arch = process.arch === "arm64" ? "arm64" : "x86_64";
    execFileSync(
      "xcrun",
      [
        "--sdk",
        "iphonesimulator",
        "swiftc",
        "-typecheck",
        "-target",
        `${arch}-apple-ios17.0-simulator`,
        ...EXTENSION_SOURCES,
      ],
      { stdio: "pipe" },
    );
  }, 180_000);

  it("reads the timeline the app encodes, and only from files its kinds name", () => {
    withTemporaryDirectory((directory) => {
      const binary = join(directory, "reader");
      execFileSync(
        "xcrun",
        ["swiftc", "-o", binary, ...READER_SOURCES, join(MODULE_DIR, "test/main.swift")],
        { stdio: "pipe" },
      );
      const timeline = join(directory, "timeline.json");
      writeFileSync(
        timeline,
        encodeWidgetTimeline([
          { at: 1_700_000_900_000, content: { label: "later" } },
          { at: 1_700_000_000_000, content: { label: "now" } },
        ]),
      );
      const usage = join(directory, "usage.json");
      writeFileSync(usage, usageTimeline());
      const output = JSON.parse(
        execFileSync(binary, [join(directory, "group"), timeline, usage], { encoding: "utf8" }),
      ) as Record<string, unknown>;

      expect(output).toMatchObject({
        beforeWrite: [],
        written: [
          { at: 1_700_000_000_000, seconds: 1_700_000_000, label: "now" },
          { at: 1_700_000_900_000, seconds: 1_700_000_900, label: "later" },
        ],
        file: "test-kind.json",
        rejectedKinds: [true, true, true, true, true, true],
        otherVersion: [],
        notJson: [],
        afterRemove: [],
      });
      // Now, then the soonest reset (in an hour) is past the fifteen minutes: one deadline, on
      // the whole minute before them.
      expect(output.usageEntries).toEqual([
        { at: NOW, fresh: [true, true] },
        { at: Math.floor((NOW + 15 * 60_000) / 60_000) * 60_000, fresh: [false, false] },
      ]);
      // Claude pools 5h and Weekly over both accounts; only one reports Weekly · Opus, the
      // tightest weekly window, so the two-row sizes show it beside the session.
      const claudeDetail = "2 accounts · pooled";
      expect(output.usageColumns).toEqual({
        medium: [
          { name: "Claude", detail: claudeDetail, rows: ["5h", "Weekly · Opus"], more: 1 },
          { name: "Codex", detail: "Plus", rows: ["5h", "Weekly"], more: 0 },
        ],
        large: [
          {
            name: "Claude",
            detail: claudeDetail,
            rows: ["5h", "Weekly · Opus", "Weekly"],
            more: 0,
          },
          { name: "Codex", detail: "Plus", rows: ["5h", "Weekly"], more: 0 },
        ],
        small: [
          { name: "Claude", detail: claudeDetail, rows: ["5h", "Weekly · Opus"], more: 1 },
          { name: "Codex", detail: "Plus", rows: ["5h", "Weekly"], more: 0 },
        ],
        lockScreen: [
          { name: "Claude", detail: claudeDetail, rows: ["Weekly · Opus"], more: 2 },
          { name: "Codex", detail: "Plus", rows: ["5h"], more: 1 },
        ],
        weeklyOnly: [
          { name: "Claude", detail: claudeDetail, rows: ["Weekly · Opus", "Weekly"], more: 0 },
          { name: "Codex", detail: "Plus", rows: ["Weekly"], more: 0 },
        ],
        // In the Limits tab's order; the email-named account is "Account 2", never its file name.
        eachAccount: [
          {
            name: "Claude",
            detail: "2 accounts",
            rows: [
              "Account 2 · 5h",
              "alpha.json · Weekly · Opus",
              "Account 2 · Weekly",
              "alpha.json · 5h",
            ],
            more: 0,
          },
          { name: "Codex", detail: "Plus", rows: ["5h", "Weekly"], more: 0 },
        ],
      });
      expect(output.usageAfterExpiry).toEqual([
        { detail: TAP_TO_REFRESH, rows: 0, more: 0 },
        { detail: TAP_TO_REFRESH, rows: 0, more: 0 },
      ]);
      // The footer and the Lock Screen say what the app's expired detail says.
      expect(output.tapToRefresh).toBe(TAP_TO_REFRESH);
    });
  }, 180_000);
  it("measures the Live Activity state as Swift encodes it, and trims it to ActivityKit's 4 KB", () => {
    withTemporaryDirectory((directory) => {
      const binary = join(directory, "activity-state");
      execFileSync("xcrun", ["swiftc", "-o", binary, ...ACTIVITY_STATE_SOURCES], { stdio: "pipe" });
      const longest = activityState("🧪".repeat(48));
      // Slashes cost one byte each in this JSON and two in Swift's.
      const slashes = activityState("/".repeat(400));
      const states = join(directory, "states.json");
      writeFileSync(states, JSON.stringify([longest, slashes]));
      const output = JSON.parse(execFileSync(binary, [states], { encoding: "utf8" })) as {
        readonly maxBytes: number;
        readonly states: ReadonlyArray<Record<string, number>>;
      };
      expect(output.maxBytes).toBe(AGENT_ACTIVITY_MAX_STATE_BYTES);
      for (const json of [longest, slashes]) {
        expect(Buffer.byteLength(json)).toBeLessThanOrEqual(AGENT_ACTIVITY_STATE_BUDGET_BYTES);
        expect((JSON.parse(json) as { rows: unknown[] }).rows).toHaveLength(5);
      }
      const [fits, trimmed] = output.states;
      // The app's margin covers Swift's encoding of its longest rows: nothing is trimmed.
      expect(fits).toMatchObject({ rows: 5, fittedRows: 5 });
      expect(fits!.swiftBytes).toBeGreaterThan(Buffer.byteLength(longest));
      expect(fits!.swiftBytes).toBeLessThanOrEqual(AGENT_ACTIVITY_MAX_STATE_BYTES);
      // Past 4 KB as Swift encodes it, rows go from the end and the counts stay.
      expect(trimmed!.swiftBytes).toBeGreaterThan(AGENT_ACTIVITY_MAX_STATE_BYTES);
      expect(trimmed!.fittedRows).toBeGreaterThan(0);
      expect(trimmed!.fittedRows).toBeLessThan(5);
      expect(trimmed!.fittedBytes).toBeLessThanOrEqual(AGENT_ACTIVITY_MAX_STATE_BYTES);
      expect(trimmed!.fittedRunning).toBe(5);
    });
  }, 180_000);
});
