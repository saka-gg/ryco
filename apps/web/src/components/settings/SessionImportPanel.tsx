import { useState, useRef, useEffect, useLayoutEffect } from "react";
import {
  ProjectId,
  ProviderInstanceId,
  type SessionImportCandidate,
  type SessionImportSource,
  type SessionImportStore,
  type SessionImportRecovery,
  type ServerProvider,
} from "@ryco/contracts";
import type { WsRpcClient } from "@ryco/client-runtime/rpc";
import { SearchIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { SETTINGS_INSET_CLASS, SettingsBlock, SettingsNotice, SettingsRow } from "./settingsLayout";
import { SettingsSelect } from "./SettingsSelect";

export interface SessionImportPanelProps {
  readonly nodeLabel: string;
  readonly allowed: boolean;
  readonly projects: readonly { id: string; name: string }[];
  readonly providerOptions: readonly Pick<
    ServerProvider,
    "instanceId" | "driver" | "enabled" | "installed" | "availability" | "displayName" | "models"
  >[];
  readonly client: () => WsRpcClient["sessionImport"];
}
export function SessionImportPanel({
  nodeLabel,
  allowed,
  projects,
  providerOptions,
  client,
}: SessionImportPanelProps) {
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  const [source, setSource] = useState<SessionImportSource>("codex");
  const [stores, setStores] = useState<readonly SessionImportStore[]>([]);
  const [storeKey, setStoreKey] = useState("");
  const [recovery, setRecovery] = useState<Record<string, SessionImportRecovery>>({});
  const current = useRef({ allowed, source, client });
  const [search, setSearch] = useState("");
  const [archived, setArchived] = useState(false);
  const [items, setItems] = useState<readonly SessionImportCandidate[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [project, setProject] = useState("");
  const [instance, setInstance] = useState("");
  const [model, setModel] = useState("");
  const [next, setNext] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [notices, setNotices] = useState<readonly string[]>([]);
  const [statuses, setStatuses] = useState<Record<string, string>>({});
  useLayoutEffect(() => {
    if (current.current.allowed !== allowed || current.current.source !== source)
      generation.current++;
    current.current = { allowed, source, client };
  }, [allowed, source, client]);
  useEffect(() => {
    const attempt = generation.current;
    if (allowed)
      void Promise.resolve()
        .then(() => current.current.client().sources({ source }))
        .then((result) => {
          if (attempt === generation.current) {
            setStores(result);
            setRecovery({});
          }
        })
        .catch((error) => {
          if (attempt === generation.current)
            setNotices([error instanceof Error ? error.message : "Source stores unavailable."]);
        })
        .finally(() => {
          if (attempt === generation.current) setBusy(false);
        });
  }, [source, allowed]);
  const activeStore = storeKey
    ? stores.find((store) => store.key === storeKey)
    : stores.find((store) => store.isDefault);
  const providers = providerOptions.filter(
    (p) =>
      p.driver === source &&
      p.enabled &&
      p.installed &&
      p.availability !== "unavailable" &&
      !!activeStore?.instanceIds.includes(p.instanceId),
  );
  const activeProvider =
    providers.find((provider) => provider.instanceId === instance) ?? providers[0];
  const activeModel =
    activeProvider?.models.find((choice) => choice.slug === model) ??
    activeProvider?.models.find((choice) => choice.isDefault) ??
    activeProvider?.models[0];
  const discover = async (offset = 0) => {
    if (!current.current.allowed) return;
    setBusy(true);
    const attempt = generation.current;
    try {
      const result = await client().discover({
        source,
        ...(activeStore ? { storeKey: activeStore.key } : {}),
        search,
        offset,
        includeArchived: archived,
      });
      if (attempt !== generation.current) return;
      setItems((previous) => (offset ? [...previous, ...result.items] : result.items));
      if (!offset) {
        setRecovery({});
        setSelected(new Set());
        setStatuses({});
      }
      setNext(result.nextOffset);
      setNotices(result.notices);
    } catch (error) {
      if (attempt === generation.current)
        setNotices([error instanceof Error ? error.message : "Discovery failed."]);
    } finally {
      if (attempt === generation.current) setBusy(false);
    }
  };
  const run = async () => {
    if (!current.current.allowed) return;
    setBusy(true);
    const attempt = generation.current;
    const destination = ProjectId.make(project);
    const instanceId = ProviderInstanceId.make(activeProvider!.instanceId);
    for (const item of items.filter(
      (item) =>
        selected.has(item.key) &&
        !item.importedThreadId &&
        !item.quarantined &&
        statuses[item.key] !== "Imported",
    )) {
      if (attempt !== generation.current) break;
      setStatuses((previous) => ({ ...previous, [item.key]: "Importing…" }));
      try {
        await client().run({
          source: item.source,
          key: item.key,
          ...(activeStore ? { storeKey: activeStore.key } : {}),
          projectId: destination,
          modelSelection: { instanceId, model: activeModel!.slug },
        });
        if (attempt !== generation.current) break;
        setStatuses((previous) => ({ ...previous, [item.key]: "Imported" }));
      } catch (error) {
        if (attempt !== generation.current) break;
        setStatuses((previous) => ({
          ...previous,
          [item.key]: error instanceof Error ? error.message : "Import failed. Retry this item.",
        }));
      }
    }
    if (attempt === generation.current) setBusy(false);
  };
  const inspect = async (item: SessionImportCandidate, cursor?: string) => {
    if (!current.current.allowed) return;
    setBusy(true);
    const attempt = generation.current;
    try {
      const result = await client().reconcile({
        source: item.source,
        key: item.key,
        ...(cursor ? { cursor } : {}),
      });
      if (attempt === generation.current)
        setRecovery((previous) => ({ ...previous, [item.key]: result }));
    } catch (error) {
      if (attempt === generation.current) {
        setRecovery((previous) => {
          const updated = { ...previous };
          delete updated[item.key];
          return updated;
        });
        setStatuses((previous) => ({
          ...previous,
          [item.key]:
            error instanceof Error ? error.message : "Inspection failed. Import remains paused.",
        }));
      }
    } finally {
      if (attempt === generation.current) setBusy(false);
    }
  };
  const adopt = async (item: SessionImportCandidate, adoptionToken: string) => {
    if (!current.current.allowed) return;
    setBusy(true);
    const attempt = generation.current;
    try {
      const result = await client().adopt({ source: item.source, key: item.key, adoptionToken });
      if (attempt === generation.current) {
        setItems((previous) =>
          previous.map((entry) =>
            entry.key === item.key
              ? { ...entry, quarantined: false, importedThreadId: result.threadId }
              : entry,
          ),
        );
        setRecovery((previous) => {
          const updated = { ...previous };
          delete updated[item.key];
          return updated;
        });
        setStatuses((previous) => ({ ...previous, [item.key]: "Imported" }));
      }
    } catch (error) {
      if (attempt === generation.current) {
        setRecovery((previous) => {
          const updated = { ...previous };
          delete updated[item.key];
          return updated;
        });
        setStatuses((previous) => ({
          ...previous,
          [item.key]:
            error instanceof Error
              ? error.message
              : "Adoption failed. Refresh and retry the saved import.",
        }));
      }
    } finally {
      if (attempt === generation.current) setBusy(false);
    }
  };
  const changeSource = (value: SessionImportSource) => {
    setSource(value);
    generation.current++;
    setStores([]);
    setRecovery({});
    setStoreKey("");
    setItems([]);
    setNext(null);
    setInstance("");
    setModel("");
    setSelected(new Set());
    setStatuses({});
  };
  const changeStore = (value: string) => {
    generation.current++;
    setStoreKey(value);
    setItems([]);
    setSelected(new Set());
    setRecovery({});
    setNext(null);
    setStatuses({});
  };
  const visibleItems = allowed ? items : [];
  const importable = visibleItems.filter(
    (item) =>
      selected.has(item.key) &&
      !item.importedThreadId &&
      !item.quarantined &&
      statuses[item.key] !== "Imported",
  ).length;
  return (
    <div aria-label="Import local conversations" role="group">
      <SettingsRow
        title="Source"
        description="Which agent's history to read. Originals stay unchanged."
        control={
          <>
            <SettingsSelect<SessionImportSource>
              ariaLabel="Import source"
              width="sm"
              value={source}
              disabled={busy}
              onValueChange={changeSource}
              options={[
                { value: "codex", label: "Codex" },
                { value: "claudeAgent", label: "Claude Code" },
              ]}
            />
            <SettingsSelect
              ariaLabel="Import source store"
              value={activeStore?.key ?? ""}
              disabled={busy || !allowed}
              placeholder="Choose a store"
              onValueChange={changeStore}
              options={stores.map((store) => ({
                value: store.key,
                label: store.instanceIds.length
                  ? store.label
                  : `${store.label} (no enabled continuation instance)`,
                triggerLabel: store.label,
              }))}
            />
          </>
        }
      />
      <SettingsBlock>
        <form
          className="flex flex-col gap-3 sm:flex-row sm:items-center"
          onSubmit={(event) => {
            event.preventDefault();
            if (!busy && allowed && activeStore) void discover();
          }}
        >
          <Input
            aria-label="Search local conversations"
            placeholder={`Search ${nodeLabel} by title or project folder`}
            value={search}
            maxLength={200}
            disabled={busy}
            className="min-w-0 flex-1"
            onChange={(event) => setSearch(event.target.value)}
          />
          <div className="flex shrink-0 items-center gap-3">
            <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
              <Checkbox
                checked={archived}
                disabled={busy}
                onCheckedChange={(checked) => setArchived(checked === true)}
              />
              Include archived
            </label>
            <Button
              type="submit"
              size="sm"
              variant="outline"
              disabled={busy || !allowed || !activeStore}
            >
              <SearchIcon />
              Find conversations
            </Button>
          </div>
        </form>
        {notices.length > 0 ? (
          <div role="status" className="mt-3 flex flex-col gap-2">
            {notices.map((notice) => (
              <SettingsNotice key={notice}>{notice}</SettingsNotice>
            ))}
          </div>
        ) : null}
      </SettingsBlock>
      {visibleItems.length > 0 ? (
        <SettingsBlock flush>
          <ul className="max-h-96 divide-y divide-border/60 overflow-y-auto">
            {visibleItems.map((item) => {
              const status = item.quarantined
                ? statuses[item.key] || "Import outcome uncertain — item quarantined"
                : item.importedThreadId
                  ? "Already imported"
                  : statuses[item.key];
              const itemRecovery = recovery[item.key];
              return (
                <li key={item.key} className={cn("flex gap-3 py-3", SETTINGS_INSET_CLASS)}>
                  <Checkbox
                    className="mt-0.5"
                    aria-label={`Select ${item.title}`}
                    disabled={
                      busy ||
                      !!item.importedThreadId ||
                      item.quarantined ||
                      statuses[item.key] === "Imported"
                    }
                    checked={selected.has(item.key)}
                    onCheckedChange={(checked) =>
                      setSelected((previous) => {
                        const updated = new Set(previous);
                        if (checked === true) updated.add(item.key);
                        else updated.delete(item.key);
                        return updated;
                      })
                    }
                  />
                  <div className="min-w-0 flex-1">
                    <p className="flex min-w-0 items-center gap-2 text-[13px] font-medium text-foreground">
                      <span className="min-w-0 break-words">{item.title}</span>
                      {item.archived ? (
                        <Badge variant="outline" size="sm">
                          Archived
                        </Badge>
                      ) : null}
                    </p>
                    <p className="mt-0.5 break-all text-xs text-muted-foreground">
                      {item.cwd || "Original folder unknown"} · {item.messageCount} messages
                    </p>
                    {status ? (
                      <p
                        role="status"
                        className={cn(
                          "mt-1 text-xs",
                          status === "Imported" || status === "Already imported"
                            ? "text-success-foreground"
                            : item.quarantined
                              ? "text-warning-foreground"
                              : "text-muted-foreground",
                        )}
                      >
                        {status}
                      </p>
                    ) : null}
                    {item.quarantined ? (
                      <div className="mt-2 flex flex-col items-start gap-2">
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={busy || !allowed}
                          onClick={() => void inspect(item)}
                        >
                          Inspect existing copies
                        </Button>
                        {itemRecovery ? (
                          <div
                            aria-label={`Recovery for ${item.title}`}
                            className="flex flex-col items-start gap-1.5 text-xs text-muted-foreground"
                          >
                            <p role="status">{itemRecovery.notice}</p>
                            {itemRecovery.candidates.map((candidate) => (
                              <p key={candidate.id} className="break-all font-mono text-[11px]">
                                Copy {candidate.id} · {candidate.messageCount} messages
                              </p>
                            ))}
                            <div className="flex flex-wrap gap-2">
                              {itemRecovery.nextCursor ? (
                                <Button
                                  size="xs"
                                  variant="outline"
                                  disabled={busy || !allowed}
                                  onClick={() => void inspect(item, itemRecovery.nextCursor!)}
                                >
                                  Inspect next page
                                </Button>
                              ) : null}
                              {itemRecovery.state === "unique" && itemRecovery.adoptionToken ? (
                                <Button
                                  size="xs"
                                  disabled={busy || !allowed}
                                  onClick={() => void adopt(item, itemRecovery.adoptionToken!)}
                                >
                                  Adopt proven copy
                                </Button>
                              ) : null}
                            </div>
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
          {next !== null ? (
            <div className={cn("border-t border-border/60 py-2.5", SETTINGS_INSET_CLASS)}>
              <Button
                size="xs"
                variant="ghost"
                disabled={busy || !allowed}
                onClick={() => void discover(next)}
              >
                Search next page
              </Button>
            </div>
          ) : null}
        </SettingsBlock>
      ) : null}
      <SettingsRow
        title="Add to project"
        description="Imported threads join this project, including ones whose original folder moved."
        status={
          !projects.length
            ? "Add a project folder in the sidebar, then return here to import."
            : undefined
        }
        control={
          <SettingsSelect
            ariaLabel="Import target project"
            value={project}
            disabled={busy}
            placeholder="Choose a project"
            onValueChange={setProject}
            options={projects.map((entry) => ({ value: entry.id, label: entry.name }))}
          />
        }
      />
      <SettingsRow
        title="Continue with"
        description="The agent and model that take over new turns in imported threads."
        status={
          !providers.length
            ? "Enable a matching provider instance to import and continue these conversations."
            : !activeModel
              ? "No available models — refresh Providers settings."
              : undefined
        }
        control={
          <>
            <SettingsSelect
              ariaLabel="Import provider instance"
              width="sm"
              value={activeProvider?.instanceId ?? ""}
              disabled={busy || !providers.length}
              placeholder="No provider"
              onValueChange={(value) => {
                setInstance(value);
                setModel("");
              }}
              options={providers.map((entry) => ({
                value: entry.instanceId,
                label: entry.displayName || entry.driver,
              }))}
            />
            <SettingsSelect
              ariaLabel="Continuation model"
              value={activeModel?.slug ?? ""}
              disabled={busy || !activeModel}
              placeholder="No model"
              onValueChange={setModel}
              options={(activeProvider?.models ?? []).map((choice) => ({
                value: choice.slug,
                label: choice.name,
              }))}
            />
          </>
        }
      />
      <SettingsBlock className="flex items-center justify-end gap-3">
        {selected.size > 0 ? (
          <span className="text-xs text-muted-foreground">
            {importable === 1 ? "1 conversation" : `${importable} conversations`} selected
          </span>
        ) : null}
        <Button
          size="sm"
          disabled={
            busy || !allowed || !project || !providers.length || !activeModel || !selected.size
          }
          onClick={() => void run()}
        >
          {busy ? "Working…" : "Import selected"}
        </Button>
      </SettingsBlock>
    </div>
  );
}
