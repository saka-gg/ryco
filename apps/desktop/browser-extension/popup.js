const status = document.getElementById("status");
document.getElementById("connect").addEventListener("click", async () => {
  try {
    const config = JSON.parse(document.getElementById("pairing").value);
    const url = new URL(config.url);
    if (
      url.protocol !== "ws:" ||
      url.hostname !== "127.0.0.1" ||
      url.pathname !== "/browser" ||
      typeof config.token !== "string" ||
      config.token.length !== 43
    )
      throw Error("Invalid pairing configuration.");
    await chrome.runtime.sendMessage({ type: "pair", config });
    document.getElementById("pairing").value = "";
    status.textContent = "Connecting…";
  } catch (error) {
    status.textContent = error.message;
  }
});
document.getElementById("disconnect").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "disconnect" });
  status.textContent = "Disconnected";
});
async function refreshStatus() {
  try {
    const state = await chrome.runtime.sendMessage({ type: "status" });
    status.textContent = state.connected ? "Connected to Ryco" : "Disconnected";
  } catch {
    status.textContent = "Connection unavailable";
  }
}
void refreshStatus();
const statusTimer = setInterval(refreshStatus, 1000);
window.addEventListener("pagehide", () => clearInterval(statusTimer), { once: true });
