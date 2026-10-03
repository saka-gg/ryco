import { Option, Result, Schema } from "effect";
import { decodeJsonResult, formatSchemaError } from "@ryco/shared/schemaJson";

/**
 * Which of a pull request's checks branch protection requires.
 *
 * `gh pr view --json statusCheckRollup` does not say, so the detail asks
 * GraphQL separately: every `StatusCheckRollupContext` (a `CheckRun` or a
 * `StatusContext`) exposes `isRequired(pullRequestNumber:)`, evaluated
 * against the rules of the pull request's base branch (classic protection and
 * rulesets alike). The rollup is read on the exact head commit the detail
 * reported, so both answers describe the same set of checks.
 *
 * Docs:
 * - https://docs.github.com/en/graphql/reference/objects#checkrun (`isRequired`)
 * - https://docs.github.com/en/graphql/reference/objects#statuscontext (`isRequired`)
 * - https://docs.github.com/en/graphql/reference/objects#statuscheckrollup (`contexts`)
 * - https://docs.github.com/en/graphql/reference/unions#statuscheckrollupcontext
 */

export const GITHUB_REQUIRED_CHECKS_PAGE_SIZE = 100;
/** 500 checks on one commit is far past any real pull request; stop there. */
export const GITHUB_REQUIRED_CHECKS_MAX_PAGES = 5;

export const GITHUB_REQUIRED_CHECKS_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $oid: GitObjectID!, $first: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    object(oid: $oid) {
      ... on Commit {
        statusCheckRollup {
          contexts(first: $first, after: $after) {
            nodes {
              __typename
              ... on CheckRun { name detailsUrl isRequired(pullRequestNumber: $number) }
              ... on StatusContext { context targetUrl isRequired(pullRequestNumber: $number) }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    }
  }
}`;

export interface NormalizedGitHubRequiredCheck {
  readonly kind: "check-run" | "status-context";
  readonly name: string;
  readonly url: string | null;
  readonly isRequired: boolean;
}

export interface DecodedGitHubRequiredChecksPage {
  readonly checks: ReadonlyArray<NormalizedGitHubRequiredCheck>;
  readonly hasNextPage: boolean;
  readonly endCursor: string | null;
}

const OptionalString = Schema.optional(Schema.NullOr(Schema.String));

const RequiredChecksPageSchema = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.NullOr(
      Schema.Struct({
        object: Schema.NullOr(
          Schema.Struct({
            // Absent when the object is not a commit; null before any check reports.
            statusCheckRollup: Schema.optional(
              Schema.NullOr(
                Schema.Struct({
                  contexts: Schema.Struct({
                    nodes: Schema.Array(
                      Schema.NullOr(
                        Schema.Struct({
                          __typename: OptionalString,
                          name: OptionalString,
                          detailsUrl: OptionalString,
                          context: OptionalString,
                          targetUrl: OptionalString,
                          isRequired: Schema.optional(Schema.NullOr(Schema.Boolean)),
                        }),
                      ),
                    ),
                    pageInfo: Schema.Struct({
                      hasNextPage: Schema.Boolean,
                      endCursor: OptionalString,
                    }),
                  }),
                }),
              ),
            ),
          }),
        ),
      }),
    ),
  }),
});

const decodeRequiredChecksPage = decodeJsonResult(RequiredChecksPageSchema);

function trimmed(value: string | null | undefined): string | null {
  const text = value?.trim() ?? "";
  return text.length > 0 ? text : null;
}

export function decodeGitHubRequiredChecksPageJson(
  raw: string,
): Result.Result<DecodedGitHubRequiredChecksPage, string> {
  const decoded = decodeRequiredChecksPage(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(
      `Invalid GitHub required checks response: ${formatSchemaError(decoded.failure)}`,
    );
  }
  const contexts = decoded.success.data.repository?.object?.statusCheckRollup?.contexts;
  if (!contexts) return Result.succeed({ checks: [], hasNextPage: false, endCursor: null });

  const checks: NormalizedGitHubRequiredCheck[] = [];
  for (const node of contexts.nodes) {
    if (!node || typeof node.isRequired !== "boolean") continue;
    const kind =
      node.__typename === "CheckRun"
        ? "check-run"
        : node.__typename === "StatusContext"
          ? "status-context"
          : null;
    const name = kind === "check-run" ? trimmed(node.name) : trimmed(node.context);
    if (kind === null || name === null) continue;
    checks.push({
      kind,
      name,
      url: kind === "check-run" ? trimmed(node.detailsUrl) : trimmed(node.targetUrl),
      isRequired: node.isRequired,
    });
  }
  return Result.succeed({
    checks,
    hasNextPage: contexts.pageInfo.hasNextPage,
    endCursor: trimmed(contexts.pageInfo.endCursor),
  });
}

/** The value every entry under `key` agrees on, or null when they disagree. */
function agreed(index: Map<string, boolean | null>, key: string): boolean | null {
  return index.get(key) ?? null;
}

function record(index: Map<string, boolean | null>, key: string, value: boolean) {
  const current = index.get(key);
  if (current === undefined) index.set(key, value);
  else if (current !== value) index.set(key, null);
}

/**
 * Marks each rollup item with whether it is required. An item matches a
 * required-check entry by kind, name and link (an Actions job link names one
 * job); a re-run that started between the two reads matches by kind and name
 * alone, since GitHub decides required-ness by check name. Ambiguous or
 * unmatched items stay unmarked: unknown, never guessed as optional.
 */
export function applyGitHubRequiredChecks<
  T extends {
    readonly kind: "check-run" | "status-context" | "unknown";
    readonly name: string;
    readonly url: Option.Option<string>;
  },
>(
  rollup: ReadonlyArray<T>,
  required: ReadonlyArray<NormalizedGitHubRequiredCheck>,
): ReadonlyArray<T & { readonly isRequired?: boolean }> {
  if (required.length === 0) return rollup;
  const byLink = new Map<string, boolean | null>();
  const byName = new Map<string, boolean | null>();
  for (const check of required) {
    record(byLink, `${check.kind}\u0000${check.name}\u0000${check.url ?? ""}`, check.isRequired);
    record(byName, `${check.kind}\u0000${check.name}`, check.isRequired);
  }
  return rollup.map((item) => {
    if (item.kind === "unknown") return item;
    const name = `${item.kind}\u0000${item.name}`;
    const isRequired =
      agreed(byLink, `${name}\u0000${Option.getOrElse(item.url, () => "")}`) ??
      agreed(byName, name);
    return isRequired === null ? item : { ...item, isRequired };
  });
}
