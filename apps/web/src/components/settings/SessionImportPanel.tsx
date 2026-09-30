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
import { Button } from "../ui/button";
import { Input } from "../ui/input";

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
  return (
    <section aria-label="Import local conversations" className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Read Codex or Claude history from {nodeLabel}. Originals stay unchanged. New turns use
        separate native session copies. Only supported user and assistant text is displayed.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <label>
          Source{" "}
          <select
            aria-label="Import source"
            value={source}
            disabled={busy}
            onChange={(event) => {
              setSource(event.target.value as SessionImportSource);
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
            }}
          >
            <option value="codex">Codex</option>
            <option value="claudeAgent">Claude Code</option>
          </select>
        </label>
        <label>
          Source store{" "}
          <select
            aria-label="Import source store"
            value={activeStore?.key ?? ""}
            disabled={busy || !allowed}
            onChange={(event) => {
              generation.current++;
              setStoreKey(event.target.value);
              setItems([]);
              setSelected(new Set());
              setRecovery({});
              setNext(null);
              setStatuses({});
            }}
          >
            {!activeStore && <option value="">Choose a configured store</option>}
            {stores.map((store) => (
              <option key={store.key} value={store.key}>
                {store.label}
                {store.instanceIds.length ? "" : " (no enabled continuation instance)"}
              </option>
            ))}
          </select>
        </label>
        <Input
          aria-label="Search local conversations"
          placeholder="Search title or project folder"
          value={search}
          maxLength={200}
          disabled={busy}
          onChange={(event) => setSearch(event.target.value)}
        />
        <label className="flex gap-2 text-sm">
          <input
            type="checkbox"
            checked={archived}
            disabled={busy}
            onChange={(event) => setArchived(event.target.checked)}
          />
          Include archived
        </label>
        <Button
          variant="outline"
          disabled={busy || !allowed || !activeStore}
          onClick={() => void discover()}
        >
          Find conversations
        </Button>
      </div>
      <div role="status" className="text-sm">
        {notices.map((notice) => (
          <p key={notice}>{notice}</p>
        ))}
      </div>
      <div className="max-h-80 overflow-auto divide-y">
        {(allowed ? items : []).map((item) => (
          <div key={item.key} className="flex gap-3 py-3 text-sm">
            <input
              type="checkbox"
              aria-label={`Select ${item.title}`}
              disabled={
                busy ||
                !!item.importedThreadId ||
                item.quarantined ||
                statuses[item.key] === "Imported"
              }
              checked={selected.has(item.key)}
              onChange={(event) =>
                setSelected((previous) => {
                  const updated = new Set(previous);
                  if (event.target.checked) updated.add(item.key);
                  else updated.delete(item.key);
                  return updated;
                })
              }
            />
            <div className="min-w-0">
              <span className="block break-words">
                {item.title}
                {item.archived ? " (archived)" : ""}
              </span>
              <span className="block break-all text-muted-foreground">
                {item.cwd || "Original folder unknown"} · {item.messageCount} messages
              </span>
              <span role="status">
                {item.quarantined
                  ? statuses[item.key] || "Import outcome uncertain — item quarantined"
                  : item.importedThreadId
                    ? "Already imported"
                    : statuses[item.key]}
              </span>
              {item.quarantined && (
                <div className="mt-2 space-y-2">
                  <Button
                    variant="outline"
                    disabled={busy || !allowed}
                    onClick={() => void inspect(item)}
                  >
                    Inspect existing copies
                  </Button>
                  {recovery[item.key] && (
                    <div aria-label={`Recovery for ${item.title}`}>
                      <p role="status">{recovery[item.key]!.notice}</p>
                      {recovery[item.key]!.candidates.map((candidate) => (
                        <p key={candidate.id}>
                          Copy {candidate.id} · {candidate.messageCount} messages
                        </p>
                      ))}
                      {recovery[item.key]!.nextCursor && (
                        <Button
                          variant="outline"
                          disabled={busy || !allowed}
                          onClick={() => void inspect(item, recovery[item.key]!.nextCursor!)}
                        >
                          Inspect next page
                        </Button>
                      )}
                      {recovery[item.key]!.state === "unique" &&
                        recovery[item.key]!.adoptionToken && (
                          <Button
                            disabled={busy || !allowed}
                            onClick={() => void adopt(item, recovery[item.key]!.adoptionToken!)}
                          >
                            Adopt proven copy
                          </Button>
                        )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
      {next !== null && (
        <Button variant="outline" disabled={busy || !allowed} onClick={() => void discover(next)}>
          Search next page
        </Button>
      )}
      <label className="block text-sm">
        Target project (also for moved or missing folders)
        <select
          className="ml-2 max-w-full"
          aria-label="Import target project"
          value={project}
          disabled={busy}
          onChange={(event) => setProject(event.target.value)}
        >
          <option value="">Choose an existing project</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      {!projects.length && (
        <p className="text-sm">Add a project folder in the sidebar, then return here to import.</p>
      )}
      <label className="block text-sm">
        Continue with
        <select
          className="ml-2"
          aria-label="Import provider instance"
          value={activeProvider?.instanceId || ""}
          disabled={busy}
          onChange={(event) => {
            setInstance(event.target.value);
            setModel("");
          }}
        >
          {providers.map((p) => (
            <option key={p.instanceId} value={p.instanceId}>
              {p.displayName || p.driver}
            </option>
          ))}
        </select>
      </label>
      {!providers.length && (
        <p className="text-sm">
          Enable a matching provider instance to import and continue these conversations.
        </p>
      )}
      <label className="block text-sm">
        Model for new turns{" "}
        <select
          aria-label="Continuation model"
          value={activeModel?.slug ?? ""}
          disabled={busy || !activeModel}
          onChange={(event) => setModel(event.target.value)}
        >
          {!activeModel && (
            <option value="">No available models — refresh Providers settings</option>
          )}
          {activeProvider?.models.map((choice) => (
            <option key={choice.slug} value={choice.slug}>
              {choice.name}
            </option>
          ))}
        </select>
      </label>
      <Button
        disabled={
          busy || !allowed || !project || !providers.length || !activeModel || !selected.size
        }
        onClick={() => void run()}
      >
        {busy ? "Working…" : "Import selected / retry failed"}
      </Button>
    </section>
  );
}
