/**
 * Live, mutable copies of the pull request fixtures for one test. The mocked
 * rpc hooks read from it and the mocked mutations write to it, and
 * `PullRequestsTestProvider` rebuilds its model from it, so an interaction
 * (resolve a thread, toggle draft, merge) shows up in the UI like it would
 * after the real optimistic update. Call `pullRequestFixtureStore.reset()`
 * between tests.
 *
 * Test data only — never import this from app code.
 */
import type {
  ChangeRequest,
  ChangeRequestActivity,
  ChangeRequestInvolvement,
  SourceControlChangeRequestDetail,
  SourceControlChangeRequestFilesViewed,
} from "@ryco/contracts";
import { useSyncExternalStore } from "react";

import {
  FIXTURE_VIEWER_LOGIN,
  fixtureActivity,
  fixtureAuthoredNumbers,
  fixtureChangeRequests,
  fixtureDetail,
  fixtureFilesViewed,
  fixtureReviewRequestedNumbers,
  hasFixtureChangeRequest,
} from "./pullRequestFixtures";

type Listener = () => void;

const listeners = new Set<Listener>();
let version = 0;
let details = new Map<number, SourceControlChangeRequestDetail>();
let activities = new Map<number, ChangeRequestActivity>();
let filesViewed = new Map<number, SourceControlChangeRequestFilesViewed>();

function emit(): void {
  version += 1;
  for (const listener of listeners) listener();
}

export const pullRequestFixtureStore = {
  /** Bumps on every write; use it as a memo key. */
  getVersion(): number {
    return version;
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  /** List rows (all states). A row whose detail was written reflects that detail. */
  rows(): ReadonlyArray<ChangeRequest> {
    return fixtureChangeRequests.map((row) => details.get(row.number) ?? row);
  },
  /** What a list read returns for this state and (server-side) involvement filter. */
  list(input: {
    readonly state: "open" | "closed" | "merged" | "all";
    readonly involvement?: ChangeRequestInvolvement | undefined;
  }): ReadonlyArray<ChangeRequest> {
    const authored = new Set(fixtureAuthoredNumbers);
    const reviewRequested = new Set(fixtureReviewRequestedNumbers);
    return pullRequestFixtureStore.rows().filter((row) => {
      if (input.state !== "all" && row.state !== input.state) return false;
      switch (input.involvement) {
        case undefined:
          return true;
        case "authored":
          return authored.has(row.number);
        case "review-requested":
          return reviewRequested.has(row.number);
        case "assigned":
          return (row.assignees ?? []).includes(FIXTURE_VIEWER_LOGIN);
        case "mentioned":
        case "involved":
          return authored.has(row.number) || reviewRequested.has(row.number);
      }
    });
  },
  detail(number: number): SourceControlChangeRequestDetail | null {
    if (!hasFixtureChangeRequest(number)) return null;
    return details.get(number) ?? fixtureDetail(number);
  },
  activity(number: number): ChangeRequestActivity | null {
    if (!hasFixtureChangeRequest(number)) return null;
    return activities.get(number) ?? fixtureActivity(number);
  },
  filesViewed(number: number): SourceControlChangeRequestFilesViewed | null {
    if (!hasFixtureChangeRequest(number)) return null;
    return filesViewed.get(number) ?? fixtureFilesViewed(number);
  },
  updateDetail(
    number: number,
    update: (detail: SourceControlChangeRequestDetail) => SourceControlChangeRequestDetail,
  ): void {
    const current = pullRequestFixtureStore.detail(number);
    if (!current) return;
    const next = update(current);
    if (next === current) return;
    details = new Map(details).set(number, next);
    emit();
  },
  updateActivity(
    number: number,
    update: (activity: ChangeRequestActivity) => ChangeRequestActivity,
  ): void {
    const current = pullRequestFixtureStore.activity(number);
    if (!current) return;
    const next = update(current);
    if (next === current) return;
    activities = new Map(activities).set(number, next);
    emit();
  },
  updateFilesViewed(
    number: number,
    update: (
      viewed: SourceControlChangeRequestFilesViewed,
    ) => SourceControlChangeRequestFilesViewed,
  ): void {
    const current = pullRequestFixtureStore.filesViewed(number);
    if (!current) return;
    const next = update(current);
    if (next === current) return;
    filesViewed = new Map(filesViewed).set(number, next);
    emit();
  },
  /** Back to the pristine fixtures. */
  reset(): void {
    details = new Map();
    activities = new Map();
    filesViewed = new Map();
    emit();
  },
};

/** Re-renders the caller whenever the store changes; returns the store version. */
export function usePullRequestFixtureVersion(): number {
  return useSyncExternalStore(
    pullRequestFixtureStore.subscribe,
    pullRequestFixtureStore.getVersion,
    pullRequestFixtureStore.getVersion,
  );
}
