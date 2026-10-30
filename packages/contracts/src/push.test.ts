import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { PushKeyId, PushSetPresenceResult, PushUnregisterDeviceInput } from "./push.ts";

const keyId = "AAAAAAAAAAAAAAAAAAAAAA";
const publicKey = "x".repeat(43);

describe("push RPCs across versions", () => {
  it("lets a newer app read an older node's empty presence answer, and an older app a newer one", () => {
    expect(Schema.decodeUnknownSync(PushSetPresenceResult)({})).toEqual({});
    const answer = Schema.encodeSync(PushSetPresenceResult)({
      status: {
        eligible: true,
        registered: true,
        keyId: Schema.decodeSync(PushKeyId)(keyId),
        kinds: ["completed"],
        hubDelivery: "available",
      },
    });
    // What an app from before presence answers decodes it with.
    expect(() => Schema.decodeUnknownSync(Schema.Struct({}))(answer)).not.toThrow();
  });

  it("keeps the public key optional, and an older node takes it as a field it ignores", () => {
    expect(Schema.decodeUnknownSync(PushUnregisterDeviceInput)({ keyId })).toEqual({ keyId });
    expect(Schema.decodeUnknownSync(PushUnregisterDeviceInput)({ keyId, publicKey })).toEqual({
      keyId,
      publicKey,
    });
    // What a node from before it decodes the payload with.
    expect(() =>
      Schema.decodeUnknownSync(Schema.Struct({ keyId: PushKeyId }))({ keyId, publicKey }),
    ).not.toThrow();
  });
});
