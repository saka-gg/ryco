import { getModelSelectionOptionDescriptors } from "@ryco/shared/model";
import { useEffect } from "react";
import { WS_METHODS, type ScopedThreadRef, type ServerProvider } from "@ryco/contracts";
import { scopedThreadKey } from "@ryco/client-runtime/scoped";
import { MessageSquarePlusIcon, XIcon } from "lucide-react";
import { sideChatStore, useSideChatStore } from "../sideChatStore";
import { readEnvironmentConnection } from "../environments/runtime";
import { useHostedRpcCapability } from "../hostedHub/capabilities";
import { randomUUID } from "../lib/utils";
import { Button } from "./ui/button";
import ChatMarkdown from "./ChatMarkdown";

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
  if (!chat) return null;
  if (!chat.open)
    return (
      <Button
        type="button"
        variant="outline"
        className="absolute bottom-40 right-4 z-40 shadow-sm"
        onClick={() => sideChatStore.getState().open(key, chat.modelSelection)}
      >
        <MessageSquarePlusIcon className="size-4" />
        Side chat{chat.pending ? " · Thinking…" : ""}
      </Button>
    );
  const actions = sideChatStore.getState();
  const provider = providers.find((entry) => entry.instanceId === chat.modelSelection.instanceId);
  const model = provider?.models.find((entry) => entry.slug === chat.modelSelection.model);
  const reasoning = getModelSelectionOptionDescriptors(
    chat?.modelSelection,
    model?.capabilities,
  ).find((option) => option.type === "select" && /reason|effort/i.test(option.id));
  const ask = () => {
    const api = readEnvironmentConnection(threadRef.environmentId)?.client.textGeneration;
    if (!ready || !api) return;
    void actions.ask(key, { threadId: threadRef.threadId, requestId: randomUUID(), api });
  };
  return (
    <aside
      aria-label="Side chat"
      className="absolute inset-y-3 right-3 z-40 flex w-[min(28rem,calc(100%-1.5rem))] flex-col overflow-hidden rounded-xl border bg-background shadow-xl"
    >
      <header className="flex items-center gap-2 border-b px-4 py-3">
        <MessageSquarePlusIcon className="size-4" />
        <h2 className="flex-1 text-sm font-medium">Side chat</h2>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => actions.clear(key)}
          disabled={!!chat.pending}
        >
          New chat
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Minimize side chat"
          onClick={() => actions.close(key)}
        >
          <XIcon className="size-4" />
        </Button>
      </header>
      <p className="border-b px-4 py-3 text-xs text-muted-foreground">
        Read-only answers from completed thread context. Your main turn continues. This conversation
        is temporary.
      </p>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4" role="log" aria-live="polite">
        {chat.exchanges.length === 0 && !chat.pending ? (
          <p className="text-sm text-muted-foreground">
            Ask about the conversation, then explore with follow-up questions.
          </p>
        ) : null}
        {chat.exchanges.map((exchange) => (
          <div key={exchange.requestId} className="space-y-3">
            <p className="whitespace-pre-wrap rounded-lg bg-muted px-3 py-2 text-sm">
              {exchange.question}
            </p>
            <ChatMarkdown text={exchange.answer} cwd={undefined} />
          </div>
        ))}
        {chat.pending ? (
          <div className="space-y-3">
            <p className="whitespace-pre-wrap rounded-lg bg-muted px-3 py-2 text-sm">
              {chat.pending.question}
            </p>
            <p className="text-sm text-muted-foreground">Thinking…</p>
          </div>
        ) : null}
        {chat.error ? (
          <p role="alert" className="text-sm text-destructive">
            {chat.error}
          </p>
        ) : null}
      </div>
      <form
        className="space-y-3 border-t p-3"
        onSubmit={(event) => {
          event.preventDefault();
          ask();
        }}
      >
        <div className="flex flex-wrap gap-2">
          <select
            aria-label="Side chat model"
            className="min-w-0 flex-1 rounded-md border bg-background p-2 text-xs"
            disabled={!!chat.pending}
            value={`${chat.modelSelection.instanceId}/${chat.modelSelection.model}`}
            onChange={(event) => {
              const selected = providers
                .flatMap((entry) =>
                  entry.models.map((item) => ({ instanceId: entry.instanceId, model: item.slug })),
                )
                .find((entry) => `${entry.instanceId}/${entry.model}` === event.target.value);
              if (selected) actions.setModel(key, { ...selected, options: [] });
            }}
          >
            {!model ? (
              <option value={`${chat.modelSelection.instanceId}/${chat.modelSelection.model}`}>
                {chat.modelSelection.model}
              </option>
            ) : null}
            {providers
              .filter((entry) => entry.enabled && entry.availability !== "unavailable")
              .map((entry) => (
                <optgroup key={entry.instanceId} label={entry.displayName ?? entry.driver}>
                  {entry.models.map((item) => (
                    <option key={item.slug} value={`${entry.instanceId}/${item.slug}`}>
                      {item.name}
                    </option>
                  ))}
                </optgroup>
              ))}
          </select>
          {reasoning?.type === "select" ? (
            <select
              aria-label="Side chat reasoning"
              className="rounded-md border bg-background p-2 text-xs"
              disabled={!!chat.pending}
              value={String(
                chat.modelSelection.options?.find((option) => option.id === reasoning.id)?.value ??
                  reasoning.currentValue ??
                  "",
              )}
              onChange={(event) =>
                actions.setModel(key, {
                  ...chat.modelSelection,
                  options: [
                    ...(chat.modelSelection.options ?? []).filter(
                      (option) => option.id !== reasoning.id,
                    ),
                    { id: reasoning.id, value: event.target.value },
                  ],
                })
              }
            >
              <option value="" disabled>
                Reasoning
              </option>
              {reasoning.options.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          ) : null}
        </div>
        <textarea
          aria-label="Side question"
          placeholder="Ask a side question…"
          maxLength={16000}
          rows={3}
          className="w-full resize-none rounded-md border bg-background p-3 text-sm"
          value={chat.draft}
          onChange={(event) => actions.setDraft(key, event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              ask();
            }
          }}
        />
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            {ready ? "Only completed context · no tools" : "Waiting for connection…"}
          </span>
          {chat.pending ? (
            <Button type="button" variant="outline" size="sm" onClick={() => actions.cancel(key)}>
              Cancel
            </Button>
          ) : (
            <Button type="submit" size="sm" disabled={!ready || !chat.draft.trim()}>
              Ask
            </Button>
          )}
        </div>
      </form>
    </aside>
  );
}
