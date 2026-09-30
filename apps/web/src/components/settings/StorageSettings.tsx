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
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsRow } from "./settingsLayout";

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
  const target = useSettingsTarget();
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
  return (
    <SettingsRow
      title="Node storage and cleanup"
      owner="node"
      scope={target?.nodeLabel ?? "This node"}
      description="Measure project storage, review protected data and clean up inactive Ryco-owned checkouts. Automatic cleanup starts disabled."
      control={
        <div className="flex w-full flex-col gap-3 text-sm">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              setSelected([]);
              setConfirmation("");
              void controller.scan();
            }}
          >
            {" "}
            {state.busy ? "Working…" : "Scan node storage"}{" "}
          </Button>
          <p className="text-xs text-muted-foreground">
            Scans have a shared time and entry budget. Sizes are apparent bytes; unavailable sizes
            and lower bounds are labelled. Provider archives, credentials, repositories and
            persistent attachments stay protected.
          </p>
          {state.snapshot && (
            <>
              <p className="text-xs text-muted-foreground">
                Scanned {new Date(state.snapshot.scannedAt).toLocaleString()}
                {state.snapshot.truncated
                  ? " · Scan limit reached; some sizes or entries are unavailable."
                  : ""}
              </p>
              <select
                aria-label="Retention policy scope"
                className="rounded-md border bg-background p-2"
                value={projectId}
                disabled={busy}
                onChange={(event) => {
                  setProjectId(event.target.value);
                  setEnableApproval(null);
                  setSelected([]);
                  setConfirmation("");
                  controller.invalidatePreview();
                }}
              >
                <option value="">Node default</option>
                {projects.map((entry) => (
                  <option key={entry.id} value={entry.projectId!}>
                    {entry.label}
                  </option>
                ))}
              </select>
              <p>
                {projectId && !settings?.projectStorageRetention[projectId]
                  ? "Inherited node retention policy"
                  : projectId
                    ? "Project retention policy"
                    : "Node retention policy"}
              </p>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={policy.automatic}
                  disabled={busy}
                  onChange={(event) => {
                    if (event.target.checked)
                      setEnableApproval({
                        ...policy,
                        automatic: true,
                        completedWorktreeDays: policy.completedWorktreeDays ?? 30,
                      });
                    else void save({ ...policy, automatic: false });
                  }}
                />
                Automatic retention cleanup
              </label>
              {(["completedWorktreeDays", "temporaryDataDays"] as const).map((field) => (
                <label className="flex items-center justify-between gap-3" key={field}>
                  {field === "completedWorktreeDays"
                    ? "Keep completed checkouts"
                    : "Keep completed temporary staging data"}
                  <select
                    aria-label={
                      field === "completedWorktreeDays"
                        ? "Completed worktree retention"
                        : "Temporary data retention"
                    }
                    className="rounded-md border bg-background p-2"
                    disabled={busy}
                    value={policy[field] ?? "forever"}
                    onChange={(event) => {
                      void save({
                        ...policy,
                        [field]:
                          event.target.value === "forever" ? null : Number(event.target.value),
                      });
                    }}
                  >
                    <option value="forever">Forever</option>
                    {[1, 7, 30, 90, 365].map((days) => (
                      <option value={days} key={days}>
                        {days} days
                      </option>
                    ))}
                    {policy[field] !== null && ![1, 7, 30, 90, 365].includes(policy[field]) && (
                      <option value={policy[field]!}>{policy[field]} days</option>
                    )}
                  </select>
                </label>
              ))}
              {projectId && settings?.projectStorageRetention[projectId] && (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    void save(null);
                  }}
                >
                  Use node retention policy
                </Button>
              )}
              <p className="text-xs text-muted-foreground">
                Retention applies hourly after the node starts. Only archived, stopped, clean,
                unshared owned checkouts qualify. Abandoned checkouts have a 24-hour grace period.
                Temporary cleanup applies only to completed Ryco staging allocations.
              </p>
              {enableApproval && (
                <div
                  role="alertdialog"
                  aria-label="Enable automatic cleanup"
                  className="rounded-md border p-3"
                >
                  <p>
                    Enable automatic deletion on {projectId ? "this project" : "this node"}?
                    Qualifying checkouts are removed after {enableApproval.completedWorktreeDays}{" "}
                    days. Branches, messages and usage history are retained. Dirty, untracked,
                    ignored, shared and running work stay protected.
                  </p>
                  <div className="mt-2 flex gap-2">
                    <Button
                      disabled={busy}
                      onClick={() => {
                        void save(enableApproval);
                      }}
                    >
                      Enable automatic cleanup
                    </Button>
                    <Button variant="outline" onClick={() => setEnableApproval(null)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
              <div className="max-h-96 space-y-3 overflow-y-auto">
                {state.snapshot.entries
                  .filter((entry) => !projectId || entry.projectId === projectId)
                  .map((entry) => (
                    <label key={entry.id} className="flex items-start gap-2 rounded-md border p-3">
                      <input
                        type="checkbox"
                        className="mt-1"
                        disabled={busy || !entry.eligible}
                        checked={selected.includes(entry.id)}
                        onChange={(event) =>
                          setSelected((current) =>
                            event.target.checked
                              ? [...current, entry.id].slice(0, 20)
                              : current.filter((id) => id !== entry.id),
                          )
                        }
                      />
                      <span className="min-w-0">
                        <span className="block font-medium">
                          {entry.label} · {entry.category} ·{" "}
                          {formatStorageSize(entry.bytes, entry.sizeStatus)}
                        </span>
                        {entry.path && (
                          <span className="block break-all text-xs text-muted-foreground">
                            {entry.path}
                          </span>
                        )}
                        <span className="block text-xs text-muted-foreground">{entry.reason}</span>
                      </span>
                    </label>
                  ))}
              </div>
              {state.snapshot.nextCursor && (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    setSelected([]);
                    void controller.scan(undefined, state.snapshot!.nextCursor!);
                  }}
                >
                  Next inventory page
                </Button>
              )}
              <Button
                disabled={busy || !selected.length}
                variant="outline"
                onClick={() => {
                  setConfirmation("");
                  void controller.preview(selected);
                }}
              >
                Preview cleanup ({selected.length})
              </Button>
              {state.snapshot.history.length > 0 && (
                <details>
                  <summary>
                    Historical measured usage ({state.snapshot.history.length} recent samples)
                  </summary>
                  {state.snapshot.history
                    .filter((sample) => !projectId || sample.projectId === projectId)
                    .map((sample) => (
                      <p
                        className="text-xs"
                        key={`${sample.projectId ?? "node"}:${sample.sampledAt}`}
                      >
                        {new Date(sample.sampledAt).toLocaleString()} ·{" "}
                        {projects.find((entry) => entry.projectId === sample.projectId)?.label ??
                          "Node data"}{" "}
                        ·{" "}
                        {formatStorageSize(
                          sample.measuredBytes,
                          sample.incompleteEntries ? "bounded" : "complete",
                        )}{" "}
                        · {sample.incompleteEntries} incomplete entries
                      </p>
                    ))}
                </details>
              )}
            </>
          )}
          {state.preview && (
            <div
              role="alertdialog"
              aria-label="Confirm storage cleanup"
              className="rounded-md border p-3"
            >
              <p>
                Delete these reviewed checkouts/data? This cannot be undone. Branches and
                conversation history are retained.
              </p>
              {state.preview.entries.map((entry) => (
                <p className="my-1 break-all text-xs" key={entry.id}>
                  {entry.path} · {formatStorageSize(entry.bytes, entry.sizeStatus)}
                </p>
              ))}
              <p className="my-2 text-xs text-muted-foreground">
                Preview expires {new Date(state.preview.expiresAt).toLocaleTimeString()}. The server
                checks safety again before each removal.
              </p>
              <Input
                aria-label="Type DELETE to confirm cleanup"
                placeholder="Type DELETE to confirm"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
              />
              <div className="mt-2 flex gap-2">
                <Button
                  variant="destructive"
                  disabled={busy || confirmation !== "DELETE"}
                  onClick={() => {
                    void controller.execute(true);
                  }}
                >
                  Delete reviewed data
                </Button>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    controller.invalidatePreview();
                    setSelected([]);
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
          {state.result?.results.map((result) => (
            <p role="status" key={result.id}>
              {result.status}: {result.detail}
            </p>
          ))}
          {(state.error || saveError) && (
            <p role="alert" className="text-destructive">
              {state.error ?? saveError}
            </p>
          )}
        </div>
      }
    />
  );
}
