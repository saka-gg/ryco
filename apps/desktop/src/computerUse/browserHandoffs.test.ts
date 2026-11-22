import type { ProjectBrowserTab } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { BROWSER_SCRUB_SCRIPT } from "@ryco/shared/browserHandoff";

import { BrowserHandoffs, type BrowserHandoffHost } from "./browserHandoffs.ts";

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
  /** What happened to agents' access, in order: "hold:tab", "release:tab". */
  const agents: string[] = [];
  const hold = { fails: false };
  /** What reached the page, in order: remote input commands and the scrub. */
  const log: string[] = [];
  let pixels = "pixels-1";
  const host: BrowserHandoffHost = {
    holdAgents: async (tab) => {
      agents.push(`hold:${tab}`);
      return !hold.fails;
    },
    releaseAgents: (tab) => {
      agents.push(`release:${tab}`);
    },
    hasTab: (tab) => open.has(tab),
    tabUrl: () => page.href,
    setHandoff: (_tab, handoff) => {
      marks.push(handoff);
      if (handoff) agents.push("card");
    },
    beginWithholding: () => {
      withholding.begun += 1;
    },
    endWithholding: () => {
      withholding.ended += 1;
      return { requests: 2, messages: 1 };
    },
    captureHandoffFrame: async () => ({
      cssWidth: 1280,
      cssHeight: 850,
      width: 1280,
      height: 850,
      fingerprint: pixels,
      encode: () => Buffer.from(`jpeg of ${pixels}`),
    }),
    sendHandoffInput: async (_tab, commands) => {
      for (const command of commands)
        log.push(`${command.method}:${String(command.params.type ?? "text")}`);
    },
    releaseHandoffInput: () => {
      log.push("release-session");
    },
    handoffViewport: () => ({ width: 1280, height: 850 }),
    evaluateInFrames: async (_tab, code, options) => {
      if (code === BROWSER_SCRUB_SCRIPT) log.push("scrub");
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
  return {
    host,
    open,
    marks,
    withholding,
    agents,
    hold,
    log,
    repaint: (next: string) => {
      pixels = next;
    },
  };
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
      remoteView: true,
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
    expect(await handoffs.handle(begin())).toEqual({ status: "handed-off", remoteView: true });

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

  it("takes the tab from agents before anything is handed over, and gives it back at the end", async () => {
    const page: FakePage = {
      href: "https://a.test/login",
      title: "Sign in",
      ready: "complete",
      text: "",
      frames: [1],
    };
    const { host, agents, hold, marks } = fakeHost(page);
    const handoffs = new BrowserHandoffs(host);
    // Agents could not be taken off the tab in time: nothing is handed over, the hold is lifted.
    hold.fails = true;
    expect(await handoffs.handle(begin())).toMatchObject({
      status: "refused",
      text: expect.stringMatching(/did not stop in time/),
    });
    expect(marks).toEqual([]);
    expect(agents).toEqual(["hold:tab-1", "release:tab-1"]);
    expect(handoffs.refusal("tab-1", "thread-1")).toBeNull();
    hold.fails = false;
    agents.length = 0;
    // Held first, the card only after; agents stay off until the tab is given back.
    expect(await handoffs.handle(begin())).toMatchObject({ status: "handed-off" });
    expect(agents).toEqual(["hold:tab-1", "card"]);
    await handoffs.handle({ op: "end", requestId: begin().requestId, outcome: "done" });
    expect(agents).toEqual(["hold:tab-1", "card", "release:tab-1"]);
    // A condition that already holds hands nothing over and lifts the hold.
    agents.length = 0;
    page.href = "https://a.test/dashboard";
    expect(
      await handoffs.handle(
        begin({ requestId: `user-action-${"c".repeat(32)}`, doneWhen: { url: "/dashboard" } }),
      ),
    ).toMatchObject({ status: "already-met" });
    expect(agents).toEqual(["hold:tab-1", "release:tab-1"]);
  });

  it("refuses agents while a hand-off is being begun", async () => {
    const page: FakePage = {
      href: "https://a.test/login",
      title: "Sign in",
      ready: "complete",
      text: "",
      frames: [1],
    };
    const { host } = fakeHost(page);
    let held!: () => void;
    const handoffs = new BrowserHandoffs({
      ...host,
      holdAgents: () =>
        new Promise<boolean>((resolve) => {
          held = () => resolve(true);
        }),
    });
    const starting = handoffs.handle(begin());
    await Promise.resolve();
    // Not handed over yet, already refused to every agent (a queued action included).
    expect(handoffs.isHandedOff("tab-1")).toBe(true);
    expect(handoffs.refusal("tab-1", "thread-1")).toMatch(/with the user for your request/);
    expect(
      await handoffs.handle(begin({ requestId: `user-action-${"d".repeat(32)}` })),
    ).toMatchObject({
      status: "refused",
    });
    held();
    expect(await starting).toMatchObject({ status: "handed-off" });
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
    for (const selector of ['input[value="x"]', 'input[/**/value^="a"]', 'input[value/**/^="a"]']) {
      expect(await handoffs.handle(begin({ doneWhen: { selector } })), selector).toMatchObject({
        status: "refused",
      });
    }
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
    expect(withholding).toEqual({ begun: 1, ended: 0 });
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

  describe("remote view and input", () => {
    const loginPage = (): FakePage => ({
      href: "https://a.test/login",
      title: "Sign in",
      ready: "complete",
      text: "",
      frames: [1],
    });
    const requestId = begin().requestId;
    const key = (action: "down" | "up", k: string) => ({
      type: "key" as const,
      action,
      key: k,
      code: `Key${k.toUpperCase()}`,
      modifiers: 0,
    });

    it("serves nothing without a pending hand-off of that tab", async () => {
      const { host } = fakeHost(loginPage());
      const handoffs = new BrowserHandoffs(host);
      expect(await handoffs.handle({ op: "view", requestId, tab: "tab-1" })).toEqual({
        status: "gone",
      });
      await handoffs.handle(begin());
      // Another tab than the handed-off one.
      expect(await handoffs.handle({ op: "view", requestId, tab: "tab-2" })).toMatchObject({
        status: "refused",
      });
      // Another request's id for the same tab.
      expect(
        await handoffs.handle({
          op: "view",
          requestId: `user-action-${"f".repeat(32)}`,
          tab: "tab-1",
        }),
      ).toEqual({ status: "gone" });
    });

    it("streams frames and takes input with the hand-off's viewer token only", async () => {
      const { host, log, repaint } = fakeHost(loginPage());
      const handoffs = new BrowserHandoffs(host);
      await handoffs.handle(begin());
      const viewing = await handoffs.handle({ op: "view", requestId, tab: "tab-1" });
      expect(viewing).toMatchObject({ status: "viewing", cssWidth: 1280, cssHeight: 850 });
      const viewer = (viewing as { viewer: string }).viewer;
      const frameRequest = {
        op: "frame" as const,
        requestId,
        tab: "tab-1",
        viewer,
        maxWidth: 1280,
        maxHeight: 900,
        quality: 60,
      };
      const first = await handoffs.handle(frameRequest);
      expect(first).toMatchObject({ status: "frame", cssWidth: 1280, fingerprint: "pixels-1" });
      expect(Buffer.from((first as { jpeg: string }).jpeg, "base64").toString()).toBe(
        "jpeg of pixels-1",
      );
      // An unchanged page costs nothing; a changed one is sent.
      expect(await handoffs.handle({ ...frameRequest, since: "pixels-1" })).toEqual({
        status: "unchanged",
      });
      repaint("pixels-2");
      expect(await handoffs.handle({ ...frameRequest, since: "pixels-1" })).toMatchObject({
        status: "frame",
        fingerprint: "pixels-2",
      });
      expect(
        await handoffs.handle({
          op: "input",
          requestId,
          tab: "tab-1",
          viewer,
          events: [key("down", "a")],
        }),
      ).toEqual({ status: "accepted" });
      expect(log).toEqual(["Input.dispatchKeyEvent:rawKeyDown"]);
      // A token that is not this hand-off's (an earlier one, another desktop process): stale.
      const stale = "0".repeat(32);
      expect(await handoffs.handle({ ...frameRequest, viewer: stale })).toEqual({
        status: "stale",
      });
      expect(
        await handoffs.handle({
          op: "input",
          requestId,
          tab: "tab-1",
          viewer: stale,
          events: [key("up", "a")],
        }),
      ).toEqual({ status: "stale" });
      expect(log).toHaveLength(1);
    });

    it("lets go of held keys before the scrub, and refuses input once it is ending", async () => {
      const { host, log } = fakeHost(loginPage());
      const handoffs = new BrowserHandoffs(host);
      await handoffs.handle(begin());
      const { viewer } = (await handoffs.handle({ op: "view", requestId, tab: "tab-1" })) as {
        viewer: string;
      };
      await handoffs.handle({
        op: "input",
        requestId,
        tab: "tab-1",
        viewer,
        events: [key("down", "a")],
      });
      // The request resolves while the remote user still types: the end starts first.
      const ending = handoffs.handle({ op: "end", requestId, outcome: "done" });
      const late = handoffs.handle({
        op: "input",
        requestId,
        tab: "tab-1",
        viewer,
        events: [key("down", "b")],
      });
      expect(await late).toEqual({ status: "gone" });
      expect(await ending).toMatchObject({ status: "ended", stillPaused: false });
      expect(log).toEqual([
        "Input.dispatchKeyEvent:rawKeyDown",
        // The held "a" is let go of, then the fields are emptied, then the session ends.
        "Input.dispatchKeyEvent:keyUp",
        "scrub",
        "release-session",
      ]);
      // After the hand-off nothing of the page leaves, with any token.
      expect(
        await handoffs.handle({
          op: "frame",
          requestId,
          tab: "tab-1",
          viewer,
          maxWidth: 640,
          maxHeight: 480,
          quality: 50,
        }),
      ).toEqual({ status: "gone" });
    });

    it("gives every hand-off of the same tab a new viewer token", async () => {
      const { host } = fakeHost(loginPage());
      const handoffs = new BrowserHandoffs(host);
      await handoffs.handle(begin());
      const first = (await handoffs.handle({ op: "view", requestId, tab: "tab-1" })) as {
        viewer: string;
      };
      await handoffs.handle({ op: "end", requestId, outcome: "declined" });
      const nextId = `user-action-${"b".repeat(32)}`;
      await handoffs.handle(begin({ requestId: nextId }));
      // The earlier hand-off's token does not open the new one (a reconnect must view again).
      expect(
        await handoffs.handle({
          op: "input",
          requestId: nextId,
          tab: "tab-1",
          viewer: first.viewer,
          events: [{ type: "release" }],
        }),
      ).toEqual({ status: "stale" });
    });

    it("drops app-level chords from remote input and keeps typing and editing", async () => {
      const { host, log } = fakeHost(loginPage());
      const handoffs = new BrowserHandoffs(host);
      await handoffs.handle(begin());
      const { viewer } = (await handoffs.handle({ op: "view", requestId, tab: "tab-1" })) as {
        viewer: string;
      };
      const chord = (k: string, modifiers: number) => ({
        type: "key" as const,
        action: "down" as const,
        key: k,
        code: `Key${k.toUpperCase()}`,
        modifiers,
      });
      expect(
        await handoffs.handle({
          op: "input",
          requestId,
          tab: "tab-1",
          viewer,
          // Ctrl+W, Cmd+Q, Ctrl+R, Ctrl+Shift+I, F5, a key paste (Ctrl+V: the desktop's clipboard)
          // and a middle click: dropped. Ctrl+C and a plain "a": sent.
          events: [
            chord("w", 2),
            chord("q", 4),
            chord("r", 2),
            chord("i", 2 | 8),
            { type: "key", action: "down", key: "F5", code: "F5", modifiers: 0 },
            chord("v", 2),
            {
              type: "mouse",
              action: "down",
              x: 5,
              y: 5,
              button: "middle",
              buttons: 4,
              clickCount: 1,
              modifiers: 0,
            },
            chord("c", 2),
            key("down", "a"),
          ],
        }),
      ).toEqual({ status: "accepted" });
      expect(log).toEqual([
        "Input.dispatchKeyEvent:rawKeyDown",
        "Input.dispatchKeyEvent:rawKeyDown",
      ]);
    });

    it("stops remote view and input once the Ryco browser is turned off, and ends the hand-off", async () => {
      const { host, log } = fakeHost(loginPage());
      let enabled = true;
      const handoffs = new BrowserHandoffs(host, { enabled: () => enabled });
      await handoffs.handle(begin());
      const { viewer } = (await handoffs.handle({ op: "view", requestId, tab: "tab-1" })) as {
        viewer: string;
      };
      enabled = false;
      // Every remote op re-reads the setting: nothing of the tab is shown or driven any more.
      expect(await handoffs.handle({ op: "view", requestId, tab: "tab-1" })).toEqual({
        status: "gone",
      });
      expect(
        await handoffs.handle({
          op: "frame",
          requestId,
          tab: "tab-1",
          viewer,
          maxWidth: 640,
          maxHeight: 480,
          quality: 50,
        }),
      ).toEqual({ status: "gone" });
      expect(
        await handoffs.handle({
          op: "input",
          requestId,
          tab: "tab-1",
          viewer,
          events: [key("down", "a")],
        }),
      ).toEqual({ status: "gone" });
      expect(log).toEqual([]);
      // The node's next probe ends it as cancelled; giving the tab back still works.
      expect(await handoffs.handle({ op: "probe", requestId })).toEqual({ status: "missing" });
      expect(await handoffs.handle({ op: "end", requestId, outcome: "cancelled" })).toMatchObject({
        status: "ended",
        outcome: "cancelled",
      });
      // And nothing new is handed over while it is off.
      expect(await handoffs.handle(begin())).toMatchObject({ status: "refused" });
    });
  });
});
