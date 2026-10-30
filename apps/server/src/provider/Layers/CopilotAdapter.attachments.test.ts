import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
} from "@ryco/contracts";
import { Effect, Layer } from "effect";

import { attachmentRelativePath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { drainRuntimeEvents } from "../testUtils/adapterRetention.ts";
import { makeFakeCopilotClient } from "../testUtils/fakeCopilotClient.ts";
import { makeCopilotAdapter } from "./CopilotAdapter.ts";

describe("Copilot adapter attachments", () => {
  const testLayer = ServerConfig.layerTest("/tmp", { prefix: "ryco-copilot-attachments-" }).pipe(
    Layer.provideMerge(NodeServices.layer),
  );
  const instanceId = ProviderInstanceId.make("copilot");

  it.live("sends a pasted image as a blob and tells the agent where it is saved", () =>
    Effect.gen(function* () {
      const copilot = makeFakeCopilotClient("copilot-attachments-session");
      const session = (yield* Effect.promise(() => copilot.client.createSession())) as {
        send: (payload: unknown) => Promise<void>;
      };
      const sent: unknown[] = [];
      session.send = async (payload) => {
        sent.push(payload);
        copilot.send("assistant.turn_start", { turnId: "turn-1" });
      };
      const adapter = yield* makeCopilotAdapter(
        { binaryPath: "copilot" },
        { instanceId, clientFactory: () => copilot.client as never },
      );
      yield* drainRuntimeEvents(adapter.streamEvents);
      const threadId = ThreadId.make("thread-copilot-attachments");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("copilot"),
        providerInstanceId: instanceId,
        runtimeSessionId: RuntimeSessionId.make("runtime-copilot-attachments"),
        threadId,
        runtimeMode: "full-access",
      });

      const { attachmentsDir } = yield* ServerConfig;
      const image = {
        type: "image" as const,
        id: "thread-copilot-image-12345678-1234-1234-1234-123456789abc",
        name: "screenshot.png",
        mimeType: "image/png",
        sizeBytes: 4,
      };
      const imagePath = path.join(attachmentsDir, attachmentRelativePath(image)!);
      yield* Effect.promise(async () => {
        await mkdir(path.dirname(imagePath), { recursive: true });
        await writeFile(imagePath, Uint8Array.from([1, 2, 3, 4]));
      });

      yield* adapter.sendTurn({
        threadId,
        input: "Put this screenshot in the PR",
        attachments: [image],
      });

      assert.deepEqual(sent, [
        {
          prompt: `Put this screenshot in the PR\n\n[Attached image "screenshot.png" is saved at: ${imagePath}]`,
          attachments: [
            {
              type: "blob",
              data: "AQIDBA==",
              mimeType: "image/png",
              displayName: "screenshot.png",
            },
          ],
          mode: "immediate",
        },
      ]);
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.provide(testLayer)),
  );
});
