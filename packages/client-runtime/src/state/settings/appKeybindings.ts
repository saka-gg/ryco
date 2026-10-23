import {
  AppKeybindings,
  KeybindingCommand as KeybindingCommandSchema,
  KeybindingRule as KeybindingRuleSchema,
  MAX_KEYBINDINGS_COUNT,
  type KeybindingCommand,
  type KeybindingRule,
  type ResolvedKeybindingsConfig,
} from "@ryco/contracts/keybindings";
import {
  compileResolvedKeybindingRule,
  compileResolvedKeybindingsConfig,
  mergeWithDefaultKeybindings,
} from "@ryco/shared/keybindings";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { APP_DEFAULT_RESOLVED_KEYBINDINGS } from "./appKeybindingDefaults.ts";

export const DEFAULT_APP_KEYBINDINGS: AppKeybindings = { rules: [], disabledCommands: [] };

export function validateAppKeybindings(input: unknown): AppKeybindings {
  const preferences = Schema.decodeUnknownSync(AppKeybindings)(input);
  if (preferences.rules.some((rule) => !compileResolvedKeybindingRule(rule))) {
    throw new Error("Invalid shortcut or when expression.");
  }
  if (preferences.rules.some((rule) => rule.command.startsWith("script."))) {
    throw new Error("Legacy script shortcuts must be assigned to a project before importing.");
  }
  return preferences;
}

export function resolveAppKeybindings(
  preferences: AppKeybindings = DEFAULT_APP_KEYBINDINGS,
  defaults: ResolvedKeybindingsConfig = APP_DEFAULT_RESOLVED_KEYBINDINGS,
) {
  return mergeWithDefaultKeybindings(
    defaults,
    compileResolvedKeybindingsConfig(preferences.rules),
    preferences.disabledCommands,
  );
}

export interface ScriptShortcutScope {
  readonly environmentId: string;
  readonly projectId: string;
}

export function scopedScriptCommand(
  scope: ScriptShortcutScope,
  scriptId: string,
): KeybindingCommand {
  return Schema.decodeUnknownSync(KeybindingCommandSchema)(
    `projectScript.${encodeURIComponent(scope.environmentId)}/${encodeURIComponent(scope.projectId)}/${scriptId}.run`,
  );
}

export function scopedScriptId(command: string, scope: ScriptShortcutScope): string | null {
  const prefix = `projectScript.${encodeURIComponent(scope.environmentId)}/${encodeURIComponent(scope.projectId)}/`;
  if (!command.startsWith(prefix) || !command.endsWith(".run")) return null;
  return command.slice(prefix.length, -4);
}

/** Filter before shortcut resolution so a foreign project's rule cannot shadow an app command. */
export function keybindingsForProject(
  bindings: ResolvedKeybindingsConfig,
  scope: ScriptShortcutScope | null,
): ResolvedKeybindingsConfig {
  return bindings.flatMap((rule) => {
    if (rule.command.startsWith("script.")) return [];
    if (!rule.command.startsWith("projectScript.")) return [rule];
    const id = scope && scopedScriptId(rule.command, scope);
    return id ? [{ ...rule, command: `script.${id}.run` as KeybindingCommand }] : [];
  });
}

export const APP_KEYBINDINGS_STORAGE_KEY = "ryco:app-keybindings:v1";

type RetainedKeybindingRule = Readonly<Record<string, unknown>> & { readonly command: string };

/**
 * Saved entries this version cannot use: rules for unknown commands or with keys it cannot
 * compile, unknown disabled commands and unknown document fields. They stay inactive here and are
 * written back unchanged, so shortcuts saved by a newer Ryco survive edits made in this one.
 */
interface RetainedAppKeybindings {
  readonly otherFields: Readonly<Record<string, unknown>>;
  readonly rules: readonly RetainedKeybindingRule[];
  readonly disabledCommands: readonly string[];
}

const NO_RETAINED_APP_KEYBINDINGS: RetainedAppKeybindings = {
  otherFields: {},
  rules: [],
  disabledCommands: [],
};

const decodeKeybindingRule = Schema.decodeUnknownOption(KeybindingRuleSchema);
const isKeybindingCommand = Schema.is(KeybindingCommandSchema);

/**
 * Decodes the saved document one entry at a time. Persisted data is otherwise decoded strictly,
 * but this document is shared by every build that runs in the profile or installation: an
 * outdated tab or a downgraded app must keep the shortcuts it knows when a newer one saved more.
 * What it cannot use is retained, except entries without a command, which no version can use.
 * A rule it can use is written back in its decoded form, so a field added to rules later would
 * be lost here and needs its own handling. A document without both lists still fails, and
 * writes stay strict through `validateAppKeybindings`.
 */
function decodePersistedAppKeybindings(input: unknown): {
  readonly preferences: AppKeybindings;
  readonly retained: RetainedAppKeybindings;
} {
  const document: Readonly<Record<string, unknown>> = Predicate.isObject(input) ? input : {};
  const { rules, disabledCommands, ...otherFields } = document;
  if (!Array.isArray(rules) || !Array.isArray(disabledCommands)) {
    throw new Error("Saved keybindings are not a keybindings document.");
  }
  const preferences = {
    rules: [] as KeybindingRule[],
    disabledCommands: [] as KeybindingCommand[],
  };
  const retained = {
    otherFields,
    rules: [] as RetainedKeybindingRule[],
    disabledCommands: [] as string[],
  };
  for (const entry of rules.slice(-MAX_KEYBINDINGS_COUNT)) {
    // An entry without a command is corrupt: no version can use it.
    if (!Predicate.isObject(entry) || typeof entry.command !== "string") continue;
    const rule = Option.getOrUndefined(decodeKeybindingRule(entry));
    if (rule && compileResolvedKeybindingRule(rule) && !rule.command.startsWith("script.")) {
      preferences.rules.push(rule);
    } else {
      retained.rules.push(entry as RetainedKeybindingRule);
    }
  }
  for (const command of new Set(disabledCommands.slice(0, MAX_KEYBINDINGS_COUNT))) {
    if (isKeybindingCommand(command)) preferences.disabledCommands.push(command);
    else if (typeof command === "string") retained.disabledCommands.push(command);
  }
  return { preferences, retained };
}

/**
 * A retained rule goes once its command is edited here, so the latest intent wins. Retained
 * entries make room first when the document is full.
 */
function retainedAfterEdit(
  retained: RetainedAppKeybindings,
  previous: AppKeybindings,
  next: AppKeybindings,
): RetainedAppKeybindings {
  // Compiled, so the editor rewriting an untouched rule's key text is not an edit.
  const commandSettings = (preferences: AppKeybindings, command: string) =>
    JSON.stringify([
      compileResolvedKeybindingsConfig(
        preferences.rules.filter((rule) => rule.command === command),
      ),
      (preferences.disabledCommands as readonly string[]).includes(command),
    ]);
  const rules = retained.rules.filter(
    (rule) => commandSettings(previous, rule.command) === commandSettings(next, rule.command),
  );
  return {
    otherFields: retained.otherFields,
    rules: rules.slice(Math.max(0, rules.length + next.rules.length - MAX_KEYBINDINGS_COUNT)),
    disabledCommands: retained.disabledCommands.slice(
      0,
      Math.max(0, MAX_KEYBINDINGS_COUNT - next.disabledCommands.length),
    ),
  };
}

/** Own rules come last, so they win over retained ones in versions that can use both. */
function serializeAppKeybindings(
  preferences: AppKeybindings,
  retained: RetainedAppKeybindings,
): string {
  return JSON.stringify({
    ...retained.otherFields,
    rules: [...retained.rules, ...preferences.rules],
    disabledCommands: [...preferences.disabledCommands, ...retained.disabledCommands],
  });
}

/** Ordered durable writes publish only after success. Hydration can never replace an edit. */
export function createAppKeybindingsStore(storage: import("../../platform/index.ts").KVService) {
  let preferences = DEFAULT_APP_KEYBINDINGS;
  let retained = NO_RETAINED_APP_KEYBINDINGS;
  // No shortcuts may execute until the installation/profile document has been read.
  let bindings: ResolvedKeybindingsConfig = [];
  let hydrated = false;
  let error: string | null = null;
  let hydration: Promise<void> | null = null;
  let writes: Promise<void> = Promise.resolve();
  const listeners = new Set<() => void>();
  let snapshot: {
    preferences: AppKeybindings;
    bindings: ResolvedKeybindingsConfig;
    hydrated: boolean;
    error: string | null;
  } = { preferences, bindings, hydrated, error };
  const publish = () => {
    snapshot = { preferences, bindings, hydrated, error };
    for (const listener of listeners) listener();
  };
  const hydrate = (): Promise<void> => {
    if (hydrated) return Promise.resolve();
    if (hydration) return hydration;
    hydration = (async () => {
      try {
        const raw = await storage.getItem(APP_KEYBINDINGS_STORAGE_KEY);
        ({ preferences, retained } =
          raw === null
            ? { preferences: DEFAULT_APP_KEYBINDINGS, retained: NO_RETAINED_APP_KEYBINDINGS }
            : decodePersistedAppKeybindings(JSON.parse(raw)));
        bindings = resolveAppKeybindings(preferences);
        hydrated = true;
        error = null;
      } catch (cause) {
        error = cause instanceof Error ? cause.message : "Could not load local keybindings.";
        throw cause;
      } finally {
        hydration = null;
        publish();
      }
    })();
    return hydration;
  };
  const update = (change: (current: AppKeybindings) => AppKeybindings): Promise<void> => {
    const write = writes.then(async () => {
      await hydrate();
      const next = validateAppKeybindings(change(preferences));
      const kept = retainedAfterEdit(retained, preferences, next);
      await storage.setItem(APP_KEYBINDINGS_STORAGE_KEY, serializeAppKeybindings(next, kept));
      preferences = next;
      retained = kept;
      bindings = resolveAppKeybindings(next);
      error = null;
      publish();
    });
    writes = write.catch((cause) => {
      error = cause instanceof Error ? cause.message : "Could not save local keybindings.";
      publish();
    });
    return write;
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      void hydrate().catch(() => undefined);
      return () => {
        listeners.delete(listener);
      };
    },
    hydrate,
    update,
    // Explicit recovery may replace unreadable/corrupt data; ordinary edits never do. It also
    // drops retained entries.
    reset: () => {
      const write = writes.then(async () => {
        await hydration?.catch(() => undefined);
        await storage.setItem(APP_KEYBINDINGS_STORAGE_KEY, JSON.stringify(DEFAULT_APP_KEYBINDINGS));
        preferences = DEFAULT_APP_KEYBINDINGS;
        retained = NO_RETAINED_APP_KEYBINDINGS;
        bindings = resolveAppKeybindings(preferences);
        hydrated = true;
        error = null;
        publish();
      });
      writes = write.catch((cause) => {
        error = cause instanceof Error ? cause.message : "Could not reset local keybindings.";
        publish();
      });
      return write;
    },
    // External platform notifications reload only after this window's queued writes settle.
    reload: () => {
      const read = writes.then(async () => {
        await hydration?.catch(() => undefined);
        hydrated = false;
        bindings = [];
        publish();
        return hydrate();
      });
      writes = read.catch(() => undefined);
      return read;
    },
  };
}

/** Legacy mutation surfaces intentionally fail on old as well as new nodes. */
export const rejectRemoteKeybindingWrite = async (): Promise<never> => {
  throw new Error("Keybindings are app-owned. Open App preferences → Keybindings.");
};
