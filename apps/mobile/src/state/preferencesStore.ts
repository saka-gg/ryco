import { Schema } from "effect";
import { ModelFavorite } from "@ryco/contracts/settings";
import { uniqueModelFavorites } from "@ryco/client-runtime/state/composer";
import { useSyncExternalStore } from "react";
import { AI_FOCUS_REFRESH_INTERVAL_OPTIONS } from "@ryco/shared/aiFocusSettings";
import {
  SIDEBAR_AUTO_SETTLE_DAY_OPTIONS,
  type AiFocusRefreshIntervalMs,
  type SidebarAutoSettleAfterDays,
} from "@ryco/contracts/settings";

import { mobileKV } from "../platform/kv";

// Device-local preferences store (§3-2). Replaces upstream's Effect/atom
// `state/preferences` + `persistence/mobile-preferences` (Semaphore/MobileDatabase)
// with a plain external store persisted through the injected `mobileKV`
// (expo-sqlite). Last-write-wins (no optimistic-version reconciliation — MVP
// faithful for a single device). The `Preferences` shape and `sanitizePreferences`
// are ported verbatim from the upstream reference (device-local; a superset of
// `@ryco/contracts/settings::ClientSettings`).

const PREFERENCES_KEY = "ryco.preferences";

export interface Preferences {
  readonly favorites?: ReadonlyArray<ModelFavorite>;
  readonly liveActivitiesEnabled?: boolean;
  readonly baseFontSize?: number;
  readonly terminalFontSize?: number | null;
  readonly markdownFontSize?: number;
  readonly codeFontSize?: number | null;
  readonly codeWordBreak?: boolean;
  readonly connectOnboardingOptOutAccounts?: ReadonlyArray<string>;
  readonly collapsedProjectGroups?: readonly string[];
  readonly projectGroupingEnabled?: boolean;
  readonly threadListV2Enabled?: boolean;
  readonly aiFocusEnabled?: boolean;
  readonly aiFocusRefreshIntervalMs?: AiFocusRefreshIntervalMs;
  readonly sidebarAutoSettleAfterDays?: SidebarAutoSettleAfterDays;
}

export function sanitizePreferences(parsed: Preferences): Preferences {
  const preferences: {
    favorites?: ReadonlyArray<ModelFavorite>;
    liveActivitiesEnabled?: boolean;
    baseFontSize?: number;
    terminalFontSize?: number | null;
    markdownFontSize?: number;
    codeFontSize?: number | null;
    codeWordBreak?: boolean;
    connectOnboardingOptOutAccounts?: ReadonlyArray<string>;
    collapsedProjectGroups?: readonly string[];
    projectGroupingEnabled?: boolean;
    threadListV2Enabled?: boolean;
    aiFocusEnabled?: boolean;
    aiFocusRefreshIntervalMs?: AiFocusRefreshIntervalMs;
    sidebarAutoSettleAfterDays?: SidebarAutoSettleAfterDays;
  } = {};

  if (typeof parsed.liveActivitiesEnabled === "boolean") {
    preferences.liveActivitiesEnabled = parsed.liveActivitiesEnabled;
  }
  if (typeof parsed.baseFontSize === "number") preferences.baseFontSize = parsed.baseFontSize;
  if (typeof parsed.terminalFontSize === "number" || parsed.terminalFontSize === null) {
    preferences.terminalFontSize = parsed.terminalFontSize;
  }
  if (typeof parsed.markdownFontSize === "number") {
    preferences.markdownFontSize = parsed.markdownFontSize;
  }
  if (typeof parsed.codeFontSize === "number" || parsed.codeFontSize === null) {
    preferences.codeFontSize = parsed.codeFontSize;
  }
  if (typeof parsed.codeWordBreak === "boolean") preferences.codeWordBreak = parsed.codeWordBreak;
  if (Array.isArray(parsed.connectOnboardingOptOutAccounts)) {
    preferences.connectOnboardingOptOutAccounts = parsed.connectOnboardingOptOutAccounts.filter(
      (account): account is string => typeof account === "string",
    );
  }
  if (Array.isArray(parsed.collapsedProjectGroups)) {
    preferences.collapsedProjectGroups = parsed.collapsedProjectGroups.filter(
      (key): key is string => typeof key === "string",
    );
  }
  if (typeof parsed.projectGroupingEnabled === "boolean") {
    preferences.projectGroupingEnabled = parsed.projectGroupingEnabled;
  }
  if (typeof parsed.threadListV2Enabled === "boolean") {
    preferences.threadListV2Enabled = parsed.threadListV2Enabled;
  }
  if (typeof parsed.aiFocusEnabled === "boolean") {
    preferences.aiFocusEnabled = parsed.aiFocusEnabled;
  }
  if (
    typeof parsed.aiFocusRefreshIntervalMs === "number" &&
    AI_FOCUS_REFRESH_INTERVAL_OPTIONS.some(
      (option) => option.value === parsed.aiFocusRefreshIntervalMs,
    )
  ) {
    preferences.aiFocusRefreshIntervalMs =
      parsed.aiFocusRefreshIntervalMs as AiFocusRefreshIntervalMs;
  }
  if (
    parsed.sidebarAutoSettleAfterDays === null ||
    (typeof parsed.sidebarAutoSettleAfterDays === "number" &&
      SIDEBAR_AUTO_SETTLE_DAY_OPTIONS.includes(
        parsed.sidebarAutoSettleAfterDays as Exclude<SidebarAutoSettleAfterDays, null>,
      ))
  ) {
    preferences.sidebarAutoSettleAfterDays = parsed.sidebarAutoSettleAfterDays;
  }
  if (Array.isArray(parsed.favorites)) {
    const decode = Schema.decodeUnknownOption(ModelFavorite);
    preferences.favorites = uniqueModelFavorites(
      parsed.favorites.flatMap((favorite) => {
        const result = decode(favorite);
        return result._tag === "Some" ? [result.value] : [];
      }),
    );
  }
  return preferences;
}

function parsePayload(raw: string | null): Preferences | null {
  if (raw === null || !raw.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Preferences)
    : null;
}

type Listener = () => void;

interface PreferencesStoreState {
  readonly preferences: Preferences;
  readonly hydrated: boolean;
}

const EMPTY_PREFERENCES: Preferences = {};

let state: PreferencesStoreState = { preferences: EMPTY_PREFERENCES, hydrated: false };
const listeners = new Set<Listener>();
let hydrationStarted = false;

function emit(): void {
  for (const listener of listeners) listener();
}

function setState(next: PreferencesStoreState): void {
  state = next;
  emit();
}

/** Idempotently async-load the persisted blob once, then mark hydrated. */
export function hydratePreferences(): void {
  if (hydrationStarted) return;
  hydrationStarted = true;
  void (async () => {
    try {
      const raw = await mobileKV.getItem(PREFERENCES_KEY);
      const parsed = parsePayload(raw);
      setState({
        preferences: parsed ? sanitizePreferences(parsed) : EMPTY_PREFERENCES,
        hydrated: true,
      });
    } catch {
      // Degrade to defaults on any read failure (MVP last-write-wins).
      setState({ preferences: EMPTY_PREFERENCES, hydrated: true });
    }
  })();
}

/** Shallow-merge a patch and fire-and-forget the persisted write. */
export function updatePreferences(patch: Partial<Preferences>): void {
  const next = sanitizePreferences({ ...state.preferences, ...patch });
  setState({ preferences: next, hydrated: true });
  void mobileKV.setItem(PREFERENCES_KEY, JSON.stringify(next)).catch(() => {
    // Fire-and-forget: a failed write leaves the in-memory value authoritative
    // until the next successful write (last-write-wins).
  });
}

export function getPreferencesSnapshot(): Preferences {
  return state.preferences;
}

export function isPreferencesHydrated(): boolean {
  return state.hydrated;
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function usePreferences(): Preferences {
  return useSyncExternalStore(subscribe, getPreferencesSnapshot, getPreferencesSnapshot);
}

export function useIsPreferencesHydrated(): boolean {
  return useSyncExternalStore(subscribe, isPreferencesHydrated, isPreferencesHydrated);
}

/** Test seam: reset the singleton store and hydration latch. */
export function resetPreferencesStoreForTests(): void {
  state = { preferences: EMPTY_PREFERENCES, hydrated: false };
  hydrationStarted = false;
  listeners.clear();
}
