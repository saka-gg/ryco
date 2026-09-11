import { expect, it, vi } from "vite-plus/test";

const { fromPartition } = vi.hoisted(() => ({ fromPartition: vi.fn() }));
vi.mock("electron", () => ({
  BrowserWindow: vi.fn(),
  WebContentsView: vi.fn(),
  session: { fromPartition },
}));
import { EmbeddedComputerBrowser } from "./embeddedBrowser.ts";

it("does not initialize browser storage when starting or reading an unused browser", async () => {
  const browser = new EmbeddedComputerBrowser();
  expect(browser.state().tabs).toEqual([]);
  await expect(browser.tabs(new AbortController().signal)).resolves.toEqual([]);
  browser.dispose();
  expect(fromPartition).not.toHaveBeenCalled();
});
