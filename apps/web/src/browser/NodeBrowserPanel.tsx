import { isUnknownUnionMember } from "@ryco/contracts/base-schemas";
import type { NodeBrowserCapability, NodeBrowserTab } from "@ryco/contracts/node-browser";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  GlobeIcon,
  LoaderCircleIcon,
  PlusIcon,
  RotateCwIcon,
  XIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import { Button } from "../components/ui/button";
import { normalizeBrowserUrl } from "./browserState";
import { NodeBrowserSurface } from "./NodeBrowserSurface";
import type { NodeBrowserViewerClient } from "./useBrowserMode";

const unavailableMessage = (capability: NodeBrowserCapability) =>
  capability.reason === "installing"
    ? "Ryco is installing the browser on this node. Try again in a minute."
    : capability.reason === "crashed"
      ? "The node's browser stopped several times in a row. Ryco tries again in a few minutes."
      : capability.reason === "sandbox-blocked"
        ? "This node gives Chrome no usable sandbox, so it cannot run browser tabs."
        : capability.reason === "root-without-sandbox"
          ? "Ryco runs as root on this node, where Chrome has no sandbox. Run Ryco as a regular user, or set RYCO_NODE_BROWSER_NO_SANDBOX=1 on the node to allow tabs without it."
          : "Browser tabs are not available on this node.";

const errorText = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "message" in error &&
  typeof error.message === "string"
    ? error.message
    : "The node's browser did not answer.";

/**
 * The Browser panel for tabs that run on the node: its tab strip (the
 * project's tabs, from `nodeBrowser.subscribe`), the toolbar (through
 * `nodeBrowser.command`) and the streamed page. `localhost` here is the node.
 */
export function NodeBrowserPanel({
  client,
  cwd,
  choice,
}: {
  readonly client: NodeBrowserViewerClient;
  readonly cwd: string | null;
  /** The desktop app's choice between the node and this computer, when it offers one. */
  readonly choice?: ReactNode;
}) {
  const scope = cwd ?? "";
  const [tabs, setTabs] = useState<ReadonlyArray<NodeBrowserTab>>([]);
  const [capability, setCapability] = useState<NodeBrowserCapability | null>(null);
  const [subscriptionFailed, setSubscriptionFailed] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newTab, setNewTab] = useState(false);
  const [address, setAddress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);

  useEffect(
    () =>
      client.subscribe(
        (event) => {
          if (isUnknownUnionMember(event)) return;
          if (event.type === "tabs") setTabs(event.tabs);
          else setCapability(event.capability);
        },
        {
          onError: () => setSubscriptionFailed(true),
          onResubscribe: () => setSubscriptionFailed(false),
        },
      ),
    [client],
  );

  const visible = tabs.filter((tab) => tab.scope === scope);
  const selected = newTab
    ? null
    : (visible.find((tab) => tab.id === selectedId) ?? visible[0] ?? null);
  const selectedUrl = selected?.url ?? "";
  // The address shows the selected tab's, until the person edits it.
  const [addressFor, setAddressFor] = useState<string | null>(null);
  const addressKey = `${selected?.id ?? "new"}:${selectedUrl}`;
  if (addressFor !== addressKey) {
    setAddressFor(addressKey);
    setAddress(selectedUrl === "about:blank" ? "" : selectedUrl);
  }

  const run = async (operation: () => Promise<unknown>) => {
    setError(null);
    try {
      await operation();
    } catch (cause) {
      setError(errorText(cause));
    }
  };
  const go = () =>
    run(async () => {
      const url = normalizeBrowserUrl(address);
      if (selected) {
        await client.command({ type: "navigate", tabId: selected.id, url });
        return;
      }
      setOpening(true);
      const opened = await client
        .command({ type: "open", scope, url })
        .finally(() => setOpening(false));
      if (opened.tab) setSelectedId(opened.tab.id);
      setNewTab(false);
    });

  const unavailable = capability !== null && !capability.available;
  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="Node browser">
      <div
        className="flex shrink-0 items-center gap-1 overflow-x-auto border-b p-1"
        role="tablist"
        aria-label="Browser tabs"
      >
        {choice}
        {visible.map((tab) => (
          <div
            key={tab.id}
            className="flex min-w-0 max-w-44 shrink-0 items-center rounded bg-muted/40"
          >
            <button
              type="button"
              role="tab"
              aria-selected={selected?.id === tab.id}
              title={
                tab.state === "suspended"
                  ? "Suspended to save memory on the node. Reloads when you open it."
                  : undefined
              }
              className={`flex min-w-0 items-center gap-1.5 px-2 py-1.5 text-xs${tab.state === "live" ? "" : " text-muted-foreground"}`}
              onClick={() => {
                setSelectedId(tab.id);
                setNewTab(false);
              }}
            >
              {tab.loading ? (
                <LoaderCircleIcon className="size-3 shrink-0 animate-spin" />
              ) : (
                <GlobeIcon className="size-3 shrink-0" />
              )}
              <span className="truncate">{tab.title || tab.url || "Loading…"}</span>
            </button>
            <button
              type="button"
              aria-label={`Close ${tab.title || "browser tab"}`}
              className="p-1 text-muted-foreground hover:text-foreground"
              onClick={() => void run(() => client.command({ type: "close", tabId: tab.id }))}
            >
              <XIcon className="size-3" />
            </button>
          </div>
        ))}
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          aria-label="New browser tab"
          onClick={() => setNewTab(true)}
        >
          <PlusIcon className="size-3.5" />
        </Button>
      </div>
      <form
        className="flex shrink-0 items-center gap-1 border-b p-2"
        onSubmit={(event) => {
          event.preventDefault();
          void go();
        }}
      >
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label="Back"
          disabled={!selected?.canGoBack}
          onClick={() =>
            selected &&
            void run(() => client.command({ type: "history", tabId: selected.id, delta: -1 }))
          }
        >
          <ArrowLeftIcon className="size-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label="Forward"
          disabled={!selected?.canGoForward}
          onClick={() =>
            selected &&
            void run(() => client.command({ type: "history", tabId: selected.id, delta: 1 }))
          }
        >
          <ArrowRightIcon className="size-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label={selected?.loading ? "Stop loading" : "Reload"}
          disabled={!selected}
          onClick={() =>
            selected &&
            void run(() =>
              client.command(
                selected.loading
                  ? { type: "stop", tabId: selected.id }
                  : { type: "reload", tabId: selected.id },
              ),
            )
          }
        >
          {selected?.loading ? (
            <XIcon className="size-3.5" />
          ) : (
            <RotateCwIcon className="size-3.5" />
          )}
        </Button>
        <input
          aria-label="Browser address"
          className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-xs"
          placeholder="Enter a URL or localhost:3000 on the node"
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          onFocus={(event) => event.currentTarget.select()}
        />
        <Button type="submit" size="sm" variant="outline" disabled={opening || unavailable}>
          Go
        </Button>
      </form>
      {capability?.sandbox === false ? (
        <p role="status" className="border-b p-2 text-xs text-warning-foreground">
          Chrome&apos;s sandbox is off on this node (RYCO_NODE_BROWSER_NO_SANDBOX). Open only sites
          you trust here.
        </p>
      ) : null}
      {error || selected?.error ? (
        <p role="alert" className="border-b p-2 text-xs text-destructive">
          {error ?? selected?.error?.text}
        </p>
      ) : null}
      {selected?.dialog ? <NodeBrowserDialog client={client} tab={selected} /> : null}
      {subscriptionFailed ? (
        <p role="alert" className="p-4 text-sm text-muted-foreground">
          Ryco could not read this node's browser tabs.
        </p>
      ) : unavailable ? (
        <p role="status" className="p-4 text-sm text-muted-foreground">
          {unavailableMessage(capability)}
        </p>
      ) : selected ? (
        <NodeBrowserSurface
          // A page that crashed and came back is a new stream.
          key={`${selected.id}:${selected.state === "crashed" ? "crashed" : "running"}`}
          client={client}
          tab={selected}
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto p-5">
          <GlobeIcon className="mb-3 size-7 text-muted-foreground" />
          <h3 className="text-sm font-semibold">Pages open on the node</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Enter an address above. These tabs run on the node and stream here, so localhost is the
            node, where the project's dev servers run.
          </p>
          <p className="mt-2 truncate text-[11px] text-muted-foreground" title={cwd ?? undefined}>
            {cwd ?? "No project selected"}
          </p>
          {opening ? (
            <p role="status" className="mt-3 text-xs">
              Opening page…
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}

/** A page's alert, confirm or prompt, answered here: the page waits for it. */
function NodeBrowserDialog({
  client,
  tab,
}: {
  readonly client: NodeBrowserViewerClient;
  readonly tab: NodeBrowserTab;
}) {
  const dialog = tab.dialog!;
  const [promptText, setPromptText] = useState(dialog.defaultValue);
  const answer = (accept: boolean) =>
    void client
      .command({
        type: "dialog",
        tabId: tab.id,
        accept,
        ...(accept && dialog.type === "prompt" ? { promptText } : {}),
      })
      .catch(() => undefined);
  return (
    <div role="dialog" aria-label="Page dialog" className="flex flex-col gap-2 border-b p-3">
      <p className="break-words text-sm">{dialog.message}</p>
      {dialog.type === "prompt" ? (
        <input
          aria-label="Dialog response"
          className="h-8 rounded-md border bg-background px-2 text-xs"
          value={promptText}
          onChange={(event) => setPromptText(event.target.value)}
        />
      ) : null}
      <div className="flex justify-end gap-2">
        {dialog.type === "alert" ? null : (
          <Button variant="outline" size="sm" onClick={() => answer(false)}>
            Dismiss
          </Button>
        )}
        <Button size="sm" onClick={() => answer(true)}>
          {dialog.type === "alert" ? "OK" : "Accept"}
        </Button>
      </div>
    </div>
  );
}
