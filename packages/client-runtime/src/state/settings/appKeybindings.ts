import {
  AppKeybindings,
  KeybindingCommand as KeybindingCommandSchema,
  KeybindingsConfig,
  type KeybindingCommand,
  type KeybindingRule,
  type ResolvedKeybindingsConfig,
} from "@ryco/contracts";
import {
  compileResolvedKeybindingRule,
  compileResolvedKeybindingsConfig,
  DEFAULT_KEYBINDINGS,
  mergeWithDefaultKeybindings,
} from "@ryco/shared/keybindings";
import { Schema } from "effect";

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

export function resolveAppKeybindings(preferences: AppKeybindings = DEFAULT_APP_KEYBINDINGS) {
  return mergeWithDefaultKeybindings(
    compileResolvedKeybindingsConfig(preferences.rules),
    preferences.disabledCommands,
  );
}

/** Whole-command comparison retains alternate/contextual overrides while letting defaults evolve. */
function actualOverrides(rules: readonly KeybindingRule[]): readonly KeybindingRule[] {
  const unchanged = new Set(
    rules
      .map((rule) => rule.command)
      .filter((command) => {
        const defaults = DEFAULT_KEYBINDINGS.filter((rule) => rule.command === command);
        if (defaults.length === 0) return false;
        const custom = rules.filter((rule) => rule.command === command);
        return (
          JSON.stringify(compileResolvedKeybindingsConfig(custom)) ===
          JSON.stringify(compileResolvedKeybindingsConfig(defaults))
        );
      }),
  );
  return rules.filter((rule) => !unchanged.has(rule.command));
}

/** Persist a complete editor snapshot, including commands the user deliberately unbound. */
export function appKeybindingsFromRules(rules: readonly KeybindingRule[]): AppKeybindings {
  const decoded = Schema.decodeUnknownSync(KeybindingsConfig)(rules);
  // Compilation drops invalid rules, so reject them before comparing against defaults.
  validateAppKeybindings({ rules: decoded, disabledCommands: [] });
  const commands = new Set(decoded.map((rule) => rule.command));
  return validateAppKeybindings({
    rules: actualOverrides(decoded),
    disabledCommands: [...new Set(DEFAULT_KEYBINDINGS.map((rule) => rule.command))].filter(
      (command) => !commands.has(command),
    ),
  });
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

/** Project-scoped script commands in different projects never participate in the same context. */
export function keybindingCommandScopesOverlap(left: string, right: string): boolean {
  const scope = (command: string) =>
    command.startsWith("projectScript.") ? command.slice(0, command.lastIndexOf("/")) : null;
  const l = scope(left);
  const r = scope(right);
  return l === null || r === null || l === r;
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

/** Explicit import keeps all locally configured/disabled commands, including their contexts. */
export function importAppKeybindings(
  current: AppKeybindings,
  incoming: readonly KeybindingRule[],
): AppKeybindings {
  const imported = validateAppKeybindings({ rules: incoming, disabledCommands: [] });
  const owned = new Set([
    ...current.rules.map((rule) => rule.command),
    ...current.disabledCommands,
  ]);
  return validateAppKeybindings({
    rules: [
      ...actualOverrides(imported.rules).filter((rule) => !owned.has(rule.command)),
      ...current.rules,
    ],
    disabledCommands: current.disabledCommands,
  });
}

export const APP_KEYBINDINGS_STORAGE_KEY = "ryco:app-keybindings:v1";

/** Ordered durable writes publish only after success. Hydration can never replace an edit. */
export function createAppKeybindingsStore(storage: import("../../platform/index.ts").KVService) {
  let preferences = DEFAULT_APP_KEYBINDINGS;
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
        preferences =
          raw === null ? DEFAULT_APP_KEYBINDINGS : validateAppKeybindings(JSON.parse(raw));
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
      await storage.setItem(APP_KEYBINDINGS_STORAGE_KEY, JSON.stringify(next));
      preferences = next;
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
    // Explicit recovery may replace unreadable/corrupt data; ordinary edits never do.
    reset: () => {
      const write = writes.then(async () => {
        await hydration?.catch(() => undefined);
        await storage.setItem(APP_KEYBINDINGS_STORAGE_KEY, JSON.stringify(DEFAULT_APP_KEYBINDINGS));
        preferences = DEFAULT_APP_KEYBINDINGS;
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
