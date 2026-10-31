/**
 * providerReleaseAge - when a provider release was published, so unattended updates leave brand-new
 * releases alone.
 *
 * Loaded with the update runner (`providerMaintenanceRunnerRuntime.ts`), never on boot. An update
 * nobody clicked installs a release only once it is {@link MINIMUM_RELEASE_AGE} old, so a broken
 * release has two days to be pulled or rated before it lands on its own. The age comes from the
 * npm registry's `time[version]` for the package's exact version (every provider CLI Ryco updates
 * publishes there under the same version numbers, whichever installer it came from); a version
 * the registry does not date is never installed unattended.
 *
 * The registry dates versions only in the full package document, which runs to megabytes for
 * packages with many prereleases. It is read only when a release is about to install, never under
 * the install lock, and a version's date is kept for the life of the process: it never changes.
 *
 * @module providerReleaseAge
 */
import { Duration, Effect, Option, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import { npmPackageUrl } from "../npmRegistry.ts";

/** How old a release must be before an unattended update installs it. */
export const MINIMUM_RELEASE_AGE = Duration.hours(48);
/** The full package document is large; a slow registry answer reads as "unknown". */
export const PACKAGE_DOCUMENT_TIMEOUT = Duration.seconds(30);

const PackageTimes = Schema.Struct({ time: Schema.Record(Schema.String, Schema.String) });
const decodePackageTimes = Schema.decodeUnknownEffect(PackageTimes);

// `<package>@<version>` to its publish time in epoch milliseconds. Only answers are kept.
const publishedAtCache = new Map<string, number>();

export function clearProviderReleaseAgeCacheForTests(): void {
  publishedAtCache.clear();
}

/** When `packageName@version` was published (epoch ms), or `null` when the registry does not say. */
export const fetchNpmVersionPublishedAt = Effect.fn("fetchNpmVersionPublishedAt")(function* (
  packageName: string,
  version: string,
) {
  const key = `${packageName}@${version}`;
  const cached = publishedAtCache.get(key);
  if (cached !== undefined) return cached;
  const client = yield* HttpClient.HttpClient;
  const request = HttpClientRequest.get(npmPackageUrl(packageName)).pipe(
    HttpClientRequest.setHeader("accept", "application/json"),
  );
  const published = yield* client.execute(request).pipe(
    Effect.flatMap((response) =>
      response.status >= 200 && response.status < 300
        ? response.json.pipe(Effect.flatMap(decodePackageTimes))
        : Effect.fail(new Error(`npm registry answered ${response.status}`)),
    ),
    Effect.map((document) => Date.parse(document.time[version] ?? "")),
    Effect.timeoutOption(PACKAGE_DOCUMENT_TIMEOUT),
    Effect.catch(() => Effect.succeed(Option.none<number>())),
    Effect.catchDefect(() => Effect.succeed(Option.none<number>())),
  );
  if (Option.isNone(published) || !Number.isFinite(published.value)) return null;
  publishedAtCache.set(key, published.value);
  return published.value;
});
