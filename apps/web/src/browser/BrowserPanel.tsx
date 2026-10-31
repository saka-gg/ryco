import { type ReactNode, useEffect, useState, useRef, useCallback } from "react";
import type {
  DiscoveredProjectSite,
  ProjectBrowserCommand,
  EnvironmentId,
  ScopedThreadRef,
} from "@ryco/contracts";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ExternalLinkIcon,
  GlobeIcon,
  LoaderCircleIcon,
  PlusIcon,
  RotateCwIcon,
  StarIcon,
  XIcon,
} from "lucide-react";
import { Button } from "../components/ui/button";
import { useComposerContextIntakeAvailable } from "../composerContextIntake";
import { preloadableLazy, useLazyComponentReady } from "../lib/preloadableLazy";
import { useBrowserElementPicker } from "./BrowserElementPicker";
import { BrowserSurface } from "./BrowserSurface";
import type { BrowserSide } from "./browserMode";
import {
  normalizeBrowserUrl,
  projectBrowserKey,
  useBrowserUi,
  useProjectBrowserTabs,
} from "./browserState";
import { isDesktopOwnBackend, useBrowserMode } from "./useBrowserMode";

// Node tabs load with the first panel that shows them; desktop and frame users never load them.
const NodeBrowserPanel = preloadableLazy(() =>
  import("./NodeBrowserPanel").then((module) => module.NodeBrowserPanel),
);

export interface BrowserProject {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  /**
   * The thread whose workspace shows the panel: "Pick element" hands page
   * elements to its composer. Without one (the sidebar's live preview) the
   * control is not offered.
   */
  thread?: ScopedThreadRef | null;
}
/**
 * The Browser panel: the desktop app's own tabs, tabs that run on the node
 * (`resolveBrowserMode`), or a sandboxed frame. For a remote environment the
 * desktop app offers both its own tabs and the node's.
 */
export function BrowserPanel(props: BrowserProject) {
  const [side, setSide] = useState<BrowserSide>("node");
  const browser = useBrowserMode(props.environmentId, side);
  const nodePanelReady = useLazyComponentReady(NodeBrowserPanel, browser.mode === "node");
  const choice = browser.choice ? <BrowserSideChoice side={side} onChange={setSide} /> : null;
  if (browser.mode === "node" && browser.nodeClient) {
    return nodePanelReady ? (
      <NodeBrowserPanel client={browser.nodeClient} cwd={props.cwd} choice={choice} />
    ) : (
      <p role="status" className="p-4 text-sm text-muted-foreground">
        Loading browser…
      </p>
    );
  }
  return <ProjectBrowserPanel {...props} choice={choice} />;
}

/** Where the desktop app opens pages for a remote environment. */
function BrowserSideChoice({
  side,
  onChange,
}: {
  readonly side: BrowserSide;
  readonly onChange: (side: BrowserSide) => void;
}) {
  return (
    <div role="group" aria-label="Where pages open" className="mr-1 flex shrink-0 rounded border">
      {(
        [
          ["node", "Node"],
          ["computer", "This computer"],
        ] as const
      ).map(([value, label]) => (
        <button
          key={value}
          type="button"
          aria-pressed={side === value}
          className={`px-2 py-1 text-xs${side === value ? " bg-accent" : " text-muted-foreground"}`}
          onClick={() => onChange(value)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function ProjectBrowserPanel({
  environmentId,
  cwd,
  thread = null,
  choice,
}: BrowserProject & { readonly choice: ReactNode }) {
  const project = projectBrowserKey(environmentId, cwd);
  const { tabs, selected, api } = useProjectBrowserTabs(project);
  const addressInput = useRef<HTMLInputElement>(null);
  const [address, setAddress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [newTab, setNewTab] = useState(false);
  const [viewport, setViewport] = useState<number | null>(null);
  // Without exact endpoint evidence, discovery shows computer-level services only.
  const localCwd =
    environmentId !== null && isDesktopOwnBackend(environmentId) ? (cwd ?? undefined) : undefined;
  const [sites, setSites] = useState<readonly DiscoveredProjectSite[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const discovery = useRef({ generation: 0 }).current;
  const [saved, setSaved] = useState<string[]>([]);
  const active = newTab ? null : selected;
  const empty = active === null;
  const composerAvailable = useComposerContextIntakeAvailable(thread);
  const picker = useBrowserElementPicker({
    api,
    tab: active,
    thread,
    project,
    available: composerAvailable,
    onError: setError,
  });
  useEffect(
    () =>
      api?.onFocusAddress((tab) => {
        if (tab === active?.id) {
          addressInput.current?.focus();
          addressInput.current?.select();
        }
      }),
    [api, active?.id],
  );
  useEffect(() => {
    setAddress(active?.url ?? "");
  }, [active?.id, active?.url]);
  useEffect(() => {
    setNewTab(false);
    try {
      const value: unknown = JSON.parse(
        localStorage.getItem(`ryco:browser-sites:${project}`) ?? "[]",
      );
      setSaved(
        Array.isArray(value)
          ? value.filter((url): url is string => typeof url === "string").slice(0, 20)
          : [],
      );
    } catch {
      setSaved([]);
    }
  }, [project]);
  const run = async (operation: () => Promise<unknown>) => {
    setError(null);
    try {
      await operation();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Browser request failed.");
    }
  };
  const discover = useCallback(async () => {
    if (!api) return;
    const generation = ++discovery.generation;
    setDiscovering(true);
    try {
      const result = await api.discover(localCwd);
      if (generation === discovery.generation) setSites(result);
    } catch (error) {
      if (generation === discovery.generation)
        setError(error instanceof Error ? error.message : "Discovery failed.");
    } finally {
      if (generation === discovery.generation) setDiscovering(false);
    }
  }, [api, localCwd, discovery]);
  useEffect(() => {
    setSites([]);
    if (empty && api) void discover();
    return () => {
      discovery.generation++;
    };
  }, [empty, api, discover, discovery, project]);
  const open = async (url: string) => {
    const normalized = normalizeBrowserUrl(url);
    setOpening(true);
    try {
      if (api) {
        const id = await api.open({ url: normalized, project });
        useBrowserUi.getState().select(project, id);
      } else useBrowserUi.getState().openFallback(normalized, project);
      setNewTab(false);
    } finally {
      setOpening(false);
    }
  };
  const command = (
    action: ProjectBrowserCommand["action"],
    extra: Partial<ProjectBrowserCommand> = {},
  ) => {
    if (api && active) void run(() => api.command({ ...extra, action, tab: active.id }));
  };
  const save = () => {
    if (!active?.url) return;
    const next = saved.includes(active.url)
      ? saved.filter((url) => url !== active.url)
      : [active.url, ...saved].slice(0, 20);
    try {
      localStorage.setItem(`ryco:browser-sites:${project}`, JSON.stringify(next));
      setSaved(next);
    } catch {
      setError("Could not save this URL.");
    }
  };
  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="Project browser">
      <div
        className="flex shrink-0 items-center gap-1 overflow-x-auto border-b p-1"
        role="tablist"
        aria-label="Browser tabs"
      >
        {choice}
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className="flex min-w-0 max-w-44 shrink-0 items-center rounded bg-muted/40"
          >
            <button
              type="button"
              role="tab"
              aria-selected={active?.id === tab.id}
              title={
                tab.suspended ? "Suspended to save memory. Reloads when you open it." : undefined
              }
              className={`flex min-w-0 items-center gap-1.5 px-2 py-1.5 text-xs${tab.suspended ? " text-muted-foreground" : ""}`}
              onClick={() => {
                useBrowserUi.getState().select(project, tab.id);
                setNewTab(false);
              }}
            >
              {tab.loading ? (
                <LoaderCircleIcon className="size-3 shrink-0 animate-spin" />
              ) : (
                <GlobeIcon className="size-3 shrink-0" />
              )}
              <span className="truncate">{tab.title || tab.url || "Loading…"}</span>
              {tab.suspended ? <span className="sr-only">, suspended</span> : null}
            </button>
            <button
              type="button"
              aria-label={`Close ${tab.title || "browser tab"}`}
              className="p-1 text-muted-foreground hover:text-foreground"
              onClick={() =>
                void run(() =>
                  api
                    ? api.command({ action: "close", tab: tab.id })
                    : Promise.resolve(useBrowserUi.getState().closeFallback(tab.id)),
                )
              }
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
          onClick={() => {
            setNewTab(true);
            setAddress("");
          }}
        >
          <PlusIcon className="size-3.5" />
        </Button>
      </div>
      <form
        className="flex shrink-0 items-center gap-1 border-b p-2"
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            if (active) {
              const url = normalizeBrowserUrl(address);
              if (api)
                await api.command({
                  action: "navigate",
                  tab: active.id,
                  url,
                });
              else useBrowserUi.getState().navigateFallback(active.id, url);
            } else await open(address);
          });
        }}
      >
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label="Back"
          disabled={!api || !active?.canGoBack}
          onClick={() => command("back")}
        >
          <ArrowLeftIcon className="size-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label="Forward"
          disabled={!api || !active?.canGoForward}
          onClick={() => command("forward")}
        >
          <ArrowRightIcon className="size-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label={active?.loading ? "Stop loading" : "Reload"}
          disabled={!api || !active}
          onClick={() => command(active?.loading ? "stop" : "reload")}
        >
          {active?.loading ? <XIcon className="size-3.5" /> : <RotateCwIcon className="size-3.5" />}
        </Button>
        <input
          ref={addressInput}
          aria-label="Browser address"
          className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-xs"
          placeholder="Enter a URL or localhost:3000"
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          onFocus={(event) => event.currentTarget.select()}
        />
        <Button type="submit" size="sm" variant="outline" disabled={opening}>
          Go
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-7"
          disabled={!active?.url}
          aria-label="Save project URL"
          aria-pressed={Boolean(active && saved.includes(active.url))}
          onClick={save}
        >
          <StarIcon className="size-3.5" />
        </Button>
      </form>
      {active ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-2 py-1 text-[11px] text-muted-foreground">
          <select
            aria-label="Browser viewport"
            className="bg-background"
            value={viewport ?? "auto"}
            onChange={(event) =>
              setViewport(event.target.value === "auto" ? null : Number(event.target.value))
            }
          >
            <option value="auto">Responsive</option>
            <option value="390">Phone · 390px</option>
            <option value="768">Tablet · 768px</option>
            <option value="1280">Desktop · 1280px</option>
          </select>
          {api ? (
            <>
              <select
                aria-label="Browser zoom"
                className="bg-background"
                value={active.zoom}
                onChange={(event) => command("zoom", { zoom: Number(event.target.value) })}
              >
                {[0.5, 0.75, 1, 1.25, 1.5, 2].map((zoom) => (
                  <option key={zoom} value={zoom}>
                    {zoom * 100}%
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() =>
                  command(
                    active.signInPopup === "armed" || active.signInPopup === "open"
                      ? "cancel-sign-in"
                      : "allow-sign-in",
                  )
                }
              >
                {active.signInPopup === "open"
                  ? "Close sign-in popup"
                  : active.signInPopup === "armed"
                    ? "Cancel sign-in"
                    : "Allow sign-in popup"}
              </button>
              {picker?.control}
              <button type="button" onClick={() => command("devtools")}>
                DevTools
              </button>
              <button type="button" onClick={() => command("popout")}>
                Pop out
              </button>
              <button
                type="button"
                onClick={() =>
                  void run(() => window.desktopBridge?.computerUse?.stop() ?? Promise.resolve())
                }
              >
                Stop agent
              </button>
            </>
          ) : (
            <span>Web preview · sites may restrict embedding</span>
          )}
          <a
            href={active.url}
            target="_blank"
            rel="noreferrer"
            className="ml-auto inline-flex items-center gap-1"
            aria-label="Open in external browser"
          >
            <ExternalLinkIcon className="size-3" />
            External
          </a>
        </div>
      ) : null}
      {api &&
      active &&
      (active.signInPopup === "armed" ||
        active.signInPopup === "blocked" ||
        active.signInPopup === "failed") ? (
        <p role="status" className="border-b p-2 text-xs text-muted-foreground">
          {active.signInPopup === "armed"
            ? "One sign-in popup allowed for 30 seconds. Click the site’s sign-in button again. Switching panels cancels permission."
            : active.signInPopup === "failed"
              ? "Sign-in popup could not load. Allow a new sign-in popup and retry the site’s sign-in button."
              : "Popup blocked. To sign in, choose Allow sign-in popup, then retry the site’s sign-in button."}
        </p>
      ) : null}
      {error || active?.error ? (
        <p role="alert" className="border-b p-2 text-xs text-destructive">
          {error ?? active?.error}
        </p>
      ) : null}
      {/* One slot, always here, so opening the note never moves or remounts the surface below:
          a new surface owner would detach the page and end the pick. */}
      {picker?.panel ?? null}
      {active ? (
        active.presentation === "window" ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm">
            <p>This tab is open in a separate window.</p>
            <Button variant="outline" onClick={() => command("dock")}>
              Bring back into Ryco
            </Button>
          </div>
        ) : (
          <BrowserSurface tab={active} width={viewport} />
        )
      ) : (
        <div className="min-h-0 flex-1 overflow-auto p-5">
          <GlobeIcon className="mb-3 size-7 text-muted-foreground" />
          <h3 className="text-sm font-semibold">Your project, live</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Enter an address above, or choose a site below. Agents can use these same tabs through
            Ryco Browser.
          </p>
          <p className="mt-2 truncate text-[11px] text-muted-foreground" title={cwd ?? undefined}>
            {cwd ?? "No project selected"}
          </p>
          {saved.length ? (
            <div className="mt-5">
              <h4 className="mb-2 text-xs font-medium">Saved for this project</h4>
              {saved.map((url) => (
                <button
                  key={url}
                  type="button"
                  className="block w-full truncate rounded px-2 py-2 text-left text-xs hover:bg-accent"
                  onClick={() => void run(() => open(url))}
                >
                  {url}
                </button>
              ))}
            </div>
          ) : null}
          <div className="mt-5 flex items-center justify-between">
            <h4 className="text-xs font-medium">Services on this computer</h4>
            <Button
              variant="ghost"
              size="sm"
              disabled={!api || discovering}
              onClick={() => void discover()}
            >
              {discovering ? "Finding…" : "Refresh"}
            </Button>
          </div>
          {!api ? (
            <p className="mt-2 text-xs text-muted-foreground">
              Local port discovery is available in Ryco desktop. For remote projects, enter a
              reachable or forwarded URL.
            </p>
          ) : !sites.length && !discovering ? (
            <p className="mt-2 text-xs text-muted-foreground">
              No local HTTP services found. Start your project’s dev server, then refresh.
            </p>
          ) : (
            sites.map((site) => (
              <button
                key={site.url}
                type="button"
                disabled={opening}
                className="mt-1 flex w-full items-center justify-between rounded border border-border/60 px-3 py-2 text-left text-xs hover:bg-accent"
                onClick={() => void run(() => open(site.url))}
              >
                <span>{site.url}</span>
                <span className="text-muted-foreground">
                  {site.projectMatch ? "This project · " : ""}
                  {site.process}
                </span>
              </button>
            ))
          )}
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
