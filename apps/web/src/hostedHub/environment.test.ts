import { EnvironmentId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { useCommandPaletteStore } from "../commandPaletteStore";
import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { useMessageQueueStore } from "../messageQueueStore";
import { useSettingsDialogStore } from "../settingsDialogStore";
import { useStore } from "../store";
import { useTerminalStateStore } from "../terminalStateStore";
import { useUiStateStore } from "../uiStateStore";
import { clearWebHostedAccountScopedState, clearWebHostedNodeScopedState } from "./environment";

/**
 * The browser/UI clearing catalog. The core transition queue owns the call
 * ordering (see the package `environment.test.ts`); this suite covers only the
 * web store sweep the catalog performs when the core asks it to clear
 * node-scoped state.
 */

const environmentId = EnvironmentId.make("env_aaaaaaaaaaaaaaaaaaaaaa");

describe("clearWebHostedNodeScopedState", () => {
  it("demotes only transport projections and preserves cross-node UI state", () => {
    useStore.setState({ activeEnvironmentId: environmentId });
    useComposerDraftStore.getState().setPrompt(DraftId.make("sensitiveThread"), "sensitive prompt");
    useTerminalStateStore.setState({
      terminalStateByThreadKey: { sensitiveThread: {} as never },
      terminalLaunchContextByThreadKey: { sensitiveThread: {} as never },
      terminalEventEntriesByKey: { sensitiveThread: [] },
    });
    useMessageQueueStore.setState({ queuesByThreadKey: { sensitiveThread: [] } });
    useUiStateStore.setState({
      projectOrder: ["sensitiveProject"],
      pinnedThreadKeys: { sensitiveThread: true },
    });
    useCommandPaletteStore.getState().openAddProject();
    useSettingsDialogStore.getState().openSettings("providers");

    clearWebHostedNodeScopedState(environmentId);

    expect(useStore.getState().activeEnvironmentId).toBe(environmentId);
    expect(
      useComposerDraftStore.getState().getComposerDraft(DraftId.make("sensitiveThread"))?.prompt,
    ).toBe("sensitive prompt");
    expect(useTerminalStateStore.getState().terminalStateByThreadKey).toHaveProperty(
      "sensitiveThread",
    );
    expect(useMessageQueueStore.getState().queuesByThreadKey).toHaveProperty("sensitiveThread");
    expect(useUiStateStore.getState()).toMatchObject({
      projectOrder: ["sensitiveProject"],
      pinnedThreadKeys: { sensitiveThread: true },
    });
    expect(useCommandPaletteStore.getState().open).toBe(true);
    expect(useSettingsDialogStore.getState().open).toBe(true);
  });

  it("clears preserved cross-node state at the account-session boundary", () => {
    useComposerDraftStore.getState().setPrompt(DraftId.make("accountDraft"), "private prompt");
    useUiStateStore.setState({ pinnedThreadKeys: { accountThread: true } });
    useCommandPaletteStore.getState().openAddProject();
    useMessageQueueStore
      .getState()
      .enqueue("accountThread", { id: "queued", composer: {} as never, settings: {} as never });
    useMessageQueueStore.getState().hold("accountThread", {
      reason: "error",
      detail: "boom",
      causeKeys: ["error:turn:boom"],
      heldAt: "2026-10-01T00:00:00.000Z",
    });
    const epoch = useMessageQueueStore.getState().epoch;

    clearWebHostedAccountScopedState();

    expect(
      useComposerDraftStore.getState().getComposerDraft(DraftId.make("accountDraft")),
    ).toBeNull();
    expect(useUiStateStore.getState().pinnedThreadKeys).toEqual({});
    expect(useCommandPaletteStore.getState().open).toBe(false);
    // The queue reset bumps the epoch so in-flight queued sends are dropped.
    expect(useMessageQueueStore.getState()).toMatchObject({
      queuesByThreadKey: {},
      holdsByThreadKey: {},
      acknowledgedCauseKeysByThreadKey: {},
      epoch: epoch + 1,
    });
  });
});
