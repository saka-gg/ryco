import { expect, it } from "vite-plus/test";
import { Schema } from "effect";
import {
  SessionImportDiscoverInput,
  SessionImportReconcileInput,
  SessionImportAdoptInput,
} from "./sessionImport.ts";
import { WS_METHODS, WsRpcGroup } from "./rpc.ts";
it("requires opaque store/import receipts rather than arbitrary native IDs or paths", () => {
  const discover = { source: "codex", search: "", offset: 0, includeArchived: false };
  expect(Schema.decodeUnknownSync(SessionImportDiscoverInput)(discover)).toEqual(discover);
  expect(() =>
    Schema.decodeUnknownSync(SessionImportDiscoverInput)({
      ...discover,
      storeKey: "/synthetic/store",
    }),
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(SessionImportReconcileInput)({
      source: "codex",
      key: "11111111-1111-4111-8111-111111111111",
    }),
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(SessionImportAdoptInput)({
      source: "codex",
      key: "a".repeat(64),
      adoptionToken: "x".repeat(65),
    }),
  ).toThrow();
  for (const method of [
    WS_METHODS.sessionImportSources,
    WS_METHODS.sessionImportReconcile,
    WS_METHODS.sessionImportAdopt,
  ])
    expect(WsRpcGroup.requests.has(method)).toBe(true);
});
