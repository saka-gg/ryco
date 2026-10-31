import { describe, expect, it } from "@effect/vitest";
import { SourceControlProviderError, type SourceControlChangeRequestDetail } from "@ryco/contracts";
import { Effect } from "effect";
import { TestClock } from "effect/testing";

import {
  CHANGE_REQUEST_ROW_REREAD_MS,
  STACKED_CHANGE_REQUEST_ROW_REREAD_MS,
  makeChangeRequestRowRevalidation,
} from "./changeRequestRowRevalidation.ts";
import type { RepositoryChanges } from "./repositoryListCache.ts";
import type { ChangeRequestWatchFingerprint } from "./SourceControlProvider.ts";

/** A row whose host the test moves; counts full reads and fingerprint asks. */
function row(options?: { readonly stacked?: boolean; readonly fingerprints?: boolean }) {
  const state = {
    version: 1,
    fingerprint: {
      status: "OPEN MERGEABLE abc SUCCESS:3",
      remarks: "1 2026-10-30T00:00:00Z 0  0",
      revision: "2026-10-30T00:00:00Z ready",
    } as ChangeRequestWatchFingerprint | null,
    failing: false,
    loads: 0,
    asked: [] as Array<number>,
    changes: { changedAtMs: 0, mutations: 0 } as RepositoryChanges,
  };
  const rows = makeChangeRequestRowRevalidation();
  const read = rows.read({
    cwd: "/repo",
    key: "42",
    get changes() {
      return state.changes;
    },
    load: Effect.sync(() => {
      state.loads += 1;
      return {
        number: 42,
        url: "https://github.com/acme/web/pull/42",
        version: state.version,
        ...(options?.stacked ? { stack: { entries: [{ number: 41 }, { number: 42 }] } } : {}),
      } as unknown as SourceControlChangeRequestDetail;
    }),
    provider: Effect.sync(() =>
      options?.fingerprints === false
        ? {}
        : {
            getChangeRequestWatchFingerprint: (request: {
              readonly cwd: string;
              readonly number: number;
              readonly url: string;
              readonly reuseSinceMs?: number | undefined;
            }) =>
              Effect.suspend(() => {
                state.asked.push(request.reuseSinceMs ?? -1);
                return state.failing
                  ? Effect.fail(
                      new SourceControlProviderError({
                        provider: "github",
                        operation: "getChangeRequestWatchFingerprint",
                        detail: "GitHub API rate limit exceeded.",
                        reason: "rate-limited",
                      }),
                    )
                  : Effect.succeed(state.fingerprint);
              }),
          },
    ),
  });
  const version = read.pipe(
    Effect.map((detail) => (detail as unknown as { version: number }).version),
  );
  return { state, version };
}

describe("changeRequestRowRevalidation", () => {
  it.effect("reads a row in full only when its fingerprint moved", () =>
    Effect.gen(function* () {
      const { state, version } = row();
      expect(yield* version).toBe(1);
      // No fingerprint stands for the first read: the second reads in full, fingerprint first.
      state.version = 2;
      expect(yield* version).toBe(2);
      state.version = 3;
      expect(yield* version).toBe(2);
      expect(yield* version).toBe(2);
      expect(state.loads).toBe(2);
      expect(state.asked).toEqual([0, 0, 0]);

      for (const moved of [
        { status: "OPEN MERGEABLE abc FAILURE:1,SUCCESS:2" },
        { remarks: "2 2026-10-30T01:00:00Z 0  0" },
        { revision: "2026-10-30T01:00:00Z ready" },
      ]) {
        state.fingerprint = { ...state.fingerprint!, ...moved };
        state.version += 1;
        expect(yield* version).toBe(state.version);
        expect(yield* version).toBe(state.version);
      }
      expect(state.loads).toBe(5);
    }),
  );

  it.effect("reads in full without a fingerprint, a revision, or when the host refused", () =>
    Effect.gen(function* () {
      // A host that offers no fingerprint (GitLab, Forgejo, ...) reads every time, as before.
      const plain = row({ fingerprints: false });
      for (let poll = 0; poll < 3; poll += 1) yield* plain.version;
      expect(plain.state.loads).toBe(3);

      const { state, version } = row();
      yield* version;
      yield* version;
      expect(state.loads).toBe(2);
      state.fingerprint = null;
      yield* version;
      state.fingerprint = { status: "OPEN", remarks: "0" };
      yield* version;
      state.fingerprint = { status: "OPEN", remarks: "0", revision: "r" };
      state.failing = true;
      yield* version;
      expect(state.loads).toBe(5);
    }),
  );

  it.effect("asks for a fingerprint newer than a change, and reads in full after a mutation", () =>
    Effect.gen(function* () {
      const { state, version } = row();
      yield* version;
      yield* version;
      state.changes = { changedAtMs: 5_000, mutations: 0 };
      yield* version;
      expect(state.asked.at(-1)).toBe(5_000);
      expect(state.loads).toBe(2);
      // A comment through Ryco: read in full though the fingerprint did not move.
      state.changes = { changedAtMs: 6_000, mutations: 1 };
      yield* version;
      expect(state.loads).toBe(3);
      yield* version;
      expect(state.loads).toBe(3);
    }),
  );

  it.effect("reads in full after the re-read age, sooner for a stacked change request", () =>
    Effect.gen(function* () {
      for (const [stacked, rereadMs] of [
        [false, CHANGE_REQUEST_ROW_REREAD_MS],
        [true, STACKED_CHANGE_REQUEST_ROW_REREAD_MS],
      ] as const) {
        const { state, version } = row({ stacked });
        yield* version;
        yield* version;
        yield* TestClock.adjust(rereadMs - 1);
        yield* version;
        expect(state.loads).toBe(2);
        yield* TestClock.adjust(1);
        yield* version;
        expect(state.loads).toBe(3);
      }
    }),
  );
});
