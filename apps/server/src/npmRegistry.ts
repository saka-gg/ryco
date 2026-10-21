/**
 * npmRegistry - Reads one dist-tag of a package from the public npm registry.
 *
 * Every lookup is bounded and never fails: an unreachable registry, a slow answer,
 * an HTTP error or an unexpected body all read as "unknown" (`null`), so callers
 * can treat the registry as optional.
 *
 * @module npmRegistry
 */
import { Duration, Effect, Option, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

/** A registry lookup never holds its caller longer than this. */
export const NPM_REGISTRY_TIMEOUT = Duration.seconds(4);

const NPM_REGISTRY_ORIGIN = "https://registry.npmjs.org";

const DistTagManifest = Schema.Struct({ version: Schema.String });
const decodeDistTagManifest = Schema.decodeUnknownEffect(DistTagManifest);

/**
 * The registry URL of `packageName@distTag`. npm convention: a scoped name keeps its
 * `@` literal and only `/` is encoded (some proxies reject an encoded `@`).
 */
export function npmDistTagUrl(packageName: string, distTag: string): string {
  return `${NPM_REGISTRY_ORIGIN}/${packageName.replaceAll("/", "%2f")}/${encodeURIComponent(distTag)}`;
}

/** The version `distTag` (e.g. `latest`, `nightly`) points at, or `null` when it is unknown. */
export const fetchNpmDistTagVersion = Effect.fn("fetchNpmDistTagVersion")(function* (
  packageName: string,
  distTag: string,
) {
  const client = yield* HttpClient.HttpClient;
  const request = HttpClientRequest.get(npmDistTagUrl(packageName, distTag)).pipe(
    HttpClientRequest.setHeader("accept", "application/json"),
  );
  const version = yield* client.execute(request).pipe(
    Effect.flatMap((response) =>
      response.status >= 200 && response.status < 300
        ? response.json.pipe(Effect.flatMap(decodeDistTagManifest))
        : Effect.fail(new Error(`npm registry answered ${response.status}`)),
    ),
    Effect.map((manifest) => manifest.version.trim()),
    // The body read counts against the same bound as the request.
    Effect.timeoutOption(NPM_REGISTRY_TIMEOUT),
    Effect.catch(() => Effect.succeed(Option.none<string>())),
    Effect.catchDefect(() => Effect.succeed(Option.none<string>())),
  );
  return Option.isSome(version) && version.value.length > 0 ? version.value : null;
});
