import { ComputerBetaSettings } from "./ComputerBetaSettings";
import { useEffect, useRef, useState } from "react";
import type { ComputerBrowser, ComputerUsePolicy, ComputerUseState } from "@ryco/contracts";
import { FolderOpenIcon, MousePointer2Icon, SquareIcon } from "lucide-react";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { PermissionStatusBadge } from "./PermissionStatusBadge";
import {
  SETTINGS_INSET_CLASS,
  SettingsBlock,
  SettingsNotice,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { SettingsSelect } from "./SettingsSelect";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";

const BROWSERS: ReadonlyArray<{ id: ComputerBrowser; label: string }> = [
  { id: "ryco", label: "Ryco Browser" },
  { id: "chrome", label: "Google Chrome" },
  { id: "brave", label: "Brave" },
  { id: "edge", label: "Microsoft Edge" },
];

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
  const permissionCheckRequested = useRef(false);
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    onError: () => setError("Could not copy. Select the text and copy it manually."),
  });
  useEffect(() => {
    if (!api) return;
    let mounted = true;
    let pending = false;
    const recheck = async (permissions = false) => {
      if (pending || !mounted) return;
      pending = true;
      try {
        const value = await (permissions ? api.checkPermissions() : api.getState());
        if (mounted) setState(value);
      } catch {
        if (mounted) setError("Computer-use settings could not be loaded.");
      } finally {
        pending = false;
      }
    };
    void recheck();
    const focus = () => {
      if (permissionCheckRequested.current) void recheck(true);
    };
    const visible = () => {
      if (document.visibilityState === "visible") focus();
    };
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", visible);
    const unsubscribe = api.onState((value) => {
      if (mounted) setState(value);
    });
    return () => {
      mounted = false;
      unsubscribe();
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [api]);
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
        if (patch.enabled !== undefined) {
          permissionCheckRequested.current = patch.enabled;
          if (patch.enabled) setState(await api.checkPermissions());
        }
        setPairing(null);
      });
  };
  const requestPermission = (kind: "accessibility" | "screenRecording") => {
    permissionCheckRequested.current = true;
    void run(() => api.requestPermission(kind));
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
  const enabled = state?.policy.enabled ?? false;
  const permissionChecked = Boolean(state?.permissionInfo?.checkedAt);
  const visibleApps = state
    ? [...appEntries.values()].filter(
        (entry) =>
          !search ||
          entry.name.toLowerCase().includes(search.toLowerCase()) ||
          state.policy.apps[entry.id] !== undefined,
      )
    : [];
  return (
    <>
      <ComputerBetaSettings />
      <SettingsSection
        title="Browser and app control"
        description="Let agents work in apps on this computer while you keep working. An independent Ryco cursor shows their actions. Native tools require Agent Control and a new provider session."
      >
        <SettingsRow
          title="Enable on this computer"
          description={
            enabled
              ? "Stop any time with ⌘/Ctrl + Shift + Escape. A stopped turn must be restarted."
              : "Off. Agents cannot inspect or operate apps or browsers through Ryco."
          }
          control={
            <Switch
              aria-label="Enable computer use on this computer"
              checked={enabled}
              disabled={busy || !state}
              onCheckedChange={(next) => update({ enabled: Boolean(next) })}
            />
          }
        />
        {error || state?.error ? (
          <SettingsBlock>
            <SettingsNotice tone="error" role="alert">
              {error ?? state?.error}
            </SettingsNotice>
          </SettingsBlock>
        ) : null}
        {state?.policy.enabled ? (
          <>
            <SettingsRow
              title={
                <span className="flex items-center gap-2" role="status">
                  <MousePointer2Icon className="size-3.5 text-muted-foreground" />
                  {state.activity
                    ? `Working in ${state.activity.target} · ${state.activity.mode}`
                    : "Waiting for an agent"}
                </span>
              }
              description="Current activity on this computer."
              control={
                <Button size="xs" variant="outline" onClick={() => void run(() => api.stop())}>
                  <SquareIcon className="size-3" />
                  Stop all
                </Button>
              }
            />
            <SettingsRow
              title="Native permissions"
              description={
                state.permissionInfo?.development
                  ? `Development build: grant permissions to ${state.permissionInfo.appName} in macOS Settings. If Screen Recording stays denied after granting it, restart this build.`
                  : "Click a permission to request it. Access is checked again when you return from System Settings."
              }
              status={
                state.permissionInfo?.error ? (
                  <span role="alert" className="text-destructive-foreground">
                    {state.permissionInfo.error}
                  </span>
                ) : undefined
              }
              control={
                <Button
                  variant="ghost"
                  size="xs"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      permissionCheckRequested.current = true;
                      setState(await api.checkPermissions());
                    })
                  }
                >
                  Check permissions
                </Button>
              }
            >
              <div className="grid gap-2 sm:grid-cols-2">
                {(
                  [
                    ["Accessibility", "accessibility"],
                    ["Screen recording", "screenRecording"],
                  ] as const
                ).map(([label, kind]) => (
                  <button
                    key={kind}
                    type="button"
                    disabled={busy}
                    onClick={() => requestPermission(kind)}
                    className="flex items-center justify-between gap-2 rounded-[min(var(--radius-md),0.5rem)] bg-muted/50 px-2.5 py-2 text-left text-xs text-foreground outline-hidden transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
                  >
                    {label}{" "}
                    <PermissionStatusBadge status={state[kind]} checked={permissionChecked} />
                  </button>
                ))}
              </div>
            </SettingsRow>
            <SettingsRow
              title="Allow foreground takeover requests"
              description="Ask before taking over your mouse and keyboard when background control is unavailable."
              control={
                <Switch
                  aria-label="Allow foreground takeover requests"
                  checked={state.policy.foregroundEnabled}
                  disabled={busy}
                  onCheckedChange={(next) => update({ foregroundEnabled: Boolean(next) })}
                />
              }
            />
          </>
        ) : null}
      </SettingsSection>

      <SettingsSection
        title="Browser Use"
        description={
          state?.policy.enabled
            ? "Ryco Browser has a separate profile. Pair Chrome, Brave, or Edge to use your existing tabs and sign-ins."
            : "Enable browser and app control above to configure Ryco Browser or pair Chrome, Brave, and Edge."
        }
        headerAction={
          state?.policy.enabled ? (
            <Button
              variant="ghost"
              size="xs"
              className="text-muted-foreground hover:text-foreground"
              onClick={() =>
                void run(async () => {
                  setExtensionDirectory(await api.showExtension());
                })
              }
            >
              <FolderOpenIcon />
              Show browser extension folder
            </Button>
          ) : null
        }
        bare={!state?.policy.enabled}
      >
        {state?.policy.enabled ? (
          <>
            {BROWSERS.map((browser) => {
              const connected = state.connectedBrowsers.includes(browser.id);
              return (
                <SettingsRow
                  key={browser.id}
                  title={
                    <span className="flex items-center gap-2">
                      {browser.label}
                      <Badge
                        size="sm"
                        variant={
                          browser.id === "ryco" ? "outline" : connected ? "success" : "outline"
                        }
                      >
                        {browser.id === "ryco"
                          ? "Built in"
                          : connected
                            ? "Connected"
                            : "Not connected"}
                      </Badge>
                    </span>
                  }
                  control={
                    <>
                      {browser.id !== "ryco" && state.policy.browsers.includes(browser.id) ? (
                        <Button
                          size="xs"
                          variant="outline"
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
                    </>
                  }
                />
              );
            })}
            {pairing ? (
              <SettingsBlock className="bg-muted/30">
                <p className="text-[13px] font-medium text-foreground">Connect your browser</p>
                <ol className="mt-2 list-decimal space-y-1 pl-4 text-xs text-muted-foreground">
                  <li>Open Extensions, enable Developer mode, then choose Load unpacked.</li>
                  <li>
                    Select the Ryco extension folder shown below. On macOS, paste its path with ⌘ +
                    Shift + G in the folder chooser.
                  </li>
                  <li>
                    Open Ryco Browser Control in the browser toolbar and paste the pairing
                    configuration.
                  </li>
                </ol>
                <div className="mt-3 flex flex-wrap gap-2">
                  {pairingBrowser ? (
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void run(() => api.openBrowserSetup(pairingBrowser))}
                    >
                      Open browser Extensions
                    </Button>
                  ) : null}
                  <Button
                    size="xs"
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
                    size="xs"
                    variant="outline"
                    onClick={() => copyToClipboard(pairing, undefined)}
                  >
                    Copy pairing configuration
                  </Button>
                  <Button size="xs" variant="ghost" onClick={() => setPairing(null)}>
                    Hide configuration
                  </Button>
                </div>
                {extensionDirectory ? (
                  <div className="mt-3 flex items-center gap-2">
                    <Input
                      size="sm"
                      aria-label="Extension folder path"
                      readOnly
                      value={extensionDirectory}
                      className="min-w-0 flex-1 font-mono text-xs"
                      onFocus={(event) => event.currentTarget.select()}
                    />
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => copyToClipboard(extensionDirectory, undefined)}
                    >
                      Copy folder path
                    </Button>
                  </div>
                ) : null}
                <Textarea
                  aria-label="Browser pairing configuration"
                  readOnly
                  value={pairing}
                  className="mt-3 font-mono text-xs"
                  onFocus={(event) => event.currentTarget.select()}
                />
                <p className="mt-2 text-xs text-muted-foreground">
                  {isCopied ? (
                    <span role="status" className="text-success-foreground">
                      Copied.{" "}
                    </span>
                  ) : null}
                  Pairing replaces the previous connection. Pair again after restarting Ryco.
                </p>
              </SettingsBlock>
            ) : null}
          </>
        ) : null}
      </SettingsSection>

      {state?.policy.enabled ? (
        <SettingsSection
          title="App access"
          description="Apps ask on first use. Blocked apps cannot be inspected or controlled. Changing access stops current work."
        >
          <SettingsBlock>
            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void run(async () => {
                  setState(await api.refresh(search || undefined));
                });
              }}
            >
              <Input
                size="sm"
                aria-label="Find installed apps"
                placeholder="Find installed apps…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="min-w-0 flex-1"
              />
              <Button type="submit" variant="outline" size="sm" disabled={busy}>
                Find apps
              </Button>
            </form>
          </SettingsBlock>
          <SettingsBlock flush>
            <ul className="max-h-80 divide-y divide-border/60 overflow-y-auto">
              {visibleApps.map((entry) => (
                <li
                  key={entry.id}
                  className={cn(
                    "flex items-center justify-between gap-4 py-2.5",
                    SETTINGS_INSET_CLASS,
                  )}
                >
                  <div className="min-w-0">
                    <p className="truncate text-[13px] text-foreground">{entry.name}</p>
                    <p className="truncate text-[11px] text-muted-foreground" title={entry.id}>
                      {entry.id}
                    </p>
                  </div>
                  <SettingsSelect<"ask" | "allow" | "block">
                    ariaLabel={`Access to ${entry.name}`}
                    width="sm"
                    size="sm"
                    disabled={busy}
                    value={state.policy.apps[entry.id] ?? "ask"}
                    onValueChange={(value) =>
                      update({ apps: { ...state.policy.apps, [entry.id]: value } })
                    }
                    options={[
                      { value: "ask", label: "Ask" },
                      { value: "allow", label: "Always allow" },
                      { value: "block", label: "Block" },
                    ]}
                  />
                </li>
              ))}
            </ul>
          </SettingsBlock>
        </SettingsSection>
      ) : null}
    </>
  );
}
