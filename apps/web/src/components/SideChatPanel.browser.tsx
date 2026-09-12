import "../index.css";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
} from "@ryco/contracts";
import { scopedThreadKey } from "@ryco/client-runtime/scoped";
import { page } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";
import { SideChatPanel } from "./SideChatPanel";
import { useSideChatStore } from "../sideChatStore";

const mocks = vi.hoisted(() => ({ ask: vi.fn(), cancel: vi.fn(async () => ({})), allowed: true }));
vi.mock("../composerDraftStore", () => import("@ryco/client-runtime/state/composer"));
vi.mock("../environments/runtime", () => ({
  readEnvironmentConnection: () => ({
    client: { textGeneration: { askSideQuestion: mocks.ask, cancelSideQuestion: mocks.cancel } },
  }),
}));
vi.mock("../hostedHub/capabilities", () => ({
  useHostedRpcCapability: () => ({ allowed: mocks.allowed }),
}));
vi.mock("./ChatMarkdown", () => ({ default: ({ text }: { text: string }) => <p>{text}</p> }));
const threadRef = { environmentId: EnvironmentId.make("test"), threadId: ThreadId.make("thread") };
const key = scopedThreadKey(threadRef);
const selection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "astra",
  options: [{ id: "reasoningEffort", value: "medium" }],
};
const providers: ServerProvider[] = [
  {
    instanceId: selection.instanceId,
    driver: ProviderDriverKind.make("codex"),
    displayName: "Codex",
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-12T00:00:00.000Z",
    slashCommands: [],
    skills: [],
    models: ["astra", "terra"].map((slug) => ({
      slug,
      name: slug,
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "reasoningEffort",
            type: "select",
            label: "Reasoning",
            options: [
              { id: "medium", label: "Medium" },
              { id: "high", label: "High" },
            ],
          },
        ],
      },
    })),
  },
];

describe("SideChatPanel", () => {
  let mounted: Awaited<ReturnType<typeof render>> | undefined;
  beforeEach(() => {
    mocks.allowed = true;
    mocks.ask.mockReset();
    mocks.cancel.mockClear();
    useSideChatStore.setState({ chatsByThreadKey: {} });
    useSideChatStore.getState().open(key, selection);
  });
  afterEach(async () => {
    await mounted?.unmount();
    mounted = undefined;
    document.body.innerHTML = "";
  });
  const mount = async (connected = true) => {
    mounted = await render(
      <div className="relative h-[650px] w-[800px]">
        <SideChatPanel threadRef={threadRef} providers={providers} connected={connected} />
      </div>,
    );
  };
  it("sends independent model/reasoning choices and successful follow-up history", async () => {
    mocks.ask.mockImplementation(async (input) => ({
      requestId: input.requestId,
      answer: "A separate answer",
    }));
    await mount();
    await page.getByLabelText("Side chat model").selectOptions("codex/terra");
    await page.getByLabelText("Side chat reasoning").selectOptions("high");
    await page.getByLabelText("Side question").fill("Why?");
    await page.getByRole("button", { name: "Ask", exact: true }).click();
    await expect.element(page.getByText("A separate answer", { exact: true })).toBeVisible();
    expect(mocks.ask).toHaveBeenLastCalledWith(
      expect.objectContaining({
        threadId: "thread",
        question: "Why?",
        history: [],
        modelSelection: {
          instanceId: "codex",
          model: "terra",
          options: [{ id: "reasoningEffort", value: "high" }],
        },
      }),
    );
    expect(selection.model).toBe("astra");
    await page.getByLabelText("Side question").fill("And then?");
    await page.getByRole("button", { name: "Ask", exact: true }).click();
    expect(mocks.ask).toHaveBeenLastCalledWith(
      expect.objectContaining({ history: [{ question: "Why?", answer: "A separate answer" }] }),
    );
  });
  it("minimizes without stopping; cancel restores draft and ignores a late answer", async () => {
    let finish!: (result: { requestId: string; answer: string }) => void;
    mocks.ask.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await mount();
    await page.getByLabelText("Side question").fill("Explain the context");
    await page.getByRole("button", { name: "Ask", exact: true }).click();
    await page.getByRole("button", { name: "Minimize side chat" }).click();
    expect(mocks.cancel).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "Side chat · Thinking…" }).click();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(mocks.cancel).toHaveBeenCalledOnce();
    const requestId = mocks.ask.mock.calls[0]![0].requestId;
    finish({ requestId, answer: "Stale answer" });
    await expect.element(page.getByLabelText("Side question")).toHaveValue("Explain the context");
    expect(useSideChatStore.getState().chatsByThreadKey[key]?.exchanges).toEqual([]);
  });
  it("fences socket loss before reconnect and never replays a pending question", async () => {
    let finish!: (result: { requestId: string; answer: string }) => void;
    mocks.ask.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await mount();
    await page.getByLabelText("Side question").fill("Pending question");
    await page.getByRole("button", { name: "Ask", exact: true }).click();
    await mounted!.rerender(
      <SideChatPanel threadRef={threadRef} providers={providers} connected={false} />,
    );
    await expect.element(page.getByRole("alert")).toHaveTextContent("Connection lost");
    finish({ requestId: mocks.ask.mock.calls[0]![0].requestId, answer: "Old socket" });
    await mounted!.rerender(
      <SideChatPanel threadRef={threadRef} providers={providers} connected />,
    );
    expect(mocks.ask).toHaveBeenCalledOnce();
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(useSideChatStore.getState().chatsByThreadKey[key]?.exchanges).toEqual([]);
    await expect.element(page.getByLabelText("Side question")).toHaveValue("Pending question");
  });
  it("blocks stale hosted readiness and keeps failed questions for retry", async () => {
    mocks.allowed = false;
    await mount();
    await page.getByLabelText("Side question").fill("Question");
    await expect.element(page.getByRole("button", { name: "Ask", exact: true })).toBeDisabled();
    expect(mocks.ask).not.toHaveBeenCalled();
    mocks.allowed = true;
    await mounted!.rerender(
      <SideChatPanel threadRef={threadRef} providers={providers} connected />,
    );
    mocks.ask.mockRejectedValueOnce(new Error("Provider unavailable"));
    await page.getByRole("button", { name: "Ask", exact: true }).click();
    await expect.element(page.getByRole("alert")).toHaveTextContent("Provider unavailable");
    await expect.element(page.getByLabelText("Side question")).toHaveValue("Question");
    await page.getByRole("button", { name: "New chat" }).click();
    await expect.element(page.getByLabelText("Side question")).toHaveValue("");
  });
});
