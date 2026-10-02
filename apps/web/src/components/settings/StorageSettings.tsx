import { useLayoutEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  type EnvironmentId,
  type ServerSettingsPatch,
  type StorageRetentionPolicy,
} from "@ryco/contracts";
import { createStorageManagementController } from "@ryco/client-runtime/state/storage";
import { formatStorageSize, resolveStorageRetentionPolicy } from "@ryco/shared/storageRetention";
import { useServerConfig } from "../../rpc/serverState";
import { useSettingsEditingScope, useSettingsTarget } from "../../settingsTarget";
import {
  readEnvironmentConnection,
  updateEnvironmentServerSettings,
} from "../../environments/runtime";
import { HardDriveIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import {
  SETTINGS_INSET_CLASS,
  SettingResetButton,
  SettingsBlock,
  SettingsEmpty,
  SettingsNotice,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { SettingsSelect } from "./SettingsSelect";

/** Node storage is separate from client/device cache and never appears in the frozen phone tier. */
export function StorageSettings() {
  const config = useServerConfig();
  const target = useSettingsTarget();
  const scope = useSettingsEditingScope();
  const environmentId = target?.environmentId ?? config?.environment.environmentId;
  return (
    <StorageEditor
      key={environmentId ?? "offline"}
      environmentId={environmentId}
      disabled={
        scope === "client" ||
        !config ||
        config.environment.capabilities.storageManagement !== true ||
        (scope === "node" && !target) ||
        Boolean(
          target && (!target.connected || target.canManage === false || target.canMutate === false),
        )
      }
    />
  );
}

function StorageEditor({
  environmentId,
  disabled,
}: {
  environmentId: EnvironmentId | undefined;
  disabled: boolean;
}) {
  const config = useServerConfig();
  const controller = useMemo(
    () =>
      createStorageManagementController({
        readClient: () =>
          environmentId ? (readEnvironmentConnection(environmentId)?.client ?? null) : null,
      }),
    [environmentId],
  );
  useLayoutEffect(() => {
    controller.setReady(!disabled);
  }, [controller, disabled]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [projectId, setProjectId] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [confirmation, setConfirmation] = useState("");
  const [enableApproval, setEnableApproval] = useState<StorageRetentionPolicy | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const settings = config?.settings;
  const policy = settings
    ? resolveStorageRetentionPolicy(settings, projectId || null)
    : { automatic: false, completedWorktreeDays: null, temporaryDataDays: null };
  const projects = state.snapshot?.entries.filter((entry) => entry.category === "repository") ?? [];
  const busy = disabled || saving || state.busy;
  async function save(next: StorageRetentionPolicy | null) {
    if (busy || !environmentId || (!projectId && !next)) return;
    setSaving(true);
    setSaveError(null);
    controller.invalidatePreview();
    setSelected([]);
    setEnableApproval(null);
    const patch: ServerSettingsPatch = projectId
      ? { projectStorageRetention: { [projectId]: next } }
      : { storageRetention: next! };
    try {
      await updateEnvironmentServerSettings(environmentId, patch);
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : "Could not save retention policy.");
    } finally {
      setSaving(false);
    }
  }
  const retentionScopeLabel =
    projectId && !settings?.projectStorageRetention[projectId]
      ? "Inherits the device policy"
      : projectId
        ? "Project policy"
        : "Device policy";
  const retentionOptions = (field: "completedWorktreeDays" | "temporaryDataDays") => {
    const current = policy[field];
    const days = [1, 7, 30, 90, 365];
    if (current !== null && !days.includes(current)) days.push(current);
    return [
      { value: "forever", label: "Forever" },
      ...days
        .toSorted((a, b) => a - b)
        .map((value) => ({ value: String(value), label: value === 1 ? "1 day" : `${value} days` })),
    ];
  };
  const visibleEntries =
    state.snapshot?.entries.filter((entry) => !projectId || entry.projectId === projectId) ?? [];
  const errorMessage = state.error ?? saveError;
  return (
    <SettingsSection
      title="Storage"
      owner="node"
      description="Measure what Ryco keeps on this device and clean up inactive checkouts. Provider archives, credentials, repositories, and persistent attachments stay protected."
      headerAction={
        <Button
          size="xs"
          variant="outline"
          disabled={busy}
          onClick={() => {
            setSelected([]);
            setConfirmation("");
            void controller.scan();
          }}
        >
          <HardDriveIcon />
          {state.busy ? "Working…" : state.snapshot ? "Rescan" : "Scan storage"}
        </Button>
      }
    >
      {!state.snapshot ? (
        <SettingsEmpty
          icon={<HardDriveIcon />}
          title="Not scanned yet"
          description="Scans share a time and entry budget. Sizes are apparent bytes; unavailable sizes and lower bounds are labelled."
          className="py-8"
        />
      ) : (
        <>
          <SettingsRow
            title="Retention policy"
            description="Applies hourly after the device starts. Only archived, stopped, clean, unshared Ryco checkouts qualify; abandoned ones get a 24-hour grace period."
            status={retentionScopeLabel}
            resetAction={
              projectId && settings?.projectStorageRetention[projectId] ? (
                <SettingResetButton
                  label="project retention policy"
                  tooltip="Use device policy"
                  ariaLabel="Use device retention policy"
                  disabled={busy}
                  onClick={() => void save(null)}
                />
              ) : null
            }
            control={
              <SettingsSelect
                ariaLabel="Retention policy scope"
                value={projectId || "device"}
                disabled={busy}
                onValueChange={(value) => {
                  setProjectId(value === "device" ? "" : value);
                  setEnableApproval(null);
                  setSelected([]);
                  setConfirmation("");
                  controller.invalidatePreview();
                }}
                options={[
                  { value: "device", label: "All projects" },
                  ...projects.map((entry) => ({ value: entry.projectId!, label: entry.label })),
                ]}
              />
            }
          />
          <SettingsRow
            title="Automatic cleanup"
            description="Remove qualifying checkouts on schedule. Branches, messages, and usage history are kept."
            control={
              <Switch
                aria-label="Automatic retention cleanup"
                checked={policy.automatic}
                disabled={busy}
                onCheckedChange={(checked) => {
                  if (checked)
                    setEnableApproval({
                      ...policy,
                      automatic: true,
                      completedWorktreeDays: policy.completedWorktreeDays ?? 30,
                    });
                  else void save({ ...policy, automatic: false });
                }}
              />
            }
          >
            {enableApproval ? (
              <div role="alertdialog" aria-label="Enable automatic cleanup">
                <SettingsNotice
                  tone="warning"
                  title={`Enable automatic deletion on ${projectId ? "this project" : "this device"}?`}
                  action={
                    <div className="flex gap-2">
                      <Button size="xs" variant="ghost" onClick={() => setEnableApproval(null)}>
                        Cancel
                      </Button>
                      <Button size="xs" disabled={busy} onClick={() => void save(enableApproval)}>
                        Enable automatic cleanup
                      </Button>
                    </div>
                  }
                >
                  Qualifying checkouts are removed after {enableApproval.completedWorktreeDays}{" "}
                  days. Dirty, untracked, ignored, shared, and running work stays protected.
                </SettingsNotice>
              </div>
            ) : null}
          </SettingsRow>
          {(["completedWorktreeDays", "temporaryDataDays"] as const).map((field) => (
            <SettingsRow
              key={field}
              title={
                field === "completedWorktreeDays"
                  ? "Keep completed checkouts"
                  : "Keep temporary staging data"
              }
              description={
                field === "completedWorktreeDays"
                  ? "How long archived, finished checkouts stay before cleanup."
                  : "How long completed Ryco staging allocations stay before cleanup."
              }
              control={
                <SettingsSelect
                  ariaLabel={
                    field === "completedWorktreeDays"
                      ? "Completed worktree retention"
                      : "Temporary data retention"
                  }
                  width="sm"
                  disabled={busy}
                  value={policy[field] === null ? "forever" : String(policy[field])}
                  onValueChange={(value) => {
                    void save({ ...policy, [field]: value === "forever" ? null : Number(value) });
                  }}
                  options={retentionOptions(field)}
                />
              }
            />
          ))}
          <SettingsBlock className="flex flex-wrap items-center justify-between gap-2 py-2.5">
            <p className="text-xs text-muted-foreground">
              Scanned {new Date(state.snapshot.scannedAt).toLocaleString()}
              {state.snapshot.truncated
                ? " · Scan limit reached; some sizes or entries are unavailable."
                : ""}
            </p>
            <Button
              size="xs"
              variant="outline"
              disabled={busy || !selected.length}
              onClick={() => {
                setConfirmation("");
                void controller.preview(selected);
              }}
            >
              Preview cleanup ({selected.length})
            </Button>
          </SettingsBlock>
          <SettingsBlock flush>
            <ul className="max-h-96 divide-y divide-border/60 overflow-y-auto">
              {visibleEntries.map((entry) => {
                const size = formatStorageSize(entry.bytes, entry.sizeStatus);
                return (
                  <li
                    key={entry.id}
                    className={cn("flex items-start gap-3 py-3", SETTINGS_INSET_CLASS)}
                  >
                    <Checkbox
                      className="mt-0.5"
                      aria-label={`${entry.label} · ${entry.category} · ${size}`}
                      disabled={busy || !entry.eligible}
                      checked={selected.includes(entry.id)}
                      onCheckedChange={(checked) =>
                        setSelected((current) =>
                          checked === true
                            ? [...current, entry.id].slice(0, 20)
                            : current.filter((id) => id !== entry.id),
                        )
                      }
                    />
                    <div className="min-w-0 flex-1">
                      <p className="flex min-w-0 items-center gap-2">
                        <span className="min-w-0 truncate text-[13px] font-medium text-foreground">
                          {entry.label}
                        </span>
                        <Badge variant="outline" size="sm" className="capitalize">
                          {entry.category}
                        </Badge>
                      </p>
                      {entry.path ? (
                        <p className="mt-0.5 break-all font-mono text-[11px] text-muted-foreground">
                          {entry.path}
                        </p>
                      ) : null}
                      <p className="mt-0.5 text-xs text-muted-foreground">{entry.reason}</p>
                    </div>
                    <span className="shrink-0 pt-0.5 text-xs tabular-nums text-muted-foreground">
                      {size}
                    </span>
                  </li>
                );
              })}
            </ul>
            {state.snapshot.nextCursor ? (
              <div className={cn("border-t border-border/60 py-2.5", SETTINGS_INSET_CLASS)}>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setSelected([]);
                    void controller.scan(undefined, state.snapshot!.nextCursor!);
                  }}
                >
                  Next inventory page
                </Button>
              </div>
            ) : null}
          </SettingsBlock>
          {state.snapshot.history.length > 0 ? (
            <SettingsBlock>
              <Collapsible>
                <CollapsibleTrigger className="flex w-full items-center justify-between gap-2 text-left text-xs font-medium text-foreground">
                  Measured usage history
                  <span className="font-normal text-muted-foreground">
                    {state.snapshot.history.length} recent samples
                  </span>
                </CollapsibleTrigger>
                <CollapsiblePanel>
                  <ul className="mt-2 space-y-1">
                    {state.snapshot.history
                      .filter((sample) => !projectId || sample.projectId === projectId)
                      .map((sample) => (
                        <li
                          className="flex flex-wrap gap-x-2 text-xs text-muted-foreground"
                          key={`${sample.projectId ?? "node"}:${sample.sampledAt}`}
                        >
                          <span>{new Date(sample.sampledAt).toLocaleString()}</span>
                          <span className="text-foreground">
                            {projects.find((entry) => entry.projectId === sample.projectId)
                              ?.label ?? "Device data"}
                          </span>
                          <span className="tabular-nums">
                            {formatStorageSize(
                              sample.measuredBytes,
                              sample.incompleteEntries ? "bounded" : "complete",
                            )}
                          </span>
                          {sample.incompleteEntries ? (
                            <span>{sample.incompleteEntries} incomplete entries</span>
                          ) : null}
                        </li>
                      ))}
                  </ul>
                </CollapsiblePanel>
              </Collapsible>
            </SettingsBlock>
          ) : null}
        </>
      )}
      {state.preview ? (
        <SettingsBlock>
          <div role="alertdialog" aria-label="Confirm storage cleanup">
            <SettingsNotice tone="error" title="Delete these reviewed checkouts and data?">
              <p>This cannot be undone. Branches and conversation history are kept.</p>
              <ul className="my-2 space-y-0.5">
                {state.preview.entries.map((entry) => (
                  <li className="break-all font-mono text-[11px] text-foreground" key={entry.id}>
                    {entry.path} · {formatStorageSize(entry.bytes, entry.sizeStatus)}
                  </li>
                ))}
              </ul>
              <p>
                Preview expires {new Date(state.preview.expiresAt).toLocaleTimeString()}. The server
                checks safety again before each removal.
              </p>
              <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                <Input
                  size="sm"
                  aria-label="Type DELETE to confirm cleanup"
                  placeholder="Type DELETE to confirm"
                  value={confirmation}
                  className="sm:max-w-56"
                  onChange={(event) => setConfirmation(event.target.value)}
                />
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      controller.invalidatePreview();
                      setSelected([]);
                    }}
                  >
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={busy || confirmation !== "DELETE"}
                    onClick={() => {
                      void controller.execute(true);
                    }}
                  >
                    Delete reviewed data
                  </Button>
                </div>
              </div>
            </SettingsNotice>
          </div>
        </SettingsBlock>
      ) : null}
      {state.result?.results.length || errorMessage ? (
        <SettingsBlock className="flex flex-col gap-2">
          {state.result?.results.map((result) => (
            <p role="status" key={result.id} className="text-xs text-muted-foreground">
              <span className="font-medium capitalize text-foreground">{result.status}</span>:{" "}
              {result.detail}
            </p>
          ))}
          {errorMessage ? (
            <SettingsNotice tone="error" role="alert">
              {errorMessage}
            </SettingsNotice>
          ) : null}
        </SettingsBlock>
      ) : null}
    </SettingsSection>
  );
}
