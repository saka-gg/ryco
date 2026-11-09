// The host list follows t3code's device sources settings (MIT); see THIRD_PARTY_NOTICES.md.
import {
  DEVICE_SSH_HOST_LIMIT,
  type DeviceHostProbeResult,
  type DeviceHostSummary,
  type DeviceSshHost,
} from "@ryco/contracts";
import { useEffect, useState } from "react";

import { readEnvironmentApi } from "../../environmentApi";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { useServerConfig } from "../../rpc/serverState";
import { useSettingsEditingScope, useSettingsTarget } from "../../settingsTarget";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { SettingsSection } from "./settingsLayout";
import { isNodeSettingsTargetReadOnly } from "./settingsSections.logic";
import {
  EMPTY_DRAFT,
  hostFromDraft,
  toDraft,
  type Draft,
} from "@ryco/client-runtime/state/settings/deviceHosts";

const fieldClass =
  "h-8 w-full rounded-md border border-border bg-background px-2 text-xs disabled:opacity-60";

/**
 * Macs whose simulators this node drives over SSH. Saved in the node's
 * settings and applied without a restart; hosts from RYCO_DEVICE_HOSTS_FILE
 * are listed read-only. Test connection checks SSH access and the Mac's Ryco
 * version, and installs nothing.
 */
export function DeviceHostsSettings() {
  const hosts = useSettings((settings) => settings.deviceHosts);
  const { updateSettings } = useUpdateSettings();
  const serverConfig = useServerConfig();
  const settingsTarget = useSettingsTarget();
  const editingScope = useSettingsEditingScope();
  const config = settingsTarget?.serverConfig ?? serverConfig;
  const supported = config?.environment.capabilities.deviceSetup === true;
  const disabled = !supported || isNodeSettingsTargetReadOnly(editingScope, settingsTarget);
  const environmentId = settingsTarget?.environmentId ?? config?.environment.environmentId ?? null;
  const device = environmentId ? readEnvironmentApi(environmentId)?.device : undefined;
  const [editing, setEditing] = useState<{ readonly index: number | null; draft: Draft } | null>(
    null,
  );
  const [probes, setProbes] = useState<
    Record<string, DeviceHostProbeResult | "testing" | { readonly error: string }>
  >({});
  const [summaries, setSummaries] = useState<readonly DeviceHostSummary[]>([]);

  useEffect(() => {
    if (!supported || !device) return;
    let cancelled = false;
    void device.list({ includeShutdown: false }).then(
      (result) => {
        if (!cancelled) setSummaries(result.hosts ?? []);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [device, supported]);

  const fileHosts = summaries.filter((host) => host.transport === "ssh" && host.source === "file");
  const atLimit = hosts.length + fileHosts.length >= DEVICE_SSH_HOST_LIMIT;

  const probe = (key: string, host: DeviceSshHost) => {
    const probeHost = device?.probeHost;
    if (!probeHost) return;
    setProbes((current) => ({ ...current, [key]: "testing" }));
    void probeHost(host).then(
      (result) => setProbes((current) => ({ ...current, [key]: result })),
      (error: unknown) =>
        setProbes((current) => ({
          ...current,
          [key]: {
            error: error instanceof Error ? error.message : "Test connection failed.",
          },
        })),
    );
  };

  const save = (next: readonly DeviceSshHost[]) => updateSettings({ deviceHosts: [...next] });
  const draftResult = editing ? hostFromDraft(editing.draft) : null;
  const draftHost = typeof draftResult === "string" ? null : draftResult;

  return (
    <SettingsSection
      title="Device hosts over SSH"
      owner="node"
      description="Drive the simulators of other Macs from this node. Each Mac needs the same Ryco version and SSH key access with a trusted host key; nothing is installed on it. Changes apply without a restart."
      headerAction={
        <Button
          size="xs"
          variant="outline"
          disabled={disabled || atLimit || editing !== null}
          onClick={() => setEditing({ index: null, draft: EMPTY_DRAFT })}
        >
          Add host
        </Button>
      }
    >
      <div className="space-y-2 p-4">
        {!supported ? (
          <p className="text-xs text-muted-foreground">
            This node does not support editing device hosts. Update the node to change them.
          </p>
        ) : null}
        {hosts.length === 0 && fileHosts.length === 0 && editing === null ? (
          <p className="text-xs text-muted-foreground">No SSH device hosts.</p>
        ) : null}
        <ul className="space-y-2" aria-label="SSH device hosts">
          {hosts.map((host, index) => {
            const key = `settings:${index}`;
            return (
              <li key={key} className="rounded-md border border-border/70 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{host.name}</p>
                    <p className="truncate font-mono text-[11px] text-muted-foreground">
                      {host.target}
                      {host.port ? `:${host.port}` : ""} → {host.executable}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={!device?.probeHost || probes[key] === "testing"}
                      onClick={() => probe(key, host)}
                    >
                      {probes[key] === "testing" ? "Testing…" : "Test connection"}
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={disabled || editing !== null}
                      onClick={() => setEditing({ index, draft: toDraft(host) })}
                    >
                      Edit
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={disabled}
                      onClick={() => save(hosts.filter((_, other) => other !== index))}
                    >
                      Remove
                    </Button>
                  </div>
                </div>
                <ProbeLine probe={probes[key]} />
              </li>
            );
          })}
          {fileHosts.map((host) => (
            <li key={host.id} className="rounded-md border border-dashed border-border/70 p-3">
              <p className="text-sm font-medium">{host.name}</p>
              <p className="text-[11px] text-muted-foreground">
                From RYCO_DEVICE_HOSTS_FILE: edit that file and restart the node to change it.
              </p>
            </li>
          ))}
        </ul>

        {editing ? (
          <form
            aria-label={editing.index === null ? "Add SSH device host" : "Edit SSH device host"}
            className="space-y-2 rounded-md border border-border p-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (!draftHost) return;
              save(
                editing.index === null
                  ? [...hosts, draftHost]
                  : hosts.map((host, index) => (index === editing.index ? draftHost : host)),
              );
              setEditing(null);
            }}
          >
            <div className="grid grid-cols-2 gap-2">
              <Field
                label="Name"
                value={editing.draft.name}
                placeholder="Simulator Mac"
                onChange={(name) => setEditing({ ...editing, draft: { ...editing.draft, name } })}
              />
              <Field
                label="SSH destination"
                value={editing.draft.target}
                placeholder="me@studio.local or an alias"
                onChange={(target) =>
                  setEditing({ ...editing, draft: { ...editing.draft, target } })
                }
              />
              <Field
                label="Port (optional)"
                value={editing.draft.port}
                placeholder="22"
                onChange={(port) => setEditing({ ...editing, draft: { ...editing.draft, port } })}
              />
              <Field
                label="Key file on this node (optional)"
                value={editing.draft.identityFile}
                placeholder="/Users/me/.ssh/id_ed25519"
                onChange={(identityFile) =>
                  setEditing({ ...editing, draft: { ...editing.draft, identityFile } })
                }
              />
            </div>
            <Field
              label="Ryco on the Mac (absolute path)"
              value={editing.draft.executable}
              placeholder="/opt/homebrew/bin/ryco"
              onChange={(executable) =>
                setEditing({ ...editing, draft: { ...editing.draft, executable } })
              }
            />
            {typeof draftResult === "string" ? (
              <p className="text-[11px] text-muted-foreground">{draftResult}</p>
            ) : null}
            <ProbeLine probe={probes.draft} />
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={!draftHost || !device?.probeHost || probes.draft === "testing"}
                onClick={() => draftHost && probe("draft", draftHost)}
              >
                {probes.draft === "testing" ? "Testing…" : "Test connection"}
              </Button>
              <Button type="button" size="xs" variant="ghost" onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button type="submit" size="xs" disabled={disabled || !draftHost}>
                Save
              </Button>
            </div>
          </form>
        ) : null}
      </div>
    </SettingsSection>
  );
}

function Field(props: {
  readonly label: string;
  readonly value: string;
  readonly placeholder: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <label className="block space-y-1 text-xs">
      <span className="text-muted-foreground">{props.label}</span>
      <input
        className={fieldClass}
        value={props.value}
        placeholder={props.placeholder}
        autoCapitalize="none"
        spellCheck={false}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </label>
  );
}

function ProbeLine(props: {
  readonly probe: DeviceHostProbeResult | "testing" | { readonly error: string } | undefined;
}) {
  const probe = props.probe;
  if (probe === undefined || probe === "testing") return null;
  const ok = "stage" in probe && probe.stage === "ok";
  const text = "error" in probe ? probe.error : probe.message;
  return (
    <p
      role={ok ? "status" : "alert"}
      data-probe-stage={"stage" in probe ? probe.stage : "error"}
      className={cn(
        "mt-2 text-[11px]",
        ok ? "text-emerald-700 dark:text-emerald-300" : "text-amber-700 dark:text-amber-300",
      )}
    >
      {text}
      {"elapsedMs" in probe ? ` (${probe.elapsedMs} ms)` : ""}
    </p>
  );
}
