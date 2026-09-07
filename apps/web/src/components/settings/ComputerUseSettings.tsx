import { useEffect, useState } from "react";
import type { ComputerBrowser, ComputerUsePolicy, ComputerUseState } from "@ryco/contracts";
import {
  MonitorIcon,
  MousePointer2Icon,
  SquareIcon,
  CheckCircle2Icon,
  XCircleIcon,
  CircleHelpIcon,
} from "lucide-react";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";

const BROWSERS: ReadonlyArray<{ id: ComputerBrowser; label: string }> = [
  { id: "ryco", label: "Ryco Browser" },
  { id: "chrome", label: "Google Chrome" },
  { id: "brave", label: "Brave" },
  { id: "edge", label: "Microsoft Edge" },
];

function PermissionBadge({ status, checked }: { status: string; checked: boolean }) {
  const granted = status === "granted";
  const denied = status === "denied" || status === "restricted";
  const Icon = granted ? CheckCircle2Icon : denied ? XCircleIcon : CircleHelpIcon;
  const label = granted
    ? "Granted"
    : status === "restricted"
      ? "Restricted"
      : denied
        ? "Not granted"
        : status === "not_required"
          ? "Not required"
          : checked
            ? "Could not check"
            : "Not checked";
  return (
    <span
      data-permission-status={status}
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${granted ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : denied ? "bg-red-500/10 text-red-700 dark:text-red-300" : "bg-muted text-muted-foreground"}`}
    >
      <Icon aria-hidden="true" className="size-3" />
      {label}
    </span>
  );
}

/** Local machine settings; a remote environment never becomes the computer target implicitly. */
export function ComputerUseSettings() {
  const api = window.desktopBridge?.computerUse;
  const [state, setState] = useState<ComputerUseState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const [pairing, setPairing] = useState<string | null>(null);
  const [pairingBrowser, setPairingBrowser] = useState<ComputerBrowser | null>(null);
  const [extensionDirectory, setExtensionDirectory] = useState<string | null>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    onError: () => setError("Could not copy. Select the text and copy it manually."),
  });
  useEffect(() => {
    if (!api) return;
    let mounted = true;
    let pending = false;
    const recheck = async () => {
      if (pending || !mounted) return;
      pending = true;
      try {
        const value = await api.getState();
        if (mounted) setState(value);
      } catch {
        if (mounted) setError("Computer-use settings could not be loaded.");
      } finally {
        pending = false;
      }
    };
    void recheck();
    const focus = () => {
      void recheck();
    };
    const visible = () => {
      if (document.visibilityState === "visible") void recheck();
    };
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", visible);
    const timer = state?.policy.enabled
      ? setInterval(() => {
          if (document.visibilityState === "visible" && document.hasFocus()) void recheck();
        }, 3_000)
      : undefined;
    const unsubscribe = api.onState((value) => {
      if (mounted) setState(value);
    });
    return () => {
      mounted = false;
      unsubscribe();
      clearInterval(timer);
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [api, state?.policy.enabled]);
  if (!api) return null;
  const run = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await operation();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Computer-use request failed.");
    } finally {
      setBusy(false);
    }
  };
  const update = (patch: Partial<ComputerUsePolicy>) => {
    if (state)
      void run(async () => {
        setState(await api.setPolicy({ ...state.policy, ...patch }));
        setPairing(null);
      });
  };
  const appEntries = new Map(
    Object.keys(state?.policy.apps ?? {}).map((id) => [
      id,
      { id, name: id.replaceAll("\\", "/").split("/").pop() ?? id },
    ]),
  );
  for (const entry of state?.apps ?? []) appEntries.set(entry.id, entry);
  for (const browser of BROWSERS)
    appEntries.set(`browser:${browser.id}`, { id: `browser:${browser.id}`, name: browser.label });
  return (
    <section className="border-b p-6 sm:p-8" aria-labelledby="computer-use-heading">
      <div className="mx-auto flex max-w-4xl flex-col gap-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <MonitorIcon className="size-4 text-muted-foreground" />
              <h2 id="computer-use-heading" className="text-lg font-semibold">
                Computer use
              </h2>
            </div>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              Let agents work in apps on this computer while you keep working. An independent Ryco
              cursor shows their actions. Native tools require Agent Control in Integrations and a
              new provider session.
            </p>
          </div>
          <Switch
            aria-label="Enable computer use on this computer"
            checked={state?.policy.enabled ?? false}
            disabled={busy || !state}
            onCheckedChange={(enabled) => update({ enabled: Boolean(enabled) })}
          />
        </div>
        {error || state?.error ? (
          <p role="alert" className="text-sm text-destructive">
            {error ?? state?.error}
          </p>
        ) : null}
        {state?.policy.enabled ? (
          <>
            <div
              className="flex items-center justify-between gap-3 rounded-lg border bg-muted/20 p-3"
              role="status"
            >
              <span className="flex items-center gap-2 text-sm">
                <MousePointer2Icon className="size-4" />
                {state.activity
                  ? `Working in ${state.activity.target} · ${state.activity.mode}`
                  : "Enabled · waiting for an agent"}
              </span>
              <Button size="sm" variant="outline" onClick={() => void run(() => api.stop())}>
                <SquareIcon className="size-3" />
                Stop all
              </Button>
            </div>
            <p className="-mt-3 text-xs text-muted-foreground">
              Use ⌘/Ctrl + Shift + Escape while computer use is enabled to stop. A stopped turn must
              be restarted.
            </p>
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-medium">Native permissions</span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      setState(await api.getState());
                    })
                  }
                >
                  Check permissions
                </Button>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void run(() => api.requestPermission("accessibility"))}
                >
                  Accessibility{" "}
                  <PermissionBadge
                    status={state.accessibility}
                    checked={Boolean(state.permissionInfo?.checkedAt)}
                  />
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void run(() => api.requestPermission("screenRecording"))}
                >
                  Screen recording{" "}
                  <PermissionBadge
                    status={state.screenRecording}
                    checked={Boolean(state.permissionInfo?.checkedAt)}
                  />
                </Button>
              </div>
              {state.permissionInfo?.error ? (
                <p role="alert" className="text-sm text-destructive">
                  {state.permissionInfo.error}
                </p>
              ) : null}
              {state.permissionInfo?.development ? (
                <p className="text-xs text-muted-foreground">
                  Development build: grant permissions to {state.permissionInfo.appName} in macOS
                  Settings. Access is checked again when you return. If Screen Recording stays
                  denied after granting it, restart this build.
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Permissions are checked automatically when you return from system settings.
                </p>
              )}
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm font-medium">Allow foreground takeover requests</p>
                  <p className="text-xs text-muted-foreground">
                    Ask before taking over your mouse and keyboard when background control is
                    unavailable.
                  </p>
                </div>
                <Switch
                  aria-label="Allow foreground takeover requests"
                  checked={state.policy.foregroundEnabled}
                  disabled={busy}
                  onCheckedChange={(enabled) => update({ foregroundEnabled: Boolean(enabled) })}
                />
              </div>
            </div>
            <div className="space-y-3 border-t pt-4">
              <h3 className="text-sm font-semibold">Browsers</h3>
              <p className="text-xs text-muted-foreground">
                Ryco Browser has a separate profile. Pair Chrome, Brave or Edge to use your existing
                tabs and sign-ins.
              </p>
              {BROWSERS.map((browser) => (
                <div key={browser.id} className="flex items-center justify-between gap-3">
                  <div className="text-sm">
                    {browser.label}
                    <span className="ml-2 text-xs text-muted-foreground">
                      {browser.id === "ryco"
                        ? "Built in"
                        : state.connectedBrowsers.includes(browser.id)
                          ? "Connected"
                          : "Not connected"}
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    {browser.id !== "ryco" && state.policy.browsers.includes(browser.id) ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            setPairing(JSON.stringify(await api.pairBrowser(browser.id)));
                            setPairingBrowser(browser.id);
                          })
                        }
                      >
                        Pair
                      </Button>
                    ) : null}
                    <Switch
                      aria-label={`Enable ${browser.label} control`}
                      checked={state.policy.browsers.includes(browser.id)}
                      disabled={busy}
                      onCheckedChange={(checked) =>
                        update({
                          browsers: checked
                            ? [...state.policy.browsers, browser.id]
                            : state.policy.browsers.filter((id) => id !== browser.id),
                        })
                      }
                    />
                  </div>
                </div>
              ))}
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  void run(async () => {
                    setExtensionDirectory(await api.showExtension());
                  })
                }
              >
                Show browser extension folder
              </Button>
              {pairing ? (
                <div className="space-y-2 rounded-lg border p-3">
                  <p className="text-sm font-medium">Connect your browser</p>
                  <ol className="list-decimal space-y-1 pl-4 text-xs text-muted-foreground">
                    <li>Open Extensions, enable Developer mode, then choose Load unpacked.</li>
                    <li>
                      Select the Ryco extension folder shown below. On macOS, paste its path with ⌘
                      + Shift + G in the folder chooser.
                    </li>
                    <li>
                      Open Ryco Browser Control in the browser toolbar and paste the pairing
                      configuration.
                    </li>
                  </ol>
                  <div className="flex flex-wrap gap-2">
                    {pairingBrowser ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => void run(() => api.openBrowserSetup(pairingBrowser))}
                      >
                        Open browser Extensions
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          setExtensionDirectory(await api.showExtension());
                        })
                      }
                    >
                      Show extension folder
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => copyToClipboard(pairing, undefined)}
                    >
                      Copy pairing configuration
                    </Button>
                  </div>
                  {extensionDirectory ? (
                    <div className="flex items-center gap-2">
                      <input
                        aria-label="Extension folder path"
                        readOnly
                        value={extensionDirectory}
                        onFocus={(event) => event.currentTarget.select()}
                        className="min-w-0 flex-1 rounded-md border bg-background p-2 font-mono text-xs"
                      />
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => copyToClipboard(extensionDirectory, undefined)}
                      >
                        Copy folder path
                      </Button>
                    </div>
                  ) : null}
                  {isCopied ? (
                    <p role="status" className="text-xs text-emerald-700 dark:text-emerald-300">
                      Copied
                    </p>
                  ) : null}
                  <p className="text-xs text-muted-foreground">
                    Pairing replaces the previous connection. Pair again after restarting Ryco.
                  </p>
                  <textarea
                    aria-label="Browser pairing configuration"
                    readOnly
                    value={pairing}
                    className="h-20 w-full rounded-md border bg-background p-2 font-mono text-xs"
                    onFocus={(event) => event.currentTarget.select()}
                  />
                  <Button size="sm" variant="ghost" onClick={() => setPairing(null)}>
                    Hide configuration
                  </Button>
                </div>
              ) : null}
            </div>
            <div className="space-y-3 border-t pt-4">
              <h3 className="text-sm font-semibold">App access</h3>
              <p className="text-xs text-muted-foreground">
                Apps ask on first use. Blocked apps cannot be inspected or controlled. Changing
                permissions stops current work.
              </p>
              <form
                className="flex gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void run(async () => {
                    setState(await api.refresh(search || undefined));
                  });
                }}
              >
                <input
                  aria-label="Find installed apps"
                  placeholder="Find installed apps…"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  className="min-w-0 flex-1 rounded-md border bg-background px-3 py-2 text-sm"
                />
                <Button variant="outline" size="sm" disabled={busy}>
                  Find apps
                </Button>
              </form>
              <div className="max-h-80 divide-y overflow-y-auto">
                {[...appEntries.values()]
                  .filter(
                    (entry) =>
                      !search ||
                      entry.name.toLowerCase().includes(search.toLowerCase()) ||
                      state.policy.apps[entry.id] !== undefined,
                  )
                  .map((entry) => (
                    <div key={entry.id} className="flex items-center justify-between gap-4 py-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm">{entry.name}</p>
                        <p className="truncate text-[11px] text-muted-foreground" title={entry.id}>
                          {entry.id}
                        </p>
                      </div>
                      <select
                        aria-label={`Access to ${entry.name}`}
                        className="rounded-md border bg-background px-2 py-1 text-sm"
                        disabled={busy}
                        value={state.policy.apps[entry.id] ?? "ask"}
                        onChange={(event) =>
                          update({
                            apps: {
                              ...state.policy.apps,
                              [entry.id]: event.target.value as "ask" | "allow" | "block",
                            },
                          })
                        }
                      >
                        <option value="ask">Ask</option>
                        <option value="allow">Always allow</option>
                        <option value="block">Block</option>
                      </select>
                    </div>
                  ))}
              </div>
            </div>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            Off. Agents cannot inspect or operate apps or browsers through Ryco computer use.
          </p>
        )}
      </div>
    </section>
  );
}
