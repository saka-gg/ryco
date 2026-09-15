import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import { AuthSessionId } from "@ryco/contracts";
import { createSpeechConnection } from "./connection.ts";
import { createSpeechService } from "./service.ts";
import type { RpcPrincipal } from "../ws/RpcPrincipal.ts";

it("two sockets sharing one direct auth session cannot cancel each other's job", async () => {
  let entered = false,
    killed = false;
  let exit!: () => void;
  const service = createSpeechService({
    supported: () => true,
    ready: async () => true,
    install: async () => {},
    remove: async () => {},
    transcribe: async (_, signal) => {
      entered = true;
      return new Promise<string>((_, reject) => {
        exit = () => reject(new Error("exited"));
        signal.addEventListener("abort", () => {
          killed = true;
        });
      });
    },
  });
  const principal: RpcPrincipal = {
    transport: "direct",
    role: "owner",
    scopeId: "same-session",
    directSessionId: AuthSessionId.make("same-session"),
    canManageLocalAccess: true,
  };
  const a = createSpeechConnection(service, principal),
    b = createSpeechConnection(service, principal);
  await Effect.runPromise(a.request({ action: "begin", requestId: "one" }));
  await Effect.runPromise(
    a.request({ action: "chunk", requestId: "one", sequence: 0, pcm: "AQA=" }),
  );
  const inference = Effect.runPromise(a.request({ action: "finish", requestId: "one" })).catch(
    () => {},
  );
  await vi.waitFor(() => expect(entered).toBe(true));
  await Effect.runPromise(b.request({ action: "cancel", requestId: "one" }));
  await b.close();
  expect(killed).toBe(false);
  const closing = a.close();
  expect(killed).toBe(true);
  expect((await Effect.runPromise(b.request({ action: "status" }))).state).toBe("busy");
  exit();
  await closing;
  await inference;
  expect((await Effect.runPromise(b.request({ action: "status" }))).state).toBe("ready");
});
it("retains existing owner-only authorization", async () => {
  const service = createSpeechService({
    supported: () => true,
    ready: async () => true,
    install: async () => {},
    remove: async () => {},
    transcribe: async () => "",
  });
  const connection = createSpeechConnection(service, {
    transport: "relay",
    role: "operator",
    scopeId: "channel",
    canManageLocalAccess: false,
  });
  await expect(
    Effect.runPromise(connection.request({ action: "begin", requestId: "one" })),
  ).rejects.toThrow("Only owner");
});
