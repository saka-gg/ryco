import type { ChangeRequestState, SourceControlChangeRequestStack } from "@ryco/contracts";

/**
 * The detail screen's stack navigator: every layer of the pull request's
 * host-native stack, from the base up, with the one on screen marked.
 */
export interface PullRequestStackLayerModel {
  readonly number: number;
  readonly title: string;
  readonly state: ChangeRequestState;
  readonly isDraft: boolean;
  readonly current: boolean;
  /** 1 is the bottom layer, on the base branch. */
  readonly position: number;
}

export interface PullRequestStackNavigatorModel {
  readonly baseRefName: string;
  readonly layers: ReadonlyArray<PullRequestStackLayerModel>;
  /** "2 of 3"; null when the pull request on screen is not among the layers. */
  readonly positionLabel: string | null;
}

export function derivePullRequestStackNavigator(
  stack: SourceControlChangeRequestStack | null | undefined,
  number: number,
): PullRequestStackNavigatorModel | null {
  if (!stack || stack.entries.length < 2) return null;
  const layers = stack.entries
    .toSorted((left, right) => left.position - right.position)
    .map((entry) => ({
      number: entry.number,
      title: entry.title,
      state: entry.state,
      isDraft: entry.isDraft,
      current: entry.number === number,
      position: entry.position,
    }));
  const current = layers.find((layer) => layer.current);
  return {
    baseRefName: stack.baseRefName,
    layers,
    positionLabel: current ? `${current.position} of ${layers.length}` : null,
  };
}
