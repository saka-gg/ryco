import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { HttpServerRequest } from "effect/unstable/http";

import { ServerConfig, type ServerConfigShape } from "../config.ts";
import { rejectCrossOriginMutation } from "./http.ts";

const check = (headers: Record<string, string>) =>
  rejectCrossOriginMutation.pipe(
    Effect.provideService(HttpServerRequest.HttpServerRequest, {
      headers: { host: "127.0.0.1:3773", ...headers },
    } as unknown as HttpServerRequest.HttpServerRequest),
    Effect.provideService(ServerConfig, { devUrl: undefined } as unknown as ServerConfigShape),
    Effect.exit,
  );

it.effect("refuses mutations a browser marks cross-site, even with a matching Origin", () =>
  Effect.gen(function* () {
    // A sandboxed page's beacon in WebKit carries the embedding page's Origin.
    const beacon = yield* check({
      origin: "http://127.0.0.1:3773",
      "sec-fetch-site": "cross-site",
    });
    expect(beacon._tag).toBe("Failure");
    const foreign = yield* check({ origin: "http://127.0.0.1:4000" });
    expect(foreign._tag).toBe("Failure");

    for (const headers of [
      { origin: "http://127.0.0.1:3773", "sec-fetch-site": "same-origin" },
      {},
      // Bearer callers from an opaque origin; ServerAuth refuses the cookie case.
      { origin: "null" },
    ]) {
      expect((yield* check(headers))._tag).toBe("Success");
    }
  }),
);
