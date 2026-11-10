import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import {
  type DatabaseStorageReport,
  type EnvironmentId,
  type ServerSettingsPatch,
  type StorageRetentionPolicy,
  DEFAULT_STORAGE_RETENTION_POLICY,
} from "@ryco/contracts";
import { createStorageManagementController } from "@ryco/client-runtime/state/storage";
import { formatStorageSize, resolveStorageRetentionPolicy } from "@ryco/shared/storageRetention";
import { usePrimaryEnvironmentId } from "../../environments/primary/context";
import { useServerConfig } from "../../rpc/serverState";
import { useSettingsEditingScope, useSettingsTarget } from "../../settingsTarget";
import { isNodeSettingsTargetReadOnly } from "./settingsSections.logic";
import {
  readEnvironmentConnection,
  updateEnvironmentServerSettings,
} from "../../environments/runtime";
import { CheckIcon, CopyIcon, HardDriveIcon } from "lucide-react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
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
import { saveSharedSetting, useSharedSettingWriter } from "./sharedSettings/SharedSettingRow";
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
        !config ||
        config.environment.capabilities.storageManagement !== true ||
        isNodeSettingsTargetReadOnly(scope, target)
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
  const sharedRetention = useSharedSettingWriter("storageRetention");
  const settings = config?.settings;
  const policy = settings
    ? resolveStorageRetentionPolicy(settings, projectId || null)
    : DEFAULT_STORAGE_RETENTION_POLICY;
  const projects = state.snapshot?.entries.filter((entry) => entry.category === "repository") ?? [];
  const busy = disabled || saving || state.busy;
  async function save(next: StorageRetentionPolicy | null) {
    if (busy || !environmentId || (!projectId && !next)) return;
    setSaving(true);
    setSaveError(null);
    controller.invalidatePreview();
    setSelected([]);
    setEnableApproval(null);
    try {
      if (projectId) {
        const patch: ServerSettingsPatch = { projectStorageRetention: { [projectId]: next } };
        await updateEnvironmentServerSettings(environmentId, patch);
      } else if (next !== null) {
        // The device policy is shared across devices; a project's policy stays here.
        await saveSharedSetting(sharedRetention.save, next);
      }
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
            description="Applies hourly after the device starts. Only archived, stopped, unshared Ryco checkouts with no uncommitted work qualify. Dependency folders such as node_modules go with them; .env and other ignored files keep a checkout. Abandoned checkouts get a 24-hour grace period."
            status={
              projectId ? (
                retentionScopeLabel
              ) : (
                <>
                  <span className="block">{retentionScopeLabel}</span>
                  {sharedRetention.status}
                </>
              )
            }
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
                  days. Uncommitted, untracked, shared, and running work stays protected, and so do
                  ignored files that are not dependency caches, such as .env.
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
          {state.snapshot.database ? (
            <DatabaseStorageRows
              database={state.snapshot.database}
              busy={busy}
              onRemoveBackup={(name) => void controller.removeDatabaseBackup(name)}
              compaction={
                state.snapshot.database.oneClickCompaction === true ? (
                  <DatabaseCompactionRow
                    database={state.snapshot.database}
                    controller={controller}
                    environmentId={environmentId}
                    disabled={disabled}
                  />
                ) : null
              }
            />
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

const formatBytes = (bytes: number) => formatStorageSize(bytes, "complete");

function compactionStatus(compaction: DatabaseStorageReport["compaction"]): string {
  const removed =
    compaction.removedEvents > 0
      ? `Removed ${compaction.removedEvents.toLocaleString()} superseded progress updates (${formatBytes(compaction.removedBytes)}).`
      : "Nothing removed yet.";
  if (!compaction.enabled) return `Off on this node. ${removed}`;
  if (compaction.lastPassCompletedAt === null)
    return compaction.compactedThroughSequence > 0
      ? `${removed} The first pass is running.`
      : "Not run yet; the first pass starts 10 minutes after the node starts.";
  const lastRun = `last run ${new Date(compaction.lastPassCompletedAt).toLocaleString()}`;
  if (compaction.caughtUp) return `${removed} Up to date, ${lastRun}.`;
  const examined =
    compaction.headSequence > 0
      ? Math.floor((compaction.compactedThroughSequence / compaction.headSequence) * 100)
      : 0;
  return `${removed} Catching up: ${examined}% of history examined, ${lastRun}.`;
}

/**
 * The node's database, from the last scan, inside the storage card. Kept in this module: it is
 * part of the lazy settings chunk, so the app shell's static graph does not grow.
 */
function DatabaseStorageRows({
  database,
  busy,
  onRemoveBackup,
  compaction,
}: {
  database: DatabaseStorageReport;
  busy: boolean;
  onRemoveBackup: (name: string) => void;
  /** The one-click compaction row, on nodes that offer it (it replaces the doctor command). */
  compaction: React.ReactNode;
}) {
  const value = (text: string) => (
    <span className="text-xs tabular-nums text-muted-foreground">{text}</span>
  );
  const shrinking = database.autoVacuum !== "none";
  return (
    <>
      <SettingsBlock className="pt-4 pb-1">
        <h3 className="text-[13px] font-semibold text-foreground">Database</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Chats, history and settings of this node, in one SQLite file.
        </p>
      </SettingsBlock>
      <SettingsRow
        title="Database file"
        description={
          // The log's file size, not pending writes: SQLite keeps the file after merging it.
          database.walBytes > 0
            ? `On disk, including the ${formatBytes(database.walBytes)} write-ahead log. SQLite keeps reusing it after merging its writes into the file.`
            : "On disk; the write-ahead log is empty."
        }
        control={value(formatBytes(database.fileBytes + database.walBytes))}
      />
      <SettingsRow
        title="Free space inside the file"
        description="Left by removed data. SQLite reuses it for new data before the file grows."
        control={value(formatBytes(database.freePages * database.pageSize))}
      />
      <SettingsRow
        title="Automatic shrinking"
        description={
          database.autoVacuum === "incremental"
            ? "Free space beyond 1 MiB is returned to the disk, up to 4 MiB a minute."
            : database.autoVacuum === "full"
              ? "SQLite returns free space to the disk at every removal."
              : "This database was created before automatic shrinking. Its free space is reused, but the file does not get smaller."
        }
        control={
          <Badge variant="outline" size="sm">
            {shrinking ? "On" : "Off"}
          </Badge>
        }
      />
      <SettingsRow
        title="History compaction"
        description="Removes older copies of progress updates once they are a day old; only the newest copy of each is ever shown."
        status={compactionStatus(database.compaction)}
      />
      <SettingsRow
        title="Estimated reclaimable"
        description={
          database.compaction.estimatedCompactableBytes === null
            ? "Free space inside the file. An estimate of superseded history follows the first compaction pass."
            : `Free space plus about ${formatBytes(database.compaction.estimatedCompactableBytes)} of superseded history not yet removed.`
        }
        control={value(formatBytes(database.reclaimableBytes))}
      />
      {compaction ??
        (database.doctor?.recommended ? <DatabaseDoctorRow database={database} /> : null)}
      {database.backups && database.backups.length > 0 ? (
        <DatabaseBackupRows backups={database.backups} busy={busy} onRemove={onRemoveBackup} />
      ) : null}
    </>
  );
}

const schemaLabel = (schema: number) => `v${String(schema).padStart(3, "0")}`;

/**
 * The database's backups, each removable by the owner's click (with a confirm step); the node
 * never removes them for that reason on its own. Only nodes that list them can remove them.
 */
function DatabaseBackupRows({
  backups,
  busy,
  onRemove,
}: {
  backups: NonNullable<DatabaseStorageReport["backups"]>;
  busy: boolean;
  onRemove: (name: string) => void;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const total = backups.reduce((sum, backup) => sum + backup.bytes, 0);
  return (
    <>
      <SettingsRow
        title="Database backups"
        description="Copies taken before upgrades, to undo one. The newest three of each kind are kept; removing one frees its space."
        control={
          <span className="text-xs tabular-nums text-muted-foreground">{formatBytes(total)}</span>
        }
      />
      {backups.map((backup) => (
        <SettingsRow
          key={backup.name}
          title={
            backup.kind === "manual"
              ? `Manual backup (${schemaLabel(backup.fromSchema)})`
              : `Before upgrade ${schemaLabel(backup.fromSchema)} → ${schemaLabel(backup.toSchema ?? backup.fromSchema)}`
          }
          description={`${new Date(backup.createdAt).toLocaleString()} · ${formatBytes(backup.bytes)}${
            backup.newest ? " · the way back from the latest upgrade" : ""
          }`}
          control={
            confirming === backup.name ? (
              <span className="flex gap-1.5">
                <Button size="xs" variant="outline" onClick={() => setConfirming(null)}>
                  Keep
                </Button>
                <Button
                  size="xs"
                  variant="destructive"
                  disabled={busy}
                  onClick={() => {
                    setConfirming(null);
                    onRemove(backup.name);
                  }}
                >
                  Remove backup
                </Button>
              </span>
            ) : (
              <Button
                size="xs"
                variant="outline"
                disabled={busy}
                aria-label={`Remove backup from ${new Date(backup.createdAt).toLocaleString()}`}
                onClick={() => setConfirming(backup.name)}
              >
                Remove
              </Button>
            )
          }
        />
      ))}
    </>
  );
}

/**
 * The offline repair, suggested when the file could shrink a lot but never shrinks by itself.
 * The node names the command: `ryco doctor --apply` for a CLI node, the CLI of the desktop app's
 * own version through npx for the desktop app (which the CLI cannot stop).
 */
function DatabaseDoctorRow({ database }: { database: DatabaseStorageReport }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  const command = database.doctor?.command ?? null;
  const desktop = command?.startsWith("npx ") === true;
  const intro = `About ${formatBytes(database.reclaimableBytes)} could be returned to the disk, but this database never shrinks by itself.`;
  return (
    <SettingsRow
      title="Shrink the database file"
      description={
        command === null
          ? `${intro} Stop this development server and run \`ryco doctor --apply\` with the same \`--base-dir\` and \`--dev-url\` it was started with.`
          : desktop
            ? `${intro} Quit the Ryco app first, then run this in a terminal (needs Node.js 22.16 or newer). It removes superseded history, writes a compacted copy and turns automatic shrinking on.`
            : `${intro} Run this in a terminal on the node. It stops the node's background service while it works and starts it again; quit a running \`ryco serve\` first.`
      }
      control={
        command === null ? null : (
          <Button size="xs" variant="outline" onClick={() => copyToClipboard(command)}>
            {isCopied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
            {isCopied ? "Copied" : "Copy"}
          </Button>
        )
      }
    >
      {command === null ? null : (
        <p
          data-testid="database-doctor-command"
          className="font-mono text-[13px] break-all select-all"
        >
          {command}
        </p>
      )}
    </SettingsRow>
  );
}

type StorageController = ReturnType<typeof createStorageManagementController>;
type CompactionStatus = NonNullable<Awaited<ReturnType<StorageController["readCompactionStatus"]>>>;
type DesktopCompactionState = Awaited<
  ReturnType<NonNullable<NonNullable<Window["desktopBridge"]>["databaseCompaction"]>["getState"]>
>;

/** While waiting for the node to idle, it is asked again this often. */
const COMPACTION_IDLE_POLL_MS = 15_000;

const RUN_STATUS_TEXT: Record<string, string> = {
  running: "Running",
  repaired: "Done",
  compacted: "History removed; the file was not replaced",
  "already-compact": "Nothing to shrink",
  refused: "Not run",
  failed: "Failed",
  cancelled: "Cancelled",
};

function describeRun(run: {
  readonly status: string;
  readonly message: string;
  readonly beforeBytes: number | null;
  readonly afterBytes: number | null;
  readonly downtimeMs: number | null;
}): string {
  // The doctor's own message already names the sizes when it shrank the file.
  const sizes =
    run.beforeBytes !== null && run.afterBytes !== null && !run.message.includes("→")
      ? ` ${formatBytes(run.beforeBytes)} → ${formatBytes(run.afterBytes)}.`
      : "";
  const downtime =
    run.downtimeMs !== null
      ? ` The server was stopped for ${Math.round(run.downtimeMs / 1000)} s.`
      : "";
  return `${RUN_STATUS_TEXT[run.status] ?? run.status}: ${run.message}${sizes}${downtime}`;
}

/**
 * One-click compaction: the doctor's copy-and-swap while the server is stopped. The desktop app
 * runs it for its own server (with progress and Cancel until the swap); a background-service node
 * runs it detached and restarts. Offered above the doctor's threshold, and only while nothing
 * would be cut off; otherwise it waits for the node to idle, while this view stays open.
 */
function DatabaseCompactionRow({
  database,
  controller,
  environmentId,
  disabled,
}: {
  database: DatabaseStorageReport;
  controller: StorageController;
  environmentId: EnvironmentId | undefined;
  disabled: boolean;
}) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const bridge =
    environmentId !== undefined && environmentId === primaryEnvironmentId
      ? window.desktopBridge?.databaseCompaction
      : undefined;
  const [status, setStatus] = useState<CompactionStatus | null>(null);
  const [desktop, setDesktop] = useState<DesktopCompactionState>({ phase: "idle" });
  const [waiting, setWaiting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void controller.readCompactionStatus().then((next) => {
      if (live) setStatus(next);
    });
    return () => {
      live = false;
    };
  }, [controller]);

  useEffect(() => {
    if (!bridge) return;
    let live = true;
    void bridge.getState().then((next) => {
      if (live) setDesktop(next);
    });
    const unsubscribe = bridge.onState((next) => {
      setDesktop(next);
      // The file changed: the sizes and the offer above come from a scan that is now stale.
      // A moment later, once the window reconnected to the restarted server.
      if (next.phase === "finished") setTimeout(() => void controller.scan(), 2_000);
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [bridge, controller]);

  const runner = status?.runner ?? "none";
  const canRun = runner === "service" || (runner === "desktop" && bridge !== undefined);

  const start = async () => {
    const fresh = await controller.readCompactionStatus();
    setStatus(fresh);
    if (fresh === null) {
      setMessage("The node could not be asked. Try again once it is connected.");
      return;
    }
    if (fresh.busy.length > 0) {
      setWaiting(true);
      return;
    }
    setWaiting(false);
    if (fresh.runner === "desktop" && bridge) {
      setDesktop(await bridge.start());
      return;
    }
    const started = await controller.startServiceCompaction().catch(() => null);
    setMessage(started?.detail ?? "The compaction could not start.");
  };

  // Waiting for the node to idle: ask again until nothing would be cut off, then start.
  const retryStart = useEffectEvent(() => void start());
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(retryStart, COMPACTION_IDLE_POLL_MS);
    return () => clearInterval(timer);
  }, [waiting]);

  const running = desktop.phase === "running";
  const finished = desktop.phase === "finished" ? desktop : null;
  const lastRun = finished ?? status?.lastRun ?? null;
  if (!database.doctor?.recommended && !running && lastRun === null) return null;

  const description = running
    ? `${desktop.text}${desktop.detail ? ` · ${desktop.detail}` : ""}${
        desktop.cancellable ? "" : " · Finishing; it can no longer be cancelled."
      }`
    : waiting
      ? `Waiting until nothing would be interrupted: ${status?.busy.join(" ") ?? ""}`
      : !database.doctor?.recommended
        ? "The database file is compact; the last run is below."
        : canRun
          ? `About ${formatBytes(database.reclaimableBytes)} could be returned to the disk. Ryco's server stops while the database is compacted (a few minutes for a large one) and starts again; nothing is replaced unless the compacted copy passes its checks.`
          : runner === "none" && status !== null
            ? "Stop this server and run the doctor to compact the database."
            : "Checking whether the database can be compacted here…";
  return (
    <SettingsRow
      title="Compact database"
      description={description}
      status={
        message ?? (lastRun !== null && !running ? `Last run: ${describeRun(lastRun)}` : undefined)
      }
      control={
        running ? (
          <Button
            size="xs"
            variant="outline"
            disabled={!desktop.cancellable}
            onClick={() => void bridge?.cancel()}
          >
            Cancel
          </Button>
        ) : waiting ? (
          <Button size="xs" variant="outline" onClick={() => setWaiting(false)}>
            Stop waiting
          </Button>
        ) : canRun && database.doctor?.recommended ? (
          <Button size="xs" variant="outline" disabled={disabled} onClick={() => void start()}>
            Compact now
          </Button>
        ) : null
      }
    >
      {running && desktop.fraction !== null ? (
        <progress
          className="mt-2 w-full"
          max={1}
          value={desktop.fraction}
          aria-label="Compaction progress"
        />
      ) : null}
      {runner === "none" && status !== null && database.doctor?.command ? (
        <p className="font-mono text-[13px] break-all select-all">{database.doctor.command}</p>
      ) : null}
    </SettingsRow>
  );
}
