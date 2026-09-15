import { usePaneEffect, usePaneFocus, usePaneCloseGuard } from "./PaneFocus";
import type { SelectionChatRequest } from "../../lib/selectionChat";
import { MessageId, type ScopedThreadRef } from "@ryco/contracts";
import {
  MAX_SELECTION_QUOTE_LENGTH,
  type SelectionQuote,
} from "@ryco/client-runtime/state/composer";
import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "../ComposerPromptEditor";
import { Button } from "../ui/button";

interface CapturedSelection {
  quote: SelectionQuote;
  left: number;
  top: number;
}

export function readTranscriptSelection(
  container: HTMLElement,
  source: ScopedThreadRef,
): CapturedSelection | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
  const range = selection.getRangeAt(0);
  const element = (node: Node) => (node instanceof Element ? node : node.parentElement);
  const start = element(range.startContainer)?.closest<HTMLElement>("[data-selection-message-id]");
  const end = element(range.endContainer)?.closest<HTMLElement>("[data-selection-message-id]");
  if (!start || start !== end || !container.contains(start)) return null;
  const text = selection.toString();
  if (!text.trim() || text.length > MAX_SELECTION_QUOTE_LENGTH) return null;
  const bounds = range.getBoundingClientRect();
  return {
    quote: { source, messageId: MessageId.make(start.dataset.selectionMessageId!), text },
    left: bounds.left,
    top: bounds.bottom + 8,
  };
}

interface Props {
  containerRef: RefObject<HTMLDivElement | null>;
  source: ScopedThreadRef;
  canUseSide: boolean;
  canCreate: boolean;
  canUseWorktree: boolean;
  onCurrent: (quote: SelectionQuote) => void;
  onSide: (quote: SelectionQuote) => void;
  onNew: (input: SelectionChatRequest) => Promise<void>;
}

/** UI-only capture/placement. Drafts and sends belong to the existing client stores. */
export function TranscriptSelectionActions(props: Props) {
  const paneFocused = usePaneFocus();
  const [selection, setSelection] = useState<CapturedSelection | null>(null);
  const [draft, setDraft] = useState<{
    selection: CapturedSelection;
    prompt: string;
    cursor: number;
    envMode: "local" | "worktree";
    requestKey: string;
  } | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const surface = useRef<HTMLDivElement>(null);
  const editor = useRef<ComposerPromptEditorHandle>(null);
  const submitting = useRef(false);
  usePaneCloseGuard(() => !draft && !submitting.current);
  const keyboardFocusPending = useRef(false);
  const latest = useRef(props);
  useLayoutEffect(() => {
    latest.current = props;
  });
  const focusBefore = useRef<HTMLElement | null>(null);
  const captureFocus = () => {
    if (!surface.current?.contains(document.activeElement)) {
      focusBefore.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
  };
  const dismiss = useCallback(() => {
    if (submitting.current) return;
    keyboardFocusPending.current = false;
    setSelection(null);
    setExpanded(false);
    if (surface.current?.contains(document.activeElement)) focusBefore.current?.focus();
  }, []);

  usePaneEffect(() => {
    let frame = 0;
    const capture = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (
          keyboardFocusPending.current ||
          surface.current?.contains(document.activeElement) ||
          submitting.current
        )
          return;
        const container = latest.current.containerRef.current;
        if (container) setSelection(readTranscriptSelection(container, latest.current.source));
      });
    };
    const pointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || surface.current?.contains(event.target)) return;
      dismiss();
    };
    const keyDown = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        surface.current &&
        (document.activeElement === document.body ||
          surface.current.contains(document.activeElement))
      ) {
        if (event.defaultPrevented || event.isComposing) return;
        event.preventDefault();
        event.stopPropagation();
        dismiss();
      } else if (event.altKey && event.key === "Enter") {
        const container = latest.current.containerRef.current;
        const selected = container && readTranscriptSelection(container, latest.current.source);
        if (!selected) return;
        event.preventDefault();
        event.stopPropagation();
        focusBefore.current =
          container?.querySelector<HTMLElement>(
            `[data-selection-message-id="${CSS.escape(selected.quote.messageId)}"]`,
          ) ?? null;
        cancelAnimationFrame(frame);
        keyboardFocusPending.current = true;
        setSelection(selected);
      }
    };
    const shortcut = (event: KeyboardEvent) => {
      if (event.altKey && event.key === "Enter") keyDown(event);
    };
    document.addEventListener("keydown", shortcut, true);
    document.addEventListener("selectionchange", capture);
    document.addEventListener("pointerup", capture);
    document.addEventListener("pointerdown", pointerDown);
    document.addEventListener("keydown", keyDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", shortcut, true);
      document.removeEventListener("selectionchange", capture);
      document.removeEventListener("pointerup", capture);
      document.removeEventListener("pointerdown", pointerDown);
      document.removeEventListener("keydown", keyDown);
    };
  }, [dismiss]);

  usePaneEffect(() => {
    // Commit keyboard focus before a queued transcript scroll can dismiss the
    // toolbar. A later animation frame leaves a gap on slower renderers.
    if (selection && keyboardFocusPending.current) {
      surface.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
      keyboardFocusPending.current = false;
    }
  }, [selection]);

  const anchor = expanded && draft ? draft.selection : selection;
  usePaneEffect(() => {
    const node = surface.current;
    if (!node || !anchor) return;
    const position = () => {
      const bounds = node.getBoundingClientRect();
      node.style.left = `${Math.max(8, Math.min(anchor.left, window.innerWidth - bounds.width - 8))}px`;
      node.style.top = `${Math.max(8, Math.min(anchor.top, window.innerHeight - bounds.height - 8))}px`;
    };
    position();
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(position);
    });
    observer.observe(node);
    window.addEventListener("resize", position);
    const scroll = () => {
      if (
        !expanded &&
        !keyboardFocusPending.current &&
        !surface.current?.contains(document.activeElement)
      )
        setSelection(null);
    };
    window.addEventListener("scroll", scroll, true);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", scroll, true);
    };
  }, [anchor, expanded]);
  usePaneEffect(() => {
    if (expanded && !busy) editor.current?.focus();
  }, [expanded, busy]);

  const submit = async (intent: "send" | "compose") => {
    if (!draft || submitting.current) return;
    const prompt = editor.current?.readSnapshot().value ?? draft.prompt;
    if (intent === "send" && !prompt.trim()) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      await props.onNew({ ...draft, quote: draft.selection.quote, prompt, intent });
      setDraft(null);
      setExpanded(false);
      setSelection(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not open the chat. Try again.");
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  if (!paneFocused) return null;

  if (!anchor)
    return draft ? (
      <Button
        className="absolute bottom-28 right-4 z-40"
        variant="outline"
        onClick={() => {
          captureFocus();
          setExpanded(true);
        }}
      >
        Resume new chat draft
      </Button>
    ) : null;

  return createPortal(
    <div
      ref={surface}
      role={expanded ? "dialog" : "toolbar"}
      aria-label={expanded ? "New chat from selection" : "Selection actions"}
      aria-busy={busy}
      onKeyDown={(event) => {
        if (expanded || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        const buttons = Array.from(
          surface.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [],
        );
        if (!buttons.length) return;
        event.preventDefault();
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? buttons.length - 1
              : (index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }}
      className={`fixed z-50 max-w-[calc(100vw-16px)] rounded-xl border bg-popover text-popover-foreground shadow-lg ${expanded ? "w-96 p-3" : "flex flex-wrap gap-1 p-1"}`}
      style={{
        left: anchor.left,
        top: anchor.top,
        maxHeight: "calc(100dvh - 16px)",
        overflowY: "auto",
      }}
    >
      {expanded && draft ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit("send");
          }}
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <h2 className="text-sm font-medium">New chat from selection</h2>
            <Button type="button" variant="ghost" size="xs" disabled={busy} onClick={dismiss}>
              Minimize
            </Button>
          </div>
          <blockquote className="mb-3 max-h-28 overflow-y-auto whitespace-pre-wrap break-words border-l-2 pl-3 text-xs text-muted-foreground">
            {draft.selection.quote.text}
          </blockquote>
          <ComposerPromptEditor
            ref={editor}
            value={draft.prompt}
            cursor={draft.cursor}
            terminalContexts={[]}
            skills={[]}
            disabled={busy}
            collapsed={false}
            placeholder="Ask about this selection…"
            ariaLabel="Message for new chat"
            onRemoveTerminalContext={() => {}}
            onPaste={() => {}}
            onChange={(prompt, cursor) =>
              setDraft((current) => (current ? { ...current, prompt, cursor } : null))
            }
            onCommandKeyDown={(key, event) => {
              if (key !== "Enter" || event.shiftKey || event.isComposing) return false;
              void submit("send");
              return true;
            }}
          />
          {error ? (
            <p role="alert" className="my-2 text-xs text-destructive">
              {error}
            </p>
          ) : null}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <select
              aria-label="Work location"
              className="min-w-0 rounded border bg-background p-1 text-xs"
              value={draft.envMode}
              disabled={busy}
              onChange={(event) => {
                const envMode = event.target.value === "worktree" ? "worktree" : "local";
                setDraft({ ...draft, envMode });
              }}
            >
              <option value="local">Project folder</option>
              <option value="worktree" disabled={!props.canUseWorktree}>
                New worktree
              </option>
            </select>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={busy || !props.canCreate}
              onClick={() => void submit("compose")}
            >
              Open in chat
            </Button>
            <Button
              type="submit"
              size="xs"
              disabled={busy || !props.canCreate || !draft.prompt.trim()}
            >
              Send
            </Button>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setDraft(null);
                dismiss();
              }}
            >
              Discard draft
            </Button>
          </div>
        </form>
      ) : (
        <>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              props.onCurrent(anchor.quote);
              setSelection(null);
            }}
          >
            Add to chat
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={!props.canUseSide}
            onClick={() => {
              props.onSide(anchor.quote);
              setSelection(null);
            }}
          >
            Add to Side
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={!props.canCreate}
            onClick={() => {
              captureFocus();
              if (!draft)
                setDraft({
                  selection: anchor,
                  prompt: "",
                  cursor: 0,
                  envMode: "local",
                  requestKey: crypto.randomUUID(),
                });
              setExpanded(true);
              setError(null);
            }}
          >
            {draft ? "Resume new chat" : "New chat"}
          </Button>
        </>
      )}
    </div>,
    document.body,
  );
}
