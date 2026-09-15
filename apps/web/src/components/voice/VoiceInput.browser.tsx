import "../../index.css";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { EnvironmentId } from "@ryco/contracts";
const f = vi.hoisted(() => {
  const status = { phase: "connected", connectedAt: "one" };
  const request = vi.fn();
  const connection = { client: { speech: { request }, isHeartbeatFresh: () => true } };
  const recording = { stop: vi.fn(async () => new Uint8Array([1, 0])), cancel: vi.fn() };
  return { status, request, connection, recording };
});
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => f.status }));
vi.mock("@ryco/client-runtime/rpc", () => ({
  getWsConnectionStatusForEnvironment: () => f.status,
  wsConnectionStatusForEnvironmentAtom: () => ({}),
}));
vi.mock("../../hostedHub/capabilities", () => ({
  useHostedRpcCapability: () => ({ allowed: true }),
}));
vi.mock("../../environments/runtime", () => ({ readEnvironmentConnection: () => f.connection }));
vi.mock("../../env", () => ({ isHostedHubMode: () => false }));
vi.mock("../../hostedHub/hostedConnectionCoordinator", () => ({
  readHostedNodeMutationLease: () => null,
}));
vi.mock("~/lib/utils", () => ({ cn: (...values: unknown[]) => values.filter(Boolean).join(" ") }));
vi.mock("../../voice/capture", () => ({
  createBrowserVoiceCapture: () => ({ available: true, start: async () => f.recording }),
}));
import { VoiceInput } from "../../voice/VoiceInput";
import { PaneFocusContext } from "../chat/PaneFocus";
const environmentId = EnvironmentId.make("voice-test");
beforeEach(async () => {
  vi.clearAllMocks();
  await page.viewport(1000, 700);
  f.request.mockImplementation(async (input) =>
    input.action === "status"
      ? { state: "ready" }
      : input.action === "finish"
        ? { state: "transcribed", text: "A short voice draft." }
        : { state: "accepted" },
  );
});
afterEach(() => vi.restoreAllMocks());
it("reviews, edits, and inserts explicitly", async () => {
  const insert = vi.fn();
  const screen = await render(
    <VoiceInput
      environmentId={environmentId}
      draftKey="a"
      destination="Test Mac"
      disabled={false}
      onInsert={insert}
    />,
  );
  await page.getByRole("button", { name: "Voice", exact: true }).click();
  await page.getByRole("button", { name: "Stop recording" }).click();
  await expect
    .element(page.getByRole("textbox", { name: "Review transcription" }))
    .toHaveValue("A short voice draft.");
  expect(insert).not.toHaveBeenCalled();
  await page.screenshot({ path: "../../../../../output/voice-qa/web-review.png" });
  await page.getByRole("textbox", { name: "Review transcription" }).fill("Edited voice draft.");
  await page.getByRole("button", { name: "Insert into draft" }).click();
  expect(insert).toHaveBeenCalledWith("Edited voice draft.");
  await screen.unmount();
});
it("same-environment draft switch cancels old inference and cannot insert into the new draft", async () => {
  let complete!: (value: unknown) => void;
  f.request.mockImplementation(async (input) =>
    input.action === "status"
      ? { state: "ready" }
      : input.action === "finish"
        ? new Promise((resolve) => {
            complete = resolve;
          })
        : { state: "accepted" },
  );
  const first = vi.fn(),
    second = vi.fn();
  const screen = await render(
    <VoiceInput
      environmentId={environmentId}
      draftKey="a"
      destination="Test Mac"
      disabled={false}
      onInsert={first}
    />,
  );
  await page.getByRole("button", { name: "Voice", exact: true }).click();
  await page.getByRole("button", { name: "Stop recording" }).click();
  await vi.waitFor(() => expect(complete).toBeTypeOf("function"));
  await screen.rerender(
    <VoiceInput
      environmentId={environmentId}
      draftKey="b"
      destination="Test Mac"
      disabled={false}
      onInsert={second}
    />,
  );
  expect(f.request.mock.calls.some(([input]) => input.action === "cancel")).toBe(true);
  complete({ state: "transcribed", text: "Old draft audio" });
  await expect.element(page.getByRole("button", { name: "Voice", exact: true })).toBeVisible();
  expect(first).not.toHaveBeenCalled();
  expect(second).not.toHaveBeenCalled();
  await expect
    .element(page.getByRole("textbox", { name: "Review transcription" }))
    .not.toBeInTheDocument();
  await screen.unmount();
});
it("backgrounding cancels owned compute on the still-authorized connection", async () => {
  let complete!: (value: unknown) => void;
  f.request.mockImplementation(async (input) =>
    input.action === "status"
      ? { state: "ready" }
      : input.action === "finish"
        ? new Promise((resolve) => {
            complete = resolve;
          })
        : { state: "accepted" },
  );
  const screen = await render(
    <VoiceInput
      environmentId={environmentId}
      draftKey="a"
      destination="Test Mac"
      disabled={false}
      onInsert={() => {}}
    />,
  );
  await page.getByRole("button", { name: "Voice", exact: true }).click();
  await page.getByRole("button", { name: "Stop recording" }).click();
  await vi.waitFor(() => expect(complete).toBeTypeOf("function"));
  vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  document.dispatchEvent(new Event("visibilitychange"));
  expect(f.request.mock.calls.some(([input]) => input.action === "cancel")).toBe(true);
  expect(f.recording.cancel).toHaveBeenCalled();
  complete({ state: "transcribed", text: "late" });
  await screen.unmount();
});

it.each(["recording", "inference"])(
  "pane focus loss cancels %s and releases global listeners",
  async (phase) => {
    let complete: ((value: unknown) => void) | undefined;
    f.request.mockImplementation(async (input) =>
      input.action === "status"
        ? { state: "ready" }
        : input.action === "finish"
          ? new Promise((resolve) => {
              complete = resolve;
            })
          : { state: "accepted" },
    );
    const insert = vi.fn();
    const view = (focused: boolean) => (
      <PaneFocusContext value={focused}>
        <VoiceInput
          environmentId={environmentId}
          draftKey="pane-a"
          destination="Test Mac"
          disabled={false}
          onInsert={insert}
        />
      </PaneFocusContext>
    );
    const addWindow = vi.spyOn(window, "addEventListener");
    const removeWindow = vi.spyOn(window, "removeEventListener");
    const addDocument = vi.spyOn(document, "addEventListener");
    const removeDocument = vi.spyOn(document, "removeEventListener");
    const screen = await render(view(true));
    await page.getByRole("button", { name: "Voice", exact: true }).click();
    if (phase === "inference") {
      await page.getByRole("button", { name: "Stop recording" }).click();
      await vi.waitFor(() => expect(complete).toBeTypeOf("function"));
    }
    const offlineListener = addWindow.mock.calls.find(([event]) => event === "offline")?.[1];
    const visibilityListener = addDocument.mock.calls.find(
      ([event]) => event === "visibilitychange",
    )?.[1];
    await screen.rerender(view(false));
    expect(offlineListener).toBeTypeOf("function");
    expect(visibilityListener).toBeTypeOf("function");
    expect(removeWindow).toHaveBeenCalledWith("offline", offlineListener);
    expect(removeDocument).toHaveBeenCalledWith("visibilitychange", visibilityListener);
    expect(f.recording.cancel).toHaveBeenCalled();
    expect(f.request.mock.calls.some(([input]) => input.action === "cancel")).toBe(true);
    await expect.element(page.getByRole("button", { name: "Voice", exact: true })).toBeDisabled();
    f.request.mockClear();
    window.dispatchEvent(new Event("offline"));
    document.dispatchEvent(new Event("visibilitychange"));
    expect(f.request).not.toHaveBeenCalled();
    complete?.({ state: "transcribed", text: "stale pane audio" });
    await expect
      .element(page.getByRole("textbox", { name: "Review transcription" }))
      .not.toBeInTheDocument();
    expect(insert).not.toHaveBeenCalled();
    await screen.rerender(view(true));
    await page.getByRole("button", { name: "Voice", exact: true }).click();
    await expect.element(page.getByRole("button", { name: "Stop recording" })).toBeVisible();
    await screen.unmount();
  },
);
