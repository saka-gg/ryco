import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";

import {
  shouldIgnoreGlobalNavigationShortcut,
  shouldIgnoreScopedNavigationShortcut,
} from "../../keybindings";
import type { PullRequestsTab } from "./pullRequestsSearch";

/**
 * Page-scoped single-key shortcuts (J/K, [ ], 1–4, V, R, …). One window
 * listener dispatches to handlers that areas register while mounted, so each
 * area owns its keys without a global keybinding entry. Shortcuts never fire
 * while typing, inside dialogs/menus, or with ⌘/Ctrl/Alt held — except where
 * Option/AltGr is simply how the layout types the symbol (German `[` is ⌥5,
 * `\` is ⌥⇧7; on Windows AltGr reports Ctrl+Alt).
 */

export interface PullRequestsShortcut {
  /**
   * `KeyboardEvent.key` lower-cased; letters held with Shift are `shift+j`.
   * Symbols use the produced character: `?`, `/`, `\\`, `[`, `]`.
   */
  readonly key: string;
  /** Only active while this tab is shown. */
  readonly tab?: PullRequestsTab | undefined;
  /** Return `false` to let an earlier-registered handler try. */
  readonly run: (event: KeyboardEvent) => boolean | void;
}

interface ShortcutRegistry {
  register(shortcut: PullRequestsShortcut): () => void;
}

const ShortcutRegistryContext = createContext<ShortcutRegistry | null>(null);

/**
 * Whether a keydown can be a page shortcut as far as modifiers go. ⌘ never
 * is; Ctrl only as half of AltGr; Alt/Option only while it produces a symbol
 * (letters and digits with Option are chords, not the layout's way to type).
 */
export function isPageShortcutKeystroke(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey"> & {
    readonly getModifierState?: ((key: string) => boolean) | undefined;
  },
): boolean {
  if (event.metaKey) return false;
  const producesSymbol = event.key.length === 1 && !/^[\p{L}\p{N}\s]$/u.test(event.key);
  if (event.ctrlKey) {
    const altGraph = event.getModifierState?.("AltGraph") === true;
    // AltGr arrives as Ctrl+Alt (some browsers never set "AltGraph").
    return (altGraph || event.altKey) && producesSymbol;
  }
  if (event.altKey) return producesSymbol;
  return true;
}

export function shortcutToken(event: Pick<KeyboardEvent, "key" | "shiftKey">): string {
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key.toLowerCase();
  return event.shiftKey && /^[a-z]$/u.test(key) ? `shift+${key}` : key;
}

export function PullRequestsShortcutsProvider(props: {
  readonly tab: PullRequestsTab;
  readonly enabled: boolean;
  /**
   * Only keys pressed inside this element count (a reader embedded beside a
   * chat must not take `1`–`4` or `J`/`K` from it). Absent: the whole window.
   */
  readonly scope?: RefObject<HTMLElement | null> | undefined;
  readonly children: ReactNode;
}) {
  const shortcutsRef = useRef<PullRequestsShortcut[]>([]);
  const tabRef = useRef(props.tab);
  useLayoutEffect(() => {
    tabRef.current = props.tab;
  }, [props.tab]);

  const registry = useMemo<ShortcutRegistry>(
    () => ({
      register(shortcut) {
        shortcutsRef.current = [...shortcutsRef.current, shortcut];
        return () => {
          shortcutsRef.current = shortcutsRef.current.filter((entry) => entry !== shortcut);
        };
      },
    }),
    [],
  );

  const scope = props.scope;
  useEffect(() => {
    if (!props.enabled) return;
    // A scoped surface listens on its own root, so keys pressed elsewhere never
    // reach it and a hosting sheet that stops propagation cannot swallow them.
    const scopeElement = scope ? scope.current : null;
    if (scope && !scopeElement) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (!isPageShortcutKeystroke(event)) return;
      if (
        scopeElement
          ? shouldIgnoreScopedNavigationShortcut(event, scopeElement)
          : shouldIgnoreGlobalNavigationShortcut(event)
      ) {
        return;
      }
      const token = shortcutToken(event);
      const candidates = shortcutsRef.current;
      // Most recently mounted handlers (deeper areas) win over page defaults.
      for (let index = candidates.length - 1; index >= 0; index -= 1) {
        const shortcut = candidates[index];
        if (!shortcut || shortcut.key !== token) continue;
        if (shortcut.tab !== undefined && shortcut.tab !== tabRef.current) continue;
        if (shortcut.run(event) === false) continue;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
    };
    const target: HTMLElement | Window = scopeElement ?? window;
    target.addEventListener("keydown", onKeyDown as EventListener);
    return () => target.removeEventListener("keydown", onKeyDown as EventListener);
  }, [props.enabled, scope]);

  return (
    <ShortcutRegistryContext.Provider value={registry}>
      {props.children}
    </ShortcutRegistryContext.Provider>
  );
}

/** Register a page shortcut while the calling component is mounted. */
export function usePullRequestsShortcut(
  key: string,
  run: PullRequestsShortcut["run"],
  options?: { readonly tab?: PullRequestsTab; readonly enabled?: boolean },
): void {
  const registry = useContext(ShortcutRegistryContext);
  const runRef = useRef(run);
  useLayoutEffect(() => {
    runRef.current = run;
  });
  const enabled = options?.enabled ?? true;
  const tab = options?.tab;
  useEffect(() => {
    if (!registry || !enabled) return;
    return registry.register({ key, tab, run: (event) => runRef.current(event) });
  }, [enabled, key, registry, tab]);
}
