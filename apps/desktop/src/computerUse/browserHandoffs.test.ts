import type { ProjectBrowserTab } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  BROWSER_SCRUB_SCRIPT,
  BrowserHandoffs,
  type BrowserHandoffHost,
} from "./browserHandoffs.ts";

interface FakePage {
  href: string;
  title: string;
  ready: string;
  text: string;
  /** Values of secret fields per frame; the scrub empties them. */
  frames: number[];
  /** The main frame's scrub fails (no answer). */
  scrubFails?: boolean;
}

function fakeHost(page: FakePage) {
  const open = new Set(["tab-1", "tab-2"]);
  const marks: Array<NonNullable<ProjectBrowserTab["handoff"]> | null> = [];
  const withholding = { begun: 0, ended: 0 };
  const host: BrowserHandoffHost = {
    hasTab: (tab) => open.has(tab),
    tabUrl: () => page.href,
    setHandoff: (_tab, handoff) => {
      marks.push(handoff);
    },
    automation: () => ({
      beginWithholding: () => {
        withholding.begun += 1;
      },
      endWithholding: () => {
        withholding.ended += 1;
        return { requests: 2, messages: 1 };
      },
    }),
    evaluateInFrames: async (_tab, code, options) => {
      if (code === BROWSER_SCRUB_SCRIPT) {
        const cleared = page.frames.map((count) => count);
        if (page.scrubFails) return [undefined, ...cleared.slice(1)];
        page.frames = page.frames.map(() => 0);
        return cleared;
      }
      // The probe: evaluate its JSON contract against the fake page.
      const text = /TEXT = ("[^"]*"|null)/u.exec(code)?.[1];
      const wanted = text && text !== "null" ? (JSON.parse(text) as string) : null;
      const probe: Record<string, unknown> = {
        href: page.href,
        title: page.title,
        ready: page.ready,
      };
      if (wanted !== null) probe.text = page.text.toLowerCase().includes(wanted);
      if (code.includes("r.heading")) {
        probe.heading = page.title;
        probe.secretFields = page.href.includes("login") ? 1 : 0;
      }
      return options.allFrames ? [JSON.stringify(probe)] : [JSON.stringify(probe)];
    },
  };
  return { host, open, marks, withholding };
}

const begin = (overrides: Record<string, unknown> = {}) => ({
  op: "begin" as const,
  requestId: `user-action-${"a".repeat(32)}`,
  threadId: "thread-1",
  tab: "tab-1",
  message: "Sign in to Jira.",
  need: "sign-in" as const,
  ttlMs: 600_000,
  ...overrides,
});

describe("BrowserHandoffs", () => {
  it("hands a tab to the user, refuses every agent meanwhile, and gives it back scrubbed", async () => {
    const page: FakePage = {
      href: "https://jira.test/login",
      title: "Sign in",
      ready: "complete",
      text: "Sign in",
      frames: [1, 1],
    };
    const { host, marks, withholding } = fakeHost(page);
    const handoffs = new BrowserHandoffs(host);
    expect(await handoffs.handle(begin({ doneWhen: { url: "/dashboard" } }))).toEqual({
      status: "handed-off",
    });
    expect(marks.at(-1)).toMatchObject({ thread: "thread-1", need: "sign-in" });
    expect(withholding.begun).toBe(1);
    expect(handoffs.refusal("tab-1", "thread-1")).toMatch(/with the user for your request/);
    expect(handoffs.refusal("tab-1", "thread-2")).toMatch(/another thread's request/);
    expect(handoffs.refusal("tab-2", "thread-1")).toBeNull();
    // A second hand-off of the same tab is refused; the same request again is not.
    expect(
      await handoffs.handle(begin({ requestId: `user-action-${"b".repeat(32)}` })),
    ).toMatchObject({ status: "refused" });
    expect(await handoffs.handle(begin())).toEqual({ status: "handed-off" });

    // Not there yet; then the user lands on the dashboard and the page has loaded.
    expect(await handoffs.handle({ op: "probe", requestId: begin().requestId })).toEqual({
      status: "active",
      met: false,
    });
    page.href = "https://jira.test/dashboard?welcome=1";
    page.title = "Dashboard";
    expect(await handoffs.handle({ op: "probe", requestId: begin().requestId })).toEqual({
      status: "active",
      met: true,
    });

    const ended = await handoffs.handle({
      op: "end",
      requestId: begin().requestId,
      outcome: "condition-met",
    });
    expect(ended).toMatchObject({
      status: "ended",
      outcome: "condition-met",
      tab: "tab-1",
      scrubbed: 2,
      stillPaused: false,
      withheld: { requests: 2, messages: 1 },
      page: { href: "https://jira.test/dashboard?welcome=1", title: "Dashboard" },
    });
    expect(marks.at(-1)).toBeNull();
    expect(handoffs.refusal("tab-1", "thread-1")).toBeNull();
    // Idempotent: the agent's own end after the card's answers what the first one did.
    expect(
      await handoffs.handle({ op: "end", requestId: begin().requestId, outcome: "done" }),
    ).toEqual(ended);
  });

  it("hands nothing over when done_when already holds", async () => {
    const { host, marks } = fakeHost({
      href: "https://jira.test/dashboard",
      title: "Dashboard",
      ready: "complete",
      text: "",
      frames: [],
    });
    const handoffs = new BrowserHandoffs(host);
    expect(await handoffs.handle(begin({ doneWhen: { url: "/dashboard" } }))).toMatchObject({
      status: "already-met",
      page: { href: "https://jira.test/dashboard" },
    });
    expect(marks).toEqual([]);
    expect(handoffs.isHandedOff("tab-1")).toBe(false);
  });

  it("refuses a closed tab and a selector that reads field values", async () => {
    const { host, open } = fakeHost({
      href: "https://a.test/",
      title: "",
      ready: "complete",
      text: "",
      frames: [],
    });
    const handoffs = new BrowserHandoffs(host);
    expect(
      await handoffs.handle(begin({ doneWhen: { selector: 'input[value="x"]' } })),
    ).toMatchObject({ status: "refused" });
    open.delete("tab-1");
    expect(await handoffs.handle(begin())).toMatchObject({ status: "refused" });
    expect(await handoffs.handle({ op: "probe", requestId: begin().requestId })).toEqual({
      status: "missing",
    });
  });

  it("keeps the tab with the user when the scrub fails", async () => {
    const page: FakePage = {
      href: "https://a.test/login",
      title: "Sign in",
      ready: "complete",
      text: "",
      frames: [1],
      scrubFails: true,
    };
    const { host, marks, withholding } = fakeHost(page);
    const handoffs = new BrowserHandoffs(host);
    await handoffs.handle(begin());
    const ended = await handoffs.handle({
      op: "end",
      requestId: begin().requestId,
      outcome: "done",
    });
    expect(ended).toMatchObject({ status: "ended", stillPaused: true });
    expect(handoffs.isHandedOff("tab-1")).toBe(true);
    // Withholding goes on until a later end succeeds.
    expect(withholding.begun).toBe(2);
    expect(marks.at(-1)).not.toBeNull();
    page.scrubFails = false;
    expect(
      await handoffs.handle({ op: "end", requestId: begin().requestId, outcome: "done" }),
    ).toMatchObject({ status: "ended", stillPaused: false });
    expect(handoffs.isHandedOff("tab-1")).toBe(false);
  });

  it("reports a tab the user closed", async () => {
    const { host, open } = fakeHost({
      href: "https://a.test/login",
      title: "",
      ready: "complete",
      text: "",
      frames: [],
    });
    const handoffs = new BrowserHandoffs(host);
    await handoffs.handle(begin());
    open.delete("tab-1");
    expect(await handoffs.handle({ op: "probe", requestId: begin().requestId })).toEqual({
      status: "closed",
    });
    expect(
      await handoffs.handle({ op: "end", requestId: begin().requestId, outcome: "closed" }),
    ).toMatchObject({ status: "ended", outcome: "closed", stillPaused: false });
  });
});
