import { EnvironmentId, type ServerConfig } from "@ryco/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  patchEnvironmentServerSettings,
  readEnvironmentServerConfig,
  resetEnvironmentServerConfigsForTests,
  writeEnvironmentServerConfig,
} from "./environmentServerConfigs";

const ENVIRONMENT_ID = EnvironmentId.make("node-a");

beforeEach(resetEnvironmentServerConfigsForTests);

describe("environment server config snapshots", () => {
  it("keeps each environment isolated and applies settings snapshots optimistically", () => {
    const config = {
      environment: { id: ENVIRONMENT_ID, label: "Node A", capabilities: {} },
      providers: [],
      settings: {
        responseStreamingMode: "turn",
        textGenerationModelSelection: { instanceId: "codex", model: "gpt-5.4" },
      },
    } as unknown as ServerConfig;
    writeEnvironmentServerConfig(ENVIRONMENT_ID, config);

    patchEnvironmentServerSettings(ENVIRONMENT_ID, {
      textGenerationModelSelection: {
        instanceId: "codex" as never,
        model: "gpt-5.6",
      },
    });

    expect(readEnvironmentServerConfig(ENVIRONMENT_ID)?.settings).toMatchObject({
      responseStreamingMode: "turn",
      textGenerationModelSelection: { model: "gpt-5.6" },
    });
    expect(readEnvironmentServerConfig(EnvironmentId.make("node-b"))).toBeNull();
  });
});
