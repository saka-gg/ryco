import {
  WS_METHODS,
  type CliProxyHubConfig,
  type CliProxyHubId,
  type CliProxyTestHubInput,
  type CliProxyTestHubResult,
  type ServerSettingsPatch,
} from "@ryco/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowUpRightIcon,
  CheckCircle2Icon,
  LoaderIcon,
  PencilIcon,
  PlugZapIcon,
  PlusIcon,
  ServerIcon,
  Trash2Icon,
} from "lucide-react";
import { useCallback, useRef, useState } from "react";

import { updateEnvironmentServerSettings } from "../../environments/runtime";
import { readEnvironmentApi } from "../../environmentApi";
import { useHostedRpcCapability } from "../../hostedHub/capabilities";
import { usePresentationTier } from "../../hooks/usePresentationTier";
import { ensureLocalApi } from "../../localApi";
import { applySettingsUpdated, useServerConfig } from "../../rpc/serverState";
import { useSettingsDialogStore } from "../../settingsDialogStore";
import { useSettingsTarget } from "../../settingsTarget";
import { parseStatisticsSearch } from "../statistics/statisticsSearch";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  buildCliProxyHubEntry,
  savedKeyApplies,
  savedCloudflareSecretApplies,
  makeCliProxyHubId,
  validateCliProxyHubDraft,
  type CliProxyHubDraft,
} from "./cliProxyHubs.logic";
import {
  SettingsEmpty,
  SettingsField,
  SettingsNotice,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";

type TestHub = (input: CliProxyTestHubInput) => Promise<CliProxyTestHubResult>;

function hubDisplayName(hub: CliProxyHubConfig): string {
  if (hub.label) return hub.label;
  try {
    return new URL(hub.url).host;
  } catch {
    return hub.url;
  }
}

/**
 * CLIProxyAPI hubs this node reads subscription usage from. Node-scoped settings. Not part of
 * the frozen web phone tier, which has no Limits view either.
 */
export function CliProxyHubSettings() {
  const config = useServerConfig();
  const target = useSettingsTarget();
  const tier = usePresentationTier();
  const navigate = useNavigate();
  const closeSettings = useSettingsDialogStore((state) => state.closeSettings);
  const settingsCapability = useHostedRpcCapability(
    WS_METHODS.serverUpdateSettings,
    target?.environmentId ?? null,
  );
  const hubs = config?.settings.cliProxyHubs ?? {};
  const entries = (Object.entries(hubs) as Array<[CliProxyHubId, CliProxyHubConfig]>).toSorted(
    ([, left], [, right]) => hubDisplayName(left).localeCompare(hubDisplayName(right)),
  );
  // An older node drops `cliProxyHubs` from settings patches without an error.
  const unsupported = config !== null && config.environment.capabilities.cliProxyHubs !== true;
  const blocked =
    !config ||
    unsupported ||
    !settingsCapability.allowed ||
    Boolean(target && (!target.connected || target.canManage === false));
  const [editing, setEditing] = useState<{ readonly hubId: CliProxyHubId | null } | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<{
    readonly hubId: CliProxyHubId;
    readonly name: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const writePatch = useCallback(
    async (patch: ServerSettingsPatch) => {
      if (target) await updateEnvironmentServerSettings(target.environmentId, patch);
      else applySettingsUpdated(await ensureLocalApi().server.updateSettings(patch));
    },
    [target],
  );

  const runWrite = (patch: ServerSettingsPatch) => {
    setError(null);
    void writePatch(patch).catch((cause: unknown) =>
      setError(cause instanceof Error ? cause.message : "Could not save the hub. Try again."),
    );
  };

  const testHub = useCallback<TestHub>(
    (input) => {
      const server = target
        ? readEnvironmentApi(target.environmentId)?.server
        : ensureLocalApi().server;
      // Older nodes are blocked above by their capabilities; no API means no connection.
      return server?.testCliProxyHub
        ? server.testCliProxyHub(input)
        : Promise.reject(new Error("This node is not connected."));
    },
    [target],
  );

  const openLimits = () => {
    closeSettings();
    void navigate({
      to: "/statistics",
      search: parseStatisticsSearch({
        view: "limits",
        ...(target ? { environmentIds: [target.environmentId] } : {}),
      }),
    });
  };

  const editingHub = editing?.hubId ? hubs[editing.hubId] : undefined;

  if (tier === "phone") return null;

  return (
    <SettingsSection
      title="CLIProxyAPI hubs"
      owner="node"
      description="Read subscription usage from CLIProxyAPI servers: Claude, Codex and Antigravity quota per account, plus request counts for API keys. Read-only; routing agents through a hub is set up per provider instance."
      headerAction={
        <div className="flex items-center gap-1.5">
          {entries.length > 0 && !unsupported ? (
            <Button size="xs" variant="ghost" onClick={openLimits}>
              View limits <ArrowUpRightIcon />
            </Button>
          ) : null}
          <Button
            size="xs"
            variant="outline"
            disabled={blocked}
            onClick={() => setEditing({ hubId: null })}
            aria-label="Add CLIProxyAPI hub"
          >
            <PlusIcon />
            Add hub
          </Button>
        </div>
      }
    >
      {unsupported ? (
        <div className="border-b border-border/60 px-4 py-3 sm:px-5">
          <SettingsNotice tone="warning">
            Update Ryco on this node to connect CLIProxyAPI hubs.
          </SettingsNotice>
        </div>
      ) : null}
      {entries.length === 0 ? (
        <SettingsEmpty
          icon={<ServerIcon />}
          title="No hubs connected"
          description="Add a CLIProxyAPI server with its management key to see how much of each subscription is left."
        />
      ) : (
        entries.map(([hubId, hub]) => {
          const name = hubDisplayName(hub);
          return (
            <SettingsRow
              key={hubId}
              title={name}
              description={<span className="break-all font-mono text-[11px]">{hub.url}</span>}
              status={
                hub.managementKeyRedacted || hub.managementKey ? undefined : (
                  <span className="text-warning-foreground">No management key saved.</span>
                )
              }
              control={
                <>
                  <Switch
                    checked={hub.enabled}
                    disabled={blocked}
                    onCheckedChange={(checked) =>
                      runWrite({ cliProxyHubs: { [hubId]: { ...hub, enabled: Boolean(checked) } } })
                    }
                    aria-label={`Read usage from ${name}`}
                  />
                  <HubIconButton
                    label={`Edit ${name}`}
                    disabled={blocked}
                    onClick={() => setEditing({ hubId })}
                  >
                    <PencilIcon className="size-3.5" />
                  </HubIconButton>
                  <HubIconButton
                    label={`Remove ${name}`}
                    disabled={blocked}
                    onClick={() => setPendingRemoval({ hubId, name })}
                  >
                    <Trash2Icon className="size-3.5" />
                  </HubIconButton>
                </>
              }
            />
          );
        })
      )}
      {error ? (
        <div className="border-t border-border/60 px-4 py-3 sm:px-5">
          <SettingsNotice tone="error">{error}</SettingsNotice>
        </div>
      ) : null}

      <CliProxyHubDialog
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        hubId={editing?.hubId ?? null}
        existing={editingHub}
        existingIds={Object.keys(hubs)}
        cloudflareAccessSupported={
          config?.environment.capabilities.cliProxyCloudflareAccess === true
        }
        testHub={testHub}
        onSave={(hubId, entry) => writePatch({ cliProxyHubs: { [hubId]: entry } })}
        onLateSaveError={setError}
      />

      <AlertDialog
        open={pendingRemoval !== null}
        onOpenChange={(open) => !open && setPendingRemoval(null)}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {pendingRemoval?.name ?? "hub"}?</AlertDialogTitle>
            <AlertDialogDescription>
              Ryco stops reading this hub and deletes its stored credentials. The hub itself is not
              changed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                const removal = pendingRemoval;
                setPendingRemoval(null);
                if (removal) runWrite({ cliProxyHubs: { [removal.hubId]: null } });
              }}
            >
              Remove hub
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsSection>
  );
}

function HubIconButton(props: {
  readonly label: string;
  readonly disabled: boolean;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            className="text-muted-foreground hover:text-foreground"
            disabled={props.disabled}
            onClick={props.onClick}
            aria-label={props.label}
          >
            {props.children}
          </Button>
        }
      />
      <TooltipPopup side="top">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

type TestState =
  | { readonly status: "idle" }
  | { readonly status: "testing" }
  | { readonly status: "ok"; readonly result: CliProxyTestHubResult }
  | { readonly status: "failed"; readonly message: string };

function CliProxyHubDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly hubId: CliProxyHubId | null;
  readonly existing: CliProxyHubConfig | undefined;
  readonly existingIds: ReadonlyArray<string>;
  readonly cloudflareAccessSupported: boolean;
  readonly testHub: TestHub;
  readonly onSave: (hubId: CliProxyHubId, entry: CliProxyHubConfig) => Promise<void>;
  readonly onLateSaveError: (message: string) => void;
}) {
  // Uncompiled on purpose: Babel's React Compiler never compiled this function
  // (it bails on value blocks inside try/catch). Oxc can, but its render reads
  // have not been audited for purity yet. Remove after that audit.
  "use no memo";
  const { open, existing } = props;
  const [draft, setDraft] = useState<CliProxyHubDraft>({ url: "", label: "", managementKey: "" });
  const hasSavedKey = savedKeyApplies(draft.url, existing);
  const hasSavedCloudflareSecret = savedCloudflareSecretApplies(draft, existing);
  const savedKeyLeftBehind = existing?.managementKeyRedacted === true && !hasSavedKey;
  const [test, setTest] = useState<TestState>({ status: "idle" });
  const [saving, setSaving] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  // A test or save answers the form it started from: closing the dialog ends that form, and
  // editing a field or testing again makes an earlier test's answer stale.
  const formSession = useRef(0);
  const testRun = useRef(0);
  const openChange = (next: boolean) => {
    if (!next) formSession.current += 1;
    props.onOpenChange(next);
  };
  // Reset the form when it opens for a hub, not on every settings push while it is open.
  const formKey = open ? (props.hubId ?? "new") : null;
  const [initializedFor, setInitializedFor] = useState<string | null>(null);
  if (formKey !== initializedFor) {
    setInitializedFor(formKey);
    if (formKey !== null) {
      setDraft({
        url: existing?.url ?? "",
        label: existing?.label ?? "",
        managementKey: "",
        ...(props.cloudflareAccessSupported
          ? {
              cloudflareAccessClientId: existing?.cloudflareAccessClientId ?? "",
              cloudflareAccessClientSecret: "",
            }
          : {}),
      });
      setTest({ status: "idle" });
      setValidationError(null);
      setSaving(false);
    }
  }

  const update = (field: keyof CliProxyHubDraft, value: string) => {
    testRun.current += 1;
    setDraft((current) => ({ ...current, [field]: value }));
    setTest({ status: "idle" });
    setValidationError(null);
  };

  const runTest = () => {
    const invalid = validateCliProxyHubDraft(draft, { hasSavedKey, hasSavedCloudflareSecret });
    if (invalid) {
      setValidationError(invalid);
      return;
    }
    setTest({ status: "testing" });
    const session = formSession.current;
    const run = ++testRun.current;
    const current = () => formSession.current === session && testRun.current === run;
    const managementKey = draft.managementKey.trim();
    void props
      .testHub({
        url: draft.url.trim(),
        ...(managementKey ? { managementKey } : {}),
        ...(props.hubId ? { hubId: props.hubId } : {}),
        ...(props.cloudflareAccessSupported
          ? {
              cloudflareAccessClientId: draft.cloudflareAccessClientId?.trim() ?? "",
              cloudflareAccessClientSecret: draft.cloudflareAccessClientSecret?.trim() ?? "",
            }
          : {}),
      })
      .then(
        (result) => {
          if (current()) setTest({ status: "ok", result });
        },
        (cause: unknown) => {
          if (!current()) return;
          setTest({
            status: "failed",
            message: cause instanceof Error ? cause.message : "The hub could not be reached.",
          });
        },
      );
  };

  const save = async () => {
    const invalid = validateCliProxyHubDraft(draft, { hasSavedKey, hasSavedCloudflareSecret });
    if (invalid) {
      setValidationError(invalid);
      return;
    }
    setSaving(true);
    const session = formSession.current;
    try {
      const hubId = props.hubId ?? makeCliProxyHubId(draft.url, props.existingIds);
      await props.onSave(hubId, buildCliProxyHubEntry(draft, existing));
      if (formSession.current !== session) return;
      setSaving(false);
      openChange(false);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Could not save the hub.";
      // A save that fails after its dialog closed is reported by the section instead.
      if (formSession.current !== session) return props.onLateSaveError(message);
      setSaving(false);
      setValidationError(message);
    }
  };

  return (
    <Dialog open={open} onOpenChange={openChange}>
      <DialogPopup className="max-w-lg" bottomStickOnMobile={false}>
        <DialogHeader>
          <DialogTitle>{props.hubId ? "Edit CLIProxyAPI hub" : "Add CLIProxyAPI hub"}</DialogTitle>
          <DialogDescription>
            Ryco reads accounts and quota through the hub&apos;s management API. The key is stored
            in this node&apos;s secret store and never sent back to clients.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <SettingsField
            label="Hub URL"
            htmlFor="cliproxy-hub-url"
            description="The address CLIProxyAPI listens on (default port 8317). Remote hubs need allow-remote enabled in their management settings."
          >
            <Input
              id="cliproxy-hub-url"
              value={draft.url}
              onChange={(event) => update("url", event.target.value)}
              placeholder="http://127.0.0.1:8317"
              spellCheck={false}
              autoCapitalize="none"
              autoComplete="off"
            />
          </SettingsField>
          <SettingsField
            label="Management key"
            htmlFor="cliproxy-hub-key"
            description={
              hasSavedKey
                ? "A key is saved. Leave empty to keep it."
                : savedKeyLeftBehind
                  ? "The address changed. Enter the key again; the saved key is only used for its own address."
                  : "The hub's management secret key (remote-management.secret-key)."
            }
          >
            <Input
              id="cliproxy-hub-key"
              type="password"
              value={draft.managementKey}
              onChange={(event) => update("managementKey", event.target.value)}
              placeholder={hasSavedKey ? "••••••••" : "Management key"}
              autoComplete="off"
              spellCheck={false}
            />
          </SettingsField>
          <SettingsField
            label="Cloudflare Access Client ID"
            htmlFor="cliproxy-hub-cloudflare-id"
            description={
              props.cloudflareAccessSupported
                ? "Optional. For a hub protected by Cloudflare Access, use a service token allowed by a Service Auth policy."
                : "Update Ryco on this node to use Cloudflare Access service tokens."
            }
          >
            <Input
              id="cliproxy-hub-cloudflare-id"
              disabled={!props.cloudflareAccessSupported}
              value={draft.cloudflareAccessClientId ?? ""}
              onChange={(event) => update("cloudflareAccessClientId", event.target.value)}
              placeholder="Service token Client ID"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
            />
          </SettingsField>
          <SettingsField
            label="Cloudflare Access Client Secret"
            htmlFor="cliproxy-hub-cloudflare-secret"
            description={
              hasSavedCloudflareSecret
                ? "A secret is saved. Leave empty to keep it. Clear the Client ID and this field to remove the service token."
                : "The service token's secret. Enter it again if the hub address or Client ID changes. Leave both Cloudflare fields empty for a hub without Access."
            }
          >
            <Input
              id="cliproxy-hub-cloudflare-secret"
              disabled={!props.cloudflareAccessSupported}
              type="password"
              value={draft.cloudflareAccessClientSecret ?? ""}
              onChange={(event) => update("cloudflareAccessClientSecret", event.target.value)}
              placeholder={hasSavedCloudflareSecret ? "••••••••" : "Service token Client Secret"}
              autoComplete="off"
              spellCheck={false}
            />
          </SettingsField>
          <SettingsField label="Label" htmlFor="cliproxy-hub-label" description="Optional.">
            <Input
              id="cliproxy-hub-label"
              value={draft.label}
              onChange={(event) => update("label", event.target.value)}
              placeholder="e.g. Home server"
            />
          </SettingsField>

          {validationError ? <SettingsNotice tone="error">{validationError}</SettingsNotice> : null}
          {test.status === "ok" ? (
            <p role="status" className="flex items-center gap-1.5 text-xs text-success-foreground">
              <CheckCircle2Icon className="size-3.5 shrink-0" aria-hidden />
              Connected
              {test.result.version ? ` to CLIProxyAPI ${test.result.version}` : ""} ·{" "}
              {test.result.accountCount === 1
                ? "1 subscription account"
                : `${test.result.accountCount} subscription accounts`}
            </p>
          ) : test.status === "failed" ? (
            <SettingsNotice tone="error">{test.message}</SettingsNotice>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="outline"
            className="sm:mr-auto"
            onClick={runTest}
            disabled={saving || test.status === "testing"}
          >
            {test.status === "testing" ? <LoaderIcon className="animate-spin" /> : <PlugZapIcon />}
            Test connection
          </Button>
          <Button variant="outline" onClick={() => openChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={saving}>
            {saving ? <LoaderIcon className="animate-spin" /> : null}
            {props.hubId ? "Save" : "Add hub"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
