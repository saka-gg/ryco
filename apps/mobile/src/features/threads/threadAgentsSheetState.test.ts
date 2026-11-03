import { describe, expect, it } from "vite-plus/test";

import type { ThreadId } from "@ryco/contracts";

import {
  chooseThreadAgentsSheetTask,
  closeThreadAgentsSheet,
  isThreadAgentsSheetMounted,
  openThreadAgentsSheet,
  THREAD_AGENTS_SHEET_CLOSED,
  threadAgentsSheetDismissed,
} from "./threadAgentsSheetState";

const CHILD = "child-1" as ThreadId;

describe("agents sheet state", () => {
  it("closes when the chat runs out of agents and stays closed for the next one", () => {
    const open = openThreadAgentsSheet();
    expect(isThreadAgentsSheetMounted(open, false)).toBe(true);
    // The chat's agents are gone: the sheet closes, and nothing waits for it.
    const emptied = closeThreadAgentsSheet(open);
    expect(emptied).toEqual(THREAD_AGENTS_SHEET_CLOSED);
    expect(isThreadAgentsSheetMounted(emptied, false)).toBe(false);
    // A new agent shows the control, not the sheet.
    expect(isThreadAgentsSheetMounted(emptied, true)).toBe(true);
    expect(emptied.open).toBe(false);
    // Closing a closed sheet changes nothing, so it re-renders nothing.
    expect(closeThreadAgentsSheet(emptied)).toBe(emptied);
  });

  it("opens a delegated task once the iOS sheet reports it is gone, not under its slide", () => {
    const chosen = chooseThreadAgentsSheetTask(CHILD, true);
    expect(chosen).toEqual({ state: { open: false, openAfterDismiss: CHILD }, openNow: null });
    // Still mounted while the task waits, even if the chat's agents went meanwhile.
    expect(isThreadAgentsSheetMounted(chosen.state, false)).toBe(true);
    const dismissed = threadAgentsSheetDismissed(chosen.state);
    expect(dismissed).toEqual({ state: THREAD_AGENTS_SHEET_CLOSED, openNow: CHILD });
    // Done or a swipe down: nothing to open.
    expect(threadAgentsSheetDismissed(closeThreadAgentsSheet(openThreadAgentsSheet()))).toEqual({
      state: THREAD_AGENTS_SHEET_CLOSED,
      openNow: null,
    });
  });

  it("opens the task at once where the platform never reports the dismissal", () => {
    expect(chooseThreadAgentsSheetTask(CHILD, false)).toEqual({
      state: THREAD_AGENTS_SHEET_CLOSED,
      openNow: CHILD,
    });
  });

  it("drops the task when the sheet is reopened before its slide ends", () => {
    chooseThreadAgentsSheetTask(CHILD, true);
    const reopened = openThreadAgentsSheet();
    expect(threadAgentsSheetDismissed(reopened)).toEqual({ state: reopened, openNow: null });
  });
});
