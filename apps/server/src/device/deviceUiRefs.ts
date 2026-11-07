/**
 * Element refs (`@e5`) and the last screen each reader was shown, so device tools can take a
 * ref as a target and return only what changed.
 *
 * A ref stands for an element identity (`elementIdentities`: role, subrole, label and which
 * of several equal ones), not for one tree read. The same element keeps its ref across
 * snapshots of a thread's device, which is what lets a diff say "@e5 changed" and leave the
 * unchanged rest out. Numbers only grow, so a ref never comes to mean a different element:
 * one whose element left the screen fails rather than hitting whatever took its place.
 *
 * Refs are per thread and device (a parent agent and its subagents share them). The diff
 * baseline is per reader (`observerKey`: one agent of one session) and device, because a
 * diff is only meaningful against the screen that reader actually saw.
 *
 * In memory and bounded; losing it (a restart) only costs one full snapshot. Loaded with the
 * first device tool call, never at boot.
 *
 * @module device/deviceUiRefs
 */
import type { DeviceUiRefTarget } from "./uiTreeTargeting.ts";
import type { DeviceUiRefNamer, DeviceUiSnapshot } from "./deviceUiSnapshot.ts";

/** Devices × threads with a ref table, and readers × devices with a baseline. */
const MAX_TABLES = 128;
const MAX_BASELINES = 256;
/** Identities one table remembers before it starts over (its numbers keep growing). */
const MAX_REFS_PER_TABLE = 4_000;

const REF_PATTERN = /^@?e([1-9][0-9]{0,8})$/u;

/** `@e5` from `@e5` or `e5`; null for anything else. */
export function normalizeRef(value: string): string | null {
  const match = REF_PATTERN.exec(value.trim());
  return match === null ? null : `@e${match[1]}`;
}

interface RefEntry {
  readonly key: string;
  description: string;
}

export class DeviceUiRefTable implements DeviceUiRefNamer {
  private readonly byKey = new Map<string, string>();
  private readonly byRef = new Map<string, RefEntry>();
  private next = 1;

  refFor(key: string, description: string): string {
    const known = this.byKey.get(key);
    if (known !== undefined) {
      const entry = this.byRef.get(known);
      if (entry !== undefined) entry.description = description;
      return known;
    }
    if (this.byKey.size >= MAX_REFS_PER_TABLE) {
      this.byKey.clear();
      this.byRef.clear();
    }
    const ref = `@e${this.next}`;
    this.next += 1;
    this.byKey.set(key, ref);
    this.byRef.set(ref, { key, description });
    return ref;
  }

  /** The target a ref names, or null when this table never gave it out. */
  resolve(ref: string): DeviceUiRefTarget | null {
    const name = normalizeRef(ref);
    if (name === null) return null;
    const entry = this.byRef.get(name);
    return entry === undefined ? null : { name, key: entry.key, description: entry.description };
  }
}

/** Insertion-ordered map that forgets its oldest entries past `max`. */
function remember<V>(map: Map<string, V>, key: string, value: V, max: number): V {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
  return value;
}

const tables = new Map<string, DeviceUiRefTable>();
const baselines = new Map<string, DeviceUiSnapshot>();

const scopeKey = (scope: string, udid: string) => `${scope}\u0000${udid}`;

/** The ref table of one thread's view of one device. */
export function deviceUiRefTable(threadId: string, udid: string): DeviceUiRefTable {
  const key = scopeKey(threadId, udid);
  const table = tables.get(key);
  return remember(tables, key, table ?? new DeviceUiRefTable(), MAX_TABLES);
}

/** The last screen `observerKey` was shown of this device, if any. */
export function lastShownSnapshot(observerKey: string, udid: string): DeviceUiSnapshot | null {
  return baselines.get(scopeKey(observerKey, udid)) ?? null;
}

export function rememberShownSnapshot(
  observerKey: string,
  udid: string,
  snapshot: DeviceUiSnapshot,
): void {
  remember(baselines, scopeKey(observerKey, udid), snapshot, MAX_BASELINES);
}

/** Tests start from nothing. */
export function resetDeviceUiRefsForTests(): void {
  tables.clear();
  baselines.clear();
}
