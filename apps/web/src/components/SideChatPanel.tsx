import { getModelSelectionOptionDescriptors } from "@ryco/shared/model";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import {
  WS_METHODS,
  type ModelSelection,
  type ScopedThreadRef,
  type ServerProvider,
} from "@ryco/contracts";
import { scopedThreadKey } from "@ryco/client-runtime/scoped";
import type { SideChat } from "@ryco/client-runtime/state/side-chat";
import {
  BrainIcon,
  ChevronDownIcon,
  MessageSquarePlusIcon,
  MinusIcon,
  SquareIcon,
  SquarePenIcon,
} from "lucide-react";
import { sideChatStore, useSideChatStore } from "../sideChatStore";
import { readEnvironmentConnection } from "../environments/runtime";
import { useHostedRpcCapability } from "../hostedHub/capabilities";
import { useDelayedUnmount } from "../hooks/useDelayedUnmount";
import { useSettings } from "../hooks/useSettings";
import { readMotionDurationMs } from "../lib/perf/motion";
import { cn, randomUUID } from "../lib/utils";
import { getCustomModelOptionsByInstance } from "../modelSelection";
import { deriveProviderInstanceEntries, sortProviderInstanceEntries } from "../providerInstances";
import { ProviderModelPicker } from "./chat/ProviderModelPicker";
import { InboxStatusGlyph } from "./inboxSidebar/InboxStatusGlyph";
import { Button } from "./ui/button";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "./ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import ChatMarkdown from "./ChatMarkdown";

type SideChatActions = ReturnType<typeof sideChatStore.getState>;

/**
 * A temporary, read-only conversation beside a thread. It grows out of its
 * launcher in the bottom-right corner and folds back into it on minimize;
 * minimizing never stops a pending answer.
 */
export function SideChatPanel({
  threadRef,
  providers,
  connected,
}: {
  threadRef: ScopedThreadRef;
  providers: readonly ServerProvider[];
  connected: boolean;
}) {
  const key = scopedThreadKey(threadRef);
  const chat = useSideChatStore((state) => state.chatsByThreadKey[key]);
  const capability = useHostedRpcCapability(WS_METHODS.textGenerationAskSideQuestion);
  const ready = connected && capability.allowed;
  useEffect(() => {
    if (!ready) sideChatStore.getState().disconnect(key);
  }, [ready, key]);
  const open = chat?.open ?? false;
  // Read as the panel closes so a reduced-motion change applies to that exit.
  const exitMs = useMemo(
    () => (open ? 0 : readMotionDurationMs("--app-motion-duration-pop", 200)),
    [open],
  );
  const panelMounted = useDelayedUnmount(open, exitMs);
  const panelRef = useRef<HTMLElement>(null);
  if (!chat) return null;
  return (
    <>
      {open ? null : (
        <button
          type="button"
          aria-label={`Side chat${chat.pending ? " · Thinking…" : ""}`}
          className="side-chat-launcher-enter absolute right-4 bottom-40 z-40 flex h-8 items-center gap-2 rounded-full border bg-popover pr-3.5 pl-3 text-xs font-medium text-foreground shadow-md transition-[background-color,scale] duration-(--app-motion-duration-chip) hover:bg-accent active:scale-97"
          onClick={() => {
            sideChatStore.getState().open(key, chat.modelSelection);
            // Opened from the launcher, typing continues in the panel. The
            // click commits synchronously, so the panel exists by the next frame.
            window.requestAnimationFrame(() =>
              panelRef.current?.querySelector("textarea")?.focus({ preventScroll: true }),
            );
          }}
        >
          {chat.pending ? (
            <InboxStatusGlyph kind="working" />
          ) : (
            <MessageSquarePlusIcon aria-hidden className="size-3.5" />
          )}
          Side chat
          {chat.pending ? (
            <span aria-hidden className="shimmer thinking-status-shimmer text-muted-foreground">
              Thinking
            </span>
          ) : null}
        </button>
      )}
      {panelMounted ? (
        <SideChatSurface
          ref={panelRef}
          chat={chat}
          chatKey={key}
          threadRef={threadRef}
          providers={providers}
          ready={ready}
          open={open}
        />
      ) : null}
    </>
  );
}

function SideChatSurface({
  ref,
  chat,
  chatKey: key,
  threadRef,
  providers,
  ready,
  open,
}: {
  ref: Ref<HTMLElement>;
  chat: SideChat;
  chatKey: string;
  threadRef: ScopedThreadRef;
  providers: readonly ServerProvider[];
  ready: boolean;
  open: boolean;
}) {
  const actions = sideChatStore.getState();
  const logRef = useRef<HTMLDivElement>(null);
  // Entries present when the panel opened appear in place; later ones rise in.
  const [settledCount] = useState(() => chat.exchanges.length + (chat.pending ? 1 : 0));
  const entries = [
    ...chat.exchanges.map((exchange) => ({
      ...exchange,
      answer: exchange.answer as string | null,
    })),
    ...(chat.pending ? [{ ...chat.pending, answer: null }] : []),
  ];
  // Follow the conversation as questions and answers arrive.
  const lastEntry = entries.at(-1);
  const followKey = lastEntry ? `${lastEntry.requestId}:${lastEntry.answer === null}` : "";
  useLayoutEffect(() => {
    const log = logRef.current;
    if (!log || !followKey) return;
    log.scrollTo({
      top: log.scrollHeight,
      behavior: readMotionDurationMs("--app-motion-duration-stack", 260) > 0 ? "smooth" : "auto",
    });
  }, [followKey]);
  const ask = () => {
    const api = readEnvironmentConnection(threadRef.environmentId)?.client.textGeneration;
    if (!ready || !api) return;
    void actions.ask(key, { threadId: threadRef.threadId, requestId: randomUUID(), api });
  };
  const canAsk = ready && !!chat.draft.trim() && !chat.failedQuestion;
  return (
    <aside
      ref={ref}
      aria-label="Side chat"
      inert={open ? undefined : true}
      className={cn(
        "absolute inset-y-3 right-3 z-40 flex w-[min(26rem,calc(100%-1.5rem))] origin-bottom-right flex-col overflow-hidden rounded-2xl border bg-popover text-popover-foreground shadow-2xl/20",
        open ? "side-chat-panel-enter" : "side-chat-panel-exit",
      )}
      onKeyDown={(event) => {
        // Portaled pickers bubble here through React; only the panel's own DOM minimizes.
        if (
          event.key === "Escape" &&
          !event.nativeEvent.isComposing &&
          event.currentTarget.contains(event.target as Node)
        ) {
          event.preventDefault();
          actions.close(key);
        }
      }}
    >
      <header className="flex h-11 shrink-0 items-center gap-2 border-b pr-1.5 pl-3.5">
        <MessageSquarePlusIcon aria-hidden className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-medium">Side chat</h2>
        <span className="text-xs text-muted-foreground">Temporary</span>
        <span className="flex-1" />
        <HeaderAction label="New chat" disabled={!!chat.pending} onClick={() => actions.clear(key)}>
          <SquarePenIcon aria-hidden className="size-3.5" />
        </HeaderAction>
        <HeaderAction label="Minimize side chat" hint="Esc" onClick={() => actions.close(key)}>
          <MinusIcon aria-hidden className="size-3.5" />
        </HeaderAction>
      </header>
      <div
        ref={logRef}
        className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 py-4"
        role="log"
        aria-live="polite"
      >
        {entries.length === 0 && !chat.error ? (
          <div className="m-auto max-w-64 text-center">
            <p className="text-sm text-foreground/85">
              Ask about this thread while it keeps working.
            </p>
            <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
              Answers read completed context only and use no tools. This conversation is temporary.
            </p>
          </div>
        ) : null}
        {entries.map((entry, index) => (
          <div
            key={entry.requestId}
            className={cn("flex flex-col gap-3", index >= settledCount && "side-chat-rise")}
          >
            <p className="ml-auto max-w-[85%] rounded-2xl rounded-br-md bg-muted px-3 py-2 text-sm whitespace-pre-wrap">
              {entry.question}
            </p>
            {entry.answer === null ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <InboxStatusGlyph kind="working" />
                <span className="shimmer thinking-status-shimmer">Thinking</span>
              </p>
            ) : (
              <div className={cn("text-sm", index >= settledCount && "side-chat-rise")}>
                <ChatMarkdown text={entry.answer} cwd={undefined} />
              </div>
            )}
          </div>
        ))}
        {chat.error ? (
          <p role="alert" className="side-chat-rise text-sm text-destructive-foreground">
            {chat.error}
          </p>
        ) : null}
      </div>
      {chat.failedQuestion ? (
        <div className="side-chat-rise mx-3 mb-2 rounded-xl border border-warning/30 bg-warning/8 px-3 py-2.5 text-xs">
          <p className="font-medium text-warning-foreground">
            Restore or discard the unsent question before asking again.
          </p>
          <details className="mt-1 text-muted-foreground">
            <summary className="cursor-pointer select-none">Unsent question</summary>
            <p className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap text-foreground">
              {chat.failedQuestion}
            </p>
          </details>
          <div className="-mx-1 mt-1.5 flex flex-wrap gap-1">
            <Button size="xs" variant="ghost" onClick={() => actions.restoreFailedQuestion(key)}>
              Add unsent question to draft
            </Button>
            <Button size="xs" variant="ghost" onClick={() => actions.discardFailedQuestion(key)}>
              Discard unsent question
            </Button>
          </div>
        </div>
      ) : null}
      <form
        className="shrink-0 px-3 pb-3"
        onSubmit={(event) => {
          event.preventDefault();
          ask();
        }}
      >
        <div className="rounded-2xl border bg-background/60 transition-[border-color,box-shadow] duration-(--app-motion-duration-chip) focus-within:border-ring/45 focus-within:shadow-[0_0_0_3px_--theme(--color-ring/8%)]">
          <textarea
            aria-label="Side question"
            placeholder="Ask a side question…"
            maxLength={16000}
            rows={2}
            className="block max-h-40 min-h-14 w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-sm outline-none [field-sizing:content] placeholder:text-muted-foreground/70"
            value={chat.draft}
            onChange={(event) => actions.setDraft(key, event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                ask();
              }
            }}
          />
          <div className="flex items-center gap-0.5 px-1.5 pb-1.5">
            <SideChatModelControls
              chatKey={key}
              actions={actions}
              selection={chat.modelSelection}
              providers={providers}
              disabled={!!chat.pending}
            />
            <span className="flex-1" />
            {chat.pending ? (
              <button
                type="button"
                aria-label="Cancel"
                title="Stop this answer"
                className="flex size-8 items-center justify-center rounded-lg border bg-background text-foreground transition-colors duration-(--app-motion-duration-chip) hover:bg-accent sm:size-7"
                onClick={() => actions.cancel(key)}
              >
                <SquareIcon aria-hidden className="size-3 fill-current" />
              </button>
            ) : (
              <button
                type="submit"
                aria-label="Ask"
                disabled={!canAsk}
                className="flex size-8 items-center justify-center rounded-lg bg-primary/90 text-primary-foreground transition-all duration-150 enabled:cursor-pointer hover:scale-105 hover:bg-primary disabled:pointer-events-none disabled:opacity-30 sm:size-7"
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                  <path
                    d="M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            )}
          </div>
        </div>
        {ready ? null : (
          <p className="mt-1.5 flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
            <InboxStatusGlyph kind="connecting" />
            Waiting for connection…
          </p>
        )}
      </form>
    </aside>
  );
}

function HeaderAction(props: {
  label: string;
  hint?: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={props.label}
            disabled={props.disabled}
            onClick={props.onClick}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        {props.label}
        {props.hint ? <span className="ml-1.5 text-muted-foreground">{props.hint}</span> : null}
      </TooltipPopup>
    </Tooltip>
  );
}

/**
 * The composer's own model picker plus a reasoning chip. The side chat keeps
 * an independent selection: changing it never touches the thread's model.
 */
function SideChatModelControls({
  chatKey: key,
  actions,
  selection,
  providers,
  disabled,
}: {
  chatKey: string;
  actions: SideChatActions;
  selection: ModelSelection;
  providers: readonly ServerProvider[];
  disabled: boolean;
}) {
  const settings = useSettings();
  const entries = useMemo(
    () => sortProviderInstanceEntries(deriveProviderInstanceEntries(providers)),
    [providers],
  );
  const optionsByInstance = useMemo(
    () =>
      getCustomModelOptionsByInstance(settings, providers, selection.instanceId, selection.model),
    [providers, selection.instanceId, selection.model, settings],
  );
  const model = providers
    .find((entry) => entry.instanceId === selection.instanceId)
    ?.models.find((entry) => entry.slug === selection.model);
  const reasoning = getModelSelectionOptionDescriptors(selection, model?.capabilities).find(
    (option) => option.type === "select" && /reason|effort/i.test(option.id),
  );
  const reasoningValue =
    reasoning?.type === "select"
      ? String(
          selection.options?.find((option) => option.id === reasoning.id)?.value ??
            reasoning.currentValue ??
            "",
        )
      : "";
  return (
    <>
      <ProviderModelPicker
        activeInstanceId={selection.instanceId}
        model={selection.model}
        modelOptions={selection.options}
        lockedProvider={null}
        instanceEntries={entries}
        modelOptionsByInstance={optionsByInstance}
        compact
        triggerVariant="ghost"
        triggerSize="xs"
        disabled={disabled}
        onInstanceModelChange={(instanceId, slug) =>
          actions.setModel(key, { instanceId, model: slug, options: [] })
        }
      />
      {reasoning?.type === "select" ? (
        <Menu>
          <MenuTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="xs"
                aria-label="Side chat reasoning"
                disabled={disabled}
                // Same tone as the model picker trigger beside it.
                className="gap-1 px-1.5 text-muted-foreground/70 hover:text-foreground/80"
              />
            }
          >
            <BrainIcon aria-hidden className="size-3.5" />
            {reasoning.options.find((option) => option.id === reasoningValue)?.label ?? "Reasoning"}
            <ChevronDownIcon aria-hidden className="size-3 opacity-60" />
          </MenuTrigger>
          <MenuPopup align="start" side="top" className="min-w-36">
            <MenuRadioGroup
              value={reasoningValue}
              onValueChange={(value) =>
                actions.setModel(key, {
                  ...selection,
                  options: [
                    ...(selection.options ?? []).filter((option) => option.id !== reasoning.id),
                    { id: reasoning.id, value: String(value) },
                  ],
                })
              }
            >
              {reasoning.options.map((option) => (
                <MenuRadioItem key={option.id} value={option.id}>
                  {option.label}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuPopup>
        </Menu>
      ) : null}
    </>
  );
}
