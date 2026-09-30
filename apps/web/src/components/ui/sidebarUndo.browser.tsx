import "../../index.css";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { CommandId, EnvironmentId, ThreadId, type EnvironmentApi } from "@ryco/contracts";
import { createSidebarUndoHistory } from "@ryco/client-runtime/state/threads";
import { ToastProvider } from "./toast";
import { presentSidebarUndoNotices, sidebarUndo } from "../../sidebarUndo";

vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useParams: () => ({}),
}));
afterEach(() => {
  presentSidebarUndoNotices([]);
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});
it("presents four keyboard-accessible undo actions, disables duplicates and dismisses finished notices", async () => {
  const mounted = await render(
    <ToastProvider>
      <span>Sidebar</span>
    </ToastProvider>,
  );
  const api = {
    orchestration: { dispatchCommand: vi.fn(async () => ({ sequence: 1 })) },
  } as unknown as EnvironmentApi;
  const context = { generation: {}, api, supported: true };
  const localContext = {
    threadRevision: "cached-thread",
    parentRevision: {},
    subscribe: () => () => {},
  };
  const history = createSidebarUndoHistory({
    readContext: () => context,
    readLocalContext: () => localContext,
    now: () => 0,
    newCommandId: () => CommandId.make("undo"),
    changed: presentSidebarUndoNotices,
    failed: vi.fn(),
  });
  vi.spyOn(sidebarUndo, "undo").mockImplementation((id) => history.undo(id));
  try {
    for (const action of ["archive", "settle", "snooze"] as const) {
      const target = {
        environmentId: EnvironmentId.make("synthetic-node"),
        threadId: ThreadId.make(action),
      };
      await history.dispatch(target, {
        type: `thread.${action}`,
        threadId: target.threadId,
        commandId: CommandId.make(action),
        snoozedUntil: "2099-01-01T00:00:00.000Z",
      });
    }
    let pinned = true;
    history.unpin(
      { environmentId: EnvironmentId.make("synthetic-node"), threadId: ThreadId.make("unpin") },
      {
        read: () => pinned,
        write: (value) => {
          pinned = value;
        },
        subscribe: () => () => {},
      },
    );
    for (const action of ["archive", "settle", "snooze", "unpin"])
      await expect
        .element(page.getByRole("button", { name: `Undo ${action}`, exact: true }))
        .toBeVisible();
    await page.getByRole("button", { name: "Undo unpin", exact: true }).click();
    expect(pinned).toBe(true);
    const button = document.querySelector<HTMLButtonElement>('[aria-label="Undo archive"]')!;
    button.focus();
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() =>
      expect(api.orchestration.dispatchCommand).toHaveBeenLastCalledWith(
        expect.objectContaining({
          type: "thread.sidebar.undo",
          threadId: "archive",
          undoCommandId: "archive",
        }),
      ),
    );
    history.dispose();
    await vi.waitFor(() =>
      expect(document.querySelectorAll('[data-slot="toast-root"]')).toHaveLength(0),
    );
  } finally {
    history.dispose();
    await mounted.unmount();
  }
});
