import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from "react";
import type { SessionImportSource } from "@ryco/contracts";
import {
  buildConversationImportView,
  createConversationImportController,
  SESSION_IMPORT_SOURCES,
  sessionImportConversationCount,
  sessionImportStoreLabel,
  type SessionImportClient,
  type SessionImportContinuationProvider,
} from "@ryco/client-runtime/state/sessionImport";
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
  readonly providerOptions: readonly SessionImportContinuationProvider[];
  readonly client: () => SessionImportClient;
}
/** Settings' conversation import: the shared controller's flow (`conversationImport.ts`). */
export function SessionImportPanel({
  nodeLabel,
  allowed,
  projects,
  providerOptions,
  client,
}: SessionImportPanelProps) {
  const [controller] = useState(createConversationImportController);
  useLayoutEffect(() => {
    controller.setInput({ allowed, projects, providerOptions, client });
  }, [controller, allowed, projects, providerOptions, client]);
  useEffect(() => () => controller.dispose(), [controller]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const view = buildConversationImportView(state, { allowed, projects, providerOptions });
  const { busy, activeStore, providers, provider: activeProvider, model: activeModel } = view;
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
              value={state.source}
              disabled={busy}
              onValueChange={controller.setSource}
              options={SESSION_IMPORT_SOURCES}
            />
            <SettingsSelect
              ariaLabel="Import source store"
              value={activeStore?.key ?? ""}
              disabled={busy || !allowed}
              placeholder="Choose a store"
              onValueChange={controller.setStore}
              options={state.stores.map((store) => ({
                value: store.key,
                label: sessionImportStoreLabel(store),
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
            void controller.find();
          }}
        >
          <Input
            aria-label="Search local conversations"
            placeholder={`Search ${nodeLabel} by title or project folder`}
            value={state.search}
            maxLength={200}
            disabled={busy}
            className="min-w-0 flex-1"
            onChange={(event) => controller.setSearch(event.target.value)}
          />
          <div className="flex shrink-0 items-center gap-3">
            <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
              <Checkbox
                checked={state.includeArchived}
                disabled={busy}
                onCheckedChange={(checked) => controller.setIncludeArchived(checked === true)}
              />
              Include archived
            </label>
            <Button type="submit" size="sm" variant="outline" disabled={!view.canFind}>
              <SearchIcon />
              Find conversations
            </Button>
          </div>
        </form>
        {state.notices.length > 0 ? (
          <div role="status" className="mt-3 flex flex-col gap-2">
            {state.notices.map((notice) => (
              <SettingsNotice key={notice}>{notice}</SettingsNotice>
            ))}
          </div>
        ) : null}
      </SettingsBlock>
      {view.items.length > 0 ? (
        <SettingsBlock flush>
          <ul className="max-h-96 divide-y divide-border/60 overflow-y-auto">
            {view.items.map(({ item, status, tone, selected, selectable, recovery, ...row }) => (
              <li key={item.key} className={cn("flex gap-3 py-3", SETTINGS_INSET_CLASS)}>
                <Checkbox
                  className="mt-0.5"
                  aria-label={`Select ${item.title}`}
                  disabled={busy || !selectable}
                  checked={selected}
                  onCheckedChange={(checked) => controller.setSelected(item.key, checked === true)}
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
                        tone === "success"
                          ? "text-success-foreground"
                          : tone === "warning"
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
                        onClick={() => void controller.inspect(item.key)}
                      >
                        Inspect existing copies
                      </Button>
                      {recovery ? (
                        <div
                          aria-label={`Recovery for ${item.title}`}
                          className="flex flex-col items-start gap-1.5 text-xs text-muted-foreground"
                        >
                          <p role="status">{recovery.notice}</p>
                          {recovery.candidates.map((copy) => (
                            <p key={copy.id} className="break-all font-mono text-[11px]">
                              Copy {copy.id} · {copy.messageCount} messages
                            </p>
                          ))}
                          <div className="flex flex-wrap gap-2">
                            {row.canInspectNextPage ? (
                              <Button
                                size="xs"
                                variant="outline"
                                disabled={busy || !allowed}
                                onClick={() => void controller.inspectNextPage(item.key)}
                              >
                                Inspect next page
                              </Button>
                            ) : null}
                            {row.canAdopt ? (
                              <Button
                                size="xs"
                                disabled={busy || !allowed}
                                onClick={() => void controller.adopt(item.key)}
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
            ))}
          </ul>
          {view.hasNextPage ? (
            <div className={cn("border-t border-border/60 py-2.5", SETTINGS_INSET_CLASS)}>
              <Button
                size="xs"
                variant="ghost"
                disabled={busy || !allowed}
                onClick={() => void controller.nextPage()}
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
            value={view.projectId}
            disabled={busy}
            placeholder="Choose a project"
            onValueChange={controller.setProject}
            options={projects.map((entry) => ({ value: entry.id, label: entry.name }))}
          />
        }
      />
      <SettingsRow
        title="Continue with"
        description="The agent and model that take over new turns in imported threads."
        status={view.continuationStatus ?? undefined}
        control={
          <>
            <SettingsSelect
              ariaLabel="Import provider instance"
              width="sm"
              value={activeProvider?.instanceId ?? ""}
              disabled={busy || !providers.length}
              placeholder="No provider"
              onValueChange={controller.setInstance}
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
              onValueChange={controller.setModel}
              options={(activeProvider?.models ?? []).map((choice) => ({
                value: choice.slug,
                label: choice.name,
              }))}
            />
          </>
        }
      />
      <SettingsBlock className="flex items-center justify-end gap-3">
        {view.selectedCount > 0 ? (
          <span className="text-xs text-muted-foreground">
            {sessionImportConversationCount(view.importableCount)} selected
          </span>
        ) : null}
        <Button size="sm" disabled={!view.canRun} onClick={() => void controller.run()}>
          {busy ? "Working…" : "Import selected"}
        </Button>
      </SettingsBlock>
    </div>
  );
}
