/**
 * The Ryco browser's tab memory budget on real Electron, with hidden windows only: a disposable
 * profile, a hidden "Ryco window" for the panel, loopback fixture pages and agent commands through
 * the real policy and driver. No OS input, no clipboard, no native helper, no shown or focused
 * window, and the app never registers as a URL handler. It checks what the fake-Electron unit tests
 * cannot: that suspension really frees each tab's page and host window (it logs this process's own
 * helpers via `pgrep -P`), that a suspended tab reloads at its address when shown, captured or
 * used by an agent, that the budget's timer fires in Electron's main process, that hidden pages are
 * really throttled (a 100 ms timer runs about once a second) except while an agent or the preview
 * holds them, that the agent's focus emulation does not keep a page awake after its claim, and that
 * the preview can capture hidden pages (throttled ones, and ones loaded while unthrottled).
 *
 * Run with `node apps/desktop/scripts/computer-use-smoke.mjs tab-budget`. It takes about two
 * minutes: the per-project pressure stage waits for its real 60 s timer. The 10-minute idle stage
 * and the 60 s agent hold instead advance a virtual clock (`Date.now`, which the budget, the agent
 * claim and the policy lease all read) and fire the budget's pending timer early. RYCO_SMOKE_TMP is
 * the parent of the temporary profile (the launcher passes its own temporary directory). With
 * RYCO_SMOKE_SHOT_DIR set, it writes captures of fixture tabs (webContents.capturePage) there.
 */
import { app, BrowserWindow, type NativeImage, type WebContents } from "electron";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ComputerBrowser, ComputerUseRequest, ComputerUseResult } from "@ryco/contracts";
import {
  BrowserComputerDriver,
  REVIVED_TAB_ERROR,
  REVIVED_TAB_NOTE,
  type BrowserTransport,
} from "../src/computerUse/browser.ts";
import {
  BROWSER_IDLE_SUSPEND_MS,
  BROWSER_LIVE_TAB_LIMIT,
  BROWSER_PREVIEW_HOLD_MS,
  BROWSER_WARM_TAB_LIMIT,
} from "../src/computerUse/browserTabBudget.ts";
import { EmbeddedComputerBrowser } from "../src/computerUse/embeddedBrowser.ts";
import {
  COMPUTER_TARGET_CLAIM_MS,
  ComputerPolicyController,
  DEFAULT_COMPUTER_POLICY,
} from "../src/computerUse/policy.ts";

const directory = mkdtempSync(
  join(process.env.RYCO_SMOKE_TMP || tmpdir(), "ryco-tab-budget-smoke-"),
);
app.setPath("userData", directory);
app.on("window-all-closed", () => {});
const shots = process.env.RYCO_SMOKE_SHOT_DIR;
const watchdog = setTimeout(() => {
  console.error("FAIL: the tab budget smoke did not finish within 300 s.");
  app.exit(2);
}, 300_000);

// The virtual clock: real time plus a skew the smoke advances instead of waiting.
const realNow = Date.now;
let skew = 0;
Date.now = () => realNow() + skew;

const PROJECT = "fixture-project";
/** Ticks per second of the fixture's 100 ms timer: about 1 (or less) throttled, about 10 not. */
const THROTTLED_RATE = 3;
const UNTHROTTLED_RATE = 7;
const TABS = BROWSER_LIVE_TAB_LIMIT + 1;
const loads = new Map<string, number>();
/** Fixture tab `n`: its load count from the server, a 100 ms tick counter and visibility changes. */
const fixturePage = (n: number, load: number) =>
  `<!doctype html><meta charset="utf-8"><title>Fixture tab ${n}</title><style>body{font:20px system-ui;padding:32px;background:#f5f4ef;color:#222}h1{font-size:30px;margin:0 0 12px}.load{font-size:44px;font-weight:650;margin:8px 0 16px}input{font:inherit;padding:8px;width:340px}p{margin:10px 0}</style><h1>Fixture tab ${n}</h1><div class="load">Load #${load}</div><p>Ticks: <b id="ticks">0</b> · visibility changes: <b id="vis">0</b> · <span id="state"></span></p><label>Draft <input id="draft" aria-label="Draft"></label><script>window.__ticks=0;window.__vis=0;const t=document.getElementById("ticks"),v=document.getElementById("vis"),s=document.getElementById("state");s.textContent=document.visibilityState;setInterval(()=>{window.__ticks++;t.textContent=String(window.__ticks)},100);document.addEventListener("visibilitychange",()=>{window.__vis++;v.textContent=String(window.__vis);s.textContent=document.visibilityState})</script>`;
const server = createServer((request, response) => {
  const match = /^\/tab\/(\d+)$/u.exec(request.url ?? "");
  if (!match) {
    response.statusCode = 404;
    return void response.end();
  }
  const load = (loads.get(request.url!) ?? 0) + 1;
  loads.set(request.url!, load);
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(fixturePage(Number(match[1]), load));
});

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const step = (label: string) => console.log(`tab-budget smoke: ${label}`);
const decoded = (value: ComputerUseResult) =>
  JSON.parse((value.content[0] as { text: string }).text);

/** The private members the smoke reads or drives (TypeScript `private`, plain at runtime). */
interface BudgetInternals {
  entries: Map<string, { live: { view: { webContents: WebContents } } | null }>;
  budgetTimer: ReturnType<typeof setTimeout> | undefined;
  budgetDueAt: number;
  applyBudget(): void;
}

interface ProcessSample {
  label: string;
  renderers: number;
  rendererRssMb: number;
  helpers: number;
  helperRssMb: number;
  mainRssMb: number;
  hostWindows: number;
}

/** This Electron process's own helpers (`pgrep -P <own pid>`), never matched by name. */
function sampleProcesses(label: string): ProcessSample {
  let pids: string[] = [];
  try {
    pids = execFileSync("pgrep", ["-P", String(process.pid)], { encoding: "utf8" })
      .trim()
      .split("\n")
      .filter(Boolean);
  } catch {
    pids = [];
  }
  const rows =
    pids.length === 0
      ? []
      : execFileSync("ps", ["-o", "pid=,rss=,command=", "-p", pids.join(",")], { encoding: "utf8" })
          .trim()
          .split("\n")
          .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line))
          .filter((row): row is RegExpExecArray => row !== null)
          .map(([, pid, rss, command]) => ({
            pid: Number(pid),
            rssKb: Number(rss),
            type: /--type=([\w-]+)/u.exec(command!)?.[1] ?? "other",
          }));
  const renderers = rows.filter((row) => row.type === "renderer");
  const mb = (kb: number) => Math.round(kb / 102.4) / 10;
  const sample: ProcessSample = {
    label,
    renderers: renderers.length,
    rendererRssMb: mb(renderers.reduce((sum, row) => sum + row.rssKb, 0)),
    helpers: rows.length,
    helperRssMb: mb(rows.reduce((sum, row) => sum + row.rssKb, 0)),
    mainRssMb: Math.round(process.memoryUsage().rss / 104_857.6) / 10,
    // Every window but the smoke's hidden Ryco window is a tab's host.
    hostWindows: BrowserWindow.getAllWindows().length - 1,
  };
  step(`processes ${JSON.stringify(sample)}`);
  return sample;
}

async function main() {
  let exitCode = 0;
  let browser: EmbeddedComputerBrowser | undefined;
  let owner: BrowserWindow | undefined;
  const samples: ProcessSample[] = [];
  try {
    await app.whenReady();
    step(`electron ${process.versions.electron}, main pid ${process.pid}`);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const url = (n: number) => `${origin}/tab/${n}`;

    // The hidden "Ryco window" that hosts the Browser panel.
    owner = new BrowserWindow({
      width: 1000,
      height: 760,
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    await owner.loadURL(
      "data:text/html;charset=utf-8,<style>body{background:%23232228;color:white;font:16px system-ui;padding:16px}</style>Ryco · Browser panel fixture",
    );
    browser = new EmbeddedComputerBrowser();
    const internals = browser as unknown as BudgetInternals;
    /** Advances the virtual clock and fires the budget's pending timer now, as it would have fired. */
    const elapse = (ms: number) => {
      skew += ms;
      clearTimeout(internals.budgetTimer);
      internals.budgetTimer = undefined;
      internals.budgetDueAt = Number.POSITIVE_INFINITY;
      internals.applyBudget();
    };
    const driver = new BrowserComputerDriver(
      new Map<ComputerBrowser, BrowserTransport>([["ryco", browser]]),
    );
    const controller = new ComputerPolicyController({
      policy: { ...DEFAULT_COMPUTER_POLICY, enabled: true, browsers: ["ryco"] },
      consent: async () => "once",
      persist: () => {},
      activity: () => {},
      cancel: () => driver.stop(),
    });
    const execute = (args: Record<string, unknown>) => {
      const request: ComputerUseRequest = {
        sessionId: "smoke",
        threadId: "smoke-thread",
        turnId: "smoke-turn",
        tool: "browser",
        args,
      };
      return controller.execute(request, new AbortController().signal, (context) =>
        driver.execute(context, "ryco"),
      );
    };
    const signal = new AbortController().signal;
    const ids: string[] = [];
    const tabState = (n: number) => {
      const tab = browser!.state().tabs.find((item) => item.id === ids[n - 1]);
      assert(tab, `tab ${n} is listed`);
      return tab;
    };
    const suspendedTabs = () =>
      ids.flatMap((id, index) =>
        browser!.state().tabs.find((tab) => tab.id === id)?.suspended ? [index + 1] : [],
      );
    const liveTabs = () =>
      ids.flatMap((id, index) =>
        browser!.state().tabs.find((tab) => tab.id === id)?.suspended ? [] : [index + 1],
      );
    /** Tab `n`'s current page (a revived tab has a new one under the same id). */
    const page = (n: number) => {
      const contents = internals.entries.get(ids[n - 1]!)?.live?.view.webContents;
      assert(contents && !contents.isDestroyed(), `tab ${n} has a live page`);
      return contents;
    };
    const evaluate = <T>(n: number, expression: string) =>
      page(n).executeJavaScript(expression) as Promise<T>;
    const waitFor = async (label: string, test: () => boolean, ms: number) => {
      const deadline = realNow() + ms;
      while (!test()) {
        if (realNow() > deadline) throw new Error(`Timed out waiting for ${label}.`);
        await delay(100);
      }
    };
    const loaded = (n: number) =>
      waitFor(
        `tab ${n} to load`,
        () => {
          const tab = tabState(n);
          return !tab.suspended && !tab.loading && tab.url === url(n);
        },
        15_000,
      );
    /** Timer ticks per second of tab `n`'s page over `ms` of real time (10/s unthrottled). */
    const tickRate = async (n: number, ms: number) => {
      const before = await evaluate<number>(n, "window.__ticks");
      await delay(ms);
      const after = await evaluate<number>(n, "window.__ticks");
      return Math.round(((after - before) * 10_000) / ms) / 10;
    };
    const describePage = async (n: number) => ({
      visibility: await evaluate<string>(n, "document.visibilityState"),
      changes: await evaluate<number>(n, "window.__vis"),
      throttling: page(n).getBackgroundThrottling(),
      pid: page(n).getOSProcessId(),
    });
    /**
     * A full-size capture of tab `n` for the PR. A throttled page in a hidden window has no frame,
     * so the page is unthrottled until it paints and then restored (budget state is untouched).
     */
    const capture = async (n: number, name: string) => {
      const contents = page(n);
      const throttled = contents.getBackgroundThrottling();
      if (throttled) contents.setBackgroundThrottling(false);
      let image: NativeImage | undefined;
      try {
        for (let attempt = 1; !image; attempt += 1) {
          try {
            image = await contents.capturePage();
            if (image.isEmpty()) throw new Error("empty capture");
          } catch (error) {
            if (attempt >= 40) throw error;
            image = undefined;
            await delay(50);
          }
        }
      } finally {
        if (throttled && !contents.isDestroyed()) contents.setBackgroundThrottling(true);
      }
      if (shots) writeFileSync(join(shots, `${name}.png`), image.toPNG());
      step(`captured ${name} (${image.getSize().width}x${image.getSize().height})`);
      return image;
    };
    /** The product's thumbnail capture (BrowserPanel preview), retried until it succeeds. */
    const previewCapture = async (n: number) => {
      const started = realNow();
      const errors: string[] = [];
      for (;;) {
        try {
          const src = await browser!.capture(ids[n - 1]!);
          return { src, errors, ms: realNow() - started };
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
          if (errors.length >= 60) throw error;
          await delay(50);
        }
      }
    };

    samples.push(sampleProcesses("baseline (hidden Ryco window, no tabs)"));

    // 1. Ten tabs in one project fit the live cap.
    for (let n = 1; n <= BROWSER_LIVE_TAB_LIMIT; n += 1) {
      const tab = await browser.open(url(n), false, signal, PROJECT);
      ids.push(tab.id);
    }
    await delay(500);
    assert.deepEqual(suspendedTabs(), [], "ten tabs stay live");
    const fresh = await describePage(5);
    step(`tab 5 page: ${JSON.stringify(fresh)}`);
    assert.equal(fresh.visibility, "hidden", "a user's tab in its hidden host is hidden");
    assert.equal(fresh.throttling, true, "a user's hidden tab is throttled");
    step(
      `renderer pids of the ten pages: ${new Set(ids.map((_id, index) => page(index + 1).getOSProcessId())).size} distinct; host windows' own renderer pids: ${JSON.stringify(
        BrowserWindow.getAllWindows()
          .filter((window) => window !== owner)
          .map((window) => window.webContents.getOSProcessId()),
      )}`,
    );
    await delay(1_500);
    samples.push(sampleProcesses("10 live tabs"));

    // Unsaved page state in tab 1, captured before the budget unloads it.
    await evaluate(1, "document.getElementById('draft').value='Unsaved draft'");
    await capture(1, "1-before-suspension");

    // 2. The 11th tab: the least recently used hidden tab is suspended at once (live cap).
    ids.push((await browser.open(url(TABS), false, signal, PROJECT)).id);
    await waitFor("tab 1 to be suspended", () => tabState(1).suspended === true, 5_000);
    assert.deepEqual(suspendedTabs(), [1], "only the least recently used tab is suspended");
    const suspendedOne = tabState(1);
    assert.equal(suspendedOne.url, url(1), "a suspended tab keeps its address");
    assert.equal(suspendedOne.title, "Fixture tab 1", "a suspended tab keeps its title");
    assert.equal(internals.entries.get(ids[0]!)?.live, null, "the suspended page is gone");
    await delay(2_000);
    samples.push(sampleProcesses("11 tabs, 1 suspended (live cap)"));
    assert.equal(samples.at(-1)!.hostWindows, BROWSER_LIVE_TAB_LIMIT, "its host window is gone");

    // 3. Showing the suspended tab in the panel reloads it at its address under the same id, and
    //    the next least recently used tab makes room.
    const panel = { owner: "ryco-window", x: 0, y: 40, width: 1000, height: 660 };
    browser.surface({ ...panel, tab: ids[0]! }, owner);
    await loaded(1);
    await waitFor("tab 2 to be suspended", () => tabState(2).suspended === true, 5_000);
    assert.deepEqual(suspendedTabs(), [2], "showing tab 1 suspends tab 2 instead");
    assert.equal(tabState(1).presentation, "panel");
    assert.equal(loads.get("/tab/1"), 2, "tab 1 reloaded from its address");
    assert.equal(await evaluate(1, "document.getElementById('draft').value"), "");
    await capture(1, "2-revived-on-show");

    // 4. Ryco is hidden: the panel unmounts tab 1, which stays live as the last-shown tab. The
    //    project has 10 live tabs, over its warm limit of 6: after a real minute its least recently
    //    used hidden tabs are suspended down to 6, by the budget's own timer.
    browser.surface({ ...panel, tab: null }, owner);
    step(`hidden tab 11 page: ${JSON.stringify(await describePage(TABS))}`);
    const hiddenRate = await tickRate(TABS, 5_000);
    step(`hidden tab 11 ticks/s (throttled): ${hiddenRate}`);
    assert(hiddenRate <= THROTTLED_RATE, "a hidden tab's 100 ms timer is throttled");
    step("waiting for the per-project pressure stage (real 60 s timer)");
    await waitFor(
      "the project to shed its excess",
      () => liveTabs().length === BROWSER_WARM_TAB_LIMIT,
      100_000,
    );
    await delay(1_000);
    assert.deepEqual(liveTabs(), [1, 7, 8, 9, 10, 11], "only the excess goes; tab 1 stays");
    step(`hidden tab 11 page after a minute: ${JSON.stringify(await describePage(TABS))}`);
    const throttledRate = await tickRate(TABS, 5_000);
    step(`hidden tab 11 ticks/s after a minute hidden (throttled): ${throttledRate}`);
    assert(throttledRate <= THROTTLED_RATE);
    samples.push(sampleProcesses("after the pressure stage (6 live)"));

    // 5. An agent read holds a hidden tab unthrottled for its claim window.
    await execute({ action: "observe", tab: ids[TABS - 1] });
    assert.equal(page(TABS).getBackgroundThrottling(), false, "agent use disables throttling");
    const agentRate = await tickRate(TABS, 3_000);
    step(`hidden tab 11 ticks/s during the agent claim: ${agentRate}`);
    assert(agentRate >= UNTHROTTLED_RATE, "an agent's tab runs at full rate");
    step(`hidden tab 11 page during the agent claim: ${JSON.stringify(await describePage(TABS))}`);
    elapse(COMPUTER_TARGET_CLAIM_MS + 1_000);
    assert.equal(page(TABS).getBackgroundThrottling(), true, "throttled again after the claim");
    await delay(500);
    const released = await describePage(TABS);
    const releasedRate = await tickRate(TABS, 3_000);
    step(`hidden tab 11 after the claim: ${JSON.stringify(released)}, ticks/s ${releasedRate}`);
    // Focus emulation (the agent's session) would keep it visible: it ends with the claim window.
    assert.equal(released.visibility, "hidden", "an agent's tab is hidden again after its claim");
    assert(releasedRate <= THROTTLED_RATE, "an agent's tab is throttled again after its claim");
    assert.equal(page(TABS).debugger.isAttached(), true, "the agent's session stays open");

    // 6. An agent command on a suspended tab reloads it and says so. The project is back at 7 live
    //    tabs, so its least recently used tab hidden for over a minute (tab 7) makes room.
    const revived = await execute({ action: "observe", tab: ids[2] });
    const last = revived.content.at(-1);
    assert(last?.type === "text" && last.text === REVIVED_TAB_NOTE, "the result notes the reload");
    assert.equal(tabState(3).suspended, undefined, "tab 3 is live again");
    assert.equal(loads.get("/tab/3"), 2, "tab 3 reloaded from its address");
    assert.match(JSON.stringify(decoded(revived)), /Fixture tab 3/u);
    await waitFor("tab 7 to be suspended", () => tabState(7).suspended === true, 5_000);
    assert.deepEqual(liveTabs(), [1, 3, 8, 9, 10, 11], "the agent's tab is held, tab 7 goes");

    // 7. Ten minutes hidden: every tab but the last-shown one is suspended; an agent's observation
    //    of a page that was unloaded since is refused with the reload note.
    const observed = decoded(await execute({ action: "observe", tab: ids[TABS - 1] }));
    const draft = observed.elements.find((element: { name: string }) => element.name === "Draft");
    assert(draft?.ref, "the observation lists the draft field");
    elapse(BROWSER_IDLE_SUSPEND_MS + 1_000);
    await delay(2_000);
    assert.deepEqual(liveTabs(), [1], "only the last-shown tab stays live");
    samples.push(sampleProcesses("after 10 minutes idle (1 live)"));
    assert.equal(samples.at(-1)!.hostWindows, 1, "suspended tabs keep no host window");
    const loadsBefore = loads.get(`/tab/${TABS}`) ?? 0;
    await assert.rejects(
      execute({ action: "fill", tab: ids[TABS - 1], ref: draft.ref, text: "agent" }),
      (error: Error) => error.message === REVIVED_TAB_ERROR,
    );
    await loaded(TABS);
    assert.equal(loads.get(`/tab/${TABS}`), loadsBefore + 1, "tab 11 reloaded for the agent");
    assert.equal(await evaluate(TABS, "document.getElementById('draft').value"), "");

    // 8. The thumbnail preview: a capture holds its tab live and unthrottled for 5 s, then the
    //    budget's timer throttles it again; capturing a suspended tab revives it.
    elapse(COMPUTER_TARGET_CLAIM_MS + 1_000); // Tab 11's agent hold ends.
    assert.equal(page(TABS).getBackgroundThrottling(), true);
    const changesBefore = await evaluate<number>(TABS, "window.__vis");
    const first = await previewCapture(TABS);
    step(
      `first preview capture of hidden throttled tab 11: ${first.errors.length} failed calls (${JSON.stringify([...new Set(first.errors)])}), ok after ${first.ms} ms`,
    );
    assert.deepEqual(first.errors, [], "the first preview capture of a throttled tab succeeds");
    assert.equal(page(TABS).getBackgroundThrottling(), false, "a previewed tab is unthrottled");
    for (let index = 0; index < 3; index += 1) {
      await delay(2_000);
      await browser.capture(ids[TABS - 1]!);
      assert.equal(page(TABS).getBackgroundThrottling(), false, "a previewed tab is unthrottled");
    }
    await delay(2_000);
    const changesAfter = await evaluate<number>(TABS, "window.__vis");
    step(`tab 11 visibility changes over 4 previews (2 s apart): ${changesAfter - changesBefore}`);
    assert(
      changesAfter - changesBefore <= 2,
      "previews 2 s apart do not toggle visibility each time",
    );
    await delay(BROWSER_PREVIEW_HOLD_MS + 1_000);
    assert.equal(page(TABS).getBackgroundThrottling(), true, "throttled again after the hold");
    const afterHold = await describePage(TABS);
    step(`hidden tab 11 page after the hold: ${JSON.stringify(afterHold)}`);
    assert.equal(afterHold.visibility, "hidden", "hidden again after the preview hold");
    await assert.rejects(browser.capture(ids[7]!), /reloading/u);
    await loaded(8);
    // The revived page loaded unthrottled (the preview holds it) and Electron never showed it.
    const revivedPreview = await previewCapture(8);
    step(
      `preview capture of revived tab 8: ${revivedPreview.errors.length} failed calls (${JSON.stringify([...new Set(revivedPreview.errors)])}), ok after ${revivedPreview.ms} ms`,
    );
    assert.deepEqual(revivedPreview.errors, [], "a page revived by the preview can be captured");
    const thumbnail = revivedPreview.src;
    assert.match(thumbnail, /^data:image\/png;base64,/u);
    if (shots)
      writeFileSync(
        join(shots, "3-preview-thumbnail-after-revival.png"),
        Buffer.from(thumbnail.split(",")[1]!, "base64"),
      );

    // 9. Nothing was shown or focused, and no tab was lost.
    assert.equal(browser.state().tabs.length, TABS, "suspension never closes a tab");
    assert(
      BrowserWindow.getAllWindows().every((window) => !window.isVisible()),
      "Every window must stay hidden",
    );
    assert.equal(BrowserWindow.getFocusedWindow(), null, "No window may take focus");
    controller.stop();
    browser.dispose();
    await delay(1_500);
    samples.push(sampleProcesses("after dispose"));
    console.log(`tab-budget smoke: samples ${JSON.stringify(samples)}`);
    console.log(
      "PASS: tab budget (live cap at once, revival on show/agent/capture under the same id, per-project pressure by the real timer, last-shown exemption, 10-minute idle, hidden tabs throttled, agent claim and preview hold unthrottle and end, preview captures of hidden pages, revival note and stale-observation refusal).",
    );
  } catch (error) {
    console.error(error);
    exitCode = 1;
  } finally {
    clearTimeout(watchdog);
    browser?.dispose();
    owner?.destroy();
    server.closeAllConnections();
    server.close();
    rmSync(directory, { recursive: true, force: true });
    app.exit(exitCode);
  }
}
void main();
