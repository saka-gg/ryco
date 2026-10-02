// apps/web/src/components/settings/KeybindingsSettings.tsx
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AlertTriangleIcon, PlusIcon, SearchIcon, Undo2Icon, XIcon } from "lucide-react";
import {
  type KeybindingCommand,
  type KeybindingRule,
  type KeybindingShortcut,
  type ResolvedKeybindingsConfig,
} from "@ryco/contracts";
import { DEFAULT_KEYBINDINGS } from "@ryco/shared/keybindings";
import { useShallow } from "zustand/react/shallow";

import { cn, isMacPlatform } from "../../lib/utils";
import {
  KEYBINDING_CATEGORIES,
  getCommandMeta,
  type KeybindingCategory,
} from "../../lib/keybindingCategories";
import {
  WHEN_PRESETS,
  describeWhen,
  presetForWhen,
  serializeWhenAst,
} from "../../lib/keybindingWhenPresets";
import { buildConflictIndex, type ConflictEntry } from "../../lib/keybindingConflicts";
import {
  eventToShortcut,
  formatShortcutTokens,
  serializeShortcut,
} from "../../lib/shortcutCapture";
import { resolveAndPersistPreferredEditor } from "../../editorPreferences";
import { readEnvironmentApi } from "../../environmentApi";
import { ensureLocalApi } from "../../localApi";
import {
  useServerAvailableEditors,
  useServerConfig,
  useServerKeybindingsConfigPath,
} from "../../rpc/serverState";
import { selectProjectsAcrossEnvironments, useStore } from "../../store";
import { useSettingsTarget } from "../../settingsTarget";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  SettingsEmpty,
  SettingsNotice,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";

type DraftRule = KeybindingRule & { __id: string };

const EMPTY_RESOLVED: ResolvedKeybindingsConfig = [];

interface CommandRowData {
  readonly command: KeybindingCommand;
  readonly title: string;
  readonly indicesInDraft: ReadonlyArray<number>;
  readonly status: "default" | "modified" | "custom";
}

interface CategoryGroup {
  readonly category: KeybindingCategory;
  readonly rows: ReadonlyArray<CommandRowData>;
}

const DEFAULT_RULE_KEY_BY_COMMAND = (() => {
  const map = new Map<KeybindingCommand, Set<string>>();
  for (const rule of DEFAULT_KEYBINDINGS) {
    const key = `${rule.key}|${rule.when ?? ""}`;
    const set = map.get(rule.command) ?? new Set();
    set.add(key);
    map.set(rule.command, set);
  }
  return map;
})();

const DEFAULT_COMMANDS = new Set<KeybindingCommand>(
  DEFAULT_KEYBINDINGS.map((r: KeybindingRule) => r.command),
);

function ruleKeyId(rule: KeybindingRule, index: number): string {
  return `${rule.command}|${rule.key}|${rule.when ?? ""}|${index}`;
}

function resolvedToRule(resolved: ResolvedKeybindingsConfig[number]): KeybindingRule {
  return {
    key: serializeShortcut(resolved.shortcut),
    command: resolved.command,
    when: serializeWhenAst(resolved.whenAst),
  };
}

function snapshotToDraft(resolved: ResolvedKeybindingsConfig): DraftRule[] {
  return resolved.map((rule, index) => ({
    ...resolvedToRule(rule),
    __id: ruleKeyId(rule as unknown as KeybindingRule, index),
  }));
}

function stripDraftIds(draft: ReadonlyArray<DraftRule>): KeybindingRule[] {
  return draft.map(({ __id: _id, ...rule }) => rule);
}

function defaultRulesFor(command: KeybindingCommand): KeybindingRule[] {
  return DEFAULT_KEYBINDINGS.filter((rule: KeybindingRule) => rule.command === command).map(
    (r: KeybindingRule) => Object.assign({}, r),
  );
}

function commandStatus(
  command: KeybindingCommand,
  draftRules: KeybindingRule[],
): CommandRowData["status"] {
  if (!DEFAULT_COMMANDS.has(command)) return "custom";
  const defaultKeys = DEFAULT_RULE_KEY_BY_COMMAND.get(command);
  if (!defaultKeys) return "custom";
  if (draftRules.length !== defaultKeys.size) return "modified";
  for (const rule of draftRules) {
    const key = `${rule.key}|${rule.when ?? ""}`;
    if (!defaultKeys.has(key)) return "modified";
  }
  return "default";
}

function matchesSearch(rule: KeybindingRule, title: string, needle: string): boolean {
  if (!needle) return true;
  const haystack = [
    title.toLowerCase(),
    rule.command.toLowerCase(),
    rule.key.toLowerCase(),
    describeWhen(rule.when).toLowerCase(),
  ];
  return haystack.some((value) => value.includes(needle));
}

function genId(): string {
  return Math.random().toString(36).slice(2);
}

interface PanelContextValue {
  readonly platform: string;
  readonly draft: ReadonlyArray<DraftRule>;
  readonly conflictsByCommand: ReadonlyMap<KeybindingCommand, ReadonlyArray<ConflictEntry>>;
  readonly onRebind: (index: number, shortcut: KeybindingShortcut) => void;
  readonly onAddBinding: (command: KeybindingCommand) => void;
  readonly onRemoveBinding: (index: number) => void;
  readonly onChangeWhen: (index: number, when: string | undefined) => void;
  readonly onResetBinding: (index: number) => void;
  readonly onResetCommand: (command: KeybindingCommand) => void;
  readonly scrollToCommand: (command: KeybindingCommand) => void;
  readonly rowRefs: RefObject<Map<KeybindingCommand, HTMLDivElement | null>>;
}

export function KeybindingsSettingsPanel() {
  const settingsTarget = useSettingsTarget();
  const serverConfig = useServerConfig();
  const keybindingsConfigPath = useServerKeybindingsConfigPath();
  const availableEditors = useServerAvailableEditors();
  const platform = typeof navigator !== "undefined" ? navigator.platform : "";
  const isMac = isMacPlatform(platform);
  const [isOpeningKeybindingsFile, setIsOpeningKeybindingsFile] = useState(false);
  const [openKeybindingsFileError, setOpenKeybindingsFileError] = useState<string | null>(null);
  const canOpenKeybindingsFile = !settingsTarget || settingsTarget.primary;
  const keybindingsApi = settingsTarget
    ? readEnvironmentApi(settingsTarget.environmentId)?.keybindings
    : ensureLocalApi().keybindings;

  const openKeybindingsFile = useCallback(() => {
    if (!keybindingsConfigPath) return;
    if (!canOpenKeybindingsFile) {
      setOpenKeybindingsFileError(
        `This file lives on ${settingsTarget?.nodeLabel ?? "the selected node"} and cannot be opened in a local editor.`,
      );
      return;
    }
    setOpenKeybindingsFileError(null);
    setIsOpeningKeybindingsFile(true);

    const editor = resolveAndPersistPreferredEditor(availableEditors ?? []);
    if (!editor) {
      setOpenKeybindingsFileError("No available editors found.");
      setIsOpeningKeybindingsFile(false);
      return;
    }

    void ensureLocalApi()
      .shell.openInEditor(keybindingsConfigPath, editor)
      .catch((error: unknown) => {
        setOpenKeybindingsFileError(
          error instanceof Error ? error.message : "Unable to open keybindings file.",
        );
      })
      .finally(() => {
        setIsOpeningKeybindingsFile(false);
      });
  }, [availableEditors, canOpenKeybindingsFile, keybindingsConfigPath, settingsTarget?.nodeLabel]);

  // Subscribe to the project list with shallow-equal compare (the array
  // identity is unstable across renders but its element references are stable
  // until a project actually changes — exactly what `useShallow` is for).
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const projectScriptCommands = useMemo(() => {
    const commands = new Set<KeybindingCommand>();
    const titles = new Map<KeybindingCommand, string>();
    for (const project of projects) {
      for (const script of project.scripts) {
        const command = `script.${script.id}.run` as KeybindingCommand;
        commands.add(command);
        if (!titles.has(command)) {
          titles.set(command, `Run: ${script.name}`);
        }
      }
    }
    return { commandList: Array.from(commands), titles };
  }, [projects]);

  const resolvedKeybindings = serverConfig?.keybindings ?? EMPTY_RESOLVED;

  const [draft, setDraft] = useState<DraftRule[]>(() => snapshotToDraft(resolvedKeybindings));
  const [serverSnapshotKey, setServerSnapshotKey] = useState(() =>
    JSON.stringify(stripDraftIds(snapshotToDraft(resolvedKeybindings))),
  );
  const draftDirtyRef = useRef(false);

  // Reconcile draft with server snapshot when it changes externally.
  useEffect(() => {
    const nextKey = JSON.stringify(stripDraftIds(snapshotToDraft(resolvedKeybindings)));
    if (nextKey === serverSnapshotKey) return;
    setServerSnapshotKey(nextKey);
    if (!draftDirtyRef.current) {
      setDraft(snapshotToDraft(resolvedKeybindings));
    }
  }, [resolvedKeybindings, serverSnapshotKey]);

  const persistDraft = useCallback(
    async (nextDraft: ReadonlyArray<DraftRule>) => {
      draftDirtyRef.current = true;
      try {
        if (!keybindingsApi) throw new Error("Keybinding settings are unavailable on this node.");
        await keybindingsApi.replaceCustom({
          rules: stripDraftIds(nextDraft),
        });
      } catch (error: unknown) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not save keybindings",
            description: error instanceof Error ? error.message : "An unknown error occurred.",
          }),
        );
        // Revert local draft on persistence failure — server snapshot is the truth.
        setDraft(snapshotToDraft(resolvedKeybindings));
      } finally {
        draftDirtyRef.current = false;
      }
    },
    [keybindingsApi, resolvedKeybindings],
  );

  const handleRebind = useCallback(
    (index: number, shortcut: KeybindingShortcut) => {
      setDraft((current) => {
        const next = current.slice();
        const existing = next[index];
        if (!existing) return current;
        const newKey = serializeShortcut(shortcut);
        if (newKey === existing.key) return current;
        next[index] = { ...existing, key: newKey, __id: existing.__id };
        void persistDraft(next);
        return next;
      });
    },
    [persistDraft],
  );

  const handleAddBinding = useCallback((command: KeybindingCommand) => {
    setDraft((current) => {
      const placeholder: DraftRule = {
        command,
        key: "",
        when: undefined,
        __id: `placeholder-${genId()}`,
      };
      // Insert placeholder right after the command's other bindings.
      const lastIndex = (() => {
        let li = -1;
        current.forEach((rule, i) => {
          if (rule.command === command) li = i;
        });
        return li;
      })();
      if (lastIndex === -1) {
        return [...current, placeholder];
      }
      const next = [
        ...current.slice(0, lastIndex + 1),
        placeholder,
        ...current.slice(lastIndex + 1),
      ];
      return next;
    });
  }, []);

  const handleRemoveBinding = useCallback(
    (index: number) => {
      setDraft((current) => {
        const next = current.slice();
        next.splice(index, 1);
        void persistDraft(next);
        return next;
      });
    },
    [persistDraft],
  );

  const handleChangeWhen = useCallback(
    (index: number, when: string | undefined) => {
      setDraft((current) => {
        const next = current.slice();
        const existing = next[index];
        if (!existing) return current;
        if ((existing.when ?? undefined) === when) return current;
        next[index] = { ...existing, when, __id: existing.__id };
        void persistDraft(next);
        return next;
      });
    },
    [persistDraft],
  );

  const handleResetBinding = useCallback(
    (index: number) => {
      setDraft((current) => {
        const target = current[index];
        if (!target) return current;
        const command = target.command;
        if (!DEFAULT_COMMANDS.has(command)) {
          // Not a default-backed command — fall through to delete.
          const next = current.slice();
          next.splice(index, 1);
          void persistDraft(next);
          return next;
        }
        // Reset the command entirely to its defaults.
        const defaults = defaultRulesFor(command);
        const next = current.filter((rule) => rule.command !== command);
        for (const defaultRule of defaults) {
          next.push({ ...defaultRule, __id: `default-${command}-${genId()}` });
        }
        void persistDraft(next);
        return next;
      });
    },
    [persistDraft],
  );

  const handleResetCommand = useCallback(
    (command: KeybindingCommand) => {
      setDraft((current) => {
        const next = current.filter((rule) => rule.command !== command);
        if (DEFAULT_COMMANDS.has(command)) {
          for (const defaultRule of defaultRulesFor(command)) {
            next.push({
              ...defaultRule,
              __id: `default-${command}-${genId()}`,
            });
          }
        }
        void persistDraft(next);
        return next;
      });
    },
    [persistDraft],
  );

  const handleRestoreAllDefaults = useCallback(async () => {
    setDraft([]);
    try {
      if (!keybindingsApi) throw new Error("Keybinding settings are unavailable on this node.");
      await keybindingsApi.replaceCustom({ rules: [] });
    } catch (error: unknown) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not restore default keybindings",
          description: error instanceof Error ? error.message : "An unknown error occurred.",
        }),
      );
      setDraft(snapshotToDraft(resolvedKeybindings));
    }
  }, [keybindingsApi, resolvedKeybindings]);

  const rowRefs = useRef(new Map<KeybindingCommand, HTMLDivElement | null>());
  const scrollToCommand = useCallback((command: KeybindingCommand) => {
    const node = rowRefs.current.get(command);
    if (!node) return;
    node.scrollIntoView({ behavior: "smooth", block: "center" });
    node.dataset.flash = "true";
    window.setTimeout(() => {
      delete node.dataset.flash;
    }, 1100);
  }, []);

  const [searchInput, setSearchInput] = useState("");
  const deferredSearch = useDeferredValue(searchInput.trim().toLowerCase());

  const conflictsByCommand = useMemo(() => buildConflictIndex(draft), [draft]);

  const groups = useMemo<ReadonlyArray<CategoryGroup>>(() => {
    // Collect all commands referenced by the draft, plus all defaults that
    // are unbound (have no draft rule), plus all known project scripts.
    const draftIndicesByCommand = new Map<KeybindingCommand, number[]>();
    draft.forEach((rule, index) => {
      const existing = draftIndicesByCommand.get(rule.command);
      if (existing) existing.push(index);
      else draftIndicesByCommand.set(rule.command, [index]);
    });

    const commandSet = new Set<KeybindingCommand>([
      ...draftIndicesByCommand.keys(),
      ...DEFAULT_COMMANDS,
      ...projectScriptCommands.commandList,
    ]);

    const rowsByCategory = new Map<string, CommandRowData[]>();
    for (const command of commandSet) {
      const indices = draftIndicesByCommand.get(command) ?? [];
      const rules = indices.map((i) => draft[i]!).filter(Boolean);
      const meta = getCommandMeta(command, projectScriptCommands.titles.get(command));
      const status = commandStatus(command, rules);

      // Search filter — match against any associated rule, or the title/command id.
      const placeholderRule: KeybindingRule = {
        key: "",
        command,
        when: undefined,
      };
      const matches =
        deferredSearch.length === 0 ||
        matchesSearch(placeholderRule, meta.title, deferredSearch) ||
        rules.some((rule) => matchesSearch(rule, meta.title, deferredSearch));
      if (!matches) continue;

      const row: CommandRowData = {
        command,
        title: meta.title,
        indicesInDraft: indices,
        status,
      };
      const categoryRows = rowsByCategory.get(meta.category.id);
      if (categoryRows) categoryRows.push(row);
      else rowsByCategory.set(meta.category.id, [row]);
    }

    const sortedGroups: CategoryGroup[] = [];
    for (const category of Object.values(KEYBINDING_CATEGORIES).toSorted(
      (a, b) => a.sortWeight - b.sortWeight,
    )) {
      const rows = rowsByCategory.get(category.id);
      if (!rows || rows.length === 0) continue;
      rows.sort((a, b) => {
        const aMeta = getCommandMeta(a.command, projectScriptCommands.titles.get(a.command));
        const bMeta = getCommandMeta(b.command, projectScriptCommands.titles.get(b.command));
        return aMeta.sortWeight - bMeta.sortWeight;
      });
      sortedGroups.push({ category, rows });
    }
    return sortedGroups;
  }, [draft, deferredSearch, projectScriptCommands]);

  const totalVisibleRows = groups.reduce((acc, group) => acc + group.rows.length, 0);

  const context: PanelContextValue = useMemo(
    () => ({
      platform,
      draft,
      conflictsByCommand,
      onRebind: handleRebind,
      onAddBinding: handleAddBinding,
      onRemoveBinding: handleRemoveBinding,
      onChangeWhen: handleChangeWhen,
      onResetBinding: handleResetBinding,
      onResetCommand: handleResetCommand,
      scrollToCommand,
      rowRefs,
    }),
    [
      platform,
      draft,
      conflictsByCommand,
      handleRebind,
      handleAddBinding,
      handleRemoveBinding,
      handleChangeWhen,
      handleResetBinding,
      handleResetCommand,
      scrollToCommand,
    ],
  );

  const issues =
    serverConfig?.issues.filter((issue) => issue.kind.startsWith("keybindings.")) ?? [];
  const hasAvailableEditors = (availableEditors ?? []).length > 0;

  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Configuration file"
        headerAction={
          <Button
            variant="ghost"
            size="xs"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => void handleRestoreAllDefaults()}
            disabled={draft.length === 0}
          >
            <Undo2Icon />
            Restore defaults
          </Button>
        }
      >
        <SettingsRow
          title="Keybindings file"
          description="Open the persisted `keybindings.json` file to edit advanced bindings directly."
          status={
            <>
              <span className="block break-all font-mono text-[11px] text-foreground">
                {keybindingsConfigPath ?? "Resolving keybindings path..."}
              </span>
              {openKeybindingsFileError ? (
                <span className="mt-1 block text-destructive">{openKeybindingsFileError}</span>
              ) : (
                <span className="mt-1 block">
                  {!canOpenKeybindingsFile
                    ? `Stored on ${settingsTarget?.nodeLabel ?? "the selected node"}; use an editor on that machine.`
                    : hasAvailableEditors
                      ? "Opens in your preferred editor."
                      : "No available editors found."}
                </span>
              )}
            </>
          }
          control={
            <Button
              size="xs"
              variant="outline"
              disabled={
                !canOpenKeybindingsFile ||
                !keybindingsConfigPath ||
                !hasAvailableEditors ||
                isOpeningKeybindingsFile
              }
              onClick={openKeybindingsFile}
            >
              {isOpeningKeybindingsFile ? "Opening..." : "Open file"}
            </Button>
          }
        />
      </SettingsSection>

      {issues.length > 0 ? (
        <SettingsNotice
          tone="warning"
          title={
            issues.length === 1 ? "A keybinding needs attention" : "Some keybindings need attention"
          }
        >
          {issues.map((issue) => (
            <p key={`${issue.kind}-${issue.message}`}>{issue.message}</p>
          ))}
          {keybindingsConfigPath ? (
            <p className="mt-1">
              Edit{" "}
              <code className="break-all font-mono text-foreground">{keybindingsConfigPath}</code>{" "}
              to resolve.
            </p>
          ) : null}
        </SettingsNotice>
      ) : null}

      <div className="flex flex-col gap-2">
        <InputGroup>
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput
            type="search"
            aria-label="Search keybindings"
            placeholder="Search by command, shortcut, or when…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
        </InputGroup>
        <p className="px-0.5 text-xs text-muted-foreground">
          Click a shortcut and press a new combination to rebind. Esc cancels, Backspace clears.
        </p>
      </div>

      {totalVisibleRows === 0 ? (
        <SettingsEmpty
          icon={<SearchIcon />}
          title="No commands match your search"
          description="Try a command name, a key like ⌘K, or a context such as terminal."
        />
      ) : (
        groups.map((group) => (
          <SettingsSection key={group.category.id} title={group.category.label}>
            {group.rows.map((row) => (
              <CommandRow
                key={row.command}
                row={row}
                context={context}
                isMac={isMac}
                scriptTitle={projectScriptCommands.titles.get(row.command)}
              />
            ))}
          </SettingsSection>
        ))
      )}
    </SettingsPageContainer>
  );
}

interface CommandRowProps {
  readonly row: CommandRowData;
  readonly context: PanelContextValue;
  readonly isMac: boolean;
  readonly scriptTitle: string | undefined;
}

const CommandRow = memo(function CommandRow({
  row,
  context,
  isMac,
  scriptTitle: _scriptTitle,
}: CommandRowProps) {
  const ruleEntries = row.indicesInDraft.map((index) => ({
    index,
    rule: context.draft[index]!,
  }));
  const conflicts = context.conflictsByCommand.get(row.command) ?? [];
  const visibleConflicts = conflicts.slice(0, 3);

  return (
    <div
      data-keybinding-command={row.command}
      ref={(node) => {
        context.rowRefs.current.set(row.command, node);
      }}
      className={cn(
        "group flex flex-col gap-2 border-t border-border/60 px-4 py-3.5 first:border-t-0 transition-colors duration-300 data-[flash=true]:bg-primary/8 sm:px-5",
      )}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[13px] font-medium text-foreground">{row.title}</span>
            <StatusPill status={row.status} />
          </div>
          <code className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground">
            {row.command}
          </code>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 sm:justify-end">
          {ruleEntries.length === 0 ? (
            <ShortcutChip
              key="placeholder"
              draftIndex={-1}
              rule={{ command: row.command, key: "", when: undefined }}
              context={context}
              isMac={isMac}
              isPrimary
              isPlaceholder
              onAddPlaceholder={() => context.onAddBinding(row.command)}
            />
          ) : (
            ruleEntries.map(({ index, rule }, i) => (
              <ShortcutChip
                key={`${index}-${rule.__id}`}
                draftIndex={index}
                rule={rule}
                context={context}
                isMac={isMac}
                isPrimary={i === 0}
                isPlaceholder={rule.key.length === 0}
              />
            ))
          )}
          {ruleEntries.length > 0 ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    onClick={() => context.onAddBinding(row.command)}
                    className="inline-flex size-6 items-center justify-center rounded-md border border-dashed border-border/60 text-muted-foreground/60 transition-colors hover:border-border hover:text-foreground"
                    aria-label={`Add another shortcut for ${row.title}`}
                  >
                    <PlusIcon className="size-3.5" />
                  </button>
                }
              />
              <TooltipPopup side="top">Add another shortcut</TooltipPopup>
            </Tooltip>
          ) : null}
          {row.status !== "default" && DEFAULT_COMMANDS.has(row.command) ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    onClick={() => context.onResetCommand(row.command)}
                    className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground/50 transition-colors hover:text-foreground"
                    aria-label={`Reset ${row.title} to default`}
                  >
                    <Undo2Icon className="size-3.5" />
                  </button>
                }
              />
              <TooltipPopup side="top">Reset to default</TooltipPopup>
            </Tooltip>
          ) : null}
        </div>
      </div>

      {visibleConflicts.length > 0 ? (
        <div className="settings-subsections-enter flex flex-col gap-1 rounded-[min(var(--radius-md),0.5rem)] border border-destructive/28 bg-destructive/6 px-2.5 py-1.5 text-[11px] text-destructive-foreground">
          {visibleConflicts.map((conflict) => (
            <ConflictLine
              key={`${conflict.key}-${conflict.otherCommand}`}
              conflict={conflict}
              isMac={isMac}
              platform={context.platform}
              onSelect={() => context.scrollToCommand(conflict.otherCommand)}
            />
          ))}
          {conflicts.length > visibleConflicts.length ? (
            <span className="opacity-70">+ {conflicts.length - visibleConflicts.length} more</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});

function StatusPill({ status }: { status: CommandRowData["status"] }) {
  if (status === "default") return null;
  return (
    <Badge size="sm" variant={status === "modified" ? "warning" : "info"}>
      {status === "modified" ? "Modified" : "Custom"}
    </Badge>
  );
}

interface ConflictLineProps {
  readonly conflict: ConflictEntry;
  readonly platform: string;
  readonly isMac: boolean;
  readonly onSelect: () => void;
}

function ConflictLine({ conflict, platform, isMac, onSelect }: ConflictLineProps) {
  const meta = getCommandMeta(conflict.otherCommand);
  const parsedKey = parseSerializedShortcut(conflict.key);
  const tokens = parsedKey ? formatShortcutTokens(parsedKey, { platform }) : [conflict.key];

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <AlertTriangleIcon className="size-3 shrink-0 text-destructive" />
      <span className="inline-flex items-center gap-0.5 font-mono">
        {tokens.map((token) => (
          <KeyToken key={token} token={token} isMac={isMac} />
        ))}
      </span>
      <span>also bound to</span>
      <button
        type="button"
        onClick={onSelect}
        className="rounded bg-destructive/20 px-1.5 py-0.5 font-medium text-destructive-foreground hover:bg-destructive/30"
      >
        {meta.title}
      </button>
      {conflict.otherWhen !== undefined ? (
        <span className="opacity-70">
          when <code className="font-mono">{describeWhen(conflict.otherWhen)}</code>
        </span>
      ) : null}
    </div>
  );
}

interface ShortcutChipProps {
  readonly draftIndex: number;
  readonly rule: KeybindingRule;
  readonly context: PanelContextValue;
  readonly isMac: boolean;
  readonly isPrimary: boolean;
  readonly isPlaceholder?: boolean;
  readonly onAddPlaceholder?: () => void;
}

function ShortcutChip({
  draftIndex,
  rule,
  context,
  isMac,
  isPlaceholder,
  onAddPlaceholder,
}: ShortcutChipProps) {
  const [isRecording, setIsRecording] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const chipRef = useRef<HTMLButtonElement | null>(null);

  const parsedShortcut = useMemo<KeybindingShortcut | null>(() => {
    if (rule.key.length === 0) return null;
    return parseSerializedShortcut(rule.key);
  }, [rule.key]);

  const tokens = parsedShortcut
    ? formatShortcutTokens(parsedShortcut, { platform: context.platform })
    : [];

  const startRecording = useCallback(() => {
    if (isPlaceholder && draftIndex === -1 && onAddPlaceholder) {
      onAddPlaceholder();
      // Defer recording start to after the new chip mounts.
      setTimeout(() => {
        // Find the just-added chip and focus it; rely on auto-focus heuristic below.
        const els = document.querySelectorAll<HTMLButtonElement>(
          `[data-chip-pending-record="true"]`,
        );
        els.forEach((el) => {
          el.click();
        });
      }, 50);
      return;
    }
    setIsRecording(true);
  }, [isPlaceholder, draftIndex, onAddPlaceholder]);

  // Window-level keydown capture during recording.
  useEffect(() => {
    if (!isRecording) return;
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();

      if (event.key === "Escape" && !hasModifier(event)) {
        setIsRecording(false);
        return;
      }
      if (event.key === "Tab" && !hasModifier(event)) {
        setIsRecording(false);
        return;
      }
      if (event.key === "Backspace" && !hasModifier(event)) {
        if (draftIndex >= 0) {
          context.onRemoveBinding(draftIndex);
        }
        setIsRecording(false);
        return;
      }
      const shortcut = eventToShortcut(event, { platform: context.platform });
      if (!shortcut) return;
      if (draftIndex >= 0) {
        context.onRebind(draftIndex, shortcut);
      }
      setSavedFlash(true);
      setIsRecording(false);
      setTimeout(() => setSavedFlash(false), 220);
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [isRecording, draftIndex, context]);

  useEffect(() => {
    if (!isRecording) return;
    chipRef.current?.focus();
  }, [isRecording]);

  const onChipKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (isRecording) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      startRecording();
    }
  };

  const handleRemove = () => {
    if (draftIndex >= 0) context.onRemoveBinding(draftIndex);
  };

  if (isPlaceholder && draftIndex === -1 && tokens.length === 0) {
    return (
      <button
        ref={chipRef}
        type="button"
        onClick={() => onAddPlaceholder?.()}
        onKeyDown={onChipKeyDown}
        className="inline-flex h-6 items-center gap-1 rounded-md border border-dashed border-border/60 bg-transparent px-2 text-[11px] text-muted-foreground/70 transition-colors hover:border-border hover:text-foreground"
      >
        <PlusIcon className="size-3" /> No shortcut — click to set
      </button>
    );
  }

  return (
    <span className="relative inline-flex items-center gap-1">
      <button
        ref={chipRef}
        type="button"
        aria-pressed={isRecording}
        aria-label={`Edit shortcut for ${rule.command}`}
        data-chip-pending-record={tokens.length === 0 && draftIndex >= 0 ? "true" : undefined}
        onClick={startRecording}
        onKeyDown={onChipKeyDown}
        className={cn(
          "inline-flex h-6 items-center gap-1 rounded-[min(var(--radius-md),0.4rem)] border px-2 font-mono text-[11px] transition-[background-color,border-color,color] duration-150",
          isRecording
            ? "keybinding-chip-recording border-primary/60 bg-primary/10 text-foreground"
            : savedFlash
              ? "border-success/50 bg-success/12 text-foreground"
              : "border-border bg-muted/60 text-foreground hover:bg-muted",
        )}
      >
        {isRecording ? (
          <span className="text-[11px] tracking-[0.04em]">Press shortcut…</span>
        ) : tokens.length === 0 ? (
          <span className="text-muted-foreground/60">Click to set</span>
        ) : (
          tokens.map((token) => <KeyToken key={token} token={token} isMac={isMac} />)
        )}
        {!isRecording && rule.when !== undefined ? (
          <span className="ml-1 hidden sm:inline">·</span>
        ) : null}
      </button>
      <WhenChip
        currentWhen={rule.when}
        onChange={(next) => context.onChangeWhen(draftIndex, next)}
        disabled={draftIndex < 0 || isRecording}
      />
      {draftIndex >= 0 && !isRecording ? (
        <button
          type="button"
          onClick={handleRemove}
          aria-label="Remove this shortcut"
          className="opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
        >
          <XIcon className="size-3 text-muted-foreground/60 hover:text-destructive" />
        </button>
      ) : null}
    </span>
  );
}

function KeyToken({ token, isMac }: { token: string; isMac: boolean }) {
  const isSymbol = isMac && token.length === 1 && /[⌀-⏿←-⇿]/.test(token);
  return (
    <span
      className={cn("rounded px-1 leading-none", isSymbol ? "bg-transparent" : "bg-foreground/10")}
    >
      {token}
    </span>
  );
}

interface WhenChipProps {
  readonly currentWhen: string | undefined;
  readonly onChange: (next: string | undefined) => void;
  readonly disabled: boolean;
}

function WhenChip({ currentWhen, onChange, disabled }: WhenChipProps) {
  const preset = presetForWhen(currentWhen);
  const description = describeWhen(currentWhen);

  return (
    <Menu>
      <MenuTrigger
        render={
          <button
            type="button"
            disabled={disabled}
            className={cn(
              "inline-flex h-5 items-center gap-1 rounded-[min(var(--radius-sm),0.3rem)] bg-muted/50 px-1.5 text-[10px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50",
              currentWhen === undefined && "italic opacity-70",
            )}
            aria-label={`When: ${description}`}
          >
            {currentWhen === undefined ? "always" : description.toLowerCase()}
          </button>
        }
      />
      <MenuPopup side="bottom" align="end" className="min-w-[220px]">
        {!preset && currentWhen !== undefined ? (
          <div className="px-2 py-1.5 text-[10px] text-muted-foreground">
            Current: <code className="font-mono">{currentWhen}</code>
          </div>
        ) : null}
        {WHEN_PRESETS.map((entry) => (
          <MenuItem
            key={entry.id}
            onClick={() => onChange(entry.value)}
            className={cn(
              "flex items-center justify-between text-[12px]",
              entry.value === currentWhen && "font-semibold text-foreground",
            )}
          >
            <span>{entry.label}</span>
            {entry.value === undefined ? (
              <span className="text-[10px] text-muted-foreground/60">no condition</span>
            ) : (
              <code className="text-[10px] font-mono text-muted-foreground/60">{entry.value}</code>
            )}
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}

function hasModifier(event: KeyboardEvent | ReactKeyboardEvent): boolean {
  return event.metaKey || event.ctrlKey || event.altKey || event.shiftKey;
}

function parseSerializedShortcut(value: string): KeybindingShortcut | null {
  // Tiny parser that mirrors parseKeybindingShortcut for client-side display
  // without pulling in the shared module (the resolved server data is already
  // structured; this is only used when a freshly-saved chip has a raw key).
  const parts = value.toLowerCase().split("+");
  let key: string | null = null;
  let metaKey = false;
  let ctrlKey = false;
  let altKey = false;
  let shiftKey = false;
  let modKey = false;
  for (const part of parts) {
    switch (part) {
      case "cmd":
      case "meta":
        metaKey = true;
        break;
      case "ctrl":
      case "control":
        ctrlKey = true;
        break;
      case "alt":
      case "option":
        altKey = true;
        break;
      case "shift":
        shiftKey = true;
        break;
      case "mod":
        modKey = true;
        break;
      default:
        if (key !== null) return null;
        key = part === "space" ? " " : part;
        break;
    }
  }
  if (key === null) return null;
  return { key, metaKey, ctrlKey, altKey, shiftKey, modKey };
}
