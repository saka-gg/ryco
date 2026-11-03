import { isPullRequestWatchedIn } from "@ryco/client-runtime/state/threads";
import type { EnvironmentId, SourceControlProviderKind } from "@ryco/contracts";
import { Schema } from "effect";
import { useEffect } from "react";
import { getLocalStorageItem, setLocalStorageItem } from "~/hooks/useLocalStorage";
import { getPresentationTier } from "~/lib/presentationTier";
import { selectEnvironmentState, useStore } from "~/store";
import { stackedThreadToast, toastManager } from "../ui/toast";
import type { PrCheckStatusView } from "./prCheckStatus";

const STORAGE_KEY = "ryco:pr-check-pass-notifications:v1";
const MAX_RECORDS = 250;

const NotificationRecord = Schema.Struct({
  key: Schema.String,
  status: Schema.String,
  updatedAt: Schema.String,
  notifiedAt: Schema.optional(Schema.String),
});
const NotificationRecords = Schema.Array(NotificationRecord);

export type NotificationRecord = typeof NotificationRecord.Type;

export interface PrCheckNotificationTarget {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly provider: SourceControlProviderKind;
  readonly number: number;
  readonly title: string;
  readonly url?: string | undefined;
  readonly status: PrCheckStatusView;
}

function storageKeyForTarget(target: PrCheckNotificationTarget): string | null {
  const headSha = target.status.headSha;
  if (!target.environmentId || !target.cwd || !headSha) return null;
  return [target.environmentId, target.cwd, target.provider, target.number, headSha].join("|");
}

function readRecords(): NotificationRecord[] {
  try {
    return [...(getLocalStorageItem(STORAGE_KEY, NotificationRecords) ?? [])];
  } catch {
    return [];
  }
}

function writeRecords(records: ReadonlyArray<NotificationRecord>) {
  try {
    setLocalStorageItem(
      STORAGE_KEY,
      records
        .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, MAX_RECORDS),
      NotificationRecords,
    );
  } catch {
    // Local storage is best-effort; losing it only means a future duplicate is possible.
  }
}

function shouldPersistStatus(status: PrCheckStatusView): boolean {
  return ["cancelled", "failed", "passed", "pending", "running"].includes(status.kind);
}

/**
 * A thread's server-side watch reads this pull request and reports its checks
 * passing from the thread's shell (thread alerts), so this page stays quiet
 * about it. Only by host URL: a number alone can name another repository's
 * pull request. The frozen phone tier shows no watch notice, so there the
 * page keeps its own.
 */
export function isWatchedOnServer(target: PrCheckNotificationTarget): boolean {
  if (!target.environmentId || !target.url || getPresentationTier() === "phone") return false;
  const threads = selectEnvironmentState(
    useStore.getState(),
    target.environmentId,
  ).sidebarThreadSummaryById;
  return isPullRequestWatchedIn(Object.values(threads), { number: target.number, url: target.url });
}

function notifyChecksPassed(target: PrCheckNotificationTarget) {
  const shortSha = target.status.headSha?.slice(0, 12);
  toastManager.add(
    stackedThreadToast({
      type: "success",
      title: `Checks passed for PR #${target.number}`,
      description: shortSha ? `${target.title} · ${shortSha}` : target.title,
      timeout: 6_000,
      ...(target.url
        ? {
            actionProps: {
              children: "Open PR",
              onClick: () => window.open(target.url, "_blank", "noopener,noreferrer"),
            },
            actionVariant: "outline" as const,
          }
        : {}),
    }),
  );
}

/**
 * The page's check notices for one pass over `targets`: the records to keep
 * (null when nothing changed) and the pull requests whose checks just passed
 * on a head seen failing or running first. A watched pull request records the
 * pass but is not announced here: its watch announces it.
 */
export function planPrCheckPassNotifications(input: {
  readonly records: ReadonlyArray<NotificationRecord>;
  readonly targets: ReadonlyArray<PrCheckNotificationTarget>;
  readonly nowIso: string;
  readonly isWatched: (target: PrCheckNotificationTarget) => boolean;
}): {
  readonly records: ReadonlyArray<NotificationRecord> | null;
  readonly notify: ReadonlyArray<PrCheckNotificationTarget>;
} {
  const byKey = new Map(input.records.map((record) => [record.key, record]));
  const notify: PrCheckNotificationTarget[] = [];
  let changed = false;
  const now = input.nowIso;

  for (const target of input.targets) {
    if (!shouldPersistStatus(target.status)) continue;
    const key = storageKeyForTarget(target);
    if (!key) continue;

    const existing = byKey.get(key);
    if (target.status.kind === "passed") {
      if (existing?.status === "passed") {
        continue;
      }
      const shouldNotify =
        existing !== undefined && existing.status !== "passed" && existing.notifiedAt === undefined;
      const next: NotificationRecord = {
        key,
        status: "passed",
        updatedAt: now,
        ...(existing?.notifiedAt ? { notifiedAt: existing.notifiedAt } : {}),
        ...(shouldNotify ? { notifiedAt: now } : {}),
      };
      byKey.set(key, next);
      changed = true;
      if (shouldNotify && !input.isWatched(target)) notify.push(target);
      continue;
    }

    if (existing?.status === target.status.kind) {
      continue;
    }
    byKey.set(key, {
      key,
      status: target.status.kind,
      updatedAt: now,
      ...(existing?.notifiedAt ? { notifiedAt: existing.notifiedAt } : {}),
    });
    changed = true;
  }

  return { records: changed ? Array.from(byKey.values()) : null, notify };
}

export function usePrCheckPassNotifications(
  targets: ReadonlyArray<PrCheckNotificationTarget>,
): void {
  useEffect(() => {
    if (targets.length === 0) return;
    const plan = planPrCheckPassNotifications({
      records: readRecords(),
      targets,
      nowIso: new Date().toISOString(),
      isWatched: isWatchedOnServer,
    });
    if (plan.records !== null) writeRecords(plan.records);
    for (const target of plan.notify) notifyChecksPassed(target);
  }, [targets]);
}
