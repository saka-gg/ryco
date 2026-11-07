// Adapted from t3code's preview mini-player store (pingdotgg/t3code, MIT); see THIRD_PARTY_NOTICES.md.
import { create } from "zustand";

/*
 * The workspace mini-player: one small window per thread that floats live
 * workspace content over the chat while the right panel shows something
 * else. Generic over what it shows; a device is the first source, and the
 * browser preview can be another. Not persisted: a reload docks everything.
 */

export interface WorkspaceMiniPlayerPosition {
  readonly x: number;
  readonly y: number;
}

export interface WorkspaceMiniPlayerSize {
  readonly width: number;
  readonly height: number;
}

export type WorkspaceMiniPlayerSource = { readonly kind: "device"; readonly udid: string };

export interface WorkspaceMiniPlayerState {
  readonly source: WorkspaceMiniPlayerSource;
  /** Null until the user moves it: it then sits in the top-right corner. */
  readonly position: WorkspaceMiniPlayerPosition | null;
  readonly width: number | null;
}

export function workspaceMiniPlayerSourceKey(source: WorkspaceMiniPlayerSource): string {
  return `${source.kind}:${source.udid}`;
}

interface WorkspaceMiniPlayerStoreState {
  readonly byThreadKey: Readonly<Record<string, WorkspaceMiniPlayerState>>;
  readonly open: (threadKey: string, source: WorkspaceMiniPlayerSource) => void;
  readonly close: (threadKey: string) => void;
  /** `sourceKey` guards against a drag that outlives the source it started on. */
  readonly place: (
    threadKey: string,
    sourceKey: string,
    frame: { readonly position: WorkspaceMiniPlayerPosition; readonly width?: number },
  ) => void;
}

export const useWorkspaceMiniPlayerStore = create<WorkspaceMiniPlayerStoreState>()((set) => ({
  byThreadKey: {},
  open: (threadKey, source) =>
    set((state) => {
      const current = state.byThreadKey[threadKey];
      if (
        current &&
        workspaceMiniPlayerSourceKey(current.source) === workspaceMiniPlayerSourceKey(source)
      ) {
        return state;
      }
      return {
        byThreadKey: {
          ...state.byThreadKey,
          // A new source keeps where the window was and how big.
          [threadKey]: {
            source,
            position: current?.position ?? null,
            width: current?.width ?? null,
          },
        },
      };
    }),
  close: (threadKey) =>
    set((state) => {
      if (!(threadKey in state.byThreadKey)) return state;
      const { [threadKey]: _closed, ...byThreadKey } = state.byThreadKey;
      return { byThreadKey };
    }),
  place: (threadKey, sourceKey, frame) =>
    set((state) => {
      const current = state.byThreadKey[threadKey];
      if (!current || workspaceMiniPlayerSourceKey(current.source) !== sourceKey) return state;
      const width = frame.width ?? current.width;
      if (
        current.position?.x === frame.position.x &&
        current.position.y === frame.position.y &&
        current.width === width
      ) {
        return state;
      }
      return {
        byThreadKey: {
          ...state.byThreadKey,
          [threadKey]: { ...current, position: frame.position, width },
        },
      };
    }),
}));

/** The device floating over a thread's chat, if one is. */
export function floatingDeviceUdid(
  byThreadKey: Readonly<Record<string, WorkspaceMiniPlayerState>>,
  threadKey: string | null,
): string | null {
  const source = threadKey ? byThreadKey[threadKey]?.source : undefined;
  return source?.kind === "device" ? source.udid : null;
}
