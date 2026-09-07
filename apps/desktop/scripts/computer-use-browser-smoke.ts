import { app } from "electron";
import { createServer } from "node:http";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserComputerDriver, type BrowserTransport } from "../src/computerUse/browser.ts";
import { EmbeddedComputerBrowser } from "../src/computerUse/embeddedBrowser.ts";
import { ComputerPolicyController, DEFAULT_COMPUTER_POLICY } from "../src/computerUse/policy.ts";
import type { ComputerBrowser, ComputerUseRequest } from "@ryco/contracts";

const directory = mkdtempSync(join(tmpdir(), "ryco-computer-browser-smoke-"));
app.setPath("userData", directory);
app.commandLine.appendSwitch("remote-debugging-port", "0");
const fixture = `<!doctype html><title>Ryco automation fixture</title><style>body{font:18px system-ui;padding:60px}input,select,button{font:inherit;padding:12px;margin:12px}#result{margin:12px}footer{margin-top:1400px}</style><h1>Automation fixture</h1><label>Name <input aria-label="Name" id="name"></label><select aria-label="Colour" id="colour"><option value="blue">Blue</option><option value="green">Green</option></select><button id="save">Save sample</button><div id="result" role="status">Waiting</div><label>Read only <input aria-label="Read only" readonly value="Original"></label><fieldset disabled><input aria-label="Disabled" value="Original"></fieldset><div style="position:relative;width:300px"><button id="covered" onclick="document.body.dataset.unwanted='yes'">Covered</button><div style="position:absolute;inset:0;background:#ccc">Cover</div></div><button id="moving" onpointerover="this.style.marginLeft='300px'" onclick="document.body.dataset.unwanted='yes'">Moving</button><footer>End</footer><script>save.onclick=()=>result.textContent='Saved '+nameInput.value+' '+colour.value;const nameInput=document.getElementById('name');</script>`;
const server = createServer((_request, response) => {
  response.setHeader("content-type", "text/html");
  response.end(fixture);
});
let transport: EmbeddedComputerBrowser | undefined;
async function main() {
  let exitCode = 0;
  try {
    await app.whenReady();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert(address && typeof address !== "string");
    transport = new EmbeddedComputerBrowser();
    const driver = new BrowserComputerDriver(
      new Map<ComputerBrowser, BrowserTransport>([["ryco", transport]]),
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
    let state = decoded(await execute({ action: "observe", tab }));
    const ref = (name: string) =>
      state.elements.find((element: { name: string }) => element.name === name)?.ref;
    await execute({ action: "fill", tab, ref: ref("Name"), text: "Ada" });
    await execute({ action: "select", tab, ref: ref("Colour"), value: "green" });
    await execute({ action: "click", tab, ref: ref("Save sample") });
    state = decoded(await execute({ action: "observe", tab }));
    assert.match(state.text, /Saved Ada green/);
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
    controller.stop();
    await assert.rejects(execute({ action: "tabs" }), /stopped/);
    console.log(
      "PASS: live Chromium rejects covered/moving/readonly/disabled targets; fill/select/click, visible cursor, screenshot, navigation invalidation and stop.",
    );
  } catch (error) {
    console.error(error);
    exitCode = 1;
  } finally {
    transport?.dispose();
    server.closeAllConnections();
    server.close();
    rmSync(directory, { recursive: true, force: true });
    app.exit(exitCode);
  }
}
void main();
