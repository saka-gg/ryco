import * as Equal from "effect/Equal";
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

type PersistedComposerDraftIndexState = Omit<
  PersistedComposerDraftStoreState,
  "draftsByThreadKey"
> & {
  readonly draftKeys: ReadonlyArray<string>;
};

interface PersistedComposerDraftIndex {
  readonly version: number;
  readonly state: PersistedComposerDraftIndexState;
}

const EMPTY_INDEX_STATE: PersistedComposerDraftIndexState = {
  draftThreadsByThreadKey: {},
  logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  draftKeys: [],
};

const MERGED_RECORD_FIELDS = [
  "draftThreadsByThreadKey",
  "logicalProjectDraftThreadKeyByLogicalProjectKey",
  "stickyModelSelectionByProvider",
] as const;

/** A field-wise three-way merge: this tab's value where it changed it, the stored one otherwise. */
function mergeIndexValue<A>(previous: A, ours: A, theirs: A): A {
  return Equal.equals(ours, previous) ? theirs : ours;
}

function mergeIndexRecord(
  previous: Readonly<Record<string, unknown>> | undefined,
  ours: Readonly<Record<string, unknown>> | undefined,
  theirs: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(ours ?? {}), ...Object.keys(theirs ?? {})])) {
    const value = mergeIndexValue(previous?.[key], ours?.[key], theirs?.[key]);
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

/**
 * Every open tab writes the one shared index, each from the drafts it holds in
 * memory, so a plain overwrite would drop drafts another tab created after
 * this one booted. Instead each write merges with the index as stored now:
 * whatever this tab changed since its last index write wins, everything else
 * (another tab's new drafts, or its deletes of drafts this tab left alone)
 * comes from the stored index. A draft this tab wrote in this very flush stays
 * listed, so an edit beats another tab's concurrent delete.
 */
function mergeComposerDraftIndexState(
  previous: PersistedComposerDraftIndexState,
  ours: PersistedComposerDraftIndexState,
  theirs: PersistedComposerDraftIndexState,
  editedKeys: ReadonlySet<string>,
): PersistedComposerDraftIndexState {
  const records = Object.fromEntries(
    MERGED_RECORD_FIELDS.map((field) => [
      field,
      mergeIndexRecord(previous[field], ours[field], theirs[field]),
    ]),
  ) as Pick<PersistedComposerDraftIndexState, (typeof MERGED_RECORD_FIELDS)[number]>;
  const previousKeys = new Set(previous.draftKeys);
  const ourKeys = new Set(ours.draftKeys);
  const theirKeys = new Set(theirs.draftKeys);
  const draftKeys = [...new Set([...ours.draftKeys, ...theirs.draftKeys])].filter((key) =>
    editedKeys.has(key)
      ? true
      : mergeIndexValue(previousKeys.has(key), ourKeys.has(key), theirKeys.has(key)),
  );
  const stickyActiveProvider = mergeIndexValue(
    previous.stickyActiveProvider ?? null,
    ours.stickyActiveProvider ?? null,
    theirs.stickyActiveProvider ?? null,
  );
  return {
    ...records,
    stickyActiveProvider,
    draftKeys,
  } as PersistedComposerDraftIndexState;
}

/** The index this tab's in-memory state stands for, in the shape the merge compares. */
function ownIndexStateOf<TImage extends ComposerDraftImage>(
  state: ComposerDraftPersistSnapshot<TImage>,
  draftKeys: ReadonlyArray<string>,
): PersistedComposerDraftIndexState {
  return {
    draftThreadsByThreadKey: state.draftThreadsByThreadKey,
    logicalProjectDraftThreadKeyByLogicalProjectKey:
      state.logicalProjectDraftThreadKeyByLogicalProjectKey,
    stickyModelSelectionByProvider: compactModelSelectionByProvider(
      state.stickyModelSelectionByProvider,
    ),
    stickyActiveProvider: state.stickyActiveProvider,
    draftKeys,
  };
}

/** A stored index, with the version its records are shaped for (none when nothing is stored). */
interface StoredIndex {
  readonly version: number | undefined;
  readonly state: PersistedComposerDraftIndexState;
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

function indexStateOf(index: PersistedComposerDraftIndex): PersistedComposerDraftIndexState {
  return {
    ...index.state,
    draftKeys: index.state.draftKeys.filter(
      (key): key is string => typeof key === "string" && key.length > 0,
    ),
  };
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
): PersistStorage<ComposerDraftPersistSnapshot<TImage>> & {
  readonly flush: () => void;
  /**
   * Takes the state the store hydrated from the index just read as what this
   * tab has not changed yet. Hydration reshapes records (it drops fields the
   * stored JSON holds as null, for one), so comparing later state with the
   * parsed index would count every hydrated record as changed by this tab.
   */
  readonly rebaseline: (state: ComposerDraftPersistSnapshot<TImage>) => void;
} {
  const written = new Map<string, WrittenDraft>();
  const attachmentRefs = new Map<string, number>();
  let writtenIndexJson: string | null = null;
  let writtenIndexRefs: ReadonlyArray<unknown> | null = null;
  /** The index as this tab last read or wrote it: the stored one, unless another tab wrote since. */
  let writtenIndex: StoredIndex = { version: undefined, state: EMPTY_INDEX_STATE };
  /**
   * This tab's own view, in its in-memory shape, at its last index write (or
   * as hydrated from the index it read): what it changed since.
   */
  let ownIndex: PersistedComposerDraftIndexState = EMPTY_INDEX_STATE;
  /** Whether the state being hydrated came from the index (not the legacy entry or nothing). */
  let hydratingFromIndex = false;
  /** Whether the stored index can be re-read inside a flush (another tab may have written it). */
  let readsSynchronously = true;
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

  const getItem = (): MaybePromise<StorageValue<unknown> | null> => {
    const read = storage.getItem(COMPOSER_DRAFT_INDEX_STORAGE_KEY);
    readsSynchronously = !isPromise(read);
    return andThen(read, (indexRaw) => {
      const index = indexRaw === null ? undefined : parseJson(indexRaw);
      hydratingFromIndex = isIndex(index);
      if (!isIndex(index)) return readLegacy();
      writtenIndexJson = indexRaw;
      writtenIndex = { version: index.version, state: indexStateOf(index) };
      // Until the store hands over what it hydrated (`rebaseline`).
      ownIndex = writtenIndex.state;
      const { draftKeys } = writtenIndex.state;
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
  };

  /**
   * The index another tab stored since this one last read or wrote it, or null
   * when it is unchanged (or the storage cannot be read synchronously).
   */
  const readForeignIndex = (): (StoredIndex & { readonly raw: string | null }) | null => {
    if (!readsSynchronously) return null;
    let raw: string | null | Promise<string | null>;
    try {
      raw = storage.getItem(COMPOSER_DRAFT_INDEX_STORAGE_KEY);
    } catch {
      return null;
    }
    if (isPromise(raw)) {
      readsSynchronously = false;
      raw.catch(() => undefined);
      return null;
    }
    if (raw === writtenIndexJson) return null;
    // Removed altogether: another tab cleared every draft.
    if (raw === null) return { raw, version: undefined, state: EMPTY_INDEX_STATE };
    const index = parseJson(raw);
    if (!isIndex(index)) return null;
    return { raw, version: index.version, state: indexStateOf(index) };
  };

  const flush = () => {
    const value = pending;
    pending = null;
    if (value === null) return;
    const { state, version } = value;
    const released = new Set<string>();
    const draftKeys: string[] = [];
    const editedKeys = new Set<string>();

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
      editedKeys.add(threadKey);
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
    const foreignIndex = readForeignIndex();
    const indexChanged =
      foreignIndex !== null ||
      writtenIndexRefs === null ||
      indexRefs.some((ref, position) => ref !== writtenIndexRefs![position]) ||
      // A draft another tab deleted is listed again once this tab edits it.
      [...editedKeys].some((key) => !writtenIndex.state.draftKeys.includes(key));
    let indexWritten = !indexChanged;
    let listedKeys: ReadonlyArray<string> = writtenIndex.state.draftKeys;
    if (indexChanged) {
      const ours = ownIndexStateOf(state, draftKeys);
      const stored = foreignIndex ?? writtenIndex;
      const indexVersion = version ?? 0;
      // An index stored in another version (a migrated read, or a tab running
      // another build) shapes its records differently: none of them are merged in.
      const merged =
        stored.version === undefined || stored.version === indexVersion
          ? mergeComposerDraftIndexState(ownIndex, ours, stored.state, editedKeys)
          : ours;
      const index: PersistedComposerDraftIndex = { version: indexVersion, state: merged };
      const json = JSON.stringify(index);
      indexWritten =
        json === (foreignIndex === null ? writtenIndexJson : foreignIndex.raw) ||
        tryWrite(COMPOSER_DRAFT_INDEX_STORAGE_KEY, () =>
          storage.setItem(COMPOSER_DRAFT_INDEX_STORAGE_KEY, json),
        );
      if (indexWritten) {
        writtenIndexJson = json;
        writtenIndexRefs = indexRefs;
        writtenIndex = { version: indexVersion, state: merged };
        ownIndex = ours;
        listedKeys = merged.draftKeys;
      }
    }
    // Entries go only once no index lists them: a reader never finds a listed draft missing.
    if (!indexWritten) return;

    const listed = new Set(listedKeys);
    const held = new Set(draftKeys);
    for (const [threadKey, entry] of written) {
      if (listed.has(threadKey)) continue;
      if (held.has(threadKey)) {
        // Another tab deleted a draft this tab still holds but left alone: its
        // entry is gone, and this tab writes it again only once it is edited.
        entry.json = "";
        continue;
      }
      tryWrite(threadKey, () => storage.removeItem(composerDraftEntryStorageKey(threadKey)));
      written.delete(threadKey);
      release(entry.attachmentIds, released);
    }
    // Only entries that the index lists now (another tab may have listed one since boot) are kept.
    for (const key of unindexedKeys) {
      const threadKey = key.slice(COMPOSER_DRAFT_ENTRY_STORAGE_KEY_PREFIX.length);
      if (listed.has(threadKey) || written.has(threadKey)) continue;
      tryWrite(key, () => storage.removeItem(key));
    }
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
      writtenIndex = { version: undefined, state: EMPTY_INDEX_STATE };
      ownIndex = EMPTY_INDEX_STATE;
    },
    flush,
    rebaseline: (state) => {
      // Hydrated from the legacy entry or nothing: no index this tab's state stands for.
      if (!hydratingFromIndex) return;
      hydratingFromIndex = false;
      // The listed drafts stay as read, so the next flush still drops entries
      // that were missing or unreadable.
      ownIndex = ownIndexStateOf(state, ownIndex.draftKeys);
    },
  };
}
