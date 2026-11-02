import {
  createThreadModelSelectionSync,
  THREAD_MODEL_SELECTION_PERSIST_DELAY_MS,
} from "@ryco/client-runtime/state/composer";
import {
  CommandId,
  type EnvironmentApi,
  type ModelSelection,
  ProviderInstanceId,
  type ServerConfig,
  ThreadId,
} from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  liveThreadModelSelectionSupported,
  mobileThreadModelSelectionView,
  stagedPickAfterStoredSelection,
} from "./liveThreadModelSelection";

const claude = ProviderInstanceId.make("claudeAgent");
const codex = ProviderInstanceId.make("codex");
const THREAD_ID = ThreadId.make("thread-1");
const THREAD_KEY = "environment:thread-1";
const pick = (model: string, effort?: string, instanceId = claude): ModelSelection => ({
  instanceId,
  model,
  ...(effort ? { options: [{ id: "effort", value: effort }] } : {}),
});

describe("stagedPickAfterStoredSelection", () => {
  it("lets the phone's pick of the stored instance give way, and keeps a pending handoff", () => {
    expect(stagedPickAfterStoredSelection(pick("opus", "max"), pick("sonnet"))).toBeNull();
    const handoff = pick("gpt-5.1", undefined, codex);
    expect(stagedPickAfterStoredSelection(handoff, pick("sonnet"))).toBe(handoff);
    expect(stagedPickAfterStoredSelection(null, pick("sonnet"))).toBeNull();
  });
});

describe("liveThreadModelSelectionSupported", () => {
  it("is on only for nodes that store picks on the thread", () => {
    const config = (capabilities: Record<string, unknown>) =>
      ({ environment: { capabilities } }) as unknown as ServerConfig;
    expect(liveThreadModelSelectionSupported(config({ liveThreadModelSelection: true }))).toBe(
      true,
    );
    expect(liveThreadModelSelectionSupported(config({}))).toBe(false);
    expect(liveThreadModelSelectionSupported(null)).toBe(false);
  });
});

describe("mobileThreadModelSelectionView", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function phone(stored: ModelSelection) {
    const dispatchCommand = vi.fn(async (_command: unknown) => ({ sequence: 1 }));
    const api = { orchestration: { dispatchCommand } } as unknown as EnvironmentApi;
    const state = { stored, staged: null as ModelSelection | null, error: null as string | null };
    const sync = createThreadModelSelectionSync();
    const render = () =>
      sync.updateView(
        THREAD_KEY,
        mobileThreadModelSelectionView({
          api: () => api,
          threadId: THREAD_ID,
          serverModelSelection: state.stored,
          composerModelSelection: state.staged ?? state.stored,
          updateStaged: (update) => {
            state.staged = update(state.staged);
          },
          reportFailure: (message) => {
            state.error = message;
          },
          newCommandId: () => CommandId.make("command-1"),
        }),
      );
    render();
    return { state, sync, render, dispatchCommand };
  }

  it("stores the phone's pick on the thread once its pause ends", async () => {
    const { state, sync, render, dispatchCommand } = phone(pick("opus", "high"));
    state.staged = pick("opus", "max");
    render();
    sync.committed(THREAD_KEY);
    await vi.advanceTimersByTimeAsync(THREAD_MODEL_SELECTION_PERSIST_DELAY_MS);
    expect(dispatchCommand).toHaveBeenCalledWith({
      type: "thread.meta.update",
      commandId: "command-1",
      threadId: THREAD_ID,
      modelSelection: pick("opus", "max"),
    });
  });

  it("shows a pick the desktop stored in place of the one staged here", () => {
    const { state, sync, render, dispatchCommand } = phone(pick("opus", "high"));
    state.staged = pick("opus", "max");
    render();
    state.stored = pick("sonnet", "low");
    render();
    sync.serverChanged(THREAD_KEY);
    expect(state.staged).toBeNull();
    expect(dispatchCommand).not.toHaveBeenCalled();
  });

  it("tells the user when the node refused the pick, and shows what the thread stores", async () => {
    const { state, sync, render, dispatchCommand } = phone(pick("opus", "high"));
    dispatchCommand.mockRejectedValueOnce(new Error("This task is archived."));
    state.staged = pick("opus", "max");
    render();
    sync.committed(THREAD_KEY);
    await vi.advanceTimersByTimeAsync(THREAD_MODEL_SELECTION_PERSIST_DELAY_MS);
    expect(state.error).toBe("This task is archived.");
    expect(state.staged).toBeNull();
  });
});
