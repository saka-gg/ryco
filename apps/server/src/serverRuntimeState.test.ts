import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, Option } from "effect";

import {
  clearPersistedServerRuntimeStateIfStale,
  parsePersistedServerRuntimeState,
  type PersistedServerProbe,
  persistedServerHost,
} from "./serverRuntimeState.ts";

const state = { pid: 4242, port: 3773, origin: "http://127.0.0.1:3773" };

it.effect("keeps the runtime file of a live server that did not answer in time", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ryco-runtime-state-"));
  const path = NodePath.join(directory, "server-runtime.json");
  const probe = (alive: boolean, listening: boolean): PersistedServerProbe => ({
    processAlive: () => alive,
    isListening: async () => listening,
  });
  return Effect.gen(function* () {
    NodeFS.writeFileSync(path, "{}\n");
    // A busy or still-hydrating server: its kernel still accepts connections.
    yield* clearPersistedServerRuntimeStateIfStale(path, state, probe(true, true));
    assert.isTrue(NodeFS.existsSync(path));
    // Its pid now belongs to another process that serves nothing there: stale.
    yield* clearPersistedServerRuntimeStateIfStale(path, state, probe(true, false));
    assert.isFalse(NodeFS.existsSync(path));
    // Its process is gone: stale.
    NodeFS.writeFileSync(path, "{}\n");
    yield* clearPersistedServerRuntimeStateIfStale(path, state, probe(false, true));
    assert.isFalse(NodeFS.existsSync(path));
  }).pipe(
    Effect.provide(NodeServices.layer),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true }))),
  );
});

it("parses the runtime file every server writes, and its host", () => {
  const parsed = parsePersistedServerRuntimeState(
    `${JSON.stringify({ version: 1, ...state, origin: "http://[::1]:3773", startedAt: "x" })}\n`,
  );
  assert.isTrue(Option.isSome(parsed));
  if (Option.isSome(parsed)) assert.equal(persistedServerHost(parsed.value), "::1");
  assert.isTrue(Option.isNone(parsePersistedServerRuntimeState("{")));
  assert.isTrue(Option.isNone(parsePersistedServerRuntimeState('{"pid":1}')));
  assert.equal(persistedServerHost({ origin: "not a url" }), "127.0.0.1");
});
