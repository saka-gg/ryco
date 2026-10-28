import "../../index.css";
import { useMemo, useState } from "react";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { expect, it } from "vite-plus/test";

import { SourcePickerPanel, useSourcePickerState } from "./SourcePickerPanel";

/**
 * Hosts the panel the way the Tasks page's link popover does: added tabs whose
 * render functions read the host's state, memoized so they change only with
 * it. The React Compiler caches the active tab's rendered content, so the
 * content must follow a new render function.
 */
function Host() {
  const state = useSourcePickerState("notes");
  const [count, setCount] = useState(0);
  const extraTabs = useMemo(
    () => [
      { id: "notes", label: "Notes", render: () => <p>Notes {count}</p> },
      { id: "links", label: "Links", render: () => <p>Links {count}</p> },
    ],
    [count],
  );
  return (
    <>
      <button type="button" onClick={() => setCount((value) => value + 1)}>
        More
      </button>
      <SourcePickerPanel
        state={state}
        repository={null}
        onSelect={() => {}}
        extraTabs={extraTabs}
      />
    </>
  );
}

it("shows an added tab's content again when its render function changes", async () => {
  const screen = await render(<Host />);
  try {
    await expect.element(page.getByText("Notes 0")).toBeVisible();

    await page.getByRole("button", { name: "More" }).click();
    await expect.element(page.getByText("Notes 1")).toBeVisible();

    await page.getByRole("tab", { name: "Links" }).click();
    await expect.element(page.getByText("Links 1")).toBeVisible();

    await page.getByRole("button", { name: "More" }).click();
    await expect.element(page.getByText("Links 2")).toBeVisible();
  } finally {
    await screen.unmount();
  }
});
