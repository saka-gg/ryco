/**
 * Drops repeats of a running tool's visible state before they become runtime events.
 *
 * Some providers re-send a tool for every chunk of its output: OpenCode's bash tool rewrites its
 * part with the output so far in `state.metadata`, one `message.part.updated` per chunk. The
 * persisted activity keeps only what clients show (status, title, detail and the projected input,
 * files and terminal output), so each repeat became an identical event, activity row and
 * projection write.
 *
 * The visible key must cover every field a client shows for a tool that has not finished. It
 * leaves out OpenCode's `metadata` (streamed output the projection drops) and the pending `raw`
 * input text, which no client reads. If clients start rendering live output, the key must grow
 * (`ProviderRuntimeIngestion.activity.test.ts` fails once the activity persists that metadata).
 */
import { createHash } from "node:crypto";

/**
 * A repeat of a tool's visible state is re-emitted at most this often; it carries nothing a client
 * shows, only liveness.
 */
export const TOOL_UPDATE_HEARTBEAT_MS = 5_000;
/**
 * Non-terminal tool items tracked per session; the least recently emitted is forgotten first and
 * then counts as new.
 */
export const TOOL_UPDATE_GATE_CAPACITY = 1_024;

/** What a client can show for a tool that has not finished. */
export interface ToolUpdateView {
  readonly status: string;
  readonly title?: string | undefined;
  readonly detail?: string | undefined;
  readonly input?: unknown;
  readonly agentId?: string | undefined;
  /** The turn the activity is recorded under. */
  readonly turnId?: string | undefined;
}

/**
 * sha1 (base64) of the view's fields, or `undefined` for a view that does not serialise (a cycle,
 * a BigInt): the gate cannot compare it, so it emits it (fail open).
 */
export function toolUpdateVisibleKey(view: ToolUpdateView): string | undefined {
  let serialized: string;
  try {
    serialized = JSON.stringify([
      view.status,
      view.title ?? null,
      view.detail ?? null,
      view.input ?? null,
      view.agentId ?? null,
      view.turnId ?? null,
    ]);
  } catch {
    return undefined;
  }
  return createHash("sha1").update(serialized).digest("base64");
}

interface EmittedToolUpdate {
  readonly key: string;
  readonly emittedAtMs: number;
}

/**
 * Per-session memory of the last emitted visible state of each running tool. It stores hashes,
 * not inputs: a `write` tool's input can be a whole file. Its owner calls it synchronously, one
 * event at a time.
 */
export class ToolUpdateGate {
  readonly #heartbeatMs: number;
  readonly #capacity: number;
  /** Insertion order is emission order, so the first key is the least recently emitted. */
  readonly #emitted = new Map<string, EmittedToolUpdate>();

  constructor(options?: { readonly heartbeatMs?: number; readonly capacity?: number }) {
    this.#heartbeatMs = options?.heartbeatMs ?? TOOL_UPDATE_HEARTBEAT_MS;
    this.#capacity = Math.max(1, options?.capacity ?? TOOL_UPDATE_GATE_CAPACITY);
  }

  /**
   * Whether this update of `itemKey` should be emitted. Terminal updates always are, and they end
   * the item's tracking; so does an update without a `visibleKey` (one that cannot be compared).
   * A first sight, a changed `visibleKey`, or a heartbeat elapsed since the last emission (a clock
   * that stepped backwards counts as elapsed) are emitted and recorded. Other updates are dropped.
   */
  admit(
    itemKey: string,
    update: { readonly terminal: boolean; readonly visibleKey: string | undefined },
    nowMs: number,
  ): boolean {
    if (update.terminal || update.visibleKey === undefined) {
      this.#emitted.delete(itemKey);
      return true;
    }
    const last = this.#emitted.get(itemKey);
    if (
      last !== undefined &&
      last.key === update.visibleKey &&
      nowMs >= last.emittedAtMs &&
      nowMs - last.emittedAtMs < this.#heartbeatMs
    ) {
      return false;
    }
    this.#emitted.delete(itemKey);
    this.#emitted.set(itemKey, { key: update.visibleKey, emittedAtMs: nowMs });
    if (this.#emitted.size > this.#capacity) {
      const oldest = this.#emitted.keys().next();
      if (!oldest.done) this.#emitted.delete(oldest.value);
    }
    return true;
  }

  /** The item's next update counts as a first sight. */
  forget(itemKey: string): void {
    this.#emitted.delete(itemKey);
  }

  get size(): number {
    return this.#emitted.size;
  }
}
