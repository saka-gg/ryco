import { describe, expect, it } from "vite-plus/test";
import { Effect, Layer, Tracer } from "effect";
import { Headers, HttpEffect, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeLocalFileTracer } from "./LocalFileTracer.ts";

describe("HTTP credential redaction", () => {
  it("keeps credentials usable by handlers but removes them from request and response spans", async () => {
    const spans: Array<Tracer.Span> = [];
    const directory = mkdtempSync(join(tmpdir(), "ryco-http-redaction-"));
    const filePath = join(directory, "trace.ndjson");
    const delegate = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });
    const sensitive = {
      authorization: "Bearer test-only-access",
      cookie: "test-only-session",
      "set-cookie": "test-only-response-session",
      "x-api-key": "test-only-api-key",
      "x-ryco-desktop-control": "test-only-desktop-control",
      dpop: "test-only-proof",
      "dpop-nonce": "test-only-nonce",
      "x-custom-credential": "test-only-custom-credential",
    };
    const layer = Layer.effect(
      Tracer.Tracer,
      makeLocalFileTracer({
        filePath,
        maxBytes: 1024 * 1024,
        maxFiles: 1,
        batchWindowMs: 10000,
        delegate,
      }),
    ).pipe(
      Layer.provide(
        Layer.succeed(Headers.CurrentRedactedNames, [
          "authorization",
          "cookie",
          "set-cookie",
          "x-api-key",
          "x-custom-credential",
        ]),
      ),
    );
    const { handler, dispose } = HttpEffect.toWebHandlerLayer(
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        for (const [name, value] of Object.entries(sensitive)) {
          expect(request.headers[name]).toBe(value);
        }
        return HttpServerResponse.empty({ headers: { ...sensitive, "x-test-status": "ready" } });
      }),
      layer,
    );
    try {
      const response = await handler(new Request("http://localhost/test", { headers: sensitive }));
      expect(response.status).toBe(204);
      expect(response.headers.get("dpop-nonce")).toBe(sensitive["dpop-nonce"]);
      await expect.poll(() => spans[0]?.status._tag).toBe("Ended");
      const attributes = Object.fromEntries(spans[0]!.attributes);
      for (const name of Object.keys(sensitive)) {
        for (const direction of ["request", "response"]) {
          expect(attributes[`http.${direction}.header.${name}`]).toBe("<redacted>");
        }
      }
      expect(attributes["http.response.header.x-test-status"]).toBe("ready");
      for (const value of Object.values(sensitive)) {
        expect(JSON.stringify(attributes)).not.toContain(value);
      }
      await dispose();
      const trace = readFileSync(filePath, "utf8");
      expect(trace).toContain("http.request.header.x-ryco-desktop-control");
      for (const value of Object.values(sensitive)) expect(trace).not.toContain(value);
    } finally {
      await dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
