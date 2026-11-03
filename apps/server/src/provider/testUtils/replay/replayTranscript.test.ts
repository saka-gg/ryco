import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import {
  decodeReplayNdjson,
  encodeReplayNdjson,
  materializeWorkspace,
  readReplayFixture,
  type ReplayTranscript,
} from "./replayTranscript.ts";

const HEADER =
  '{"type":"transcript_start","provider":"codex","protocol":"codex.app-server","version":"0.145.0","scenario":"unit","source":"hand-authored"}';

const transcript: ReplayTranscript = {
  header: {
    type: "transcript_start",
    provider: "codex",
    protocol: "codex.app-server",
    version: "0.145.0",
    scenario: "unit",
    source: "hand-authored",
    metadata: { description: "unit" },
  },
  entries: [
    {
      type: "expect_outbound",
      label: "initialize",
      frame: { params: { b: 1, a: [{ y: 2, x: 1 }] }, method: "initialize", id: 1 },
    },
    { type: "emit_inbound", label: "banner", frame: "warming up", stream: "stderr" },
    { type: "emit_inbound", frame: { result: {}, id: 1 } },
    { type: "expect_outbound", frame: { method: "skills/list", id: 2 }, optional: true },
    { type: "spawn", label: "restart" },
    { type: "runtime_exit", status: "error", code: 3, error: { message: "boom" } },
  ],
};

describe("replay transcript NDJSON", () => {
  it.effect("decodes a header and its entries, skipping blank lines", () =>
    Effect.gen(function* () {
      const decoded = yield* decodeReplayNdjson(
        `${HEADER}\n\n{"type":"spawn"}\r\n{"type":"runtime_exit","status":"success"}\n`,
      );
      assert.equal(decoded.header.scenario, "unit");
      assert.deepEqual(decoded.entries, [
        { type: "spawn" },
        { type: "runtime_exit", status: "success" },
      ]);
    }),
  );

  it.effect("names the line of invalid JSON and of an invalid entry", () =>
    Effect.gen(function* () {
      const badJson = yield* Effect.flip(decodeReplayNdjson(`${HEADER}\n\n{"type":`));
      assert.equal(badJson._tag, "ReplayNdjsonLineError");
      assert.equal(badJson._tag === "ReplayNdjsonLineError" && badJson.lineNumber, 3);
      assert.include(badJson.message, "line 3");

      const badEntry = yield* Effect.flip(
        decodeReplayNdjson(`${HEADER}\n{"type":"runtime_exit","status":"crashed"}`),
      );
      assert.equal(badEntry._tag === "ReplayNdjsonLineError" && badEntry.lineNumber, 2);
      assert.include(badEntry.message, "invalid entry");
    }),
  );

  it.effect("accepts the header on line 1 only", () =>
    Effect.gen(function* () {
      const late = yield* Effect.flip(decodeReplayNdjson(`${HEADER}\n${HEADER}`));
      assert.equal(late._tag, "ReplayNdjsonLineError");
      assert.equal(late._tag === "ReplayNdjsonLineError" && late.lineNumber, 2);
      assert.include(late.message, "only valid on line 1");

      const missing = yield* Effect.flip(decodeReplayNdjson(`{"type":"spawn"}\n${HEADER}`));
      assert.equal(missing._tag, "ReplayMissingHeaderError");
      assert.equal(missing._tag === "ReplayMissingHeaderError" && missing.lineNumber, 1);

      const empty = yield* Effect.flip(decodeReplayNdjson("\n  \n"));
      assert.equal(empty._tag, "ReplayEmptyError");
    }),
  );

  it.effect("round-trips through encode with a stable key order", () =>
    Effect.gen(function* () {
      const text = encodeReplayNdjson(transcript);
      assert.deepEqual(yield* decodeReplayNdjson(text), transcript);
      assert.equal(encodeReplayNdjson(yield* decodeReplayNdjson(text)), text);
      const lines = text.trimEnd().split("\n");
      assert.equal(
        lines[1],
        '{"type":"expect_outbound","label":"initialize","frame":{"id":1,"method":"initialize","params":{"a":[{"x":1,"y":2}],"b":1}}}',
      );
      assert.equal(
        lines[6],
        '{"type":"runtime_exit","status":"error","code":3,"error":{"message":"boom"}}',
      );
    }),
  );

  it.effect("keeps the checked-in fixtures in their encoded form", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixtureDir = yield* path.fromFileUrl(
        new URL("../../../../integration/replay/fixtures/", import.meta.url),
      );
      for (const provider of yield* fileSystem.readDirectory(fixtureDir)) {
        for (const file of yield* fileSystem.readDirectory(path.join(fixtureDir, provider))) {
          if (!file.endsWith(".ndjson")) continue;
          const filePath = path.join(fixtureDir, provider, file);
          const text = yield* fileSystem.readFileString(filePath);
          const decoded = yield* readReplayFixture(yield* path.toFileUrl(filePath));
          assert.equal(decoded.header.provider, provider, file);
          assert.equal(encodeReplayNdjson(decoded), text, `${provider}/${file} is not canonical`);
          assert.isBelow(text.length, 50_000, `${provider}/${file} is too large`);
        }
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it("materializes workspace and home placeholders in outbound and inbound frames", () => {
    const materialized = materializeWorkspace(
      {
        header: transcript.header,
        entries: [
          {
            type: "expect_outbound",
            frame: { cwd: "<workspace>", paths: ["<workspace>/src", "<home>/.config", "x<home>"] },
          },
          { type: "emit_inbound", frame: { result: { cwd: "<workspace>" } } },
          { type: "runtime_exit", status: "error", error: { cwd: "<workspace>" } },
        ],
      },
      { workspace: "/tmp/run/workspace", home: "/tmp/run/home" },
    );
    assert.deepEqual(
      materialized.entries.map((entry) =>
        "frame" in entry ? entry.frame : "error" in entry ? entry.error : undefined,
      ),
      [
        {
          cwd: "/tmp/run/workspace",
          paths: ["/tmp/run/workspace/src", "/tmp/run/home/.config", "x<home>"],
        },
        { result: { cwd: "/tmp/run/workspace" } },
        // A recorded failure stays as recorded.
        { cwd: "<workspace>" },
      ],
    );
  });
});
