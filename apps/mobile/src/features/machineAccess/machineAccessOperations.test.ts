import { RemoteEnvironmentAuthHttpError } from "@ryco/client-runtime/connection";
import type {
  RemoteMachineAccessApi,
  RemoteMachineAccessTarget,
} from "@ryco/client-runtime/machineAccess/remoteMachineAccess";
import { AuthSessionId, EnvironmentId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  attemptHostedNodeRevoke,
  createDirectAccessOperations,
  directAccessErrorMessage,
  MachinePairingUnavailableError,
  runDirectAccessAction,
} from "./machineAccessOperations";

const ENVIRONMENT = EnvironmentId.make("environment-1");

function fakeApi() {
  const targets: RemoteMachineAccessTarget[] = [];
  const api: RemoteMachineAccessApi = {
    createPairingCredential: async (target, label) => {
      targets.push(target);
      return {
        id: "link-1",
        credential: "ABCDEFGHJKLM",
        ...(label === null ? {} : { label }),
        // Read off JSON undecoded, as the node answers it.
        expiresAt: "2036-04-07T10:05:00.000Z" as never,
      };
    },
    revokePairingLink: async (target) => {
      targets.push(target);
    },
    revokeClientSession: async (target) => {
      targets.push(target);
    },
    revokeOtherClientSessions: async (target) => {
      targets.push(target);
      return 2;
    },
  };
  return { api, targets };
}

describe("createDirectAccessOperations", () => {
  it("reads the pairing's current bearer for every call", async () => {
    const { api, targets } = fakeApi();
    let bearer = "bearer-1";
    const operations = createDirectAccessOperations(ENVIRONMENT, {
      api,
      readHttpBaseUrl: () => "http://192.168.1.20:3773/",
      readBearerToken: async () => bearer,
    });

    const code = await operations.createCode("iPad");
    expect(code).toEqual({
      id: "link-1",
      credential: "ABCDEFGHJKLM",
      label: "iPad",
      expiresAt: "2036-04-07T10:05:00.000Z",
    });
    // A renewal replaced the bearer: the next call presents the new one.
    bearer = "bearer-2";
    await operations.revokeCode("link-1");
    await operations.revokeClientSession(AuthSessionId.make("session-2"));
    await expect(operations.revokeOtherClientSessions()).resolves.toBe(2);
    expect(targets.map((target) => target.bearerToken)).toEqual([
      "bearer-1",
      "bearer-2",
      "bearer-2",
      "bearer-2",
    ]);
  });

  it("refuses without a saved pairing rather than calling the node", async () => {
    const { api, targets } = fakeApi();
    const operations = createDirectAccessOperations(ENVIRONMENT, {
      api,
      readHttpBaseUrl: () => "http://192.168.1.20:3773/",
      readBearerToken: async () => null,
    });
    await expect(operations.revokeCode("link-1")).rejects.toBeInstanceOf(
      MachinePairingUnavailableError,
    );
    const forgotten = createDirectAccessOperations(ENVIRONMENT, {
      api,
      readHttpBaseUrl: () => null,
      readBearerToken: async () => "bearer",
    });
    await expect(forgotten.createCode(null)).rejects.toBeInstanceOf(MachinePairingUnavailableError);
    expect(targets).toEqual([]);
  });
});

describe("directAccessErrorMessage", () => {
  it("names what the node refused and why", () => {
    expect(
      directAccessErrorMessage(
        new RemoteEnvironmentAuthHttpError("Only owner sessions can manage network access.", 403),
        "revoke this pairing link",
        "Studio",
      ),
    ).toBe("Only an owner pairing can revoke this pairing link on Studio.");
    expect(
      directAccessErrorMessage(new RemoteEnvironmentAuthHttpError("no", 401), "x", "Studio"),
    ).toContain("Pair it again");
    expect(directAccessErrorMessage(new TypeError("fetch failed"), "x", "Studio")).toContain(
      "Could not reach Studio",
    );
    expect(directAccessErrorMessage(new MachinePairingUnavailableError(), "x", "Studio")).toContain(
      "no longer has a saved pairing",
    );
  });

  it("turns a failure into the screen's sentence and a success into its value", async () => {
    await expect(
      runDirectAccessAction(
        async () => 3,
        () => "failed",
      ),
    ).resolves.toEqual({
      ok: true,
      value: 3,
    });
    await expect(
      runDirectAccessAction(
        async () => {
          throw new Error("boom");
        },
        () => "failed",
      ),
    ).resolves.toEqual({ ok: false, message: "failed" });
  });
});

describe("attemptHostedNodeRevoke", () => {
  it("reports nothing once the Hub confirmed", async () => {
    await expect(attemptHostedNodeRevoke(async () => undefined)).resolves.toBeNull();
  });

  it("words a lost answer for the app and never claims nothing changed", async () => {
    const failure = await attemptHostedNodeRevoke(async () => {
      throw Object.assign(new Error("unavailable"), { code: "unavailable", status: 0 });
    });
    expect(failure?.outcome).toBe("unknown");
    expect(failure?.message).toContain("this device");
    expect(failure?.message.toLowerCase()).not.toContain("nothing was changed");
  });

  it("keeps a Hub refusal retryable", async () => {
    const failure = await attemptHostedNodeRevoke(async () => {
      throw Object.assign(new Error("forbidden"), { code: "forbidden", status: 403 });
    });
    expect(failure?.outcome).toBe("unchanged");
  });
});
