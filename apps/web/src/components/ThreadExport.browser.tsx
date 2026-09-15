import "../index.css";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import type { ScopedThreadRef } from "@ryco/contracts";
import { useThreadExportAction } from "../hooks/useThreadExportAction";
import { exportThreadMarkdown } from "../lib/threadExport";

vi.mock("../lib/threadExport", () => ({ exportThreadMarkdown: vi.fn() }));
vi.mock("../hostedHub/capabilities", () => ({ useHostedRpcCapability: () => ({ allowed: true }) }));
const ref = { environmentId: "environment", threadId: "thread" } as ScopedThreadRef;
function Action({ selected = true }: { selected?: boolean }) {
  const action = useThreadExportAction(selected ? ref : null);
  return (
    <button
      disabled={action.disabled}
      onClick={() => {
        expect(action.keepOpen).toBe(true);
        void action.run();
      }}
    >
      {action.title}
    </button>
  );
}
function Harness({ selected = true }: { selected?: boolean }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      {open ? <Action selected={selected} /> : null}
      <button onClick={() => setOpen(false)}>Close palette</button>
    </>
  );
}
afterEach(() => vi.resetAllMocks());
describe("thread export command interaction", () => {
  it("runs export for the selected scoped thread", async () => {
    vi.mocked(exportThreadMarkdown).mockResolvedValue("downloaded");
    const screen = await render(<Harness />);
    await screen.getByRole("button", { name: "Export thread as Markdown" }).click();
    expect(exportThreadMarkdown).toHaveBeenCalledWith(ref, expect.any(AbortSignal));
  });
  it("cancels a pending export through the same action", async () => {
    let signal: AbortSignal | undefined;
    vi.mocked(exportThreadMarkdown).mockImplementation((_ref, current) => {
      signal = current;
      return new Promise((resolve) =>
        current.addEventListener("abort", () => resolve("cancelled")),
      );
    });
    const screen = await render(<Harness />);
    await screen.getByRole("button", { name: "Export thread as Markdown" }).click();
    await screen.getByRole("button", { name: "Cancel thread export" }).click();
    expect(signal?.aborted).toBe(true);
    await expect
      .element(screen.getByRole("button", { name: "Export thread as Markdown" }))
      .toBeVisible();
  });
  it("aborts when the palette closes", async () => {
    let signal: AbortSignal | undefined;
    vi.mocked(exportThreadMarkdown).mockImplementation((_ref, current) => {
      signal = current;
      return new Promise((resolve) =>
        current.addEventListener("abort", () => resolve("cancelled")),
      );
    });
    const screen = await render(<Harness />);
    await screen.getByRole("button", { name: "Export thread as Markdown" }).click();
    await screen.getByRole("button", { name: "Close palette" }).click();
    expect(signal?.aborted).toBe(true);
  });
  it("requires a selected thread", async () => {
    const screen = await render(<Harness selected={false} />);
    await expect
      .element(screen.getByRole("button", { name: "Export thread as Markdown" }))
      .toBeDisabled();
    expect(exportThreadMarkdown).not.toHaveBeenCalled();
  });
});
