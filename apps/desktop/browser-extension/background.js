let socket = null;
let config = null;
let authenticated = false;
let generation = 0;
let detaching = Promise.resolve();
const attached = new Set();
const methods = new Set([
  "Runtime.evaluate",
  "Page.getFrameTree",
  "Page.createIsolatedWorld",
  "Page.navigate",
  "Page.reload",
  "Page.getNavigationHistory",
  "Page.navigateToHistoryEntry",
  "Page.captureScreenshot",
  "Input.dispatchMouseEvent",
  "Input.dispatchKeyEvent",
  "Input.insertText",
]);
const safeUrl = (value) => {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw Error("Unsupported URL");
  return url.href;
};
async function detachAll() {
  const tabs = [...attached];
  attached.clear();
  await Promise.all(tabs.map((tabId) => chrome.debugger.detach({ tabId }).catch(() => {})));
}
function disconnect() {
  authenticated = false;
  generation++;
  const previous = socket;
  socket = null;
  previous?.close();
  detaching = Promise.all([detaching, detachAll()]).then(() => {});
}
async function run(message, attempt) {
  const check = () => {
    if (attempt !== generation || !socket || socket.readyState !== WebSocket.OPEN)
      throw Error("Control revoked");
  };
  check();
  if (message.action === "tabs")
    return (await chrome.tabs.query({}))
      .filter((tab) => /^https?:\/\//i.test(tab.url || ""))
      .slice(0, 500)
      .map((tab) => ({ id: String(tab.id), url: tab.url, title: tab.title || "" }));
  if (message.action === "open") {
    const tab = await chrome.tabs.create({
      url: safeUrl(message.url),
      active: message.visible === true,
    });
    check();
    return { id: String(tab.id), url: tab.url || message.url, title: tab.title || "" };
  }
  const tabId = Number(message.tab);
  if (!Number.isSafeInteger(tabId) || tabId < 0) throw Error("Invalid tab");
  const tab = await chrome.tabs.get(tabId);
  safeUrl(tab.url);
  check();
  if (message.action === "show") {
    await chrome.tabs.update(tabId, { active: true });
    return {};
  }
  if (message.action === "close") {
    await chrome.tabs.remove(tabId);
    return {};
  }
  if (message.action !== "cdp" || !methods.has(message.method)) throw Error("Unsupported action");
  if (message.method === "Page.navigate") safeUrl(message.params.url);
  if (!attached.has(tabId)) {
    await chrome.debugger.attach({ tabId }, "1.3");
    if (attempt !== generation) {
      await chrome.debugger.detach({ tabId }).catch(() => {});
      throw Error("Control revoked");
    }
    attached.add(tabId);
  }
  check();
  return await chrome.debugger.sendCommand({ tabId }, message.method, message.params || {});
}
async function connect() {
  const previousGeneration = generation;
  await detaching;
  if (previousGeneration !== generation || !config || socket) return;
  const attempt = ++generation;
  const ws = new WebSocket(config.url);
  socket = ws;
  ws.addEventListener("open", () => {
    if (attempt !== generation) return ws.close();
    ws.send(JSON.stringify({ type: "authenticate", browser: config.browser, token: config.token }));
  });
  ws.addEventListener("message", async (event) => {
    if (attempt !== generation) return;
    let message;
    try {
      message = JSON.parse(event.data);
      if (message.type === "authenticated") {
        authenticated = true;
        return;
      }
      if (message.type === "heartbeat") return;
      const result = await run(message, attempt);
      if (attempt === generation && ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ id: message.id, result }));
    } catch {
      if (attempt === generation && ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ id: message?.id, error: "Action failed" }));
    }
  });
  ws.addEventListener("close", () => {
    if (socket === ws) {
      authenticated = false;
      socket = null;
      generation++;
      detaching = Promise.all([detaching, detachAll()]).then(() => {});
    }
  });
  ws.addEventListener("error", () => ws.close());
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("popup.html")) return;
  if (message.type === "status") {
    respond({ connected: authenticated && socket?.readyState === WebSocket.OPEN });
    return;
  }
  if (message.type === "pair") {
    disconnect();
    config = message.config;
    chrome.storage.local.set({ config }).then(() => {
      connect();
      respond({ ok: true });
    });
    return true;
  }
  if (message.type === "disconnect") {
    disconnect();
    config = null;
    chrome.storage.local.remove("config").then(() => respond({ ok: true }));
    return true;
  }
});
chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId !== undefined) attached.delete(source.tabId);
  if (reason === "canceled_by_user") {
    // Browser cancellation/DevTools takeover must not be undone by auto-reconnect.
    disconnect();
    config = null;
    void chrome.storage.local.remove("config");
  }
});
chrome.alarms.create("ryco-connect", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => {
  if (!socket) connect();
  else if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "heartbeat" }));
});
const startupGeneration = generation;
chrome.storage.local.get("config").then((value) => {
  if (generation !== startupGeneration) return;
  config = value.config || null;
  connect();
});
