import "../../index.css";
import { page } from "vite-plus/test/browser";
import { beforeEach, expect, it } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { SESSION_IMPORT_BANNER_DISMISSED_KEY, SessionImportBanner } from "./SessionImportBanner";
import { useSessionImportDialogStore } from "./sessionImportDialogStore";

beforeEach(() => {
  window.localStorage.removeItem(SESSION_IMPORT_BANNER_DISMISSED_KEY);
  useSessionImportDialogStore.setState({ open: false, token: 0, environmentId: null });
});

it("opens the import dialog, and once dismissed stays hidden on this device", async () => {
  const first = await render(<SessionImportBanner />);
  await page.getByRole("button", { name: "Import projects…" }).click();
  expect(useSessionImportDialogStore.getState()).toMatchObject({ open: true, token: 1 });

  await page.getByRole("button", { name: "Dismiss import suggestion" }).click();
  await expect
    .element(page.getByRole("region", { name: "Import from Codex or Claude Code" }))
    .not.toBeInTheDocument();
  await first.unmount();

  await render(<SessionImportBanner />);
  await expect
    .element(page.getByRole("button", { name: "Import projects…" }))
    .not.toBeInTheDocument();
});
