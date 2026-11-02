import { app, BrowserWindow, nativeTheme, webContents } from "electron";
import { createServer } from "node:http";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserComputerDriver, type BrowserTransport } from "../src/computerUse/browser.ts";
import { BrowserUploadStore } from "../src/computerUse/browserUploads.ts";
import { newBrowserUploadId } from "@ryco/shared/browserUpload";
import { EmbeddedComputerBrowser } from "../src/computerUse/embeddedBrowser.ts";
import { ComputerPolicyController, DEFAULT_COMPUTER_POLICY } from "../src/computerUse/policy.ts";
import type { ComputerBrowser, ComputerUseRequest } from "@ryco/contracts";

const directory = mkdtempSync(join(tmpdir(), "ryco-computer-browser-smoke-"));
app.setPath("userData", directory);
// A native dialog the shim missed would block this run; never leave Electron behind.
setTimeout(() => app.exit(2), 120_000).unref();
app.commandLine.appendSwitch("remote-debugging-port", "0");
// File chooser interlock. Every debugger is wrapped to record what the product sends: the
// "Choose file" click is withheld unless Page.setInterceptFileChooserDialog {enabled:true}
// succeeded on the current session, so a regression fails the run instead of opening a native
// open panel. The smoke never enables interception itself (that would hide a product bug).
const interceptionSent = new Map<number, boolean[]>();
let chooserClickArmed = false;
app.on("web-contents-created", (_event, contents) => {
  const sent: boolean[] = [];
  interceptionSent.set(contents.id, sent);
  const cdp = contents.debugger;
  const attach = cdp.attach.bind(cdp);
  const detach = cdp.detach.bind(cdp);
  const sendCommand = cdp.sendCommand.bind(cdp);
  let confirmed = false;
  let latest = 0;
  const forget = () => {
    confirmed = false;
    latest += 1;
  };
  cdp.attach = (...args: Parameters<typeof attach>) => {
    forget();
    attach(...args);
  };
  cdp.detach = () => {
    forget();
    detach();
  };
  cdp.on("detach", forget);
  cdp.sendCommand = async (...args: Parameters<typeof sendCommand>): Promise<unknown> => {
    const [method, params] = args as [string, Record<string, unknown> | undefined];
    if (method === "Page.setInterceptFileChooserDialog") {
      forget();
      const sequence = latest;
      const value = await sendCommand(...args);
      sent.push(params?.enabled === true);
      if (sequence === latest) confirmed = params?.enabled === true;
      return value;
    }
    const input =
      method === "Input.dispatchKeyEvent" ||
      (method === "Input.dispatchMouseEvent" &&
        (params?.type === "mousePressed" || params?.type === "mouseReleased"));
    if (chooserClickArmed && input && !confirmed)
      throw new Error(
        "Smoke interlock: file chooser interception is not on for this session, so the click was withheld.",
      );
    return sendCommand(...args);
  };
});
const fixture = `<!doctype html><title>Ryco automation fixture</title><style>:root{color-scheme:light dark}body{font:18px system-ui;padding:60px}input,select,button{font:inherit;padding:12px;margin:12px}#result{margin:12px}footer{margin-top:1400px}</style><h1>Automation fixture</h1><label>Name <input aria-label="Name" id="name"></label><select aria-label="Colour" id="colour"><option value="blue">Blue</option><option value="green">Green</option></select><button id="save">Save sample</button><div id="result" role="status">Waiting</div><label>Read only <input aria-label="Read only" readonly value="Original"></label><fieldset disabled><input aria-label="Disabled" value="Original"></fieldset><div style="position:relative;width:300px"><button id="covered" onclick="document.body.dataset.unwanted='yes'">Covered</button><div style="position:absolute;inset:0;background:#ccc">Cover</div></div><button id="moving" onpointerover="this.style.marginLeft='300px'" onclick="document.body.dataset.unwanted='yes'">Moving</button><button id="alert" onclick="alert('hello')">Alert</button><button id="confirm" onclick="result.textContent = confirm('sure?') ? 'yes' : 'no'">Confirm</button><button id="slow" onclick="fetch('/slow?token=secret').then(() => result.textContent = 'loaded')">Slow</button><p id="scheme"></p><label>Avatar <input type="file" id="file" style="display:none" onchange="uploaded.textContent = 'uploaded ' + this.files[0]?.name + ' ' + this.files[0]?.size"></label><button id="pick" onclick="file.click()">Choose file</button><div id="uploaded">No file</div><footer>End</footer><script>save.onclick=()=>result.textContent='Saved '+nameInput.value+' '+colour.value;const nameInput=document.getElementById('name');console.error('fixture-error');const dark=matchMedia('(prefers-color-scheme: dark)');const showScheme=()=>{scheme.textContent='scheme: '+(dark.matches?'dark':'light')};dark.addEventListener('change',showScheme);showScheme();</script>`;
// Safety: no fixture page opens a dialog on its own (no onload/timer alert, no beforeunload).
// Dialogs only come from agent clicks, under the dialog shim. The file chooser opens only from the
// agent's click on "Choose file" in the hidden tab, the run's last step (interception answers it).
const server = createServer((request, response) => {
  if (request.url?.startsWith("/slow")) {
    setTimeout(() => response.end("ok"), 800);
    return;
  }
  response.setHeader("content-type", "text/html");
  response.end(fixture);
});
let transport: EmbeddedComputerBrowser | undefined;
let uploadsStore: BrowserUploadStore | undefined;
async function main() {
  let exitCode = 0;
  try {
    await app.whenReady();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert(address && typeof address !== "string");
    transport = new EmbeddedComputerBrowser();
    // The upload directory lives in this run's temporary userData, never in a real profile.
    const uploads = await BrowserUploadStore.create(directory);
    uploadsStore = uploads;
    transport.onTabReset((tab) => void uploads.releaseTab(tab));
    const driver = new BrowserComputerDriver(
      new Map<ComputerBrowser, BrowserTransport>([["ryco", transport]]),
      { uploads: () => uploads },
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
    const decoded = (value: Awaited<ReturnType<typeof execute>>) =>
      JSON.parse((value.content[0] as { text: string }).text);
    const tab = decoded(
      await execute({ action: "open", url: `http://127.0.0.1:${address.port}`, visible: true }),
    ).id;
    // RYCO_SMOKE_SHOT_DIR=<dir> saves what the hidden tab shows (webContents.capturePage).
    const shotDirectory = process.env.RYCO_SMOKE_SHOT_DIR;
    const shoot = async (name: string) => {
      if (!shotDirectory) return;
      const image = await webContents.fromId(Number(tab))!.capturePage();
      mkdirSync(shotDirectory, { recursive: true });
      writeFileSync(join(shotDirectory, `${name}.png`), image.toPNG());
    };
    const assertBackground = () => {
      assert.equal(BrowserWindow.getFocusedWindow(), null, "Agent tabs must not take native focus");
      assert(
        BrowserWindow.getAllWindows().every((window) => !window.isVisible()),
        "Agent hosts must stay hidden",
      );
    };
    assertBackground();
    await execute({ action: "show", tab });
    assertBackground();
    let state = decoded(await execute({ action: "observe", tab }));
    const ref = (name: string) =>
      state.elements.find((element: { name: string }) => element.name === name)?.ref;
    await execute({ action: "fill", tab, ref: ref("Name"), text: "Ada" });
    await execute({ action: "key", tab, key: "End" });
    await execute({ action: "type", tab, text: " Lovelace!" });
    await execute({ action: "key", tab, key: "Backspace" });
    await execute({ action: "select", tab, ref: ref("Colour"), value: "green" });
    await execute({ action: "click", tab, ref: ref("Save sample") });
    state = decoded(await execute({ action: "observe", tab }));
    assert.match(state.text, /Saved Ada Lovelace green/);
    for (const name of ["Read only", "Disabled"]) {
      await assert.rejects(
        execute({ action: "fill", tab, ref: ref(name), text: "Must not change" }),
        /Page state changed/,
      );
    }
    await assert.rejects(
      execute({ action: "click", tab, ref: ref("Covered") }),
      /Page state changed/,
    );
    await assert.rejects(
      execute({ action: "click", tab, ref: ref("Moving") }),
      /Page state changed/,
    );
    const unchanged = (await transport.send(
      tab,
      "Runtime.evaluate",
      {
        expression: `({unwanted:document.body.dataset.unwanted || null, values:Array.from(document.querySelectorAll('input[readonly],fieldset input')).map(el=>el.value)})`,
        returnByValue: true,
      },
      new AbortController().signal,
    )) as { result: { value: { unwanted: string | null; values: string[] } } };
    assert.equal(unchanged.result.value.unwanted, null);
    assert.deepEqual(unchanged.result.value.values, ["Original", "Original"]);
    const cursor = (await transport.send(
      tab,
      "Runtime.evaluate",
      {
        expression:
          "({exists:!!document.getElementById('__ryco_agent_cursor'),pointerEvents:document.getElementById('__ryco_agent_cursor')?.style.pointerEvents,transform:document.getElementById('__ryco_agent_cursor')?.style.transform})",
        returnByValue: true,
      },
      new AbortController().signal,
    )) as { result: { value: { exists: boolean; pointerEvents: string; transform: string } } };
    assert.equal(cursor.result.value.exists, true);
    assert.equal(cursor.result.value.pointerEvents, "none");
    assert.match(cursor.result.value.transform, /translate/);
    const shot = await execute({ action: "screenshot", tab });
    assert.equal(shot.content[0]?.type, "image");
    await execute({ action: "navigate", tab, url: `http://127.0.0.1:${address.port}/next` });
    await assert.rejects(execute({ action: "click", tab, ref: "e1" }), /Observe this document/);
    assertBackground();

    // Waits, diagnostics and emulation (browser-agent-control).
    const content = (value: Awaited<ReturnType<typeof execute>>) =>
      value.content.map((part) => JSON.parse((part as { text: string }).text));
    assert.equal(
      decoded(await execute({ action: "wait", tab, selector: "#result" })).matched,
      true,
    );
    state = decoded(await execute({ action: "observe", tab }));
    const started = Date.now();
    await execute({ action: "click", tab, ref: ref("Slow") });
    assert.equal(decoded(await execute({ action: "wait", tab, idle: "network" })).matched, true);
    assert(Date.now() - started >= 800, "Network idle must wait for the slow request");
    state = decoded(await execute({ action: "observe", tab }));
    assert.match(state.text, /loaded/);
    assertBackground();
    const network = decoded(await execute({ action: "network", tab }));
    assert(
      network.entries.some(
        (entry: { phase: string; url: string; status?: number }) =>
          entry.phase === "response" &&
          entry.url.endsWith("/slow?token=[REDACTED]") &&
          entry.status === 200,
      ),
      "network shows the slow request, redacted",
    );
    assert(!JSON.stringify(network).includes("secret"), "network redacts query values");
    // The agent tab's first load is recorded too: network capture starts before it.
    assert(
      network.entries.some(
        (entry: { phase: string; url: string; status?: number }) =>
          entry.phase === "response" &&
          entry.url === `http://127.0.0.1:${address.port}/` &&
          entry.status === 200,
      ),
      "network shows the document the agent tab opened with",
    );
    const consoleLog = decoded(await execute({ action: "console", tab }));
    assert(
      consoleLog.entries.some(
        (entry: { level: string; text: string }) =>
          entry.level === "error" && entry.text === "fixture-error",
      ),
      "console shows the fixture's error",
    );
    assert.equal(
      decoded(await execute({ action: "resize", tab, width: 390, height: 844 })).viewport.width,
      390,
    );
    assert.equal(
      decoded(await execute({ action: "resize", tab, reset: true })).viewport.width,
      1280,
    );
    // Both forced schemes, so the page's matchMedia listener sees a change whatever the Mac uses.
    for (const scheme of ["light", "dark"] as const) {
      assert.equal(
        decoded(await execute({ action: "appearance", tab, scheme })).prefersDark,
        scheme === "dark",
      );
      assert.equal(
        decoded(await execute({ action: "wait", tab, text: `scheme: ${scheme}`, timeout: 2_000 }))
          .matched,
        true,
      );
    }
    await execute({ action: "resize", tab, width: 390, height: 844 });
    await shoot("emulated-phone-dark");
    await execute({ action: "resize", tab, reset: true });
    assert.equal(
      decoded(await execute({ action: "appearance", tab, scheme: "system" })).prefersDark,
      nativeTheme.shouldUseDarkColors,
    );
    assertBackground();

    // Dialog steps last: a native alert here would mean the shim did not take effect.
    // Chromium reports every dialog it is about to show (and Electron with it) on the debugger.
    let dialogsShownByChromium = 0;
    let choosersIntercepted = 0;
    webContents.fromId(Number(tab))!.debugger.on("message", (_event, method) => {
      if (method === "Page.javascriptDialogOpening") dialogsShownByChromium += 1;
      if (method === "Page.fileChooserOpened") choosersIntercepted += 1;
    });
    const nativeDialogs = async () => {
      const value = (await transport!.send(
        tab,
        "Runtime.evaluate",
        {
          expression:
            "['alert','confirm','prompt'].every(name => Function.prototype.toString.call(window[name]).includes('[native code]'))",
          returnByValue: true,
        },
        new AbortController().signal,
      )) as { result: { value: boolean } };
      assert.equal(value.result.value, true, "alert, confirm and prompt are the page's own again");
    };
    state = decoded(await execute({ action: "observe", tab }));
    let parts = content(await execute({ action: "click", tab, ref: ref("Alert") }));
    assert.deepEqual(
      parts[1].dialogs.map(({ kind, action }: { kind: string; action: string }) => ({
        kind,
        action,
      })),
      [{ kind: "alert", action: "accepted" }],
    );
    await nativeDialogs();
    assertBackground();
    parts = content(await execute({ action: "click", tab, ref: ref("Confirm") }));
    assert.equal(parts[1].dialogs[0].action, "dismissed");
    state = decoded(await execute({ action: "observe", tab }));
    assert.match(state.text, /\bno\b/);
    await nativeDialogs();
    assertBackground();
    parts = content(await execute({ action: "click", tab, ref: ref("Confirm"), dialog: "accept" }));
    assert.equal(parts[1].dialogs[0].action, "accepted");
    state = decoded(await execute({ action: "observe", tab }));
    assert.match(state.text, /\byes\b/);
    await nativeDialogs();
    assertBackground();
    assert.equal(dialogsShownByChromium, 0, "the shim answered every dialog inside the page");
    await shoot("after-dialogs");

    // Uploads (browser-agent-upload). The backend's staging is simulated: files are put into the
    // store's directory by hand, the way the server lays them out.
    const stage = (uploadId: string) => {
      const slot = join(uploads.root, uploadId, "0");
      mkdirSync(slot, { recursive: true, mode: 0o700 });
      const file = join(slot, "fixture.txt");
      writeFileSync(file, "hello upload", { mode: 0o600 }); // 12 bytes
      return file;
    };
    const gone = async (path: string) => {
      for (let attempt = 0; attempt < 40 && existsSync(path); attempt += 1)
        await new Promise((resolve) => setTimeout(resolve, 50));
      return !existsSync(path);
    };
    state = decoded(await execute({ action: "observe", tab }));
    const avatar = state.elements.find((element: { name: string }) => element.name === "Avatar");
    assert.deepEqual(
      avatar && { type: avatar.type, hidden: avatar.hidden, multiple: avatar.multiple },
      { type: "file", hidden: true, multiple: false },
      "observe lists the hidden file input",
    );
    const firstId = newBrowserUploadId();
    const first = stage(firstId);
    assert.deepEqual(
      decoded(
        await execute({
          action: "upload",
          tab,
          ref: avatar.ref,
          files: [first],
          uploadId: firstId,
        }),
      ).uploaded,
      ["fixture.txt"],
    );
    state = decoded(await execute({ action: "observe", tab }));
    assert.match(state.text, /uploaded fixture\.txt 12/);
    assertBackground();
    await shoot("upload-by-ref");
    // The page keeps its copy until its main frame navigates.
    assert(existsSync(join(uploads.root, firstId)), "the page keeps the uploaded copy");
    await execute({ action: "navigate", tab, url: `http://127.0.0.1:${address.port}/upload` });
    assert(await gone(join(uploads.root, firstId)), "navigating removes the page's copies");
    // A request that ended without a page taking its copies leaves nothing behind.
    const unusedId = newBrowserUploadId();
    stage(unusedId);
    await uploads.settle(unusedId);
    assert(!existsSync(join(uploads.root, unusedId)), "settle removes unretained copies");
    // A page whose renderer goes away, or whose tab closes, frees its copies too (other hidden tabs).
    const uploadInOtherTab = async () => {
      const other: string = decoded(
        await execute({ action: "open", url: `http://127.0.0.1:${address.port}/other` }),
      ).id;
      const input = decoded(await execute({ action: "observe", tab: other })).elements.find(
        (element: { name: string }) => element.name === "Avatar",
      );
      const uploadId = newBrowserUploadId();
      const file = stage(uploadId);
      assert.deepEqual(
        decoded(
          await execute({ action: "upload", tab: other, ref: input.ref, files: [file], uploadId }),
        ).uploaded,
        ["fixture.txt"],
      );
      assert(existsSync(join(uploads.root, uploadId)), "the other page keeps its copy");
      return { other, uploadId };
    };
    const crashed = await uploadInOtherTab();
    const crashedContents = webContents.fromId(Number(crashed.other))!;
    // Only end a renderer this tab does not share with the main tab (the chooser step needs it).
    if (crashedContents.getOSProcessId() !== webContents.fromId(Number(tab))!.getOSProcessId()) {
      crashedContents.forcefullyCrashRenderer();
      assert(await gone(join(uploads.root, crashed.uploadId)), "a gone renderer frees its copies");
      console.log("renderer-gone release checked");
    } else console.log("renderer-gone release skipped: the tabs share a renderer");
    await execute({ action: "close", tab: crashed.other });
    const closed = await uploadInOtherTab();
    await execute({ action: "close", tab: closed.other });
    assert(await gone(join(uploads.root, closed.uploadId)), "closing a tab frees its copies");
    assertBackground();
    // Last: a click that opens the page's file chooser in the hidden tab. Interception keeps the
    // native open panel away; upload without ref answers the chooser.
    state = decoded(await execute({ action: "observe", tab }));
    assert.equal(choosersIntercepted, 0, "no chooser opened before the chooser step");
    // If Chromium reported no intercepted chooser, a native panel may be up: end the run at once.
    const chooserWatchdog = setTimeout(() => {
      if (choosersIntercepted > 0) return;
      console.error("No intercepted file chooser 5 s after the click; exiting.");
      app.exit(3);
    }, 5_000);
    chooserClickArmed = true;
    try {
      parts = content(await execute({ action: "click", tab, ref: ref("Choose file") }));
    } finally {
      chooserClickArmed = false;
    }
    let chooser = parts.find((part: { fileChooser?: unknown }) => part.fileChooser);
    assertBackground();
    console.log(`file chooser reported by ${chooser ? "the click result" : "the next observe"}`);
    if (!chooser) {
      // The chooser can be reported a moment after the click returned.
      await new Promise((resolve) => setTimeout(resolve, 250));
      chooser = content(await execute({ action: "observe", tab })).find(
        (part: { fileChooser?: unknown }) => part.fileChooser,
      );
    }
    assert.deepEqual(chooser?.fileChooser, { mode: "selectSingle" }, "the click opened a chooser");
    clearTimeout(chooserWatchdog);
    assert.equal(
      choosersIntercepted,
      1,
      "Chromium reported the chooser instead of showing a panel",
    );
    const sent = interceptionSent.get(Number(tab)) ?? [];
    assert(
      sent.length > 0 && sent.every(Boolean),
      `a hidden agent tab keeps interception on (sent: ${JSON.stringify(sent)})`,
    );
    const pickId = newBrowserUploadId();
    const second = stage(pickId);
    assert.deepEqual(
      decoded(await execute({ action: "upload", tab, files: [second], uploadId: pickId })).uploaded,
      ["fixture.txt"],
    );
    state = decoded(await execute({ action: "observe", tab }));
    assert.match(state.text, /uploaded fixture\.txt 12/);
    assertBackground();
    assert(existsSync(join(uploads.root, pickId)), "the page keeps the chooser upload's copy");
    await shoot("upload-through-chooser");

    // Between actions the agent's tab never shows a native dialog, also while the Browser panel
    // shows it: Electron answers it at once and the agent's next result reports it. (Without
    // disableDialogs the page would wait for a native box here until the run's exit guard.) An
    // inactive window stands in for the Ryco window the panel lives in.
    const panel = new BrowserWindow({ width: 900, height: 700, show: false });
    panel.showInactive();
    transport.surface({ owner: "smoke", tab, x: 0, y: 0, width: 800, height: 600 }, panel);
    assert.equal(transport.presented(tab), true, "the panel shows the agent's tab");
    const answered = await webContents
      .fromId(Number(tab))!
      .executeJavaScript(
        "new Promise(resolve => setTimeout(() => resolve(confirm('Between actions?')), 0))",
      );
    assert.equal(answered, false, "the page got its answer at once, without a box");
    parts = content(await execute({ action: "observe", tab }));
    assert.deepEqual(
      parts
        .at(-1)
        .dialogs.map(
          ({ kind, message, action, during }: Record<string, string>) =>
            `${kind}:${message}:${action}:${during}`,
        ),
      ["confirm:Between actions?:dismissed:background"],
    );
    transport.surface({ owner: "smoke", tab: null, x: 0, y: 0, width: 1, height: 1 }, panel);
    panel.destroy();
    assertBackground();
    controller.stop();
    await assert.rejects(execute({ action: "tabs" }), /stopped/);
    console.log(
      "PASS: hidden Chromium input/navigation stays hidden and unfocused; rejects covered/moving/readonly/disabled targets; fill/type/key/select/click, visible cursor, screenshot, navigation invalidation, waits, console/network diagnostics (first load included), resize/appearance emulation, dialogs without native windows (also between actions in a shown agent tab), uploads by ref and through an intercepted file chooser (no native panel), upload copy cleanup on navigation, settle, renderer exit and tab close, and stop.",
    );
  } catch (error) {
    console.error(error);
    exitCode = 1;
  } finally {
    transport?.dispose();
    uploadsStore?.dispose();
    server.closeAllConnections();
    server.close();
    rmSync(directory, { recursive: true, force: true });
    app.exit(exitCode);
  }
}
void main();
