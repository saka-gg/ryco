// The command palette's Settings results open their section and reveal the row.
// The palette asks before the settings page may have mounted, and while it
// shows, so both are pinned here.
import "../../index.css";

import { page } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

const navigate = vi.fn(async () => undefined);
// Rendered outside a `RouterProvider`: the page reads route params only for the
// routed thread, and leaves settings through the router.
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => navigate,
  useParams: () => null,
  useRouter: () => ({ navigate, history: { canGoBack: () => false, back: () => undefined } }),
}));

import { useSettingsDialogStore } from "../../settingsDialogStore";
import { SidebarProvider } from "../ui/sidebar";
import { SettingsPage } from "./SettingsPage";
import { requestSettingsReveal, useSettingsSearchRevealStore } from "./settingsSearchReveal";

let mounted: Awaited<ReturnType<typeof render>> | null = null;

const revealedSection = () => document.activeElement?.getAttribute("data-settings-section");

async function renderSettingsPage() {
  await page.viewport(1_280, 720);
  mounted = await render(
    <SidebarProvider>
      <SettingsPage />
    </SidebarProvider>,
  );
}

beforeEach(() => {
  useSettingsDialogStore.setState({ open: true, section: "general", editingScope: "client" });
});

afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  useSettingsDialogStore.setState({ open: false, section: "general", editingScope: "client" });
  useSettingsSearchRevealStore.setState({ request: null });
  document.body.innerHTML = "";
});

describe("settings rows the command palette asks for", () => {
  it("reveals a row requested before the page mounted", async () => {
    useSettingsDialogStore.getState().showSection("client", "appearance");
    requestSettingsReveal("Diff style");
    await renderSettingsPage();

    await vi.waitFor(() => expect(revealedSection()).toBe("Diff style"));
    expect(useSettingsSearchRevealStore.getState().request).toBeNull();
  });

  it("replaces a search in progress with the requested row", async () => {
    await renderSettingsPage();
    const search = page.getByRole("searchbox", { name: "Search settings" });
    await search.fill("font");
    await expect.element(page.getByText("Interface font")).toBeVisible();

    useSettingsDialogStore.getState().showSection("client", "appearance");
    requestSettingsReveal("Diff style");

    await vi.waitFor(() => expect(revealedSection()).toBe("Diff style"));
    await expect.element(search).toHaveValue("");
  });
});
