/**
 * The element picker on real Electron with hidden windows only: a disposable profile, a hidden
 * "Ryco window" with the fixture tab docked in its panel, synthetic input into that tab's own
 * webContents (`sendInputEvent`) and CDP input on its own debugger session. No OS input, no
 * clipboard, no native helper, no shown or focused window, and the app never registers as a URL
 * handler. It proves what unit tests cannot: that Chromium's inspect overlay reports picks in a
 * docked WebContentsView, that the overlay and the picked highlight are drawn, and that agent input
 * after a pick reaches the page.
 *
 * Run with `node apps/desktop/scripts/computer-use-smoke.mjs picker`. RYCO_SMOKE_TMP is the parent
 * of the temporary profile (the launcher passes its own temporary directory). With
 * RYCO_SMOKE_SHOT_DIR set, it writes captures of the fixture tab (webContents.capturePage) there;
 * RYCO_SMOKE_TRACE=1 logs the page's debugger events.
 */
import { app, BrowserWindow, webContents, type NativeImage, type WebContents } from "electron";
import { createServer } from "node:http";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ComputerBrowser, ComputerUseRequest, ComputerUseResult } from "@ryco/contracts";
import { BrowserComputerDriver, type BrowserTransport } from "../src/computerUse/browser.ts";
import { EmbeddedComputerBrowser } from "../src/computerUse/embeddedBrowser.ts";
import { ComputerPolicyController, DEFAULT_COMPUTER_POLICY } from "../src/computerUse/policy.ts";

const directory = mkdtempSync(
  join(process.env.RYCO_SMOKE_TMP || tmpdir(), "ryco-element-picker-smoke-"),
);
app.setPath("userData", directory);
app.on("window-all-closed", () => {});
const shots = process.env.RYCO_SMOKE_SHOT_DIR;
const watchdog = setTimeout(() => {
  console.error("FAIL: the element picker smoke did not finish within 180 s.");
  app.exit(2);
}, 180_000);

/** The docked fixture page: a Name field, a Save button that copies it into #result. */
const PROJECT_PREVIEW_PAGE =
  '<title>Shared project preview</title><style>body{font:20px system-ui;padding:40px;background:#f5f4ef}input,button{font:inherit;padding:10px}h1{font-size:32px}</style><h1>Project preview</h1><label>Name <input aria-label="Name" id="name"></label><button onclick="document.getElementById(\'result\').textContent=document.getElementById(\'name\').value">Save</button><p id="result">Ready</p>';
/** A frame that counts the clicks it receives. */
const FRAME_PAGE =
  '<title>Checkout widget</title><style>body{margin:0}button{width:100%;height:100vh;font:20px system-ui}</style><button id="pay" onclick="document.body.dataset.clicks=String(Number(document.body.dataset.clicks||0)+1)">Pay</button>';
const embeddingPage = (frameUrl: string) =>
  `<title>Embedded widget</title><style>body{font:20px system-ui;padding:40px}</style><h1>Checkout</h1><iframe id="checkout" title="Payment" src="${frameUrl}" style="width:320px;height:120px;border:0"></iframe>`;
/**
 * `/embedded` embeds `/frame` from `localhost` (another site than `127.0.0.1`, so Chromium gives it
 * its own renderer process); `/same-site` embeds it from the page's own origin (same process).
 */
const server = createServer((request, response) => {
  response.setHeader("content-type", "text/html");
  const address = server.address();
  const port = address && typeof address !== "string" ? address.port : 0;
  if (request.url === "/frame") return void response.end(FRAME_PAGE);
  if (request.url === "/embedded")
    return void response.end(embeddingPage(`http://localhost:${port}/frame`));
  if (request.url === "/same-site")
    return void response.end(embeddingPage(`http://127.0.0.1:${port}/frame`));
  response.end(PROJECT_PREVIEW_PAGE);
});

interface PickerSmoke {
  readonly browser: EmbeddedComputerBrowser;
  readonly tabId: string;
  /** An agent browser action through the policy and driver, on the fixture tab. */
  execute(args: Record<string, unknown>): Promise<ComputerUseResult>;
  /** `http://127.0.0.1:<port>`. */
  readonly origin: string;
  /** Unmounts and re-mounts the fixture tab in its panel (a panel or tab switch). */
  remount(): void;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const step = (label: string) => console.log(`picker smoke: ${label}`);
const decoded = (result: ComputerUseResult) =>
  JSON.parse((result.content[0] as { text: string }).text);

/** Pixels of `image` matching `test(r, g, b)` (BGRA bitmap on macOS and Windows, RGBA elsewhere). */
function countPixels(image: NativeImage, test: (r: number, g: number, b: number) => boolean) {
  const bitmap = image.toBitmap();
  const bgra = process.platform === "darwin" || process.platform === "win32";
  let count = 0;
  for (let index = 0; index + 3 < bitmap.length; index += 4) {
    const r = bitmap[index + (bgra ? 2 : 0)]!;
    const g = bitmap[index + 1]!;
    const b = bitmap[index + (bgra ? 0 : 2)]!;
    if (test(r, g, b)) count += 1;
  }
  return count;
}
/** Ryco purple (#b1a4ff) of the picked highlight's border, blended over the light fixture page. */
const isPickedPurple = (r: number, g: number, b: number) =>
  b >= 235 && r >= 165 && r <= 205 && g >= 150 && g <= 195 && b - g >= 50;
/** Chromium inspect overlay's content colour (DevTools blue, rgb 111 168 220 at 0.66) over the page. */
const isInspectBlue = (r: number, g: number, b: number) =>
  b >= 195 && b <= 235 && g >= 170 && g <= 210 && r >= 120 && r <= 175 && b - r >= 45;

async function main() {
  let exitCode = 0;
  let browser: EmbeddedComputerBrowser | undefined;
  let owner: BrowserWindow | undefined;
  try {
    await app.whenReady();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
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
    const tab = await browser.open(origin, false, new AbortController().signal, "fixture-project");
    const surface = { owner: "surface-a", tab: tab.id, x: 350, y: 70, width: 600, height: 550 };
    browser.surface(surface, owner);
    assert.equal(browser.state().tabs[0]?.presentation, "panel");
    // A pick needs the tab shown to the user; this window stays hidden, so the real check refuses.
    await assert.rejects(browser.pick(tab.id), /Show this tab in the Browser panel/u);
    step("a hidden panel refuses a pick");
    // Smoke only: treat the docked tab as shown. A window's visibility is the one thing a hidden run
    // cannot provide; the unit tests cover that check.
    const docked = browser;
    docked.presented = (id) =>
      docked.state().tabs.some((entry) => entry.id === id && entry.presentation === "panel");
    const driver = new BrowserComputerDriver(
      new Map<ComputerBrowser, BrowserTransport>([["ryco", browser]]),
    );
    const policy = new ComputerPolicyController({
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
        args: { ...args, tab: tab.id },
      };
      return policy.execute(request, new AbortController().signal, (context) =>
        driver.execute(context, "ryco"),
      );
    };
    const shell = owner;
    if (shots) mkdirSync(shots, { recursive: true });
    await smokeElementPicker(
      {
        browser,
        tabId: tab.id,
        execute,
        origin,
        remount: () => {
          docked.surface({ ...surface, tab: null }, shell);
          docked.surface(surface, shell);
        },
      },
      shots ? (name, image) => writeFileSync(join(shots, `${name}.png`), image.toPNG()) : undefined,
    );
    assert(
      BrowserWindow.getAllWindows().every((window) => !window.isVisible()),
      "Every window must stay hidden",
    );
    assert.equal(BrowserWindow.getFocusedWindow(), null, "No window may take focus");
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

/** Runs every picker check on the docked fixture tab; leaves it on `/` with no pick and no agent hold. */
async function smokeElementPicker(
  smoke: PickerSmoke,
  shot: ((name: string, image: NativeImage) => void) | undefined,
): Promise<void> {
  const { browser, tabId, execute, origin } = smoke;
  const guest = webContents.fromId(Number(tabId));
  assert(guest);
  const port = Number(new URL(origin).port);
  const within = <T>(promise: Promise<T>, label: string, ms = 5_000) =>
    Promise.race([
      promise,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error(`${label} timed out`)), ms),
      ),
    ]);
  const pickerState = () => browser.state().tabs.find(({ id }) => id === tabId)?.picker;
  const evaluate = (contents: Pick<WebContents, "executeJavaScript">, expression: string) =>
    contents.executeJavaScript(expression) as Promise<unknown>;
  const center = async (selector: string) =>
    (await evaluate(
      guest,
      `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`,
    )) as { x: number; y: number };
  /** Synthetic input into the page's own widget (the path a user's click takes on the main frame). */
  const clickAt = ({ x, y }: { x: number; y: number }) => {
    guest.sendInputEvent({ type: "mouseMove", x, y });
    guest.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
    guest.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
  };
  /**
   * CDP input on the page's debugger session. Chromium hit-tests it across frames like real input,
   * so a click over a cross-site frame goes to that frame's renderer (sendInputEvent does not).
   */
  const routedClickAt = async (
    send: (method: string, params: Record<string, unknown>) => Promise<unknown>,
    { x, y }: { x: number; y: number },
  ) => {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    for (const type of ["mousePressed", "mouseReleased"])
      await send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
  };
  const onPickerSession = (method: string, params: Record<string, unknown>) =>
    guest.debugger.sendCommand(method, params);
  /** Clicks with `click` every 250 ms until `pending` settles (Chromium's inspect tool reports the pick). */
  const clickUntilSettled = async <T>(pending: Promise<T>, click: () => unknown, label: string) => {
    const settled = pending.then(
      () => true,
      () => true,
    );
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (await Promise.race([settled, delay(250).then(() => false)])) break;
      await click();
    }
    return within(pending, label);
  };
  const waitUntilPicking = async () => {
    for (let attempt = 0; attempt < 40 && pickerState() !== "picking"; attempt += 1)
      await delay(25);
    assert.equal(pickerState(), "picking");
    // Let the inspect-mode commands land before anything else happens.
    await delay(250);
  };
  const waitUntilDetached = async () => {
    for (let attempt = 0; attempt < 40 && guest.debugger.isAttached(); attempt += 1)
      await delay(25);
    assert.equal(guest.debugger.isAttached(), false, "Every ended pick must let the session go");
  };
  /** Starts a pick and clicks `selector` until Chromium's inspect tool reports it. */
  const pickAt = async (selector: string) => {
    const pending = browser.pick(tabId);
    await waitUntilPicking();
    const point = await center(selector);
    return clickUntilSettled(pending, () => clickAt(point), `Picking ${selector}`);
  };
  /** The loaded child frame whose URL is `url`. */
  const loadedFrame = async (url: string) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const frame = guest.mainFrame.frames.find((candidate) => candidate.url === url);
      if (frame && (await frame.executeJavaScript("document.readyState")) === "complete")
        return frame;
      await delay(50);
    }
    throw new Error(`The frame ${url} did not load`);
  };
  const navigate = async (path: string) => {
    await browser.command({ action: "navigate", tab: tabId, url: `${origin}${path}` });
    assert.equal(guest.getURL(), `${origin}${path}`);
  };
  /** The fixture page as shown (webContents.capturePage); a hidden page's first capture can fail. */
  const capture = async (name: string) => {
    step(`capture ${name}`);
    let image: NativeImage | undefined;
    for (let attempt = 1; !image; attempt += 1) {
      try {
        image = await guest.capturePage();
      } catch (error) {
        step(`capture ${name} attempt ${attempt}: ${String(error)}`);
        if (attempt >= 8) throw error;
        await delay(250);
      }
    }
    shot?.(name, image);
    return image;
  };
  const resultText = () => evaluate(guest, "document.getElementById('result').textContent");

  if (process.env.RYCO_SMOKE_TRACE)
    guest.debugger.on("message", (_event, method, _params, sessionId) =>
      step(`event ${method}${sessionId ? ` (${sessionId.slice(0, 8)})` : ""}`),
    );
  const savePoint = await center("button");
  // The hidden window's page has never painted, and Chromium drops input to a page that never
  // painted; a capture paints it.
  const before = await capture("before-pick");
  // Baseline: a user click reaches the docked page.
  await evaluate(guest, "document.getElementById('name').value = 'User click'");
  clickAt(savePoint);
  for (let attempt = 0; attempt < 20 && (await resultText()) !== "User click"; attempt += 1)
    await delay(50);
  assert.equal(await resultText(), "User click", "A user click must reach the docked page");
  await evaluate(
    guest,
    "document.getElementById('name').value = ''; document.getElementById('result').textContent = 'Ready'",
  );
  // 1-3. Pick the Save button: Chromium's inspect tool reports the click, main describes it.
  step("1-3 pick the Save button");
  const savePick = browser.pick(tabId);
  await waitUntilPicking();
  // The inspect overlay outlines what the pointer is over, with its info tooltip.
  guest.sendInputEvent({ type: "mouseMove", x: savePoint.x, y: savePoint.y });
  await delay(400);
  const hover = await capture("picking-hover-save");
  const save = await clickUntilSettled(savePick, () => clickAt(savePoint), "Picking the button");
  assert.equal(save.kind, "picked", `Expected a picked button, got ${JSON.stringify(save)}`);
  assert(save.kind === "picked");
  console.log(`picked: ${JSON.stringify(save.element)}`);
  assert.equal(save.element.tagName, "button");
  assert.equal(save.element.name, "Save");
  assert.equal(save.element.role, "button");
  assert.match(save.element.selector, /button/u);
  assert.equal(save.element.url, `${origin}/`);
  assert.equal(save.element.pageTitle, "Shared project preview");
  assert(save.element.box && save.element.box.width > 0 && save.element.box.height > 0);
  assert.equal(pickerState(), "picked");
  assert.equal(await resultText(), "Ready", "A click while picking must not reach the page");
  await delay(250);
  const picked = await capture("picked-save-highlight");
  const pixels = {
    blueBefore: countPixels(before, isInspectBlue),
    blueHover: countPixels(hover, isInspectBlue),
    purpleBefore: countPixels(before, isPickedPurple),
    purplePicked: countPixels(picked, isPickedPurple),
  };
  console.log(`element picker pixels: ${JSON.stringify(pixels)}`);
  assert(
    pixels.blueHover > pixels.blueBefore + 200,
    "Chromium's inspect overlay must outline the hovered element",
  );
  assert(
    pixels.purplePicked > pixels.purpleBefore + 200,
    "The picked element must be highlighted in Ryco purple",
  );
  // 4. A form field never carries its value. Re-picking takes over the picked session.
  step("4 pick the Name field");
  await evaluate(guest, "document.getElementById('name').value = 'private value'");
  const field = await pickAt("#name");
  assert(field.kind === "picked", `Expected a picked field, got ${JSON.stringify(field)}`);
  console.log(`picked: ${JSON.stringify(field.element)}`);
  assert.equal(field.element.selector, "#name");
  assert.equal(field.element.tagName, "input");
  assert.equal(field.element.text, null);
  assert.equal(field.element.name, null);
  assert(!JSON.stringify(field).includes("private value"));
  // 5. end-pick turns everything off and ends the session the picker held alone; the highlight
  // goes and user clicks reach the page again.
  step("5 end-pick");
  await browser.command({ action: "end-pick", tab: tabId });
  assert.equal(pickerState(), undefined);
  assert.equal(guest.debugger.isAttached(), false, "Ending a lone pick must detach");
  await delay(250);
  const ended = await capture("after-end-pick");
  assert(
    countPixels(ended, isPickedPurple) < pixels.purpleBefore + 50,
    "end-pick must hide the highlight",
  );
  await evaluate(guest, "document.getElementById('name').value = 'User click after the pick'");
  clickAt(savePoint);
  await delay(250);
  assert.equal(await resultText(), "User click after the pick");
  // 6. An agent read keeps a pick, and so does "Stop agent"; an agent click ends the pick first and
  // reaches the page.
  step("6 agent precedence");
  const pending = browser.pick(tabId);
  await waitUntilPicking();
  const observed = decoded(await execute({ action: "observe" }));
  assert.equal(pickerState(), "picking", "An agent read must keep the user's pick");
  const saveRef = observed.elements.find((element: { name: string }) => element.name === "Save");
  assert(saveRef, "The agent must see the Save button");
  browser.stop();
  assert.equal(pickerState(), "picking", "Stopping the agent must keep the user's pick");
  assert.equal(
    guest.debugger.isAttached(),
    true,
    "Stopping the agent must keep the pick's session",
  );
  await evaluate(guest, "document.getElementById('name').value = 'Clicked by the agent'");
  await execute({ action: "click", ref: saveRef.ref });
  assert.deepEqual(await within(pending, "Agent precedence"), {
    kind: "cancelled",
    reason: "agent",
  });
  assert.equal(
    await resultText(),
    "Clicked by the agent",
    "The agent's click must reach the page, not the inspect tool",
  );
  const after = decoded(await execute({ action: "observe" }));
  assert(Array.isArray(after.elements), "The agent must observe again after the pick ended");
  // A pick cannot start while an agent command runs (agentBusy, counted synchronously by send) or
  // while a mutating agent action holds its bracket.
  const signal = new AbortController().signal;
  const busy = browser.send(
    tabId,
    "Runtime.evaluate",
    { expression: "new Promise((done) => setTimeout(done, 500))", awaitPromise: true },
    signal,
  );
  await assert.rejects(browser.pick(tabId), /The agent is using this tab/u);
  await busy;
  const endMutation = await browser.beginAgentMutation(tabId, signal);
  await assert.rejects(browser.pick(tabId), /The agent is using this tab/u);
  endMutation();
  // The agent's hold ends here, so the steps below see lone picks again.
  browser.stop();
  assert.equal(guest.debugger.isAttached(), false);
  // 7. A navigation, Escape in the page, a panel switch and a new pick each end a pick.
  step("7 navigation, Escape, panel switch, replacement");
  const navigating = browser.pick(tabId);
  await waitUntilPicking();
  await navigate("/");
  assert.deepEqual(await within(navigating, "Navigation"), {
    kind: "cancelled",
    reason: "navigation",
  });
  const escaped = browser.pick(tabId);
  await waitUntilPicking();
  guest.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
  guest.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
  assert.deepEqual(await within(escaped, "Escape"), { kind: "cancelled", reason: "user" });
  const hidden = browser.pick(tabId);
  await waitUntilPicking();
  smoke.remount();
  assert.deepEqual(await within(hidden, "Panel switch"), { kind: "cancelled", reason: "hidden" });
  const replaced = browser.pick(tabId);
  await waitUntilPicking();
  const replacement = browser.pick(tabId);
  assert.deepEqual(await within(replaced, "Replacing pick"), {
    kind: "cancelled",
    reason: "replaced",
  });
  await waitUntilPicking();
  await browser.command({ action: "end-pick", tab: tabId });
  assert.deepEqual(await within(replacement, "end-pick"), { kind: "cancelled", reason: "user" });
  await waitUntilDetached();
  // 8. A cross-site (out-of-process) frame: Chromium sends input over it to the frame's own
  // renderer, so the picker attaches to the frame and gives it its own inspect mode. A click inside
  // picks the frame's element in the page and never reaches the frame.
  step("8 cross-site frame");
  await navigate("/embedded");
  const widget = await loadedFrame(`http://localhost:${port}/frame`);
  assert.notEqual(
    widget.osProcessId,
    guest.mainFrame.osProcessId,
    "The fixture frame must be out-of-process (site isolation)",
  );
  const attachedFrames: string[] = [];
  const onMessage = (_event: unknown, method: string, params: Record<string, any>) => {
    if (method === "Target.attachedToTarget" && params.targetInfo?.type === "iframe")
      attachedFrames.push(String(params.targetInfo.url));
  };
  guest.debugger.on("message", onMessage);
  try {
    const framePick = browser.pick(tabId);
    await waitUntilPicking();
    for (let attempt = 0; attempt < 40 && attachedFrames.length === 0; attempt += 1)
      await delay(25);
    assert.deepEqual(attachedFrames, [`http://localhost:${port}/frame`]);
    await delay(250); // The frame's inspect mode.
    const framePoint = await center("#checkout");
    const embedded = await clickUntilSettled(
      framePick,
      () => routedClickAt(onPickerSession, framePoint),
      "Picking inside the cross-site frame",
    );
    assert(
      embedded.kind === "picked",
      `Expected the frame element, got ${JSON.stringify(embedded)}`,
    );
    console.log(`picked: ${JSON.stringify(embedded.element)}`);
    assert.equal(embedded.element.tagName, "iframe");
    assert.equal(embedded.element.selector, "#checkout");
    assert.equal(embedded.element.name, "Payment");
    assert.equal(embedded.element.url, `${origin}/embedded`);
    assert.equal(
      await widget.executeJavaScript("document.body.dataset.clicks || '0'"),
      "0",
      "A click while picking must not reach the cross-site frame",
    );
    await delay(250);
    await capture("picked-cross-site-frame");
    await browser.command({ action: "end-pick", tab: tabId });
    assert.equal(guest.debugger.isAttached(), false, "Ending a lone pick must detach");
    // After the pick, the frame takes clicks again.
    await routedClickAt(
      (method, params) => browser.send(tabId, method, params, signal),
      framePoint,
    );
    await delay(250);
    assert.equal(await widget.executeJavaScript("document.body.dataset.clicks || '0'"), "1");
    browser.stop();
  } finally {
    guest.debugger.removeListener("message", onMessage);
  }
  // 9. A same-site frame shares the page's renderer: the page's inspect tool reports the node inside
  // it, and the picker turns that into the frame's element in the page, as for a cross-site frame.
  step("9 same-site frame");
  await navigate("/same-site");
  const sameSite = await loadedFrame(`${origin}/frame`);
  const framed = browser.pick(tabId);
  await waitUntilPicking();
  const sameSitePoint = await center("#checkout");
  const sameSitePick = await clickUntilSettled(
    framed,
    () => clickAt(sameSitePoint),
    "Picking inside the same-site frame",
  );
  assert(
    sameSitePick.kind === "picked",
    `Expected the frame element, got ${JSON.stringify(sameSitePick)}`,
  );
  console.log(`picked: ${JSON.stringify(sameSitePick.element)}`);
  assert.equal(sameSitePick.element.tagName, "iframe");
  assert.equal(sameSitePick.element.selector, "#checkout");
  assert.equal(sameSitePick.element.name, "Payment");
  assert.equal(sameSitePick.element.url, `${origin}/same-site`);
  assert.equal(await sameSite.executeJavaScript("document.body.dataset.clicks || '0'"), "0");
  await delay(250);
  await capture("picked-same-site-frame");
  await browser.command({ action: "end-pick", tab: tabId });
  await waitUntilDetached();
  await navigate("/");
  console.log(
    "PASS: element picker (inspect overlay and purple highlight drawn, pick, re-pick, form-value redaction, end-pick, agent reads and stop keep a pick, agent click ends it and reaches the page, busy refusal, navigation, Escape, panel switch, replacement, cross-site and same-site frames).",
  );
}
void main();
