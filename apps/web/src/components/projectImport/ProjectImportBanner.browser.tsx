import "../../index.css";
import { page } from "vite-plus/test/browser";
import { beforeEach, expect, it } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { PROJECT_IMPORT_BANNER_DISMISSED_KEY, ProjectImportBanner } from "./ProjectImportBanner";
import { useProjectImportDialogStore } from "./projectImportDialogStore";

beforeEach(() => {
  window.localStorage.removeItem(PROJECT_IMPORT_BANNER_DISMISSED_KEY);
  useProjectImportDialogStore.setState({ open: false, token: 0, environmentId: null });
});

it("opens the import dialog, and once dismissed stays hidden on this device", async () => {
  const first = await render(<ProjectImportBanner />);
  await page.getByRole("button", { name: "Import projects…" }).click();
  expect(useProjectImportDialogStore.getState()).toMatchObject({ open: true, token: 1 });

  await page.getByRole("button", { name: "Dismiss import suggestion" }).click();
  await expect
    .element(page.getByRole("region", { name: "Import from Codex or Claude Code" }))
    .not.toBeInTheDocument();
  await first.unmount();

  await render(<ProjectImportBanner />);
  await expect
    .element(page.getByRole("button", { name: "Import projects…" }))
    .not.toBeInTheDocument();
});
