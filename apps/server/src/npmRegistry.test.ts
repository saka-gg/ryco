import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import * as TestClock from "effect/testing/TestClock";

import { fetchNpmDistTagVersion, npmDistTagUrl } from "./npmRegistry.ts";

const clientAnswering = (respond: (url: string) => Response, urls: Array<string> = []) =>
  HttpClient.make((request) => {
    urls.push(request.url);
    return Effect.succeed(HttpClientResponse.fromWeb(request, respond(request.url)));
  });

const fetchWith = (client: HttpClient.HttpClient, name = "ryco-cli", tag = "latest") =>
  fetchNpmDistTagVersion(name, tag).pipe(Effect.provideService(HttpClient.HttpClient, client));

describe("npmRegistry", () => {
  it("keeps a scoped name's @ and encodes only its slash", () => {
    expect(npmDistTagUrl("ryco-cli", "nightly")).toBe(
      "https://registry.npmjs.org/ryco-cli/nightly",
    );
    expect(npmDistTagUrl("@openai/codex", "latest")).toBe(
      "https://registry.npmjs.org/@openai%2fcodex/latest",
    );
  });

  it.effect("reads the version a dist-tag points at", () =>
    Effect.gen(function* () {
      const urls: Array<string> = [];
      const client = clientAnswering(() => Response.json({ version: " 0.1.36 " }), urls);
      expect(yield* fetchWith(client, "ryco-cli", "nightly")).toBe("0.1.36");
      expect(urls).toEqual(["https://registry.npmjs.org/ryco-cli/nightly"]);
    }),
  );

  it.effect("answers null for an HTTP error, an unexpected body or a failed request", () =>
    Effect.gen(function* () {
      expect(
        yield* fetchWith(clientAnswering(() => new Response("missing", { status: 404 }))),
      ).toBeNull();
      expect(
        yield* fetchWith(clientAnswering(() => Response.json({ name: "ryco-cli" }))),
      ).toBeNull();
      expect(yield* fetchWith(clientAnswering(() => new Response("not json")))).toBeNull();
      expect(yield* fetchWith(clientAnswering(() => Response.json({ version: "  " })))).toBeNull();
      const failing = HttpClient.make((request) =>
        Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request, cause: new Error("offline") }),
          }),
        ),
      );
      expect(yield* fetchWith(failing)).toBeNull();
    }),
  );

  it.effect("gives up after four seconds", () =>
    Effect.gen(function* () {
      const hanging = HttpClient.make(() => Effect.never);
      const fiber = yield* Effect.forkChild(fetchWith(hanging));
      yield* TestClock.adjust("4 seconds");
      expect(yield* Fiber.join(fiber)).toBeNull();
    }),
  );
});
