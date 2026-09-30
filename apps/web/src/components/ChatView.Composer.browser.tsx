import {
  ORCHESTRATION_WS_METHODS,
  type MessageId,
  ProviderInstanceId,
  type ServerConfig,
} from "@ryco/contracts";
import {
  PROMPT_STASH_STORAGE_KEY,
  stripInlineTerminalContextPlaceholders,
} from "@ryco/client-runtime/state/composer";
import { createModelCapabilities, createModelSelection } from "@ryco/shared/model";
import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";
import { useComposerDraftStore, DraftId } from "../composerDraftStore";
import { usePromptStashStore } from "../promptStashStore";
import {
  INLINE_TERMINAL_CONTEXT_PLACEHOLDER,
  removeInlineTerminalContextPlaceholder,
} from "../lib/terminalContext";
import { isMacPlatform } from "../lib/utils";
import { useUiStateStore } from "../uiStateStore";
import {
  setupChatViewBrowserSuite,
  COMPACT_FOOTER_VIEWPORT,
  DEFAULT_VIEWPORT,
  LOCAL_ENVIRONMENT_ID,
  NARROW_PHONE_VIEWPORT,
  NOW_ISO,
  PHONE_VIEWPORT,
  PROJECT_DRAFT_KEY,
  PROJECT_ID,
  THREAD_ID,
  THREAD_KEY,
  THREAD_REF,
  WIDE_FOOTER_VIEWPORT,
  configureContextHandoffProviders,
  createBrowserComposerImage,
  createDraftOnlySnapshot,
  createPromptStashEntry,
  createSnapshotForTargetUser,
  createSnapshotWithPendingUserInput,
  createSnapshotWithPlanFollowUpPrompt,
  createSourceControlContext,
  createTerminalContext,
  dispatchComposerStashShortcut,
  enableComposerStashShortcut,
  expandPhoneComposerIfCollapsed,
  expectComposerActionsContained,
  findComposerProviderModelPicker,
  findScrollableAncestor,
  fixture,
  mountChatView,
  pressComposerKey,
  pressComposerUndo,
  releaseModShortcut,
  selectAllComposerContent,
  setComposerSelectionByTextOffsets,
  setDraftThreadWithoutWorktree,
  waitForButtonByText,
  waitForButtonContainingText,
  waitForComposerEditor,
  waitForComposerMenuItem,
  waitForComposerStashBinding,
  waitForComposerText,
  waitForElement,
  waitForInteractionModeButton,
  waitForLayout,
  waitForSelectItemContainingText,
  waitForSendButton,
  waitForServerConfigToApply,
  wsRequests,
} from "./ChatView.browser.helpers";

// Hoisted per suite: a mock registered from the shared helpers runs after this file's static imports.
vi.mock("../lib/gitStatusState", () => import("../../test/gitStatusStateMock"));

describe("ChatView Composer (full app)", () => {
  setupChatViewBrowserSuite();

  it("stashes globally, preserves contexts/model state, merges on keyboard restore, and deletes from the picker", async () => {
    const terminalContext = createTerminalContext({
      id: "stash-terminal",
      terminalLabel: "Terminal 1",
      lineStart: 3,
      lineEnd: 4,
      text: "git status",
    });
    const sourceControlContext = createSourceControlContext("stash-source");
    const draftStore = useComposerDraftStore.getState();
    draftStore.setPrompt(THREAD_REF, "Stashed text");
    draftStore.addTerminalContext(THREAD_REF, terminalContext);
    draftStore.addSourceControlContext(THREAD_REF, sourceControlContext);

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-stash-global" as MessageId,
        targetText: "stash global target",
      }),
      configureFixture: enableComposerStashShortcut,
    });

    try {
      await waitForComposerStashBinding("s");
      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();
      const saveEvent = dispatchComposerStashShortcut({}, composerEditor);
      expect(saveEvent.defaultPrevented).toBe(true);

      let stashedId = "";
      await vi.waitFor(() => {
        const stash = usePromptStashStore.getState().entries;
        expect(stash).toHaveLength(1);
        expect(stash[0]?.prompt).toBe("Stashed text");
        stashedId = stash[0]?.id ?? "";
        const draft = useComposerDraftStore.getState().getComposerDraft(THREAD_REF);
        expect(stripInlineTerminalContextPlaceholders(draft?.prompt ?? "")).toBe("");
        expect(draft?.terminalContexts.map((context) => context.id)).toEqual(["stash-terminal"]);
        expect(draft?.sourceControlContexts.map((context) => context.id)).toEqual(["stash-source"]);
      });
      expect(localStorage.getItem(PROMPT_STASH_STORAGE_KEY)).toContain("Stashed text");

      usePromptStashStore.getState().stashEntry(
        createPromptStashEntry({
          id: "newer-picker-entry",
          prompt: "Other stash",
        }),
      );
      const emptyShortcut = dispatchComposerStashShortcut();
      expect(emptyShortcut.defaultPrevented).toBe(true);
      await waitForElement(
        () => document.querySelector('[data-prompt-stash-picker="true"]'),
        "Empty stash shortcut should open the picker.",
      );
      const escapeEvent = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(escapeEvent);
      expect(escapeEvent.defaultPrevented).toBe(true);
      await vi.waitFor(() => {
        expect(document.querySelector('[data-prompt-stash-picker="true"]')).toBeNull();
      });
      dispatchComposerStashShortcut();
      await waitForElement(
        () => document.querySelector('[data-prompt-stash-picker="true"]'),
        "Empty stash shortcut should reopen the picker.",
      );
      const outsidePickerButton = document.createElement("button");
      document.body.append(outsidePickerButton);
      outsidePickerButton.focus();
      const outsidePickerArrow = new KeyboardEvent("keydown", {
        key: "ArrowDown",
        bubbles: true,
        cancelable: true,
      });
      outsidePickerButton.dispatchEvent(outsidePickerArrow);
      expect(outsidePickerArrow.defaultPrevented).toBe(false);
      outsidePickerButton.remove();

      const switchedSelection = createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-opus-4-6",
        [{ id: "effort", value: "max" }],
      );
      useComposerDraftStore.getState().setModelSelection(THREAD_REF, switchedSelection);
      useComposerDraftStore
        .getState()
        .setPrompt(THREAD_REF, `${INLINE_TERMINAL_CONTEXT_PLACEHOLDER}Current text`);
      await waitForLayout();

      const stashPicker = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-prompt-stash-picker="true"]'),
        "Unable to focus the stash picker.",
      );
      stashPicker.focus();
      await userEvent.keyboard("{ArrowUp}{ArrowDown}{ArrowDown}{Enter}");

      await vi.waitFor(() => {
        const draft = useComposerDraftStore.getState().getComposerDraft(THREAD_REF);
        expect(stripInlineTerminalContextPlaceholders(draft?.prompt ?? "")).toBe(
          "Current text\n\nStashed text",
        );
        expect(draft?.modelSelectionByProvider[ProviderInstanceId.make("claudeAgent")]).toEqual(
          switchedSelection,
        );
        expect(draft?.activeProvider).toBe("claudeAgent");
        expect(usePromptStashStore.getState().entries.map((entry) => entry.id)).not.toContain(
          stashedId,
        );
      });

      const mergedPrompt =
        useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.prompt ?? "";
      const stashBadge = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('[data-prompt-stash-badge="true"]'),
        "Unable to find stash badge for deletion.",
      );
      stashBadge.click();
      const deleteButton = await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>(
            '[data-prompt-stash-delete="newer-picker-entry"]',
          ),
        "Unable to find stash delete button.",
      );
      deleteButton.focus();
      await userEvent.keyboard("{Enter}");
      await vi.waitFor(() => {
        expect(usePromptStashStore.getState().entries).toEqual([]);
        expect(useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.prompt).toBe(
          mergedPrompt,
        );
      });
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      );
      await vi.waitFor(() => {
        expect(document.querySelector('[data-prompt-stash-picker="true"]')).toBeNull();
      });

      usePromptStashStore
        .getState()
        .stashEntry(createPromptStashEntry({ id: "keyboard-keep", prompt: "Keep" }));
      usePromptStashStore
        .getState()
        .stashEntry(createPromptStashEntry({ id: "keyboard-delete", prompt: "Delete" }));
      const keyboardDeleteBadge = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('[data-prompt-stash-badge="true"]'),
        "Unable to find stash badge for keyboard deletion.",
      );
      keyboardDeleteBadge.click();
      const keyboardDeletePicker = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-prompt-stash-picker="true"]'),
        "Unable to focus stash picker for keyboard deletion.",
      );
      keyboardDeletePicker.focus();
      const deleteShortcut = new KeyboardEvent("keydown", {
        key: "Backspace",
        metaKey: isMacPlatform(navigator.platform),
        ctrlKey: !isMacPlatform(navigator.platform),
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(deleteShortcut);
      expect(deleteShortcut.defaultPrevented).toBe(true);
      await vi.waitFor(() => {
        expect(usePromptStashStore.getState().entries.map((entry) => entry.id)).toEqual([
          "keyboard-keep",
        ]);
        expect(useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.prompt).toBe(
          mergedPrompt,
        );
      });

      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      );
      await vi.waitFor(() => {
        expect(document.querySelector('[data-prompt-stash-picker="true"]')).toBeNull();
      });

      const entriesBeforeIgnoredShortcuts = usePromptStashStore.getState().entries;
      const alreadyHandledShortcut = new KeyboardEvent("keydown", {
        key: "s",
        metaKey: isMacPlatform(navigator.platform),
        ctrlKey: !isMacPlatform(navigator.platform),
        bubbles: true,
        cancelable: true,
      });
      alreadyHandledShortcut.preventDefault();
      window.dispatchEvent(alreadyHandledShortcut);
      expect(usePromptStashStore.getState().entries).toBe(entriesBeforeIgnoredShortcuts);

      const dialog = document.createElement("div");
      dialog.setAttribute("role", "dialog");
      const dialogInput = document.createElement("input");
      dialog.append(dialogInput);
      document.body.append(dialog);
      dialogInput.focus();
      const ignoredInDialog = dispatchComposerStashShortcut({}, dialogInput);
      expect(ignoredInDialog.defaultPrevented).toBe(false);
      expect(usePromptStashStore.getState().entries).toBe(entriesBeforeIgnoredShortcuts);
      dialog.remove();

      const terminalInput = document.createElement("textarea");
      terminalInput.className = "xterm-helper-textarea";
      document.body.append(terminalInput);
      terminalInput.focus();
      const unresolvedInTerminal = dispatchComposerStashShortcut();
      expect(unresolvedInTerminal.defaultPrevented).toBe(false);
      terminalInput.remove();
    } finally {
      await mounted.cleanup();
    }
  });

  it("separates restored text from retained terminal placeholders", async () => {
    const draftStore = useComposerDraftStore.getState();
    draftStore.setPrompt(THREAD_REF, "Separated stash text");
    draftStore.addTerminalContext(
      THREAD_REF,
      createTerminalContext({
        id: "stash-separator-terminal",
        terminalLabel: "Terminal 1",
        lineStart: 3,
        lineEnd: 4,
        text: "git status",
      }),
    );
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-stash-separator" as MessageId,
        targetText: "stash separator target",
      }),
      configureFixture: enableComposerStashShortcut,
    });

    try {
      await waitForComposerStashBinding("s");
      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();
      dispatchComposerStashShortcut();
      await vi.waitFor(() => {
        expect(usePromptStashStore.getState().entries).toHaveLength(1);
        expect(useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.prompt).toBe(
          INLINE_TERMINAL_CONTEXT_PLACEHOLDER,
        );
      });

      dispatchComposerStashShortcut();
      const row = await waitForElement(
        () => document.querySelector<HTMLElement>("[data-prompt-stash-row]"),
        "Unable to find the terminal-separator stash row.",
      );
      row.click();
      await vi.waitFor(() => {
        expect(useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.prompt).toBe(
          `${INLINE_TERMINAL_CONTEXT_PLACEHOLDER}\n\nSeparated stash text`,
        );
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("honors a custom composer stash binding without suppressing the unbound Save shortcut", async () => {
    useComposerDraftStore.getState().setPrompt(THREAD_REF, "Custom binding prompt");
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-stash-custom-binding" as MessageId,
        targetText: "stash custom binding target",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "composer.stash",
              shortcut: {
                key: "x",
                metaKey: false,
                ctrlKey: true,
                shiftKey: false,
                altKey: true,
                modKey: false,
              },
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "terminalFocus" },
              },
            },
          ],
        };
      },
    });

    try {
      await waitForComposerStashBinding("x");
      expect(dispatchComposerStashShortcut().defaultPrevented).toBe(false);
      expect(usePromptStashStore.getState().entries).toEqual([]);

      const customEvent = new KeyboardEvent("keydown", {
        key: "x",
        ctrlKey: true,
        altKey: true,
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(customEvent);
      expect(customEvent.defaultPrevented).toBe(true);
      await vi.waitFor(() => {
        expect(usePromptStashStore.getState().entries[0]?.prompt).toBe("Custom binding prompt");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps newer typing during image finalization and enforces restore dedupe and attachment caps", async () => {
    let resolveImageBytes!: (value: ArrayBuffer) => void;
    const delayedImageBytes = new Promise<ArrayBuffer>((resolve) => {
      resolveImageBytes = resolve;
    });
    const delayedImage = createBrowserComposerImage({
      id: "delayed-image",
      name: "delayed.png",
      arrayBuffer: () => delayedImageBytes,
      previewUrl: "blob:delayed-image",
    });
    const draftStore = useComposerDraftStore.getState();
    draftStore.setPrompt(THREAD_REF, "Image prompt");
    draftStore.addImage(THREAD_REF, delayedImage);

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-stash-images" as MessageId,
        targetText: "stash images target",
      }),
      configureFixture: enableComposerStashShortcut,
    });
    const originalRevokeObjectUrl = URL.revokeObjectURL;
    const revokeObjectUrl = vi.fn();
    URL.revokeObjectURL = revokeObjectUrl;

    try {
      await waitForComposerStashBinding("s");
      dispatchComposerStashShortcut();
      await vi.waitFor(() => {
        expect(usePromptStashStore.getState().entries[0]?.pendingImageCount).toBe(1);
        expect(useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.images ?? []).toEqual(
          [],
        );
      });

      useComposerDraftStore.getState().setPrompt(THREAD_REF, "Typed while saving");
      resolveImageBytes(new Uint8Array([1, 2, 3]).buffer);
      await vi.waitFor(() => {
        expect(usePromptStashStore.getState().entries[0]?.pendingImageCount).toBe(0);
        expect(useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.prompt).toBe(
          "Typed while saving",
        );
        expect(revokeObjectUrl).toHaveBeenCalledWith("blob:delayed-image");
      });

      const finalizedImageBadge = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('[data-prompt-stash-badge="true"]'),
        "Unable to find finalized image stash badge.",
      );
      finalizedImageBadge.click();
      const delayedRow = await waitForElement(
        () => document.querySelector<HTMLElement>("[data-prompt-stash-row]"),
        "Unable to find finalized image stash row.",
      );
      delayedRow.click();
      await vi.waitFor(() => {
        const draft = useComposerDraftStore.getState().getComposerDraft(THREAD_REF);
        expect(draft?.prompt).toBe("Typed while saving\n\nImage prompt");
        expect(draft?.images.map((image) => image.name)).toEqual(["delayed.png"]);
      });

      useComposerDraftStore.getState().clearPromptAndImages(THREAD_REF);
      const currentImages = [
        createBrowserComposerImage({
          id: "current-duplicate",
          name: "duplicate.png",
        }),
        ...Array.from({ length: 6 }, (_, index) =>
          createBrowserComposerImage({
            id: `current-${index}`,
            name: `current-${index}.png`,
            bytes: new Uint8Array([index + 10]),
          }),
        ),
      ];
      useComposerDraftStore.getState().addImages(THREAD_REF, currentImages);
      useComposerDraftStore.getState().setPrompt(THREAD_REF, "Current cap text");
      usePromptStashStore.getState().stashEntry(
        createPromptStashEntry({
          id: "cap-entry",
          prompt: "Saved cap text",
          attachments: [
            {
              id: "saved-duplicate",
              name: "duplicate.png",
              mimeType: "image/png",
              sizeBytes: 3,
              dataUrl: "data:image/png;base64,AQID",
            },
            {
              id: "saved-accepted",
              name: "accepted.png",
              mimeType: "image/png",
              sizeBytes: 3,
              dataUrl: "data:image/png;base64,AQID",
            },
            {
              id: "saved-overflow",
              name: "overflow.png",
              mimeType: "image/png",
              sizeBytes: 3,
              dataUrl: "data:image/png;base64,AQID",
            },
          ],
        }),
      );

      const capBadge = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('[data-prompt-stash-badge="true"]'),
        "Unable to find attachment cap stash badge.",
      );
      capBadge.click();
      const capRow = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-prompt-stash-row="cap-entry"]'),
        "Unable to find attachment cap stash row.",
      );
      capRow.click();
      await vi.waitFor(() => {
        const draft = useComposerDraftStore.getState().getComposerDraft(THREAD_REF);
        expect(draft?.prompt).toBe("Current cap text\n\nSaved cap text");
        expect(draft?.images).toHaveLength(8);
        expect(draft?.images.map((image) => image.name)).toContain("accepted.png");
        expect(draft?.images.map((image) => image.name)).not.toContain("overflow.png");
        expect(draft?.images.filter((image) => image.name === "duplicate.png")).toHaveLength(1);
      });
    } finally {
      await mounted.cleanup();
      URL.revokeObjectURL = originalRevokeObjectUrl;
    }
  });

  it("keeps the mobile run-context control non-interactive when the environment is locked", async () => {
    const mounted = await mountChatView({
      viewport: COMPACT_FOOTER_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-mobile-locked-workspace" as MessageId,
        targetText: "locked mobile workspace",
      }),
    });

    try {
      await expect.element(page.getByTestId("composer-editor")).toBeInTheDocument();
      expect(document.querySelector('button[aria-label="Run on"]')).toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  it("shrinks the desktop composer at rest and while reading, then expands without losing the draft", async () => {
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-compact-composer" as MessageId,
        targetText: "compact composer",
      }),
    });

    try {
      const editor = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="composer-editor"]'),
        "Unable to find the composer editor.",
      );
      const surface = editor.closest<HTMLElement>("[data-chat-composer-compact]")!;
      (document.activeElement as HTMLElement | null)?.blur();
      await vi.waitFor(() => expect(editor.getBoundingClientRect().height).toBeCloseTo(26, 0));

      surface.dispatchEvent(
        new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" }),
      );
      await vi.waitFor(() => expect(editor.getBoundingClientRect().height).toBeGreaterThan(60));
      surface.dispatchEvent(
        new PointerEvent("pointerout", {
          bubbles: true,
          pointerType: "mouse",
          relatedTarget: document.body,
        }),
      );
      await vi.waitFor(() => expect(editor.getBoundingClientRect().height).toBeCloseTo(26, 0));

      editor.focus();
      await vi.waitFor(() => expect(editor.getBoundingClientRect().height).toBeGreaterThan(60));
      useComposerDraftStore.getState().setPrompt(THREAD_REF, "Keep this draft");
      await vi.waitFor(() => expect(editor.textContent).toContain("Keep this draft"));
      const timelineRow = await waitForElement(
        () => document.querySelector<HTMLElement>("[data-message-id]"),
        "Unable to find a timeline message.",
      );
      const scrollContainer = findScrollableAncestor(timelineRow)!;
      scrollContainer.dispatchEvent(new WheelEvent("wheel", { deltaY: -240, bubbles: true }));
      await vi.waitFor(() => expect(editor.getBoundingClientRect().height).toBeCloseTo(26, 0));
      expect(document.activeElement).toBe(editor);
      expect(editor.textContent).toContain("Keep this draft");

      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
      await vi.waitFor(() => expect(editor.getBoundingClientRect().height).toBeGreaterThan(60));
      expect(document.querySelector('[data-testid="composer-editor"]')).toBe(editor);
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the active-thread composer on its stable outer width while phones remain full width", async () => {
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-composer-width" as MessageId,
        targetText: "composer width",
      }),
    });

    try {
      const composerForm = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-chat-composer-form="true"]'),
        "Unable to find the composer form.",
      );
      const composerContainer = composerForm.parentElement;
      expect(composerContainer).toBeTruthy();
      await waitForLayout();

      const desktopFormRect = composerForm.getBoundingClientRect();
      const desktopContainerRect = composerContainer!.getBoundingClientRect();
      expect(desktopFormRect.width).toBeCloseTo(52 * 16, 1);
      expect(desktopFormRect.left - desktopContainerRect.left).toBeCloseTo(
        (desktopContainerRect.width - desktopFormRect.width) / 2,
        1,
      );

      await mounted.setViewport(PHONE_VIEWPORT);
      await vi.waitFor(() => {
        expect(document.documentElement.getAttribute("data-tier")).toBe("phone");
      });
      await waitForLayout();

      const phoneFormRect = composerForm.getBoundingClientRect();
      const phoneContainerRect = composerContainer!.getBoundingClientRect();
      expect(phoneFormRect.width / phoneContainerRect.width).toBeCloseTo(1, 2);
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the new-thread composer on the same stable content width", async () => {
    const draftId = DraftId.make("draft-composer-timeline-width");
    useComposerDraftStore.setState({
      draftThreadsByThreadKey: {
        [draftId]: {
          threadId: THREAD_ID,
          environmentId: LOCAL_ENVIRONMENT_ID,
          projectId: PROJECT_ID,
          logicalProjectKey: PROJECT_DRAFT_KEY,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          envMode: "local",
        },
      },
      logicalProjectDraftThreadKeyByLogicalProjectKey: {
        [PROJECT_DRAFT_KEY]: draftId,
      },
    });

    const newThreadMounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      initialPath: `/draft/${draftId}`,
    });

    try {
      await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="new-thread-hero"]'),
        "Unable to find the new-thread hero.",
      );
      const composerForm = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-chat-composer-form="true"]'),
        "Unable to find the new-thread composer form.",
      );
      const composerContainer = composerForm.parentElement;
      expect(composerContainer).toBeTruthy();
      await waitForLayout();

      const formRect = composerForm.getBoundingClientRect();
      const containerRect = composerContainer!.getBoundingClientRect();
      expect(formRect.width).toBeCloseTo(52 * 16, 1);
      expect(formRect.left - containerRect.left).toBeCloseTo(
        (containerRect.width - formRect.width) / 2,
        1,
      );
    } finally {
      await newThreadMounted.cleanup();
    }
  });

  it("contains the active chat and composer at 320 CSS pixels", async () => {
    const mounted = await mountChatView({
      viewport: NARROW_PHONE_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-narrow-mobile" as MessageId,
        targetText: "narrow mobile workspace",
      }),
    });

    try {
      const composer = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="composer-editor"]'),
        "Unable to find the mobile composer.",
      );
      await waitForLayout();
      const rect = composer.getBoundingClientRect();
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
      expect(rect.left).toBeGreaterThanOrEqual(0);
      expect(rect.right).toBeLessThanOrEqual(window.innerWidth);
      expect(rect.bottom).toBeLessThanOrEqual(window.innerHeight);
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps dismiss-only composer banners aligned on mobile", async () => {
    const mounted = await mountChatView({
      viewport: COMPACT_FOOTER_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-mobile-version-banner" as MessageId,
        targetText: "mobile version banner",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          environment: {
            ...nextFixture.serverConfig.environment,
            serverVersion: "9.9.9",
          },
        };
      },
    });

    try {
      const banner = await waitForElement(
        () =>
          Array.from(document.querySelectorAll<HTMLElement>('[data-slot="alert"]')).find(
            (element) => element.textContent?.includes("Client and server versions differ"),
          ) ?? null,
        "Unable to find version mismatch banner.",
      );
      const title = banner.querySelector<HTMLElement>('[data-slot="alert-title"]');
      const description = banner.querySelector<HTMLElement>('[data-slot="alert-description"]');
      const dismissButton = banner.querySelector<HTMLButtonElement>(
        'button[aria-label="Dismiss version mismatch warning"]',
      );

      expect(title).toBeTruthy();
      expect(description).toBeTruthy();
      expect(dismissButton).toBeTruthy();
      expect(dismissButton!.getBoundingClientRect().top).toBeLessThan(
        description!.getBoundingClientRect().top,
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("toggles plan mode with Shift+Tab only while the composer is focused", async () => {
    useUiStateStore.getState().setAlwaysUseBuildMode(false);
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-target-hotkey" as MessageId,
        targetText: "hotkey target",
      }),
    });

    try {
      const initialModeButton = await waitForInteractionModeButton("Build");
      expect(initialModeButton.title).toContain("Make changes and run commands.");

      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      await waitForLayout();

      expect((await waitForInteractionModeButton("Build")).title).toContain(
        "Make changes and run commands.",
      );

      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();
      composerEditor.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );

      await vi.waitFor(
        async () => {
          expect((await waitForInteractionModeButton("Plan")).title).toContain(
            "Chat toward a plan before making changes.",
          );
        },
        { timeout: 8_000, interval: 16 },
      );

      composerEditor.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );

      await vi.waitFor(
        async () => {
          expect((await waitForInteractionModeButton("Build")).title).toContain(
            "Make changes and run commands.",
          );
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("surrounds selected plain text and preserves the inner selection for repeated wrapping", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-surround-basic" as MessageId,
        targetText: "surround basic",
      }),
    });

    try {
      useComposerDraftStore.getState().setPrompt(THREAD_REF, "selected");
      await waitForComposerText("selected");
      await setComposerSelectionByTextOffsets({
        start: 0,
        end: "selected".length,
      });
      await pressComposerKey("(");
      await waitForComposerText("(selected)");

      await pressComposerKey("[");
      await waitForComposerText("([selected])");
    } finally {
      await mounted.cleanup();
    }
  });

  it("leaves collapsed-caret typing unchanged for surround symbols", async () => {
    useComposerDraftStore.getState().setPrompt(THREAD_REF, "selected");

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-surround-collapsed" as MessageId,
        targetText: "surround collapsed",
      }),
    });

    try {
      await waitForComposerText("selected");
      await setComposerSelectionByTextOffsets({
        start: "selected".length,
        end: "selected".length,
      });
      await pressComposerKey("(");
      await waitForComposerText("selected(");
    } finally {
      await mounted.cleanup();
    }
  });

  it("supports symmetric and backward-selection surrounds", async () => {
    useComposerDraftStore.getState().setPrompt(THREAD_REF, "backward");

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-surround-backward" as MessageId,
        targetText: "surround backward",
      }),
    });

    try {
      await waitForComposerText("backward");
      await setComposerSelectionByTextOffsets({
        start: 0,
        end: "backward".length,
        direction: "backward",
      });
      await pressComposerKey("*");
      await waitForComposerText("*backward*");
    } finally {
      await mounted.cleanup();
    }
  });

  it("supports option-produced surround symbols like guillemets", async () => {
    useComposerDraftStore.getState().setPrompt(THREAD_REF, "quoted");

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-surround-guillemet" as MessageId,
        targetText: "surround guillemet",
      }),
    });

    try {
      await waitForComposerText("quoted");
      await setComposerSelectionByTextOffsets({
        start: 0,
        end: "quoted".length,
      });
      await pressComposerKey("«");
      await waitForComposerText("«quoted»");
    } finally {
      await mounted.cleanup();
    }
  });

  it("supports dead-key composition that resolves to another surround symbol without an extra undo step", async () => {
    useComposerDraftStore.getState().setPrompt(THREAD_REF, "quoted");

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-surround-dead-quote" as MessageId,
        targetText: "surround dead quote",
      }),
    });

    try {
      await waitForComposerText("quoted");
      await setComposerSelectionByTextOffsets({
        start: 0,
        end: "quoted".length,
      });
      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();
      composerEditor.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Dead",
          bubbles: true,
          cancelable: true,
        }),
      );
      composerEditor.dispatchEvent(
        new InputEvent("beforeinput", {
          data: "'",
          inputType: "insertCompositionText",
          bubbles: true,
          cancelable: true,
        }),
      );
      const resolvedInputEvent = new InputEvent("beforeinput", {
        data: "'",
        inputType: "insertText",
        bubbles: true,
        cancelable: true,
      });
      composerEditor.dispatchEvent(resolvedInputEvent);
      expect(resolvedInputEvent.defaultPrevented).toBe(true);
      await waitForComposerText("'quoted'");
      await pressComposerUndo();
      await waitForComposerText("quoted");
    } finally {
      await mounted.cleanup();
    }
  });

  it("surrounds text after a mention using the correct expanded offsets", async () => {
    useComposerDraftStore.getState().setPrompt(THREAD_REF, "hi @package.json there");

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-surround-after-mention" as MessageId,
        targetText: "surround after mention",
      }),
    });

    try {
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain("package.json");
        },
        { timeout: 8_000, interval: 16 },
      );
      await waitForComposerText("hi @package.json there");
      await setComposerSelectionByTextOffsets({
        start: "hi package.json ".length,
        end: "hi package.json there".length,
      });
      await pressComposerKey("(");
      await waitForComposerText("hi @package.json (there)");
    } finally {
      await mounted.cleanup();
    }
  });

  it("falls back to normal replacement when the selection includes a mention token", async () => {
    useComposerDraftStore.getState().setPrompt(THREAD_REF, "hi @package.json there ");

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-surround-token" as MessageId,
        targetText: "surround token",
      }),
    });

    try {
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain("package.json");
        },
        { timeout: 8_000, interval: 16 },
      );
      await selectAllComposerContent();
      await pressComposerKey("(");
      await waitForComposerText("(");
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows runtime mode descriptions in the desktop composer access select", async () => {
    setDraftThreadWithoutWorktree();

    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
    });

    try {
      const runtimeModeSelect = await waitForButtonByText("Full access");
      runtimeModeSelect.click();

      expect((await waitForSelectItemContainingText("Supervised")).textContent).toContain(
        "Ask before commands and file changes",
      );

      const autoAcceptItem = await waitForSelectItemContainingText("Auto-accept edits");
      expect(autoAcceptItem.textContent).toContain("Auto-approve edits");
      expect(
        (await waitForSelectItemContainingText("Routine actions proceed without you")).textContent,
      ).toContain("Auto");
      expect((await waitForSelectItemContainingText("Full access")).textContent).toContain(
        "Allow commands and edits without prompts",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps removed terminal context pills removed when a new one is added", async () => {
    const removedLabel = "Terminal 1 lines 1-2";
    const addedLabel = "Terminal 2 lines 9-10";
    useComposerDraftStore.getState().addTerminalContext(
      THREAD_REF,
      createTerminalContext({
        id: "ctx-removed",
        terminalLabel: "Terminal 1",
        lineStart: 1,
        lineEnd: 2,
        text: "bun i\nno changes",
      }),
    );

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-terminal-pill-backspace" as MessageId,
        targetText: "terminal pill backspace target",
      }),
    });

    try {
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain(removedLabel);
        },
        { timeout: 8_000, interval: 16 },
      );

      const store = useComposerDraftStore.getState();
      const currentPrompt = store.draftsByThreadKey[THREAD_KEY]?.prompt ?? "";
      const nextPrompt = removeInlineTerminalContextPlaceholder(currentPrompt, 0);
      store.setPrompt(THREAD_REF, nextPrompt.prompt);
      store.removeTerminalContext(THREAD_REF, "ctx-removed");

      await vi.waitFor(
        () => {
          expect(useComposerDraftStore.getState().draftsByThreadKey[THREAD_KEY]).toBeUndefined();
          expect(document.body.textContent).not.toContain(removedLabel);
        },
        { timeout: 8_000, interval: 16 },
      );

      useComposerDraftStore.getState().addTerminalContext(
        THREAD_REF,
        createTerminalContext({
          id: "ctx-added",
          terminalLabel: "Terminal 2",
          lineStart: 9,
          lineEnd: 10,
          text: "git status\nOn branch main",
        }),
      );

      await vi.waitFor(
        () => {
          const draft = useComposerDraftStore.getState().draftsByThreadKey[THREAD_KEY];
          expect(draft?.terminalContexts.map((context) => context.id)).toEqual(["ctx-added"]);
          expect(document.body.textContent).toContain(addedLabel);
          expect(document.body.textContent).not.toContain(removedLabel);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("disables send when the composer only contains an expired terminal pill", async () => {
    const expiredLabel = "Terminal 1 line 4";
    useComposerDraftStore.getState().addTerminalContext(
      THREAD_REF,
      createTerminalContext({
        id: "ctx-expired-only",
        terminalLabel: "Terminal 1",
        lineStart: 4,
        lineEnd: 4,
        text: "",
      }),
    );

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-expired-pill-disabled" as MessageId,
        targetText: "expired pill disabled target",
      }),
    });

    try {
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain(expiredLabel);
        },
        { timeout: 8_000, interval: 16 },
      );

      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(true);
    } finally {
      await mounted.cleanup();
    }
  });

  it("warns when sending text while omitting expired terminal pills", async () => {
    const expiredLabel = "Terminal 1 line 4";
    useComposerDraftStore.getState().addTerminalContext(
      THREAD_REF,
      createTerminalContext({
        id: "ctx-expired-send-warning",
        terminalLabel: "Terminal 1",
        lineStart: 4,
        lineEnd: 4,
        text: "",
      }),
    );
    useComposerDraftStore
      .getState()
      .setPrompt(THREAD_REF, `yoo${INLINE_TERMINAL_CONTEXT_PLACEHOLDER}waddup`);

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-expired-pill-warning" as MessageId,
        targetText: "expired pill warning target",
      }),
    });

    try {
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain(expiredLabel);
        },
        { timeout: 8_000, interval: 16 },
      );

      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      sendButton.click();

      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain(
            "Expired terminal context omitted from message",
          );
          expect(document.body.textContent).not.toContain(expiredLabel);
          expect(document.body.textContent).toContain("yoowaddup");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("submits pending user input after the final option selection resolves the draft answers", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithPendingUserInput(),
      resolveRpc: (body) => {
        if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
          return {
            sequence: fixture.snapshot.snapshotSequence + 1,
          };
        }
        return undefined;
      },
    });

    try {
      const firstOption = await waitForButtonContainingText("Tight");
      firstOption.click();

      const finalOption = await waitForButtonContainingText("Conservative");
      finalOption.click();

      await vi.waitFor(
        () => {
          const dispatchRequest = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              request.type === "thread.user-input.respond",
          ) as
            | {
                _tag: string;
                type?: string;
                requestId?: string;
                answers?: Record<string, unknown>;
              }
            | undefined;

          expect(dispatchRequest).toMatchObject({
            _tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
            type: "thread.user-input.respond",
            requestId: "req-browser-user-input",
            answers: {
              scope: "Tight",
              risk: "Conservative",
            },
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps plan follow-up footer actions fused and aligned after a real resize", async () => {
    useUiStateStore.getState().setAlwaysUseBuildMode(false);
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: createSnapshotWithPlanFollowUpPrompt(),
    });

    try {
      const footer = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-chat-composer-footer="true"]'),
        "Unable to find composer footer.",
      );
      const initialModelPicker = await waitForElement(
        findComposerProviderModelPicker,
        "Unable to find provider model picker.",
      );
      const initialModelPickerOffset =
        initialModelPicker.getBoundingClientRect().left - footer.getBoundingClientRect().left;
      const initialImplementButton = await waitForButtonByText("Implement");
      const initialImplementWidth = initialImplementButton.getBoundingClientRect().width;

      await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>('button[aria-label="Implementation actions"]'),
        "Unable to find implementation actions trigger.",
      );

      await mounted.setViewport({
        ...WIDE_FOOTER_VIEWPORT,
        width: 1_024,
      });
      await expectComposerActionsContained();

      const implementButton = await waitForButtonByText("Implement");
      const implementActionsButton = await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>('button[aria-label="Implementation actions"]'),
        "Unable to find implementation actions trigger.",
      );

      await vi.waitFor(
        () => {
          const implementRect = implementButton.getBoundingClientRect();
          const implementActionsRect = implementActionsButton.getBoundingClientRect();
          const compactModelPicker = findComposerProviderModelPicker();
          expect(compactModelPicker).toBeTruthy();

          const compactModelPickerOffset =
            compactModelPicker!.getBoundingClientRect().left - footer.getBoundingClientRect().left;

          expect(Math.abs(implementRect.right - implementActionsRect.left)).toBeLessThanOrEqual(1);
          expect(Math.abs(implementRect.top - implementActionsRect.top)).toBeLessThanOrEqual(1);
          expect(Math.abs(implementRect.width - initialImplementWidth)).toBeLessThanOrEqual(1);
          expect(Math.abs(compactModelPickerOffset - initialModelPickerOffset)).toBeLessThanOrEqual(
            1,
          );
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the wide desktop follow-up layout expanded when the footer still fits", async () => {
    useUiStateStore.getState().setAlwaysUseBuildMode(false);
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: createSnapshotWithPlanFollowUpPrompt({
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.3-codex-spark",
        },
        planMarkdown:
          "# Imaginary Long-Range Plan: Ryco Adaptive Orchestration and Safe-Delay Execution Initiative",
      }),
    });

    try {
      await waitForButtonByText("Implement");

      await vi.waitFor(
        () => {
          const footer = document.querySelector<HTMLElement>('[data-chat-composer-footer="true"]');
          const actions = document.querySelector<HTMLElement>(
            '[data-chat-composer-actions="right"]',
          );

          expect(footer?.dataset.chatComposerFooterCompact).toBe("false");
          expect(actions?.dataset.chatComposerPrimaryActionsCompact).toBe("false");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("compacts the footer when a wide desktop follow-up layout starts overflowing", async () => {
    useUiStateStore.getState().setAlwaysUseBuildMode(false);
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: createSnapshotWithPlanFollowUpPrompt({
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.3-codex-spark",
        },
        planMarkdown:
          "# Imaginary Long-Range Plan: Ryco Adaptive Orchestration and Safe-Delay Execution Initiative",
      }),
    });

    try {
      await waitForButtonByText("Implement");

      await mounted.setContainerSize({
        width: 804,
        height: WIDE_FOOTER_VIEWPORT.height,
      });

      await expectComposerActionsContained();

      await vi.waitFor(
        () => {
          const footer = document.querySelector<HTMLElement>('[data-chat-composer-footer="true"]');
          const actions = document.querySelector<HTMLElement>(
            '[data-chat-composer-actions="right"]',
          );

          expect(footer?.dataset.chatComposerFooterCompact).toBe("true");
          expect(actions?.dataset.chatComposerPrimaryActionsCompact).toBe("true");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the slash-command menu visible above the composer", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-command-menu-target" as MessageId,
        targetText: "command menu thread",
      }),
    });

    try {
      await waitForComposerEditor();
      await page.getByTestId("composer-editor").fill("/");

      const menuItem = await waitForComposerMenuItem("slash:model");
      const composerForm = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-chat-composer-form="true"]'),
        "Unable to find composer form.",
      );

      await vi.waitFor(
        () => {
          const menuRect = menuItem.getBoundingClientRect();
          const composerRect = composerForm.getBoundingClientRect();
          const hitTarget = document.elementFromPoint(
            menuRect.left + menuRect.width / 2,
            menuRect.top + menuRect.height / 2,
          );

          expect(menuRect.width).toBeGreaterThan(0);
          expect(menuRect.height).toBeGreaterThan(0);
          expect(menuRect.bottom).toBeLessThanOrEqual(composerRect.bottom);
          expect(hitTarget instanceof Element && menuItem.contains(hitTarget)).toBe(true);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("stages an idle provider target locally and sends it without an unsafe model meta update", async () => {
    useUiStateStore.getState().setAlwaysUseBuildMode(false);
    const snapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-context-handoff-stage" as MessageId,
      targetText: "context handoff staging thread",
    });
    const thread = snapshot.threads.find((candidate) => candidate.id === THREAD_ID);
    if (!thread) throw new Error("Expected context handoff thread fixture.");
    Object.assign(thread, { interactionMode: "ask" as const });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot,
      configureFixture: configureContextHandoffProviders,
      resolveRpc: (body) => {
        if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
          return { sequence: fixture.snapshot.snapshotSequence + 1 };
        }
        return undefined;
      },
    });

    try {
      await waitForServerConfigToApply();
      const picker = await waitForElement(
        findComposerProviderModelPicker,
        "Unable to find provider/model picker for context handoff.",
      );
      await picker.click();
      await page.getByRole("button", { name: "Claude", exact: true }).click();
      await page.getByText("Sonnet 4.6", { exact: true }).click();
      await waitForLayout();

      const pendingHandoff = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-pending-context-handoff="true"]'),
        "Unable to find the staged context-handoff chip.",
      );
      expect(pendingHandoff.textContent).toContain("Next message hands off context");
      expect(pendingHandoff.textContent).toContain("GPT-5");
      expect(pendingHandoff.textContent).toContain("Sonnet 4.6");
      expect(pendingHandoff.textContent).not.toContain("claude-sonnet-4-6");
      expect(pendingHandoff.querySelector("button")).toBeNull();
      expect(pendingHandoff.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        document
          .querySelector<HTMLElement>('[data-chat-composer-mobile-collapsed="false"]')!
          .getBoundingClientRect().top,
      );

      expect(
        wsRequests.some((request) => request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand),
      ).toBe(false);
      expect(useComposerDraftStore.getState().getComposerDraft(THREAD_REF)).toMatchObject({
        activeProvider: ProviderInstanceId.make("claudeAgent"),
        modelSelectionByProvider: {
          claudeAgent: {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            model: "claude-sonnet-4-6",
          },
        },
        interactionMode: "default",
      });
      expect(useComposerDraftStore.getState().stickyActiveProvider).not.toBe(
        ProviderInstanceId.make("claudeAgent"),
      );

      useComposerDraftStore.getState().setPrompt(THREAD_REF, "Continue on the staged target");
      const sendButton = await waitForSendButton();
      sendButton.click();

      await vi.waitFor(
        () => {
          const turnStart = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              request.type === "thread.turn.start",
          );
          expect(turnStart).toMatchObject({
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: "claude-sonnet-4-6",
            },
          });
        },
        { timeout: 8_000, interval: 16 },
      );
      expect(document.querySelector('[data-pending-context-handoff="true"]')).toBeNull();
      expect(
        wsRequests.some(
          (request) =>
            request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
            request.type === "thread.meta.update" &&
            "modelSelection" in request,
        ),
      ).toBe(false);
    } finally {
      await mounted.cleanup();
    }
  });

  it("changes models inside the active provider without presenting a context handoff", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-same-provider-model-stage" as MessageId,
        targetText: "same provider model staging thread",
      }),
      configureFixture: configureContextHandoffProviders,
      resolveRpc: (body) => {
        if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
          return { sequence: fixture.snapshot.snapshotSequence + 1 };
        }
        return undefined;
      },
    });

    try {
      await waitForServerConfigToApply();
      const picker = await waitForElement(
        findComposerProviderModelPicker,
        "Unable to find provider/model picker for same-provider model change.",
      );
      await picker.click();
      await page.getByRole("button", { name: "Codex", exact: true }).click();
      await page.getByText("GPT-5.1", { exact: true }).click();
      await waitForLayout();

      expect(document.querySelector('[data-pending-context-handoff="true"]')).toBeNull();
      expect(useComposerDraftStore.getState().getComposerDraft(THREAD_REF)).toMatchObject({
        activeProvider: ProviderInstanceId.make("codex"),
        modelSelectionByProvider: {
          codex: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.1",
          },
        },
      });

      useComposerDraftStore.getState().setPrompt(THREAD_REF, "Continue with the new Codex model");
      const sendButton = await waitForSendButton();
      sendButton.click();

      await vi.waitFor(
        () => {
          const turnStart = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              request.type === "thread.turn.start",
          );
          expect(turnStart).toMatchObject({
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5.1",
            },
          });
        },
        { timeout: 8_000, interval: 16 },
      );
      expect(document.querySelector('[data-pending-context-handoff="true"]')).toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the frozen web phone picker on the current provider", async () => {
    const mounted = await mountChatView({
      viewport: PHONE_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-context-handoff-phone" as MessageId,
        targetText: "frozen phone provider thread",
      }),
      configureFixture: configureContextHandoffProviders,
    });

    try {
      await waitForServerConfigToApply();
      await expandPhoneComposerIfCollapsed();
      const picker = await waitForElement(
        findComposerProviderModelPicker,
        "Unable to find frozen phone provider/model picker.",
      );
      await picker.click();
      await waitForElement(
        () => document.querySelector('[data-slot="mobile-select-sheet-list"]'),
        "Unable to find phone model sheet.",
      );

      expect(document.body.textContent).toContain("GPT-5");
      expect(document.body.textContent).not.toContain("Claude Sonnet 4.6");
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens the model picker when selecting /model", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-model-command-target" as MessageId,
        targetText: "model command thread",
      }),
    });

    try {
      await waitForComposerEditor();
      await page.getByTestId("composer-editor").fill("/mod");

      const menuItem = await waitForComposerMenuItem("slash:model");
      await menuItem.click();

      await vi.waitFor(() => {
        expect(document.querySelector(".model-picker-list")).not.toBeNull();
        expect(findComposerProviderModelPicker()?.textContent).not.toContain("/model");
      });

      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => resolve());
        });
      });

      await vi.waitFor(() => {
        const searchInput = document.querySelector<HTMLInputElement>(
          'input[placeholder="Search models..."]',
        );
        expect(searchInput).not.toBeNull();
        expect(document.activeElement).toBe(searchInput);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("toggles the model picker and shows jump keys immediately from the shortcut", async () => {
    const snapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-model-picker-shortcut-target" as MessageId,
      targetText: "model picker shortcut thread",
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...snapshot,
        projects: snapshot.projects.map((project) =>
          project.id === PROJECT_ID
            ? Object.assign({}, project, {
                defaultModelSelection: {
                  instanceId: ProviderInstanceId.make("codex"),
                  model: "gpt-5.4",
                },
              })
            : project,
        ),
        threads: snapshot.threads.map((thread) =>
          thread.id === THREAD_ID
            ? Object.assign({}, thread, {
                modelSelection: {
                  instanceId: ProviderInstanceId.make("codex"),
                  model: "gpt-5.4",
                },
              })
            : thread,
        ),
      },
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "modelPicker.toggle",
              shortcut: {
                key: "m",
                metaKey: false,
                ctrlKey: true,
                shiftKey: true,
                altKey: false,
                modKey: false,
              },
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "terminalFocus" },
              },
            },
            {
              command: "thread.jump.1",
              shortcut: {
                key: "1",
                metaKey: false,
                ctrlKey: true,
                shiftKey: false,
                altKey: false,
                modKey: false,
              },
            },
            {
              command: "modelPicker.jump.1",
              shortcut: {
                key: "1",
                metaKey: false,
                ctrlKey: true,
                shiftKey: false,
                altKey: false,
                modKey: false,
              },
              whenAst: { type: "identifier", name: "modelPickerOpen" },
            },
          ],
          providers: [
            {
              ...nextFixture.serverConfig.providers[0]!,
              models: [
                {
                  slug: "gpt-5.1-codex-max",
                  name: "GPT-5.1 Codex Max",
                  isCustom: false,
                  capabilities: createModelCapabilities({
                    optionDescriptors: [
                      {
                        id: "fastMode",
                        label: "Fast Mode",
                        type: "boolean" as const,
                      },
                    ],
                  }),
                },
                {
                  slug: "gpt-5.3-codex",
                  name: "GPT-5.3 Codex",
                  isCustom: false,
                  capabilities: createModelCapabilities({
                    optionDescriptors: [
                      {
                        id: "fastMode",
                        label: "Fast Mode",
                        type: "boolean" as const,
                      },
                    ],
                  }),
                },
                {
                  slug: "gpt-5.4",
                  name: "GPT-5.4",
                  isCustom: false,
                  capabilities: createModelCapabilities({
                    optionDescriptors: [
                      {
                        id: "fastMode",
                        label: "Fast Mode",
                        type: "boolean" as const,
                      },
                    ],
                  }),
                },
              ],
            },
          ],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      await waitForComposerEditor();

      const initialPath = mounted.router.state.location.pathname;
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "m",
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );

      await vi.waitFor(() => {
        expect(document.querySelector(".model-picker-list")).not.toBeNull();
      });

      const jumpLabel = isMacPlatform(navigator.platform) ? "⌃1" : "Ctrl+1";
      await vi.waitFor(() => {
        expect(
          Array.from(
            document.querySelectorAll<HTMLElement>('.model-picker-list [data-slot="kbd"]'),
          ).some((element) => element.textContent?.trim() === jumpLabel),
        ).toBe(true);
      });
      expect(mounted.router.state.location.pathname).toBe(initialPath);

      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "m",
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );

      await vi.waitFor(() => {
        expect(document.querySelector(".model-picker-list")).toBeNull();
      });
    } finally {
      releaseModShortcut("Control");
      await mounted.cleanup();
    }
  });

  it("shows a tooltip with the skill description when hovering a skill pill", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-skill-tooltip-target" as MessageId,
        targetText: "skill tooltip thread",
      }),
      configureFixture: (nextFixture) => {
        const provider = nextFixture.serverConfig.providers[0];
        if (!provider) {
          throw new Error("Expected default provider in test fixture.");
        }
        (
          provider as {
            skills: ServerConfig["providers"][number]["skills"];
          }
        ).skills = [
          {
            name: "agent-browser",
            displayName: "Agent Browser",
            description: "Open pages, click around, and inspect web apps.",
            path: "/Users/test/.agents/skills/agent-browser/SKILL.md",
            enabled: true,
          },
        ];
      },
    });

    try {
      useComposerDraftStore.getState().setPrompt(THREAD_REF, "use the $agent-browser ");
      await waitForComposerText("use the $agent-browser ");

      await waitForElement(
        () => document.querySelector<HTMLElement>('[data-composer-skill-chip="true"]'),
        "Unable to find rendered composer skill chip.",
      );
      await page.getByText("Agent Browser").hover();

      await vi.waitFor(
        () => {
          const tooltip = document.querySelector<HTMLElement>('[data-slot="tooltip-popup"]');
          expect(tooltip).not.toBeNull();
          expect(tooltip?.textContent).toContain("Open pages, click around, and inspect web apps.");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });
});
