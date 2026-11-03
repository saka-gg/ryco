// Minimal codex app-server stand-in for device-code sign-in tests. Runs as a
// plain Node process — stdlib only. The scenario comes from the JSON file named
// by RYCO_CODEX_LOGIN_SCRIPT:
//   account            account/read's account before a login (default null)
//   requiresOpenaiAuth account/read's flag (default true)
//   start              "deviceCode" (default) | "error" | "hang" | "insecureUrl"
//   completion         "success" (default) | "failure"; emitted once
//                      `<script>.trigger` exists. "exit" ends the process
//                      then instead, with no completion (a crash mid-wait)
//   completionError    the failure's error text
//   accountAfterLogin  whether account/read reports one after success (default true)
//   codexHome          overrides the home initialize reports (default CODEX_HOME)
// The peer appends every request (method and params) to `<script>.requests`
// and writes its pid to `<script>.pid`.
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";

const scriptPath = process.env.RYCO_CODEX_LOGIN_SCRIPT;
const script = JSON.parse(NodeFS.readFileSync(scriptPath, "utf8"));
NodeFS.writeFileSync(`${scriptPath}.pid`, String(process.pid));

const LOGIN_ID = "login-fixture-1";
const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
let signedIn = false;
let poll;

const awaitTrigger = () => {
  poll = setInterval(() => {
    if (!NodeFS.existsSync(`${scriptPath}.trigger`)) return;
    clearInterval(poll);
    if (script.completion === "exit") process.exit(3);
    const success = (script.completion ?? "success") === "success";
    signedIn = success && script.accountAfterLogin !== false;
    write({
      jsonrpc: "2.0",
      method: "account/login/completed",
      params: success
        ? { loginId: LOGIN_ID, success: true }
        : { loginId: LOGIN_ID, success: false, error: script.completionError ?? "denied" },
    });
  }, 20);
};

const rl = NodeReadline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = message;
  if (method !== undefined) {
    NodeFS.appendFileSync(`${scriptPath}.requests`, `${JSON.stringify({ method, params })}\n`);
  }
  if (method === "initialize") {
    write({
      id,
      result: {
        userAgent: "codex-login-mock/0.0.0",
        codexHome: script.codexHome ?? process.env.CODEX_HOME,
        platformFamily: "unix",
        platformOs: "linux",
      },
    });
    return;
  }
  if (method === "account/read") {
    const account = signedIn
      ? { type: "chatgpt", email: "fixture@example.com", planType: "plus" }
      : (script.account ?? null);
    write({ id, result: { account, requiresOpenaiAuth: script.requiresOpenaiAuth ?? true } });
    return;
  }
  if (method === "account/login/start") {
    const start = script.start ?? "deviceCode";
    if (start === "hang") return;
    if (start === "error") {
      write({
        id,
        error: { code: -32600, message: "unknown variant `chatgptDeviceCode`\nat line 1" },
      });
      return;
    }
    write({
      id,
      result: {
        type: "chatgptDeviceCode",
        loginId: LOGIN_ID,
        userCode: "FIXT-CODE",
        verificationUrl:
          start === "insecureUrl"
            ? "http://auth.example.test/codex/device"
            : "https://auth.example.test/codex/device",
      },
    });
    awaitTrigger();
    return;
  }
  if (method === "account/login/cancel") {
    clearInterval(poll);
    write({ id, result: { status: "canceled" } });
    return;
  }
  if (id !== undefined) {
    write({ id, result: {} });
  }
});
