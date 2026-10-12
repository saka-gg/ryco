import { decodeBase64Url, encodeBase64Url } from "@ryco/client-runtime/relay/base64url";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  encodeAuthenticationRequest,
  encodeRegistrationRequest,
  mapNativePasskeyError,
  normalizeAuthenticationResponse,
  normalizeRegistrationResponse,
  withPasskeyAbort,
} from "./passkeyTranscript";

const challenge = new Uint8Array([1, 2, 3, 4, 250, 251, 252, 253]);
const userId = new Uint8Array([9, 8, 7, 6]);
const credentialId = new Uint8Array([17, 18, 19, 20]);

function registrationOptions() {
  return {
    challenge,
    rp: { name: "Ryco", id: "app.ryco.space" },
    user: { id: userId, name: "owner@example.test", displayName: "Owner" },
    pubKeyCredParams: [{ type: "public-key" as const, alg: -7 }],
  };
}

describe("passkey option encoding", () => {
  it("base64url-encodes every binary member of an authentication request", () => {
    const request = encodeAuthenticationRequest({
      challenge,
      rpId: "app.ryco.space",
      allowCredentials: [{ id: credentialId, type: "public-key", transports: ["internal"] }],
    });

    expect(request.challenge).toBe(encodeBase64Url(challenge));
    expect(decodeBase64Url(request.challenge)).toEqual(challenge);
    expect(request.rpId).toBe("app.ryco.space");
    expect(request.allowCredentials).toEqual([
      { type: "public-key", id: encodeBase64Url(credentialId), transports: ["internal"] },
    ]);
  });

  it("base64url-encodes challenge, user id, and excluded credentials on registration", () => {
    const request = encodeRegistrationRequest({
      ...registrationOptions(),
      excludeCredentials: [{ id: credentialId, type: "public-key" }],
    });

    expect(request.challenge).toBe(encodeBase64Url(challenge));
    expect(request.user.id).toBe(encodeBase64Url(userId));
    expect(request.rp).toEqual({ id: "app.ryco.space", name: "Ryco" });
    expect(request.excludeCredentials).toEqual([
      { type: "public-key", id: encodeBase64Url(credentialId) },
    ]);
  });

  it("passes server-supplied option members through verbatim", () => {
    const extensions = { credProps: true };
    const request = encodeAuthenticationRequest({
      challenge,
      rpId: "app.ryco.space",
      timeout: 60_000,
      userVerification: "required",
      extensions,
    });

    expect(request.timeout).toBe(60_000);
    expect(request.userVerification).toBe("required");
    expect(request.extensions).toEqual(extensions);
  });

  it("omits absent optional members rather than emitting undefined", () => {
    const request = encodeAuthenticationRequest({ challenge, rpId: "app.ryco.space" });

    expect(Object.keys(request).toSorted()).toEqual(["challenge", "rpId"]);
  });

  it("fails closed when the server omits the relying party id", () => {
    // A browser derives the RP ID from the document origin; native has no
    // origin, and substituting one would override the server's RP ID.
    expect(() => encodeAuthenticationRequest({ challenge })).toThrow(
      "Passkey options are missing the relying party id.",
    );
    expect(() =>
      encodeRegistrationRequest({ ...registrationOptions(), rp: { name: "Ryco" } }),
    ).toThrow("Passkey options are missing the relying party id.");
  });
});

describe("authentication transcript normalization", () => {
  const nativeResult = {
    id: "Y3JlZC1pZA",
    rawId: "Y3JlZC1pZA",
    type: "public-key",
    authenticatorAttachment: "platform",
    response: {
      clientDataJSON: "Y2xpZW50",
      authenticatorData: "YXV0aA",
      signature: "c2ln",
      userHandle: "dXNlcg",
    },
    clientExtensionResults: { credProps: { rk: true } },
  };

  it("produces the runtime transcript shape exactly", () => {
    expect(normalizeAuthenticationResponse(nativeResult)).toEqual({
      id: "Y3JlZC1pZA",
      rawId: "Y3JlZC1pZA",
      response: {
        clientDataJSON: "Y2xpZW50",
        authenticatorData: "YXV0aA",
        signature: "c2ln",
        userHandle: "dXNlcg",
      },
      type: "public-key",
      clientExtensionResults: { credProps: { rk: true } },
      authenticatorAttachment: "platform",
    });
  });

  it("falls back to id when the native result omits rawId", () => {
    const { rawId: _rawId, ...withoutRawId } = nativeResult;
    expect(normalizeAuthenticationResponse(withoutRawId).rawId).toBe("Y3JlZC1pZA");
  });

  it("omits userHandle instead of emitting undefined", () => {
    const result = normalizeAuthenticationResponse({
      ...nativeResult,
      response: { ...nativeResult.response, userHandle: undefined },
    });
    expect("userHandle" in result.response).toBe(false);
  });

  it("omits an unrecognized authenticatorAttachment", () => {
    const result = normalizeAuthenticationResponse({
      ...nativeResult,
      authenticatorAttachment: "hybrid-thing",
    });
    expect("authenticatorAttachment" in result).toBe(false);
  });

  it("defaults a missing clientExtensionResults to an empty object", () => {
    const { clientExtensionResults: _drop, ...withoutExtensions } = nativeResult;
    expect(normalizeAuthenticationResponse(withoutExtensions).clientExtensionResults).toEqual({});
  });

  it("throws a cancellation error for a null or undefined native result", () => {
    expect(() => normalizeAuthenticationResponse(null)).toThrow("Passkey ceremony was cancelled.");
    expect(() => normalizeAuthenticationResponse(undefined)).toThrow(
      "Passkey ceremony was cancelled.",
    );
  });

  it("rejects a partial transcript rather than returning one", () => {
    expect(() =>
      normalizeAuthenticationResponse({
        ...nativeResult,
        response: { clientDataJSON: "Y2xpZW50", authenticatorData: "YXV0aA" },
      }),
    ).toThrow("Invalid passkey response.");
    expect(() => normalizeAuthenticationResponse({ ...nativeResult, response: undefined })).toThrow(
      "Invalid passkey response.",
    );
  });

  it("rejects a credential type other than public-key", () => {
    expect(() => normalizeAuthenticationResponse({ ...nativeResult, type: "password" })).toThrow(
      "Invalid passkey response.",
    );
  });
});

describe("registration transcript normalization", () => {
  const nativeResult = {
    id: "Y3JlZC1pZA",
    rawId: "Y3JlZC1pZA",
    type: "public-key",
    response: { clientDataJSON: "Y2xpZW50", attestationObject: "YXR0" },
  };

  it("emits only the required members when the optional ones are absent", () => {
    expect(normalizeRegistrationResponse(nativeResult)).toEqual({
      id: "Y3JlZC1pZA",
      rawId: "Y3JlZC1pZA",
      response: { clientDataJSON: "Y2xpZW50", attestationObject: "YXR0" },
      type: "public-key",
      clientExtensionResults: {},
    });
  });

  it("carries the optional response members through when present", () => {
    const result = normalizeRegistrationResponse({
      ...nativeResult,
      authenticatorAttachment: "platform",
      response: {
        ...nativeResult.response,
        transports: ["internal", "hybrid"],
        publicKeyAlgorithm: -7,
        publicKey: "cHVi",
        authenticatorData: "YXV0aA",
      },
    });

    expect(result.response).toEqual({
      clientDataJSON: "Y2xpZW50",
      attestationObject: "YXR0",
      transports: ["internal", "hybrid"],
      publicKeyAlgorithm: -7,
      publicKey: "cHVi",
      authenticatorData: "YXV0aA",
    });
    expect(result.authenticatorAttachment).toBe("platform");
  });

  it("drops transports outside the runtime's allow-list", () => {
    const result = normalizeRegistrationResponse({
      ...nativeResult,
      response: { ...nativeResult.response, transports: ["internal", "carrier-pigeon", 7] },
    });
    expect(result.response.transports).toEqual(["internal"]);
  });

  it("omits transports entirely when none survive filtering", () => {
    const result = normalizeRegistrationResponse({
      ...nativeResult,
      response: { ...nativeResult.response, transports: ["carrier-pigeon"] },
    });
    expect("transports" in result.response).toBe(false);
  });

  it("drops a non-integer publicKeyAlgorithm", () => {
    const result = normalizeRegistrationResponse({
      ...nativeResult,
      response: { ...nativeResult.response, publicKeyAlgorithm: "-7" },
    });
    expect("publicKeyAlgorithm" in result.response).toBe(false);
  });

  it("throws a cancellation error for a null native result", () => {
    expect(() => normalizeRegistrationResponse(null)).toThrow("Passkey ceremony was cancelled.");
  });

  it("rejects a registration result missing the attestation object", () => {
    expect(() =>
      normalizeRegistrationResponse({ ...nativeResult, response: { clientDataJSON: "Y2xpZW50" } }),
    ).toThrow("Invalid passkey response.");
  });
});

describe("native error mapping", () => {
  it("maps user cancellation onto the shared cancellation message", () => {
    expect(mapNativePasskeyError({ error: "UserCancelled", message: "..." }).message).toBe(
      "Passkey ceremony was cancelled.",
    );
  });

  it("maps known native codes onto bounded messages", () => {
    expect(mapNativePasskeyError({ error: "NotSupported", message: "..." }).message).toBe(
      "Passkeys are not supported on this device.",
    );
    expect(mapNativePasskeyError({ error: "NoCredentials", message: "..." }).message).toBe(
      "No passkey is available for this account on this device.",
    );
  });

  it("never propagates an unbounded native message", () => {
    // The library's fallback branch stringifies the raw native error into
    // `message`; that text must not reach a user-visible error.
    const leaked = "Native error: challenge=SUPERSECRETCHALLENGE token=abc123";
    const mapped = mapNativePasskeyError({ error: "Native error", message: leaked });

    expect(mapped).toBeInstanceOf(Error);
    expect(mapped.message).toBe("Passkey ceremony failed.");
    expect(mapped.message).not.toContain("SUPERSECRETCHALLENGE");
    expect(mapped.message).not.toContain("abc123");
  });

  it("collapses unrecognized rejection values to a generic error", () => {
    expect(mapNativePasskeyError("a string").message).toBe("Passkey ceremony failed.");
    expect(mapNativePasskeyError(undefined).message).toBe("Passkey ceremony failed.");
    expect(mapNativePasskeyError({ nope: true }).message).toBe("Passkey ceremony failed.");
  });

  it("preserves an already-mapped cancellation error", () => {
    const cancelled = new Error("Passkey ceremony was cancelled.");
    expect(mapNativePasskeyError(cancelled)).toBe(cancelled);
  });
});

describe("ceremony abort handling", () => {
  it("rejects without invoking native when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const run = vi.fn(async () => "unreachable");

    await expect(withPasskeyAbort(controller.signal, run)).rejects.toThrow(
      "Passkey ceremony was cancelled.",
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects when the signal aborts while the ceremony is in flight", async () => {
    const controller = new AbortController();
    const pending = withPasskeyAbort(controller.signal, () => new Promise<string>(() => {}));

    controller.abort();

    await expect(pending).rejects.toThrow("Passkey ceremony was cancelled.");
  });

  it("resolves with the native result when no abort arrives", async () => {
    const controller = new AbortController();
    await expect(withPasskeyAbort(controller.signal, async () => "ok")).resolves.toBe("ok");
  });

  it("runs the ceremony when no signal is supplied", async () => {
    await expect(withPasskeyAbort(undefined, async () => "ok")).resolves.toBe("ok");
  });

  it("removes its abort listener once the ceremony settles", async () => {
    const controller = new AbortController();
    const removeEventListener = vi.spyOn(controller.signal, "removeEventListener");

    await withPasskeyAbort(controller.signal, async () => "ok");

    expect(removeEventListener).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("propagates a native rejection unchanged", async () => {
    const controller = new AbortController();
    const failure = new Error("Passkey ceremony failed.");

    await expect(withPasskeyAbort(controller.signal, () => Promise.reject(failure))).rejects.toBe(
      failure,
    );
  });
});
