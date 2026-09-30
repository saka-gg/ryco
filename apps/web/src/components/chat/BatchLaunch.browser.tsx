import "../../index.css";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
} from "@ryco/contracts";
import { batchSelectionKey, type BatchLaunch } from "@ryco/client-runtime/state/composer";
import { BatchLaunchControls } from "./BatchLaunchControls";
import { BatchResultSummary } from "./BatchResultSummary";
import { useChatPanesStore } from "../../chatPanesStore";

const { cancel } = vi.hoisted(() => ({ cancel: vi.fn(async () => {}) }));
// These UI tests cannot inspect real connections/accounts or call authenticated APIs.
vi.mock("../../batchLaunchStore", () => ({
  batchLaunchStore: { cancel, reconcile: vi.fn(async () => {}) },
}));
vi.mock("../../environmentApi", () => ({ readEnvironmentApi: () => undefined }));
vi.mock("../../environments/runtime", () => ({ readEnvironmentConnection: () => null }));
vi.mock("../../rpc/wsConnectionState", () => ({
  useWsConnectionStatusForEnvironment: () => ({ phase: "disconnected" }),
}));
const selection = (effort: string): ModelSelection => ({
  instanceId: ProviderInstanceId.make("fixture"),
  model: "model",
  options: [{ id: "reasoningEffort", value: effort }],
});
const fixture: BatchLaunch = {
  id: "fixture",
  ownerKey: "fixture-draft",
  environmentId: EnvironmentId.make("fixture-node"),
  projectId: ProjectId.make("fixture-project"),
  createdAt: "2026-09-30T00:00:00.000Z",
  cancelled: false,
  destinations: ["launched", "uncertain", "failed"].map((status, index) => ({
    status: status as "launched" | "uncertain" | "failed",
    threadId: ThreadId.make(`result-${index}`),
    messageId: MessageId.make(`message-${index}`),
    label: `Candidate ${index}`,
    modelSelection: selection(index === 0 ? "low" : "high"),
    error: status === "uncertain" ? "Connection lost after dispatch" : null,
    attempts: 1,
  })),
};
afterEach(async () => {
  await cleanup();
  useChatPanesStore.setState({ root: null, activeRef: null });
  vi.clearAllMocks();
});

it("collects distinct effort combinations through the current picker selection and removes targets", async () => {
  await page.viewport(1280, 800);
  function Harness() {
    const [targets, setTargets] = useState<readonly ModelSelection[]>([]);
    const [current, setCurrent] = useState(selection("low"));
    return (
      <>
        <button onClick={() => setCurrent(selection("high"))}>Choose high effort</button>
        <BatchLaunchControls
          selections={targets}
          disabled={false}
          reason={null}
          onAdd={() =>
            setTargets((previous) =>
              previous.some((item) => batchSelectionKey(item) === batchSelectionKey(current))
                ? previous
                : [...previous, current],
            )
          }
          onRemove={(key) =>
            setTargets((previous) => previous.filter((item) => batchSelectionKey(item) !== key))
          }
        />
      </>
    );
  }
  await render(<Harness />);
  await page.getByRole("button", { name: "Compare models…" }).click();
  await expect
    .element(
      page.getByText(
        "Choose another provider, model or effort in the model picker, then add it here.",
      ),
    )
    .toBeVisible();
  await page.getByRole("button", { name: "Choose high effort" }).click();
  await page.getByRole("button", { name: "Add current selection" }).click();
  await expect
    .element(
      page.getByText(
        "Send launches 2 isolated worktrees with the same prompt and context. Up to 2 launch at once.",
      ),
    )
    .toBeVisible();
  await page.getByRole("button", { name: "Add current selection" }).click();
  expect(document.querySelectorAll('button[aria-label^="Remove"]').length).toBe(2);
  await page.getByRole("button", { name: "Remove fixture model reasoningEffort low" }).click();
  expect(document.querySelectorAll('button[aria-label^="Remove"]').length).toBe(1);
});

it("disables selection additions when workspace/mutation readiness is unavailable", async () => {
  await render(
    <BatchLaunchControls
      selections={[selection("low")]}
      disabled
      reason="Batch launch requires a Git project."
      onAdd={() => {
        throw new Error("Must not add");
      }}
      onRemove={() => {
        throw new Error("Must not remove");
      }}
    />,
  );
  await expect.element(page.getByRole("button", { name: "Add current selection" })).toBeDisabled();
  await expect.element(page.getByText("Batch launch requires a Git project.")).toBeVisible();
});

it("shows honest partial/uncertain results, direct links, and existing split-pane navigation", async () => {
  await page.viewport(1024, 768);
  const retry = vi.fn();
  const root = createRootRoute();
  const source = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => <BatchResultSummary batch={fixture} onRetry={retry} retryDisabled />,
  });
  const thread = createRoute({
    getParentRoute: () => root,
    path: "/$environmentId/$threadId",
    component: () => <p>Opened {(thread.useParams() as { threadId: string }).threadId}</p>,
  });
  const router = createRouter({
    routeTree: root.addChildren([source, thread]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  useChatPanesStore.setState({
    activeRef: { environmentId: fixture.environmentId, threadId: ThreadId.make("source") },
  });
  await render(<RouterProvider router={router} />);
  await expect.element(page.getByText("Model comparison · 1/3 launched")).toBeVisible();
  await expect.element(page.getByText("Connection lost after dispatch")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Retry safe failures" })).toBeDisabled();
  await expect.element(page.getByRole("button", { name: "Refresh evidence" })).toBeDisabled();
  expect(document.body.textContent).toContain("Unavailable");
  await page.getByRole("button", { name: "Split view" }).first().click();
  expect(JSON.stringify(useChatPanesStore.getState().root)).toContain("result-0");
  await page.getByRole("link", { name: "Open thread" }).first().click();
  await expect.element(page.getByText("Opened result-0")).toBeVisible();
  expect(retry).not.toHaveBeenCalled();
});
