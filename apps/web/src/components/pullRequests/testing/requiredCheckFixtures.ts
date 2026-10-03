import type {
  SourceControlChangeRequestDetail,
  SourceControlCheckRollupItem,
} from "@ryco/contracts";
import { Option } from "effect";

import { fixtureDetail } from "./pullRequestFixtures";

/**
 * The shared fixtures leave `isRequired` out, the way a host that does not
 * mark required checks reports them. These mark them the way GitHub's detail
 * does after its required-checks lookup.
 */
export interface FixtureRequiredChecks {
  /** Check names the base branch requires; every other check is optional. */
  readonly required: ReadonlyArray<string>;
  /** Check names that also fail. */
  readonly failing?: ReadonlyArray<string>;
  /** The merge state the host reports with these checks (default: the fixture's). */
  readonly mergeStateStatus?: SourceControlChangeRequestDetail["mergeStateStatus"];
}

const FAILED = {
  status: Option.some("COMPLETED"),
  conclusion: Option.some("FAILURE"),
} as const;

export function fixtureRequiredRollup(
  number: number,
  input: FixtureRequiredChecks,
): ReadonlyArray<SourceControlCheckRollupItem> {
  const required = new Set(input.required);
  const failing = new Set(input.failing ?? []);
  const marked: SourceControlCheckRollupItem[] = [];
  for (const item of fixtureDetail(number).checkRollup ?? []) {
    marked.push({
      ...item,
      isRequired: required.has(item.name),
      ...(failing.has(item.name) ? FAILED : {}),
    });
  }
  return marked;
}

/** The detail with a marked rollup, for a test provider's `detailState.data`. */
export function fixtureRequiredDetail(
  number: number,
  input: FixtureRequiredChecks,
): SourceControlChangeRequestDetail {
  return {
    ...fixtureDetail(number),
    checkRollup: fixtureRequiredRollup(number, input),
    ...(input.mergeStateStatus ? { mergeStateStatus: input.mergeStateStatus } : {}),
  };
}
