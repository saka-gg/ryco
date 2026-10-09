import { describe, expect, it } from "vite-plus/test";

import { connectionToneForEnvironment, resolveConnectionTone } from "./connectionTone";

describe("connectionTone", () => {
  it("maps each connection state to a labelled tone", () => {
    expect(resolveConnectionTone("connected").label).toBe("Connected");
    expect(resolveConnectionTone("error").label).toBe("Connection failed");
    expect(resolveConnectionTone("offline").label).toBe("Offline");
  });

  it("overlays the single-socket reconnecting state on a connected env", () => {
    expect(connectionToneForEnvironment("connected", "reconnecting").label).toBe("Offline");
    // offline socket wins regardless of the per-env state
    expect(connectionToneForEnvironment("connected", "offline").label).toBe("Offline");
    // otherwise the per-env state stands
    expect(connectionToneForEnvironment("connecting", "connecting").label).toBe("Connecting");
    expect(connectionToneForEnvironment("disconnected", "connected").label).toBe("Disconnected");
  });
});
