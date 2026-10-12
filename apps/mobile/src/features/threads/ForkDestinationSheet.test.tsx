import type { ReactElement } from "react";
import {
  createThreadForkAttemptController,
  THREAD_FORK_COPY,
  type ThreadForkApi,
} from "@ryco/client-runtime/state/threads";
import {
  EnvironmentId,
  MessageId,
  ThreadId,
  TurnId,
  type ThreadForkKey,
  type ThreadForkResult,
} from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

// The sheet invoked as plain functions with react-native mocked (no React renderer exists in this
// suite): what it proves is the wiring of the close guard. While a request is in flight the
// Cancel button is disabled and the Modal's close request (Android back, an iOS swipe attempt)
// does not close the sheet; once the node answered both close it again.

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useEffect: () => undefined,
    useSyncExternalStore: <T,>(_subscribe: unknown, getSnapshot: () => T): T => getSnapshot(),
  };
});
vi.mock("react-native", () => ({
  Modal: "Modal",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  TextInput: "TextInput",
  View: "View",
}));
vi.mock("../../components/icons", () => ({ IconGitFork: "IconGitFork" }));
vi.mock("../../components/AppText", () => ({ AppText: "Text" }));
vi.mock("../../components/AppSymbol", () => ({ SymbolView: "SymbolView" }));
vi.mock("../../components/OptionRow", () => ({ OptionRow: "OptionRow" }));
vi.mock("../../lib/useThemeColor", () => ({ useThemeColor: () => "#888888" }));

import { ForkDestinationSheet, ForkSheetContent } from "./ForkDestinationSheet";
import type { ForkSheetHandle, ForkSheetSource } from "./forkDestinationModel";

function elements(node: unknown): ReactElement<Record<string, unknown>>[] {
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<Record<string, unknown>>;
  const children = element.props.children;
  return [element, ...(Array.isArray(children) ? children : [children]).flatMap(elements)];
}

const source: ForkSheetSource = {
  isChat: false,
  isGitRepo: true,
  chatsAvailable: true,
  sourceWorktreePath: null,
  sourceBranch: "main",
  checkpointAvailable: true,
};

function openSheet() {
  let reject!: (error: unknown) => void;
  const api: ThreadForkApi = {
    fork: () =>
      new Promise<ThreadForkResult>((_resolve, rejectFork) => {
        reject = rejectFork;
      }),
  };
  let next = 0;
  const mintKey = (): ThreadForkKey => {
    next += 1;
    return `fork-${String(next).padStart(16, "0")}`;
  };
  const environmentId = EnvironmentId.make("env-sheet");
  const sourceThreadId = ThreadId.make("source-thread");
  const messageId = MessageId.make("reply-sheet");
  const controller = createThreadForkAttemptController({
    boundary: { environmentId, sourceThreadId, sourceMessageId: messageId },
    initialSelection: { destination: "current-checkout", worktreeStart: null, baseRef: "main" },
    defaultBaseRef: "main",
    ports: {
      mintKey,
      captureReadiness: () => () => undefined,
      resolveApi: () => api,
      waitForShell: async () => true,
      readAvailability: () => "available",
    },
    onForked: () => undefined,
  });
  controller.start();
  const sheet: ForkSheetHandle = {
    request: {
      environmentId,
      sourceThreadId,
      sourceTitle: "Source",
      messageId,
      turnId: TurnId.make("turn-1"),
      excerpt: "The reply",
    },
    controller,
    visible: true,
  };
  return { sheet, controller, failRequest: (error: unknown) => reject(error) };
}

function render(sheet: ForkSheetHandle, onClose: () => void) {
  const modal = ForkDestinationSheet({ sheet, source, ready: true, onClose });
  const content = elements(modal).find((element) => element.type === ForkSheetContent);
  if (!content) throw new Error("sheet content missing");
  const body = ForkSheetContent(content.props as Parameters<typeof ForkSheetContent>[0]);
  const pressables = elements(body).filter((element) => element.type === "Pressable");
  const cancel = pressables.find(
    (element) => element.props.accessibilityLabel === THREAD_FORK_COPY.cancel,
  );
  const primary = pressables.at(-1);
  if (!cancel || !primary) throw new Error("sheet buttons missing");
  return {
    requestClose: modal.props.onRequestClose as () => void,
    cancel,
    primary,
  };
}

describe("fork destination sheet", () => {
  it("cannot be closed by Cancel, back or swipe while threads.fork is in flight", async () => {
    const { sheet, failRequest } = openSheet();
    const onClose = vi.fn();

    const editing = render(sheet, onClose);
    expect(editing.cancel.props.disabled).toBe(false);
    (editing.primary.props.onPress as () => void)();

    const working = render(sheet, onClose);
    expect(working.cancel.props.disabled).toBe(true);
    expect(working.cancel.props.accessibilityState).toMatchObject({ disabled: true });
    working.requestClose();
    (working.cancel.props.onPress as () => void)();
    expect(onClose).not.toHaveBeenCalled();

    failRequest(new Error("socket closed"));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const answered = render(sheet, onClose);
    expect(answered.cancel.props.disabled).toBe(false);
    answered.requestClose();
    expect(onClose).toHaveBeenCalledOnce();
  });
});
