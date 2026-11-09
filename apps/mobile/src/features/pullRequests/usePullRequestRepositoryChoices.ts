import type { EnvironmentId } from "@ryco/contracts";
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import { selectProjectsAcrossEnvironments, useStore } from "../../state/threadsRuntime";
import { useHomeEnvironments } from "../home/useHomeEnvironments";
import {
  derivePullRequestRepositoryChoices,
  type PullRequestRepositoryChoice,
} from "./pullRequestRepositoriesModel";

export function readablePullRequestConnection(state: string): boolean {
  return state === "connected" || state === "read-only";
}

function splitIds(key: string): EnvironmentId[] {
  return key.length > 0 ? (key.split("\u0000") as EnvironmentId[]) : [];
}

/**
 * The repositories the PRs tab and the global search offer, each read through
 * its best checkout (see `derivePullRequestRepositoryChoices`), with the
 * machines' names. Memoized on string keys so a new environments array with
 * the same content keeps the same choices.
 */
export function usePullRequestRepositoryChoices(): ReadonlyArray<PullRequestRepositoryChoice> {
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const environments = useHomeEnvironments();
  const connectedKey = environments
    .filter((environment) => readablePullRequestConnection(environment.connectionState))
    .map((environment) => environment.environmentId)
    .join("\u0000");
  const actingKey = environments
    .filter((environment) => environment.mutationReady && environment.role !== "viewer")
    .map((environment) => environment.environmentId)
    .join("\u0000");
  const labelsKey = environments
    .map((environment) => `${environment.environmentId}\u0001${environment.label}`)
    .join("\u0000");
  return useMemo(() => {
    const labels = new Map<EnvironmentId, string>();
    for (const entry of labelsKey.length > 0 ? labelsKey.split("\u0000") : []) {
      const [id, label] = entry.split("\u0001");
      if (id && label) labels.set(id as EnvironmentId, label);
    }
    return derivePullRequestRepositoryChoices({
      projects,
      connected: new Set(splitIds(connectedKey)),
      acting: new Set(splitIds(actingKey)),
      environmentLabels: labels,
    });
  }, [actingKey, connectedKey, labelsKey, projects]);
}
