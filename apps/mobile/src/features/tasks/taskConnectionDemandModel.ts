import type { EnvironmentId } from "@ryco/contracts";

// Which Hub machines the Tasks surfaces hold a connection lease on. Pure apart
// from the `retain` it is given, so the bound and the rotation are testable.
//
// A Hub machine's relay connection lives in the shared warm set, which is
// small (`MAX_MOBILE_HOSTED_CONNECTIONS`) and also serves the selected machine
// and any open chat. Queued demand waits in order, so asking for every machine
// at once would leave the ones past the bound unread for good. Instead:
//
// - The first `liveSlots` machines (the ones a surface needs most, then those
//   already connected, then the rest in order) hold a lease while the surface
//   shows: their lists follow the change feed.
// - The others are read one at a time: a lease until that machine's tasks
//   were read (or it failed, or `rotationTimeoutMs` passed), then released
//   for the next. Each is read once per visit, like Home's discovery.
// - Only eligible machines (online, trusted, not paired directly) are asked
//   for; an offline one never takes a slot.

export interface TaskDemandInput {
  /** A Tasks surface shows, the app is in the foreground and the Hub session is current. */
  readonly active: boolean;
  /** The account, session and Space; a change starts over. */
  readonly authority: string | null;
  /** The Hub machines the surfaces want, in their order. */
  readonly wanted: ReadonlyArray<EnvironmentId>;
  /** Machines a surface needs live now (the one picked, a capture's, one being edited). */
  readonly priority: ReadonlySet<EnvironmentId>;
  readonly eligible: ReadonlySet<EnvironmentId>;
  /** Machines connected already (the selected one, a warm one): live at no extra cost. */
  readonly connected: ReadonlySet<EnvironmentId>;
  readonly failed: ReadonlySet<EnvironmentId>;
  /** When the machine's tasks were last read (ms), or null. */
  readonly readAt: (environmentId: EnvironmentId) => number | null;
  readonly now: number;
}

export interface TaskDemandPlan {
  readonly live: ReadonlyArray<EnvironmentId>;
  readonly rotating: EnvironmentId | null;
  /** When `update` should run again to give up on a slow rotating read; null for never. */
  readonly checkAt: number | null;
}

export const IDLE_TASK_DEMAND_PLAN: TaskDemandPlan = { live: [], rotating: null, checkAt: null };

export function createTaskConnectionDemand(options: {
  readonly retain: (environmentId: EnvironmentId) => () => void;
  readonly liveSlots: number;
  readonly rotationTimeoutMs: number;
}) {
  const live = new Map<EnvironmentId, { readonly since: number; readonly release: () => void }>();
  let rotating: {
    readonly environmentId: EnvironmentId;
    readonly since: number;
    readonly release: () => void;
  } | null = null;
  /** Read during this visit: not rotated again until the visit ends or it goes away. */
  const read = new Set<EnvironmentId>();
  let active = false;
  let authority: string | null = null;

  const readSince = (input: TaskDemandInput, environmentId: EnvironmentId, since: number) => {
    const at = input.readAt(environmentId);
    return at !== null && at >= since;
  };

  const releaseAll = () => {
    for (const lease of live.values()) lease.release();
    live.clear();
    rotating?.release();
    rotating = null;
  };

  const reset = () => {
    releaseAll();
    read.clear();
    active = false;
    authority = null;
  };

  const update = (input: TaskDemandInput): TaskDemandPlan => {
    if (input.authority !== authority) {
      reset();
      authority = input.authority;
    }
    const nextActive = input.active && authority !== null;
    if (nextActive && !active) read.clear();
    active = nextActive;
    if (!active) {
      releaseAll();
      return IDLE_TASK_DEMAND_PLAN;
    }

    // A machine that went away (offline, revoked, paired directly) is read afresh when it is back.
    for (const environmentId of read) {
      if (!input.eligible.has(environmentId)) read.delete(environmentId);
    }

    const wanted = [...new Set(input.wanted)].filter((id) => input.eligible.has(id));
    const rank = (id: EnvironmentId) =>
      input.priority.has(id) ? 0 : input.connected.has(id) ? 1 : live.has(id) ? 2 : 3;
    const ordered = wanted
      .map((id, index) => ({ id, index }))
      .toSorted((a, b) => rank(a.id) - rank(b.id) || a.index - b.index)
      .map((entry) => entry.id);
    const nextLive = ordered.slice(0, Math.max(0, options.liveSlots));
    const rest = ordered.slice(nextLive.length);

    // Leases leaving the live set; released at the end unless the rotation takes one over.
    const demoted = new Map<
      EnvironmentId,
      { readonly since: number; readonly release: () => void }
    >();
    for (const [environmentId, lease] of live) {
      if (nextLive.includes(environmentId)) continue;
      // Leaving the live set after a read counts as read: it is not rotated straight back.
      if (readSince(input, environmentId, lease.since)) read.add(environmentId);
      demoted.set(environmentId, lease);
      live.delete(environmentId);
    }
    for (const environmentId of nextLive) {
      if (live.has(environmentId)) continue;
      if (rotating?.environmentId === environmentId) {
        // Promoted mid-read: the rotating lease becomes the live one.
        live.set(environmentId, { since: rotating.since, release: rotating.release });
        rotating = null;
        continue;
      }
      live.set(environmentId, { since: input.now, release: options.retain(environmentId) });
    }

    if (rotating !== null) {
      const current = rotating;
      const done =
        !rest.includes(current.environmentId) ||
        readSince(input, current.environmentId, current.since) ||
        input.failed.has(current.environmentId) ||
        input.now - current.since >= options.rotationTimeoutMs;
      if (done) {
        if (rest.includes(current.environmentId)) read.add(current.environmentId);
        current.release();
        rotating = null;
      }
    }
    if (rotating === null) {
      const next = rest.find((id) => !read.has(id) && !input.failed.has(id));
      if (next !== undefined) {
        const kept = demoted.get(next);
        demoted.delete(next);
        rotating = {
          environmentId: next,
          since: kept?.since ?? input.now,
          release: kept?.release ?? options.retain(next),
        };
      }
    }
    for (const lease of demoted.values()) lease.release();

    return {
      live: [...live.keys()],
      rotating: rotating?.environmentId ?? null,
      checkAt: rotating === null ? null : rotating.since + options.rotationTimeoutMs,
    };
  };

  /** Every machine not live is read once more (pull to refresh); the next `update` starts it. */
  const rescan = () => {
    read.clear();
  };

  return { update, reset, rescan };
}
