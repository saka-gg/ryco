import type { PersistStorage, StorageValue } from "zustand/middleware";

import {
  COMPOSER_DRAFT_ENTRY_STORAGE_KEY_PREFIX,
  COMPOSER_DRAFT_INDEX_STORAGE_KEY,
  compactModelSelectionByProvider,
  composerDraftEntryStorageKey,
  type PersistedComposerDraftStoreState,
  type PersistedComposerThreadDraftState,
  partializeComposerThreadDraftState,
} from "./draftPersistence.ts";
import type {
  ComposerDraftImage,
  ComposerDraftStoreState,
  ComposerThreadDraftState,
} from "./draftStore.ts";

/** Plain key-value storage injected by the platform (web binds localStorage). */
export interface ComposerDraftStorage {
  readonly getItem: (name: string) => string | null | Promise<string | null>;
  readonly setItem: (name: string, value: string) => unknown;
  readonly removeItem: (name: string) => unknown;
  /**
   * Runs `flush` later: the platform debounces it and runs it before the page
   * goes away. Without it every update flushes at once, which still writes only
   * the draft it changed.
   */
  readonly scheduleWrite?: ((flush: () => void) => void) | undefined;
  /** Every key the storage holds, so entries no index lists can be removed. */
  readonly keys?: (() => Iterable<string>) | undefined;
  /**
   * Attachments whose bytes the platform keeps outside this storage (`bytes:
   * "local"`) that no persisted draft references any more.
   */
  readonly releaseAttachments?: ((attachmentIds: ReadonlyArray<string>) => void) | undefined;
  /** A write the storage refused (a full quota); the draft is written again on its next change. */
  readonly onWriteError?: ((key: string, error: unknown) => void) | undefined;
}

/** What the persist middleware hands the storage on every update: references, nothing serialized. */
export type ComposerDraftPersistSnapshot<TImage extends ComposerDraftImage> = Pick<
  ComposerDraftStoreState<TImage>,
  | "draftsByThreadKey"
  | "draftThreadsByThreadKey"
  | "logicalProjectDraftThreadKeyByLogicalProjectKey"
  | "stickyModelSelectionByProvider"
  | "stickyActiveProvider"
>;

export function snapshotComposerDraftPersistState<TImage extends ComposerDraftImage>(
  state: ComposerDraftStoreState<TImage>,
): ComposerDraftPersistSnapshot<TImage> {
  return {
    draftsByThreadKey: state.draftsByThreadKey,
    draftThreadsByThreadKey: state.draftThreadsByThreadKey,
    logicalProjectDraftThreadKeyByLogicalProjectKey:
      state.logicalProjectDraftThreadKeyByLogicalProjectKey,
    stickyModelSelectionByProvider: state.stickyModelSelectionByProvider,
    stickyActiveProvider: state.stickyActiveProvider,
  };
}

interface PersistedComposerDraftIndex {
  readonly version: number;
  readonly state: Omit<PersistedComposerDraftStoreState, "draftsByThreadKey"> & {
    readonly draftKeys: ReadonlyArray<string>;
  };
}

/** A draft entry as last read or written: what the next flush compares against. */
interface WrittenDraft {
  /** The in-memory draft it was written from; null when it was only read. */
  draft: object | null;
  json: string;
  attachmentIds: ReadonlyArray<string>;
}

type MaybePromise<T> = T | Promise<T>;

const isPromise = (value: unknown): value is Promise<unknown> =>
  typeof (value as { then?: unknown } | null)?.then === "function";

function andThen<A, B>(
  value: MaybePromise<A>,
  next: (value: A) => MaybePromise<B>,
): MaybePromise<B> {
  return isPromise(value) ? value.then(next) : next(value);
}

function allOf<A>(values: ReadonlyArray<MaybePromise<A>>): MaybePromise<ReadonlyArray<A>> {
  return values.some(isPromise) ? Promise.all(values) : (values as ReadonlyArray<A>);
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function attachmentIdsOf(draft: unknown): ReadonlyArray<string> {
  const attachments = (draft as { attachments?: unknown } | null)?.attachments;
  if (!Array.isArray(attachments)) return [];
  return attachments.flatMap((attachment) =>
    typeof (attachment as { id?: unknown } | null)?.id === "string"
      ? [(attachment as { id: string }).id]
      : [],
  );
}

function isIndex(value: unknown): value is PersistedComposerDraftIndex {
  const state = (value as { state?: { draftKeys?: unknown } } | null)?.state;
  return (
    typeof (value as { version?: unknown } | null)?.version === "number" &&
    Array.isArray(state?.draftKeys)
  );
}

/**
 * The composer draft store's persist storage. The single blob every draft
 * shared made each change re-serialize every draft (image data included) and
 * rewrite all of it; here the index and each draft live in their own entry, a
 * flush serializes only the drafts whose objects changed since they were last
 * written, and writes only those whose text changed.
 *
 * Reading assembles the same `{ version, state }` the middleware always read,
 * so migrations and merging are unchanged. A storage that only has the old
 * single entry is read from it; the first flush writes the split layout and
 * then removes the old entry, so nothing is lost if the page closes between.
 */
export function createSplitComposerDraftPersistStorage<TImage extends ComposerDraftImage>(
  storage: ComposerDraftStorage,
  legacyName: string,
): PersistStorage<ComposerDraftPersistSnapshot<TImage>> & { readonly flush: () => void } {
  const written = new Map<string, WrittenDraft>();
  const attachmentRefs = new Map<string, number>();
  let writtenIndexJson: string | null = null;
  let writtenIndexRefs: ReadonlyArray<unknown> | null = null;
  let legacyEntryPresent = false;
  let unindexedKeys: ReadonlyArray<string> = [];
  let pending: StorageValue<ComposerDraftPersistSnapshot<TImage>> | null = null;

  const retain = (ids: ReadonlyArray<string>) => {
    for (const id of ids) attachmentRefs.set(id, (attachmentRefs.get(id) ?? 0) + 1);
  };
  const release = (ids: ReadonlyArray<string>, candidates: Set<string>) => {
    for (const id of ids) {
      const count = (attachmentRefs.get(id) ?? 0) - 1;
      if (count > 0) attachmentRefs.set(id, count);
      else {
        attachmentRefs.delete(id);
        candidates.add(id);
      }
    }
  };
  const tryWrite = (key: string, write: () => unknown): boolean => {
    try {
      write();
      return true;
    } catch (error) {
      storage.onWriteError?.(key, error);
      return false;
    }
  };

  const readLegacy = (): MaybePromise<StorageValue<unknown> | null> =>
    andThen(storage.getItem(legacyName), (raw) => {
      if (raw === null) return null;
      legacyEntryPresent = true;
      const parsed = parseJson(raw);
      return parsed && typeof parsed === "object" ? (parsed as StorageValue<unknown>) : null;
    });

  const getItem = (): MaybePromise<StorageValue<unknown> | null> =>
    andThen(storage.getItem(COMPOSER_DRAFT_INDEX_STORAGE_KEY), (indexRaw) => {
      const index = indexRaw === null ? undefined : parseJson(indexRaw);
      if (!isIndex(index)) return readLegacy();
      writtenIndexJson = indexRaw;
      const draftKeys = index.state.draftKeys.filter(
        (key): key is string => typeof key === "string" && key.length > 0,
      );
      if (storage.keys) {
        const indexed = new Set(draftKeys);
        unindexedKeys = [...storage.keys()].filter(
          (key) =>
            key.startsWith(COMPOSER_DRAFT_ENTRY_STORAGE_KEY_PREFIX) &&
            !indexed.has(key.slice(COMPOSER_DRAFT_ENTRY_STORAGE_KEY_PREFIX.length)),
        );
      }
      return andThen(
        allOf(draftKeys.map((key) => storage.getItem(composerDraftEntryStorageKey(key)))),
        (raws) => {
          const draftsByThreadKey: Record<string, PersistedComposerThreadDraftState> = {};
          draftKeys.forEach((threadKey, position) => {
            const raw = raws[position] ?? null;
            const draft = raw === null ? undefined : parseJson(raw);
            // A missing or unreadable entry is tracked so the next flush removes it.
            const attachmentIds = draft && typeof draft === "object" ? attachmentIdsOf(draft) : [];
            written.set(threadKey, { draft: null, json: raw ?? "", attachmentIds });
            retain(attachmentIds);
            if (draft && typeof draft === "object") {
              draftsByThreadKey[threadKey] = draft as PersistedComposerThreadDraftState;
            }
          });
          const { draftKeys: _draftKeys, ...indexState } = index.state;
          return {
            version: index.version,
            state: { ...indexState, draftsByThreadKey },
          } satisfies StorageValue<PersistedComposerDraftStoreState>;
        },
      );
    });

  const flush = () => {
    const value = pending;
    pending = null;
    if (value === null) return;
    const { state, version } = value;
    const released = new Set<string>();
    const draftKeys: string[] = [];

    for (const [threadKey, draft] of Object.entries(state.draftsByThreadKey)) {
      if (threadKey.length === 0) continue;
      const previous = written.get(threadKey);
      if (previous?.draft === draft) {
        draftKeys.push(threadKey);
        continue;
      }
      const persisted = partializeComposerThreadDraftState(
        draft as ComposerThreadDraftState<TImage>,
      );
      if (persisted === null) continue;
      draftKeys.push(threadKey);
      const json = JSON.stringify(persisted);
      if (previous?.json === json) {
        previous.draft = draft;
        continue;
      }
      if (
        !tryWrite(threadKey, () => storage.setItem(composerDraftEntryStorageKey(threadKey), json))
      ) {
        // Untracked, so the next flush tries again.
        if (previous) previous.draft = null;
        continue;
      }
      const attachmentIds = attachmentIdsOf(persisted);
      retain(attachmentIds);
      if (previous) release(previous.attachmentIds, released);
      written.set(threadKey, { draft, json, attachmentIds });
    }

    const indexRefs = [
      state.draftThreadsByThreadKey,
      state.logicalProjectDraftThreadKeyByLogicalProjectKey,
      state.stickyModelSelectionByProvider,
      state.stickyActiveProvider,
      version,
      draftKeys.join("\u0000"),
    ];
    const indexChanged =
      writtenIndexRefs === null ||
      indexRefs.some((ref, position) => ref !== writtenIndexRefs![position]);
    let indexWritten = !indexChanged;
    if (indexChanged) {
      const index: PersistedComposerDraftIndex = {
        version: version ?? 0,
        state: {
          draftThreadsByThreadKey: state.draftThreadsByThreadKey,
          logicalProjectDraftThreadKeyByLogicalProjectKey:
            state.logicalProjectDraftThreadKeyByLogicalProjectKey,
          stickyModelSelectionByProvider: compactModelSelectionByProvider(
            state.stickyModelSelectionByProvider,
          ),
          stickyActiveProvider: state.stickyActiveProvider,
          draftKeys,
        },
      };
      const json = JSON.stringify(index);
      indexWritten =
        json === writtenIndexJson ||
        tryWrite(COMPOSER_DRAFT_INDEX_STORAGE_KEY, () =>
          storage.setItem(COMPOSER_DRAFT_INDEX_STORAGE_KEY, json),
        );
      if (indexWritten) {
        writtenIndexJson = json;
        writtenIndexRefs = indexRefs;
      }
    }
    // Entries go only once no index lists them: a reader never finds a listed draft missing.
    if (!indexWritten) return;

    const current = new Set(draftKeys);
    for (const [threadKey, entry] of written) {
      if (current.has(threadKey)) continue;
      tryWrite(threadKey, () => storage.removeItem(composerDraftEntryStorageKey(threadKey)));
      written.delete(threadKey);
      release(entry.attachmentIds, released);
    }
    for (const key of unindexedKeys) tryWrite(key, () => storage.removeItem(key));
    unindexedKeys = [];
    if (legacyEntryPresent) {
      legacyEntryPresent = false;
      tryWrite(legacyName, () => storage.removeItem(legacyName));
    }
    const unreferenced = [...released].filter((id) => !attachmentRefs.has(id));
    if (unreferenced.length > 0) storage.releaseAttachments?.(unreferenced);
  };

  return {
    // The middleware reads the persisted shape and writes live snapshots; it
    // only hands what `getItem` returns to `migrate` and `merge`.
    getItem: getItem as PersistStorage<ComposerDraftPersistSnapshot<TImage>>["getItem"],
    setItem: (_name, value) => {
      pending = value;
      if (storage.scheduleWrite) storage.scheduleWrite(flush);
      else flush();
    },
    removeItem: () => {
      pending = null;
      for (const threadKey of written.keys()) {
        storage.removeItem(composerDraftEntryStorageKey(threadKey));
      }
      written.clear();
      storage.removeItem(COMPOSER_DRAFT_INDEX_STORAGE_KEY);
      storage.removeItem(legacyName);
      writtenIndexJson = null;
      writtenIndexRefs = null;
    },
    flush,
  };
}
