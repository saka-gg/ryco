import { scopedThreadKey, scopeThreadRef } from "@ryco/client-runtime/scoped";
import {
  createTerminalEventReconciler,
  isTerminalReplayEvent,
  selectPendingTerminalEventEntries,
  selectTerminalEventEntries,
  selectTerminalEventEntriesAfterSnapshot,
  type TerminalEventEntry,
  type TerminalStateStoreState,
} from "@ryco/client-runtime/state/terminal";
import type {
  EnvironmentApi,
  EnvironmentId,
  ScopedThreadRef,
  TerminalEvent,
  TerminalSessionSnapshot,
  ThreadId,
} from "@ryco/contracts";

import {
  boundTerminalHistory,
  chunkTerminalBridgeData,
  decodeRendererTerminalMessage,
  encodeNativeTerminalMessage,
  TERMINAL_RENDERER_VERSION,
  type NativeTerminalMessage,
} from "./terminalBridgeProtocol";
import {
  safeTerminalError,
  TERMINAL_COPY_UNAVAILABLE,
  TERMINAL_PASTE_INTERRUPTED,
  TERMINAL_PASTE_UNAVAILABLE,
  type SafeTerminalError,
} from "./terminalErrors";
import { chunkTerminalInput, planTerminalPaste, terminalControlSequence } from "./terminalInput";
import {
  acknowledgeTerminalRendererOutput,
  clampTerminalDimensions,
  initialTerminalRendererOutputState,
  queueTerminalRendererOutput,
  resetTerminalRendererOutput,
  terminalDimensionsChanged,
  type TerminalDimensions,
  type TerminalRendererOutputState,
} from "./terminalRendererState";
import {
  buildTerminalScreenState,
  type TerminalConnectionState,
  type TerminalRendererPhase,
  type TerminalScreenState,
} from "./terminalScreenModel";
import {
  advanceTerminalStatus,
  buildTerminalTabs,
  canCreateMobileTerminalSession,
  knownTerminalSessionIds,
  MOBILE_DEFAULT_TERMINAL_ID,
  selectRetainedRendererTerminalIds,
  terminalStatusFromEvents,
  type MobileTerminalStatus,
  type TerminalStatusSummary,
  type TerminalTabModel,
} from "./terminalSessionModel";

const RESIZE_DEBOUNCE_MS = 100;

/** Matches the dark renderer document; the terminal keeps one palette in both app themes. */
export const TERMINAL_COLORS: Readonly<Record<string, string>> = {
  background: "#0b0c0f",
  foreground: "#d9dde5",
  cursor: "#5eead4",
  "cursor-accent": "#0b0c0f",
  selection: "#2f5f5a99",
  black: "#15171c",
  red: "#ff6b78",
  green: "#57d996",
  yellow: "#e7c65a",
  blue: "#70a5ff",
  magenta: "#c98bff",
  cyan: "#55d6d0",
  white: "#d9dde5",
  "bright-black": "#737985",
  "bright-red": "#ff8a94",
  "bright-green": "#7be2ad",
  "bright-yellow": "#efd77f",
  "bright-blue": "#94bcff",
  "bright-magenta": "#d9a9ff",
  "bright-cyan": "#80e2de",
  "bright-white": "#ffffff",
};

export interface TerminalStoreLike {
  readonly getState: () => TerminalStateStoreState;
  readonly subscribe: (
    listener: (state: TerminalStateStoreState, previous: TerminalStateStoreState) => void,
  ) => () => void;
}

export interface TerminalControllerPorts {
  readonly store: TerminalStoreLike;
  readonly clipboard: {
    readonly getString: () => Promise<string>;
    readonly setString: (text: string) => Promise<unknown>;
  };
  readonly lifecycle: {
    readonly isForeground: () => boolean;
    /** Calls back with `true` on return to the foreground and `false` on leaving it. */
    readonly subscribe: (listener: (foreground: boolean) => void) => () => void;
  };
  readonly createTerminalId: () => string;
  readonly scheduleFrame: (callback: () => void) => void;
  readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
}

export interface TerminalControllerInputs {
  readonly cwd: string | null;
  readonly worktreePath: string | null;
  /**
   * The environment's live API, or `undefined` without a connection. Its
   * identity is the connection's: every response is fenced by it, so a
   * replaced connection can never publish an old answer.
   */
  readonly api: EnvironmentApi | undefined;
  readonly connectionState: TerminalConnectionState;
  /** The shared mutation readiness of the environment row (role, session and shell). */
  readonly mutationReady: boolean;
  readonly fontSize: number;
}

export type TerminalBusyAction = "clear" | "restart" | "close";

export interface TerminalControllerView {
  readonly rendererGeneration: number;
  readonly rendererPhase: TerminalRendererPhase;
  readonly screenState: TerminalScreenState;
  readonly hasSession: boolean;
  readonly tabs: readonly TerminalTabModel[];
  readonly activeTerminalId: string | null;
  readonly activeStatus: MobileTerminalStatus;
  readonly writable: boolean;
  readonly mutationReady: boolean;
  readonly canCreateTerminal: boolean;
  readonly busyAction: TerminalBusyAction | null;
  readonly pasting: boolean;
  readonly controlArmed: boolean;
  readonly error: SafeTerminalError | null;
}

interface Surface {
  readonly terminalId: string;
  readonly reconciler: ReturnType<typeof createTerminalEventReconciler>;
  /** The token of the hydration the renderer has not acknowledged yet. */
  pendingHydration: number | null;
  /** The renderer parsed the latest snapshot; live events apply on top. */
  hydrated: boolean;
  /** The renderer shows this session's output, current or from before a disconnect. */
  rendered: boolean;
  snapshot: TerminalSessionSnapshot | null;
  lastAppliedEntryId: number;
  output: TerminalRendererOutputState;
  status: TerminalStatusSummary | null;
  bracketedPaste: boolean;
  dimensions: TerminalDimensions | null;
  writeChain: Promise<void>;
}

/** What every asynchronous answer is checked against before it may change anything. */
interface OperationFence {
  readonly generation: number;
  readonly api: EnvironmentApi;
}

const INITIAL_INPUTS: TerminalControllerInputs = {
  cwd: null,
  worktreePath: null,
  api: undefined,
  connectionState: "offline",
  mutationReady: false,
  fontSize: 12,
};

function eventsOf(entries: readonly TerminalEventEntry[]): readonly TerminalEvent[] {
  return entries.map((entry) => entry.event);
}

/**
 * One thread's terminal screen, outside React.
 *
 * It owns the renderer bridge (hydration tokens, ordered and acknowledged
 * output, high-water recovery), per-session reconciliation over the shared
 * memory-only terminal store, serialized input and paste, and the generation
 * fence every RPC answer passes. React renders `getSnapshot()` and dispatches
 * intents. Leaving the screen, losing the connection or backgrounding the app
 * never closes a session; only the explicit close action does.
 */
export class TerminalController {
  readonly #threadRef: ScopedThreadRef;
  readonly #threadKey: string;
  readonly #ports: TerminalControllerPorts;
  #inputs: TerminalControllerInputs = INITIAL_INPUTS;
  #workspaceKey = "";

  #rendererGeneration = 1;
  #rendererPhase: TerminalRendererPhase = "loading";
  #send: ((encoded: string) => boolean) | null = null;
  readonly #surfaces = new Map<string, Surface>();
  /** The session the renderer was last told to show. */
  #shownTerminalId: string | null = null;
  #hydrationCounter = 0;

  /** Bumped by everything that invalidates in-flight work: suspension, reconnection, reload. */
  #operationGeneration = 1;
  #opening: { readonly terminalId: string; readonly generation: number } | null = null;
  readonly #pendingOpen = new Set<string>();
  #busyAction: TerminalBusyAction | null = null;
  #error: SafeTerminalError | null = null;
  #controlArmed = false;
  #paste: { readonly token: object; readonly terminalId: string } | null = null;
  #labels: Readonly<Record<string, string>> = {};
  #recentTerminalIds: readonly string[] = [];
  #selectionRequestTerminalId: string | null = null;

  #frameScheduled = false;
  readonly #frameOutput = new Map<string, string[]>();
  #resizeTimer: unknown = null;

  #attached = false;
  #suspended = false;
  readonly #listeners = new Set<() => void>();
  #view: TerminalControllerView | null = null;

  constructor(environmentId: EnvironmentId, threadId: ThreadId, ports: TerminalControllerPorts) {
    this.#threadRef = scopeThreadRef(environmentId, threadId);
    this.#threadKey = scopedThreadKey(this.#threadRef);
    this.#ports = ports;
  }

  // --- React binding ---------------------------------------------------------

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  readonly getSnapshot = (): TerminalControllerView => (this.#view ??= this.#buildView());

  /** Starts observing the store and the app lifecycle; returns the matching stop. */
  readonly attach = (): (() => void) => {
    if (!this.#attached) {
      this.#attached = true;
      this.#suspended = !this.#ports.lifecycle.isForeground();
      if (!this.#suspended) this.#observeStore(true);
      this.#stopLifecycle = this.#ports.lifecycle.subscribe((foreground) =>
        this.setForeground(foreground),
      );
      this.#requestActiveOpen();
      this.#changed();
    }
    return this.#detachOnce;
  };

  readonly #detachOnce = (): void => {
    if (!this.#attached) return;
    this.#attached = false;
    this.#stopLifecycle?.();
    this.#stopLifecycle = null;
    this.#observeStore(false);
    this.#invalidate();
    this.#frameOutput.clear();
  };

  #stopLifecycle: (() => void) | null = null;
  #stopStore: (() => void) | null = null;

  #observeStore(observe: boolean): void {
    if (!observe) {
      this.#stopStore?.();
      this.#stopStore = null;
      return;
    }
    if (this.#stopStore !== null) return;
    this.#stopStore = this.#ports.store.subscribe((state, previous) => {
      if (
        state.terminalStateByThreadKey[this.#threadKey] !==
          previous.terminalStateByThreadKey[this.#threadKey] ||
        this.#threadEntriesChanged(state, previous)
      ) {
        this.#onStoreChange(state, previous);
      }
    });
  }

  /** Whether this thread's buffered events changed; other threads' output is not ours. */
  #threadEntriesChanged(
    state: TerminalStateStoreState,
    previous: TerminalStateStoreState,
  ): boolean {
    if (state.terminalEventEntriesByKey === previous.terminalEventEntriesByKey) return false;
    const prefix = `${this.#threadKey}\u0000`;
    const keys = new Set([
      ...Object.keys(state.terminalEventEntriesByKey),
      ...Object.keys(previous.terminalEventEntriesByKey),
    ]);
    for (const key of keys) {
      if (
        key.startsWith(prefix) &&
        state.terminalEventEntriesByKey[key] !== previous.terminalEventEntriesByKey[key]
      ) {
        return true;
      }
    }
    return false;
  }

  /** Inputs from the screen: workspace, connection, readiness and appearance. */
  readonly update = (inputs: TerminalControllerInputs): void => {
    const previous = this.#inputs;
    this.#inputs = inputs;
    const workspaceKey = `${inputs.cwd ?? ""}\u0000${inputs.worktreePath ?? ""}`;
    if (workspaceKey !== this.#workspaceKey) {
      const first = this.#workspaceKey === "";
      this.#workspaceKey = workspaceKey;
      // A different workspace is a different terminal context: start the view over.
      if (!first) this.#replaceRenderer();
    }
    if (inputs.api !== previous.api) {
      // A replaced connection may front a restarted node: nothing it answered
      // before counts, and every shown session re-hydrates before input.
      this.#invalidate();
      for (const surface of this.#surfaces.values()) surface.hydrated = false;
    }
    if (inputs.fontSize !== previous.fontSize) this.#sendAppearance();
    if (inputs.api !== previous.api || (inputs.mutationReady && !previous.mutationReady)) {
      this.#requestActiveOpen();
    }
    this.#syncWritable();
    this.#changed();
  };

  /** Background suspends the view; the foreground re-hydrates it from the server snapshot. */
  readonly setForeground = (foreground: boolean): void => {
    if (foreground === !this.#suspended) return;
    this.#suspended = !foreground;
    if (!foreground) {
      // Nothing the background holds is replayed later: in-flight work is
      // dropped, the store is no longer observed, and the shown output stays as
      // it was until the authoritative snapshot replaces it.
      this.#invalidate();
      this.#observeStore(false);
      this.#frameOutput.clear();
      for (const surface of this.#surfaces.values()) {
        surface.hydrated = false;
        surface.output = resetTerminalRendererOutput(surface.output);
      }
      this.#controlArmed = false;
    } else {
      if (this.#attached) this.#observeStore(true);
      // iOS may have reclaimed the WebView's content process while away.
      if (this.#rendererPhase === "failed") this.#replaceRenderer();
      else this.#requestActiveOpen();
    }
    this.#syncWritable();
    this.#changed();
  };

  // --- Renderer bridge -----------------------------------------------------------

  /** The WebView of `generation` became able to receive messages (or stopped, with `null`). */
  readonly attachRenderer = (
    generation: number,
    send: ((encoded: string) => boolean) | null,
  ): void => {
    if (generation !== this.#rendererGeneration) return;
    this.#send = send;
  };

  readonly onRendererMessage = (raw: string, generation: number): void => {
    if (generation !== this.#rendererGeneration) return;
    const message = decodeRendererTerminalMessage(raw);
    if (!message) return;
    switch (message.type) {
      case "ready":
        if (message.rendererVersion !== TERMINAL_RENDERER_VERSION) {
          this.#failRenderer();
          return;
        }
        this.#rendererPhase = "ready";
        this.#resetSurfacesForNewDocument();
        this.#sendAppearance();
        // A fresh document never accepts input before its snapshot is acknowledged.
        this.#post({ type: "connection", writable: false });
        this.#activateActive();
        this.#requestActiveOpen();
        this.#changed();
        return;
      case "hydrated":
        this.#onHydrated(message.terminalId, message.hydration);
        return;
      case "written": {
        const surface = this.#surfaces.get(message.terminalId);
        if (surface)
          surface.output = acknowledgeTerminalRendererOutput(surface.output, message.sequence);
        return;
      }
      case "input":
        this.#onRendererInput(message.terminalId, message.data);
        return;
      case "resize":
        this.#onResize(message.terminalId, { cols: message.cols, rows: message.rows });
        return;
      case "modes": {
        const surface = this.#surfaces.get(message.terminalId);
        if (surface) surface.bracketedPaste = message.bracketedPaste;
        return;
      }
      case "selection":
        if (this.#selectionRequestTerminalId !== message.terminalId) return;
        this.#selectionRequestTerminalId = null;
        if (message.text.length === 0) return;
        void this.#ports.clipboard.setString(message.text).catch(() => {
          this.#setError(TERMINAL_COPY_UNAVAILABLE);
        });
        return;
      case "fatal":
        this.#failRenderer();
        return;
    }
  };

  readonly onRendererFailure = (generation: number): void => {
    if (generation !== this.#rendererGeneration) return;
    this.#failRenderer();
  };

  /** Discard the renderer and build a new one; the node's processes are untouched. */
  readonly reloadRenderer = (): void => {
    this.#replaceRenderer();
    this.#changed();
  };

  // --- Intents -------------------------------------------------------------------

  readonly startTerminal = (): void => {
    if (!this.#canMutate()) return;
    const store = this.#ports.store.getState();
    // `open` records the session even while it is the store's default shape.
    store.ensureTerminal(this.#threadRef, MOBILE_DEFAULT_TERMINAL_ID, { open: true, active: true });
    this.#selectLocal(MOBILE_DEFAULT_TERMINAL_ID);
  };

  readonly createTerminal = (): string | null => {
    if (!this.#canMutate() || !canCreateMobileTerminalSession(this.#knownTerminalIds())) {
      return null;
    }
    const terminalId = this.#ports.createTerminalId();
    this.#ports.store.getState().newTerminal(this.#threadRef, terminalId);
    this.#selectLocal(terminalId);
    return terminalId;
  };

  readonly selectTerminal = (terminalId: string): void => {
    if (!this.#knownTerminalIds().includes(terminalId)) return;
    this.#ports.store.getState().setActiveTerminal(this.#threadRef, terminalId);
    this.#selectLocal(terminalId);
  };

  readonly renameTerminal = (terminalId: string, label: string): void => {
    this.#labels = { ...this.#labels, [terminalId]: label };
    this.#changed();
  };

  /** Re-hydrate the active session from a fresh snapshot. Never restarts it. */
  readonly refresh = (): void => {
    const terminalId = this.#activeTerminalId();
    if (terminalId === null) return;
    const surface = this.#surfaces.get(terminalId);
    if (surface) surface.hydrated = false;
    this.#requestOpen(terminalId);
    this.#changed();
  };

  readonly focus = (): void => {
    const terminalId = this.#activeTerminalId();
    if (terminalId !== null) this.#post({ type: "focus", terminalId });
  };

  readonly dismissKeyboard = (): void => {
    this.#post({ type: "blur" });
  };

  readonly copySelection = (): void => {
    const terminalId = this.#activeTerminalId();
    if (terminalId === null) return;
    this.#selectionRequestTerminalId = terminalId;
    this.#post({ type: "requestSelection", terminalId });
  };

  readonly toggleControl = (): void => {
    this.#controlArmed = !this.#controlArmed;
    this.#changed();
    this.focus();
  };

  readonly dismissError = (): void => {
    this.#setError(null);
  };

  /** Accessory-row keys: sent as typed, after any one-shot Ctrl. */
  readonly sendKeys = (data: string): void => {
    const terminalId = this.#activeTerminalId();
    if (terminalId === null) return;
    void this.#sendInput(terminalId, this.#consumeControl(data));
    this.focus();
  };

  /**
   * Paste the clipboard into the active session: encoded for its current paste
   * mode, chunked within the write limit, serialized behind earlier input, and
   * stopped when the target changes. A bracketed paste cut short is closed so
   * the shell does not keep reading keystrokes as pasted text.
   */
  readonly paste = async (): Promise<void> => {
    const terminalId = this.#activeTerminalId();
    if (terminalId === null || !this.#isWritable(terminalId)) return;
    let text: string;
    try {
      text = await this.#ports.clipboard.getString();
    } catch {
      this.#setError(TERMINAL_PASTE_UNAVAILABLE);
      return;
    }
    const surface = this.#surfaces.get(terminalId);
    const fence = this.#fence();
    if (
      text.length === 0 ||
      !surface ||
      fence === null ||
      this.#activeTerminalId() !== terminalId ||
      !this.#isWritable(terminalId)
    ) {
      return;
    }
    const plan = planTerminalPaste(text, surface.bracketedPaste);
    const paste = { token: {}, terminalId };
    this.#paste = paste;
    this.#changed();
    const current = () => this.#paste === paste && this.#fenceHolds(fence);
    await this.#enqueueWrite(surface, async () => {
      let sent = 0;
      for (const chunk of plan.chunks) {
        if (!current()) break;
        try {
          await fence.api.terminal.write({
            threadId: this.#threadRef.threadId,
            terminalId,
            data: chunk,
          });
        } catch (failure) {
          if (this.#fenceHolds(fence)) this.#setError(safeTerminalError(failure));
          break;
        }
        sent += 1;
      }
      if (sent < plan.chunks.length) {
        if (sent > 0 && plan.closeSequence !== null && this.#fenceHolds(fence)) {
          await fence.api.terminal
            .write({
              threadId: this.#threadRef.threadId,
              terminalId,
              data: plan.closeSequence,
            })
            .catch(() => undefined);
        }
        if (this.#error === null) this.#setError(TERMINAL_PASTE_INTERRUPTED);
      }
    });
    if (this.#paste === paste) {
      this.#paste = null;
      this.#changed();
    }
  };

  readonly clear = (): Promise<boolean> => this.#runSessionAction("clear");
  readonly restart = (): Promise<boolean> => this.#runSessionAction("restart");
  readonly close = (deleteHistory = false): Promise<boolean> =>
    this.#runSessionAction("close", deleteHistory);

  // --- Store observation ---------------------------------------------------------

  #onStoreChange(state: TerminalStateStoreState, previous: TerminalStateStoreState): void {
    if (this.#suspended) return;
    for (const surface of this.#surfaces.values()) {
      if (!surface.hydrated) continue;
      const entries = selectTerminalEventEntries(
        state.terminalEventEntriesByKey,
        this.#threadRef,
        surface.terminalId,
      );
      const previousEntries = selectTerminalEventEntries(
        previous.terminalEventEntriesByKey,
        this.#threadRef,
        surface.terminalId,
      );
      if (entries.at(-1)?.id === previousEntries.at(-1)?.id) continue;
      this.#applyPendingEntries(surface, entries);
    }
    // Another client (or a live start) can move the active session.
    const active = this.#activeTerminalId();
    if (active !== this.#shownTerminalId) {
      this.#activateActive();
      this.#requestActiveOpen();
      this.#syncWritable();
    }
    this.#changed();
  }

  #applyPendingEntries(surface: Surface, entries: readonly TerminalEventEntry[]): void {
    for (const entry of selectPendingTerminalEventEntries(entries, surface.lastAppliedEntryId)) {
      this.#applyEvent(surface, entry.event);
      // A replay or a restart handed the surface to a new hydration, which
      // applies the buffer after its acknowledgement; stop before this entry.
      if (!surface.hydrated) return;
      surface.lastAppliedEntryId = entry.id;
    }
  }

  #applyEvent(surface: Surface, event: TerminalEvent): void {
    if (event.type === "activity") {
      // Tracked so a reconnect replay can tell missed output from activity already seen.
      surface.reconciler.accept(event);
      return;
    }
    if (!surface.reconciler.accept(event)) return;
    if (isTerminalReplayEvent(event)) {
      // Output was missed and the replay carries no history: re-hydrate.
      surface.hydrated = false;
      this.#requestOpen(surface.terminalId);
      return;
    }
    surface.status = advanceTerminalStatus(
      surface.status ?? this.#storeStatus(surface.terminalId),
      event,
    );
    switch (event.type) {
      case "output":
        this.#enqueueOutput(surface.terminalId, event.data);
        return;
      case "started":
      case "restarted":
        if (
          surface.snapshot?.cursor !== undefined &&
          event.snapshot.cursor?.generation === surface.snapshot.cursor.generation &&
          event.snapshot.cursor.sequence === surface.snapshot.cursor.sequence
        ) {
          return; // The snapshot this surface already hydrated from (a restart's own answer).
        }
        this.#flushOutput(surface.terminalId);
        this.#hydrate(surface, event.snapshot);
        return;
      case "cleared":
        this.#flushOutput(surface.terminalId);
        this.#post({ type: "clear", terminalId: surface.terminalId });
        return;
      case "exited":
      case "error":
        this.#syncWritable();
        return;
    }
  }

  // --- Hydration -----------------------------------------------------------------

  #requestActiveOpen(): void {
    const terminalId = this.#activeTerminalId();
    if (terminalId === null) return;
    if (!this.#surfaces.get(terminalId)?.hydrated) this.#requestOpen(terminalId);
  }

  #requestOpen(terminalId: string): void {
    // One snapshot at a time per session: an open in flight or a hydration the
    // renderer has not acknowledged already brings it current.
    if (this.#opening?.terminalId === terminalId) return;
    if (this.#surfaces.get(terminalId)?.pendingHydration != null) return;
    this.#pendingOpen.add(terminalId);
    this.#drainOpen();
  }

  /** Opens the active pending session once a renderer, a size and mutation authority exist. */
  #drainOpen(): void {
    const terminalId = this.#activeTerminalId();
    if (terminalId === null || !this.#pendingOpen.has(terminalId)) return;
    if (this.#opening !== null || this.#suspended || this.#rendererPhase !== "ready") return;
    const surface = this.#surface(terminalId);
    const fence = this.#fence();
    const { cwd, worktreePath } = this.#inputs;
    if (cwd === null || fence === null || !this.#inputs.mutationReady) return;
    if (surface.dimensions === null) return; // The renderer reports a size after activation.
    this.#pendingOpen.delete(terminalId);
    const opening = { terminalId, generation: fence.generation };
    this.#opening = opening;
    this.#changed();
    const dimensions = surface.dimensions;
    void fence.api.terminal
      .open({
        threadId: this.#threadRef.threadId,
        terminalId,
        cwd,
        worktreePath,
        cols: dimensions.cols,
        rows: dimensions.rows,
      })
      .then(
        (snapshot) => {
          if (!this.#fenceHolds(fence) || this.#rendererPhase !== "ready") return;
          this.#hydrate(surface, snapshot);
        },
        (failure: unknown) => {
          if (this.#fenceHolds(fence)) this.#setError(safeTerminalError(failure));
        },
      )
      .finally(() => {
        if (this.#opening !== opening) return;
        this.#opening = null;
        this.#drainOpen();
        this.#changed();
      });
  }

  #hydrate(surface: Surface, snapshot: TerminalSessionSnapshot): void {
    const hydration = ++this.#hydrationCounter;
    surface.snapshot = snapshot;
    surface.reconciler.reset(snapshot);
    surface.pendingHydration = hydration;
    surface.hydrated = false;
    surface.bracketedPaste = false;
    surface.status = { status: snapshot.status, exitCode: snapshot.exitCode };
    surface.output = resetTerminalRendererOutput(surface.output);
    this.#frameOutput.delete(surface.terminalId);
    if (
      !this.#post({
        type: "hydrate",
        terminalId: surface.terminalId,
        hydration,
        history: boundTerminalHistory(snapshot.history),
      })
    ) {
      this.#failRenderer();
    }
    this.#syncWritable();
    this.#changed();
  }

  #onHydrated(terminalId: string, hydration: number): void {
    const surface = this.#surfaces.get(terminalId);
    if (!surface || surface.pendingHydration !== hydration || surface.snapshot === null) return;
    surface.pendingHydration = null;
    surface.hydrated = true;
    surface.rendered = true;
    if (!this.#suspended) {
      const entries = selectTerminalEventEntries(
        this.#ports.store.getState().terminalEventEntriesByKey,
        this.#threadRef,
        terminalId,
      );
      surface.lastAppliedEntryId = entries.at(-1)?.id ?? 0;
      for (const entry of selectTerminalEventEntriesAfterSnapshot(
        entries,
        surface.snapshot.updatedAt,
        surface.snapshot.cursor,
      )) {
        this.#applyEvent(surface, entry.event);
        if (!surface.hydrated) break;
      }
    }
    this.#syncWritable();
    this.#changed();
  }

  // --- Output ----------------------------------------------------------------------

  #enqueueOutput(terminalId: string, data: string): void {
    const chunks = chunkTerminalBridgeData(data);
    if (chunks.length === 0) return;
    const pending = this.#frameOutput.get(terminalId) ?? [];
    pending.push(...chunks);
    this.#frameOutput.set(terminalId, pending);
    if (this.#frameScheduled) return;
    this.#frameScheduled = true;
    this.#ports.scheduleFrame(() => {
      this.#frameScheduled = false;
      for (const id of [...this.#frameOutput.keys()]) this.#flushOutput(id);
    });
  }

  #flushOutput(terminalId: string): void {
    const chunks = this.#frameOutput.get(terminalId);
    if (!chunks) return;
    this.#frameOutput.delete(terminalId);
    const surface = this.#surfaces.get(terminalId);
    if (!surface?.hydrated) return;
    for (const data of chunks) {
      const queued = queueTerminalRendererOutput(surface.output, data);
      surface.output = queued.state;
      if (queued.kind === "empty") continue;
      if (queued.kind === "overflow") {
        // The renderer fell a megabyte behind: re-hydrate rather than drop or reorder.
        surface.hydrated = false;
        this.#requestOpen(terminalId);
        this.#changed();
        return;
      }
      if (!this.#post({ type: "write", terminalId, sequence: queued.sequence, data })) {
        this.#failRenderer();
        return;
      }
    }
  }

  // --- Input -----------------------------------------------------------------------

  #onRendererInput(terminalId: string, data: string): void {
    void this.#sendInput(terminalId, this.#consumeControl(data));
  }

  #consumeControl(data: string): string {
    if (!this.#controlArmed) return data;
    this.#controlArmed = false;
    this.#changed();
    return terminalControlSequence(data) ?? data;
  }

  #sendInput(terminalId: string, data: string): Promise<void> {
    const surface = this.#surfaces.get(terminalId);
    const fence = this.#fence();
    if (data.length === 0 || !surface || fence === null || !this.#isWritable(terminalId)) {
      return Promise.resolve();
    }
    const chunks = chunkTerminalInput(data);
    return this.#enqueueWrite(surface, async () => {
      for (const chunk of chunks) {
        if (!this.#fenceHolds(fence)) return;
        try {
          await fence.api.terminal.write({
            threadId: this.#threadRef.threadId,
            terminalId,
            data: chunk,
          });
        } catch (failure) {
          if (this.#fenceHolds(fence)) this.#setError(safeTerminalError(failure));
          return;
        }
      }
    });
  }

  /** Input to one session is strictly ordered: each write waits for the one before it. */
  #enqueueWrite(surface: Surface, write: () => Promise<void>): Promise<void> {
    const next = surface.writeChain.then(write);
    surface.writeChain = next.catch(() => undefined);
    return next;
  }

  #onResize(terminalId: string, next: TerminalDimensions): void {
    const surface = this.#surface(terminalId);
    const dimensions = clampTerminalDimensions(next);
    const first = surface.dimensions === null;
    if (!terminalDimensionsChanged(surface.dimensions, dimensions)) return;
    surface.dimensions = dimensions;
    // The first size takes part in `terminal.open` instead of a resize.
    if (first) {
      this.#drainOpen();
      return;
    }
    if (this.#resizeTimer !== null) this.#ports.clearTimer(this.#resizeTimer);
    this.#resizeTimer = this.#ports.setTimer(() => {
      this.#resizeTimer = null;
      this.#sendResize(surface);
    }, RESIZE_DEBOUNCE_MS);
  }

  #sendResize(surface: Surface): void {
    const fence = this.#fence();
    if (
      fence === null ||
      surface.dimensions === null ||
      !surface.hydrated ||
      !this.#inputs.mutationReady ||
      surface.status?.status !== "running"
    ) {
      return;
    }
    void fence.api.terminal
      .resize({
        threadId: this.#threadRef.threadId,
        terminalId: surface.terminalId,
        cols: surface.dimensions.cols,
        rows: surface.dimensions.rows,
      })
      .catch((failure: unknown) => {
        if (this.#fenceHolds(fence)) this.#setError(safeTerminalError(failure));
      });
  }

  // --- Session actions ---------------------------------------------------------------

  async #runSessionAction(action: TerminalBusyAction, deleteHistory = false): Promise<boolean> {
    const terminalId = this.#activeTerminalId();
    const fence = this.#fence();
    const { cwd, worktreePath } = this.#inputs;
    if (terminalId === null || fence === null || cwd === null || !this.#canMutate()) return false;
    if (this.#busyAction !== null) return false;
    const surface = this.#surface(terminalId);
    this.#busyAction = action;
    this.#error = null;
    this.#changed();
    const input = { threadId: this.#threadRef.threadId, terminalId };
    let succeeded = false;
    try {
      if (action === "clear") {
        await fence.api.terminal.clear(input);
        if (this.#fenceHolds(fence)) this.#post({ type: "clear", terminalId });
      } else if (action === "restart") {
        const dimensions = surface.dimensions ?? { cols: 80, rows: 24 };
        const snapshot = await fence.api.terminal.restart({
          ...input,
          cwd,
          worktreePath,
          cols: dimensions.cols,
          rows: dimensions.rows,
        });
        if (this.#fenceHolds(fence)) this.#hydrate(surface, snapshot);
      } else {
        await fence.api.terminal.close({ ...input, deleteHistory });
        if (this.#fenceHolds(fence)) this.#forgetSession(terminalId);
      }
      succeeded = true;
    } catch (failure) {
      if (this.#fenceHolds(fence)) this.#setError(safeTerminalError(failure));
    }
    this.#busyAction = null;
    this.#changed();
    return succeeded;
  }

  #forgetSession(terminalId: string): void {
    if (this.#paste?.terminalId === terminalId) this.#paste = null;
    const store = this.#ports.store.getState();
    store.closeTerminal(this.#threadRef, terminalId);
    store.clearTerminalEventHistory(this.#threadRef, terminalId);
    this.#post({ type: "dispose", terminalId });
    this.#surfaces.delete(terminalId);
    this.#pendingOpen.delete(terminalId);
    this.#frameOutput.delete(terminalId);
    const { [terminalId]: _removed, ...labels } = this.#labels;
    this.#labels = labels;
    this.#recentTerminalIds = this.#recentTerminalIds.filter((id) => id !== terminalId);
    this.#activateActive();
    this.#requestActiveOpen();
  }

  // --- Internals -------------------------------------------------------------------

  #selectLocal(terminalId: string): void {
    // The paste was for the session the user left; it does not follow them.
    if (this.#paste !== null && this.#paste.terminalId !== terminalId) this.#paste = null;
    this.#controlArmed = false;
    this.#recentTerminalIds = [
      terminalId,
      ...this.#recentTerminalIds.filter((id) => id !== terminalId),
    ];
    this.#activateActive();
    this.#requestActiveOpen();
    this.#syncWritable();
    this.#changed();
  }

  #activateActive(): void {
    const terminalId = this.#activeTerminalId();
    this.#shownTerminalId = terminalId;
    if (terminalId === null) return;
    this.#surface(terminalId);
    this.#post({ type: "activate", terminalId });
    this.#evictRenderers(terminalId);
  }

  /**
   * Keep renderer terminals for the active session and the most recently shown
   * ones, up to the session cap. An evicted session stays a tab and keeps
   * running on the node; selecting it again opens a fresh snapshot.
   */
  #evictRenderers(activeTerminalId: string): void {
    const retained = new Set(
      selectRetainedRendererTerminalIds({
        activeTerminalId,
        knownTerminalIds: [...this.#surfaces.keys()],
        recentTerminalIds: this.#recentTerminalIds,
      }),
    );
    for (const terminalId of [...this.#surfaces.keys()]) {
      if (retained.has(terminalId)) continue;
      this.#post({ type: "dispose", terminalId });
      this.#surfaces.delete(terminalId);
      this.#pendingOpen.delete(terminalId);
      this.#frameOutput.delete(terminalId);
    }
  }

  #surface(terminalId: string): Surface {
    const existing = this.#surfaces.get(terminalId);
    if (existing) return existing;
    const created: Surface = {
      terminalId,
      reconciler: createTerminalEventReconciler(),
      pendingHydration: null,
      hydrated: false,
      rendered: false,
      snapshot: null,
      lastAppliedEntryId: 0,
      output: initialTerminalRendererOutputState(),
      status: null,
      bracketedPaste: false,
      dimensions: null,
      writeChain: Promise.resolve(),
    };
    this.#surfaces.set(terminalId, created);
    return created;
  }

  #resetSurfacesForNewDocument(): void {
    for (const surface of this.#surfaces.values()) {
      surface.pendingHydration = null;
      surface.hydrated = false;
      surface.rendered = false;
      surface.bracketedPaste = false;
      surface.dimensions = null;
      surface.lastAppliedEntryId = 0;
      surface.output = resetTerminalRendererOutput(surface.output);
    }
    this.#frameOutput.clear();
  }

  #replaceRenderer(): void {
    this.#invalidate();
    this.#rendererGeneration += 1;
    this.#rendererPhase = "loading";
    this.#send = null;
    this.#resetSurfacesForNewDocument();
  }

  #failRenderer(): void {
    this.#invalidate();
    this.#rendererPhase = "failed";
    this.#send = null;
    this.#changed();
  }

  /** Every in-flight answer, paste and debounced resize stops counting. */
  #invalidate(): void {
    this.#operationGeneration += 1;
    this.#opening = null;
    this.#paste = null;
    this.#busyAction = null;
    if (this.#resizeTimer !== null) {
      this.#ports.clearTimer(this.#resizeTimer);
      this.#resizeTimer = null;
    }
    for (const surface of this.#surfaces.values()) surface.pendingHydration = null;
  }

  #fence(): OperationFence | null {
    const api = this.#inputs.api;
    return api === undefined ? null : { generation: this.#operationGeneration, api };
  }

  #fenceHolds(fence: OperationFence): boolean {
    return (
      this.#attached &&
      !this.#suspended &&
      fence.generation === this.#operationGeneration &&
      fence.api === this.#inputs.api
    );
  }

  #canMutate(): boolean {
    return (
      this.#attached &&
      !this.#suspended &&
      this.#inputs.mutationReady &&
      this.#inputs.cwd !== null &&
      this.#inputs.api !== undefined
    );
  }

  #isWritable(terminalId: string): boolean {
    const surface = this.#surfaces.get(terminalId);
    return (
      this.#canMutate() &&
      this.#rendererPhase === "ready" &&
      this.#activeTerminalId() === terminalId &&
      this.#opening?.terminalId !== terminalId &&
      surface?.hydrated === true &&
      surface.status?.status === "running"
    );
  }

  #syncWritable(): void {
    const terminalId = this.#activeTerminalId();
    this.#post({
      type: "connection",
      writable: terminalId !== null && this.#isWritable(terminalId),
    });
  }

  #sendAppearance(): void {
    if (this.#rendererPhase !== "ready") return;
    this.#post({ type: "appearance", fontSize: this.#inputs.fontSize, colors: TERMINAL_COLORS });
  }

  #post(message: NativeTerminalMessage): boolean {
    if (this.#send === null || this.#rendererPhase !== "ready") return false;
    const encoded = encodeNativeTerminalMessage(message);
    return encoded !== null && this.#send(encoded);
  }

  #setError(error: SafeTerminalError | null): void {
    this.#error = error;
    this.#changed();
  }

  #sessions() {
    return this.#ports.store.getState().terminalStateByThreadKey[this.#threadKey] ?? null;
  }

  /** Any buffered event: the bounded buffer can outlive the `started` it began with. */
  #defaultTerminalHasEvents(state: TerminalStateStoreState): boolean {
    return (
      selectTerminalEventEntries(
        state.terminalEventEntriesByKey,
        this.#threadRef,
        MOBILE_DEFAULT_TERMINAL_ID,
      ).length > 0
    );
  }

  #knownTerminalIds(): readonly string[] {
    const state = this.#ports.store.getState();
    return knownTerminalSessionIds({
      sessions: state.terminalStateByThreadKey[this.#threadKey] ?? null,
      defaultTerminalHasEvents: this.#defaultTerminalHasEvents(state),
    });
  }

  #activeTerminalId(): string | null {
    const known = this.#knownTerminalIds();
    if (known.length === 0) return null;
    const active = this.#sessions()?.activeTerminalId;
    return active !== undefined && known.includes(active) ? active : (known[0] ?? null);
  }

  #storeStatus(terminalId: string): TerminalStatusSummary {
    return terminalStatusFromEvents(
      eventsOf(
        selectTerminalEventEntries(
          this.#ports.store.getState().terminalEventEntriesByKey,
          this.#threadRef,
          terminalId,
        ),
      ),
    );
  }

  #changed(): void {
    this.#view = null;
    for (const listener of [...this.#listeners]) listener();
  }

  #buildView(): TerminalControllerView {
    const terminalIds = this.#knownTerminalIds();
    const activeTerminalId = this.#activeTerminalId();
    const sessions = this.#sessions();
    const statusByTerminalId: Record<string, TerminalStatusSummary> = {};
    for (const terminalId of terminalIds) {
      statusByTerminalId[terminalId] =
        this.#surfaces.get(terminalId)?.status ?? this.#storeStatus(terminalId);
    }
    const active = activeTerminalId === null ? null : this.#surfaces.get(activeTerminalId);
    const activeStatus =
      activeTerminalId === null
        ? "starting"
        : (statusByTerminalId[activeTerminalId]?.status ?? "starting");
    const writable = activeTerminalId !== null && this.#isWritable(activeTerminalId);
    return {
      rendererGeneration: this.#rendererGeneration,
      rendererPhase: this.#rendererPhase,
      screenState: buildTerminalScreenState({
        workspaceRootAvailable: this.#inputs.cwd !== null,
        hasSession: activeTerminalId !== null,
        connectionState: this.#inputs.connectionState,
        mutationReady: this.#inputs.mutationReady && this.#inputs.api !== undefined,
        rendererPhase: this.#rendererPhase,
        opening: this.#opening !== null && this.#opening.terminalId === activeTerminalId,
        hydrated: active?.hydrated === true,
        rendered: active?.rendered === true,
        terminalStatus: activeStatus,
      }),
      hasSession: activeTerminalId !== null,
      tabs: buildTerminalTabs({
        terminalIds,
        activeTerminalId: activeTerminalId ?? "",
        runningTerminalIds: sessions?.runningTerminalIds ?? [],
        labelsByTerminalId: this.#labels,
        statusByTerminalId,
      }),
      activeTerminalId,
      activeStatus,
      writable,
      mutationReady: this.#canMutate(),
      canCreateTerminal: this.#canMutate() && canCreateMobileTerminalSession(terminalIds),
      busyAction: this.#busyAction,
      pasting: this.#paste !== null,
      controlArmed: this.#controlArmed,
      error: this.#error,
    };
  }
}
