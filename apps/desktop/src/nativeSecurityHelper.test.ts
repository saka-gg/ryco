import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createNativeSecurityHelperRunner,
  DesktopNativeSecurityError,
  DesktopNativeSecurityHelper,
  desktopNativeInstallationNamespace,
  desktopNativeSecurityNamespace,
  resolveDesktopNativeSecurityHelperPath,
  type DesktopNativeSecretStore,
  type NativeSecurityHelperRunner,
} from "./nativeSecurityHelper.ts";

const point = new Uint8Array([
  0x04,
  ...new Uint8Array(32).fill(0x11),
  ...new Uint8Array(32).fill(0x22),
]);
const agreementPublic = new Uint8Array(32).fill(0x33);
const agreementSecret = new Uint8Array(32).fill(0x44);
const derSignature = new Uint8Array([0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x02]);
const base64 = (value: Uint8Array) => Buffer.from(value).toString("base64");
const signingRecord = base64(new Uint8Array([1, 2, 3]));
const agreementRecord = base64(new Uint8Array([4, 5, 6]));

function memoryStore(): DesktopNativeSecretStore {
  const records = new Map<string, string>();
  return {
    read: async (kind) => records.get(kind) ?? null,
    create: async (kind, value) => {
      if (records.has(kind)) return false;
      records.set(kind, value);
      return true;
    },
    delete: async (kind) => {
      records.delete(kind);
    },
  };
}

describe("Desktop native security helper", () => {
  it("derives a stable opaque namespace and resolves development/packaged helpers", () => {
    expect(desktopNativeSecurityNamespace("hub\0installation")).toMatch(/^[0-9a-f]{64}$/);
    expect(desktopNativeSecurityNamespace("hub\0installation")).toBe(
      desktopNativeSecurityNamespace("hub\0installation"),
    );
    expect(
      resolveDesktopNativeSecurityHelperPath({
        isPackaged: false,
        resourcesPath: "/Applications/Ryco.app/Contents/Resources",
        moduleDirectory: "/repo/apps/desktop/dist-electron",
      }),
    ).toBe("/repo/apps/desktop/resources/ryco-desktop-security-helper");
    expect(
      resolveDesktopNativeSecurityHelperPath({
        isPackaged: true,
        resourcesPath: "/Applications/Ryco.app/Contents/Resources",
        moduleDirectory: "/ignored",
      }),
    ).toBe("/Applications/Ryco.app/Contents/Resources/ryco-desktop-security-helper");
  });

  it("isolates development and preview records while preserving the production namespace", () => {
    const legacyProductionNamespace = desktopNativeSecurityNamespace(
      "ryco.desktop.installation.v1",
    );
    expect(desktopNativeInstallationNamespace("production")).toBe(legacyProductionNamespace);
    expect(desktopNativeInstallationNamespace("development")).not.toBe(legacyProductionNamespace);
    expect(desktopNativeInstallationNamespace("preview")).not.toBe(legacyProductionNamespace);
    expect(desktopNativeInstallationNamespace("development")).not.toBe(
      desktopNativeInstallationNamespace("preview"),
    );
  });

  it("keeps signing hardware-backed and converts the native DER signature", async () => {
    const run = vi.fn<NativeSecurityHelperRunner>(async (request) => {
      if (request.operation === "signing.create") {
        return {
          ok: true,
          backing: "secure-enclave",
          keyRecord: signingRecord,
          publicKey: base64(point),
        };
      }
      if (request.operation === "signing.sign") {
        expect(request.keyRecord).toBe(signingRecord);
        return { ok: true, signature: base64(derSignature) };
      }
      throw new Error("unexpected");
    });
    const helper = new DesktopNativeSecurityHelper({ run, store: memoryStore() });
    const signingKey = await helper.getSigningKey();

    expect(signingKey.publicJwk).toEqual({
      kty: "EC",
      crv: "P-256",
      x: "ERERERERERERERERERERERERERERERERERERERERERE",
      y: "IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiI",
    });
    expect(await helper.getSigningPublicKey()).toEqual(point);
    expect(await signingKey.sign(new Uint8Array([1, 2, 3]))).toEqual(
      new Uint8Array([...new Uint8Array(31), 1, ...new Uint8Array(31), 2]),
    );
    expect(run.mock.calls[1]?.[0]).toMatchObject({
      operation: "signing.sign",
      payload: "AQID",
    });
  });

  it("reopens the stored hardware record instead of silently replacing it", async () => {
    const store = memoryStore();
    await store.create("signing", signingRecord);
    const run = vi.fn<NativeSecurityHelperRunner>(async (request) => {
      if (request.operation === "signing.inspect") {
        expect(request.keyRecord).toBe(signingRecord);
        return { ok: true, backing: "secure-enclave", publicKey: base64(point) };
      }
      throw new Error("unexpected");
    });
    const helper = new DesktopNativeSecurityHelper({ run, store });
    await expect(helper.getSigningKey()).resolves.toMatchObject({ algorithm: "ES256" });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("borrows the device-bound agreement scalar for one operation and erases it", async () => {
    const run: NativeSecurityHelperRunner = async (request) => {
      if (request.operation === "agreement.create") {
        return {
          ok: true,
          keyRecord: agreementRecord,
          publicKey: base64(agreementPublic),
        };
      }
      if (request.operation === "agreement.inspect") {
        return { ok: true, publicKey: base64(agreementPublic) };
      }
      if (request.operation === "agreement.borrow") {
        return { ok: true, secretKey: base64(agreementSecret) };
      }
      throw new Error("unexpected");
    };
    const store = memoryStore();
    const helper = new DesktopNativeSecurityHelper({ run, store });
    expect(await helper.ensureAgreementPublicKey()).toEqual(agreementPublic);
    let borrowed: Uint8Array | undefined;
    await helper.withAgreementSecretKey((secretKey) => {
      borrowed = secretKey;
      expect(secretKey).toEqual(agreementSecret);
    });
    expect(borrowed).toEqual(new Uint8Array(32));
    await helper.deleteAgreementKey();
    await expect(helper.getAgreementPublicKey()).rejects.toMatchObject({ code: "key_missing" });
  });

  it("collapses missing hardware and malformed helper output", async () => {
    const unavailable = new DesktopNativeSecurityHelper({
      store: memoryStore(),
      run: async () => ({ ok: false, error: "unavailable" }),
    });
    await expect(unavailable.getSigningKey()).rejects.toMatchObject({
      name: "DesktopNativeSecurityError",
      code: "hardware_unavailable",
    });

    const malformed = new DesktopNativeSecurityHelper({
      store: memoryStore(),
      run: async () => ({
        ok: true,
        backing: "secure-enclave",
        keyRecord: signingRecord,
        publicKey: "not-base64",
      }),
    });
    await expect(malformed.getSigningKey()).rejects.toBeInstanceOf(DesktopNativeSecurityError);
  });
});

describe("helper process lifetime while a relay session holds it", () => {
  const request = { operation: "signing.create" } as const;

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Stand-ins for helper processes: each answers every request line with `{ ok: true }`. */
  function fakeProcesses() {
    const children: Array<{ readonly end: ReturnType<typeof vi.fn> }> = [];
    const spawn = vi.fn(() => {
      const stdout = new EventEmitter();
      const end = vi.fn();
      const stdin = {
        on: vi.fn(),
        end,
        write: vi.fn(() => {
          queueMicrotask(() => stdout.emit("data", Buffer.from('{"ok":true}\n')));
          return true;
        }),
      };
      children.push({ end });
      return Object.assign(new EventEmitter(), { stdin, stdout, kill: vi.fn() });
    });
    return { spawn: spawn as never, spawned: spawn, children };
  }

  it("lets an idle helper exit after the idle period when nothing holds it", async () => {
    const { spawn, children } = fakeProcesses();
    const run = createNativeSecurityHelperRunner("helper", { spawn, idleMs: 2_000 });
    await run(request);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(children[0]!.end).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(children[0]!.end).toHaveBeenCalledOnce();
  });

  it("keeps the helper up while held and lets it exit one idle period after the release", async () => {
    const { spawn, spawned, children } = fakeProcesses();
    const run = createNativeSecurityHelperRunner("helper", { spawn, idleMs: 2_000 });
    const release = run.holdForRelay();
    await run(request);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(children[0]!.end).not.toHaveBeenCalled();
    // The relay session signs again later: the same process answers.
    await run(request);
    expect(spawned).toHaveBeenCalledOnce();

    release();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(children[0]!.end).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(children[0]!.end).toHaveBeenCalledOnce();
  });

  it("cancels an idle exit that is already pending when a hold starts", async () => {
    const { spawn, children } = fakeProcesses();
    const run = createNativeSecurityHelperRunner("helper", { spawn, idleMs: 2_000 });
    await run(request);
    await vi.advanceTimersByTimeAsync(1_000);

    const release = run.holdForRelay();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(children[0]!.end).not.toHaveBeenCalled();

    release();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(children[0]!.end).toHaveBeenCalledOnce();
  });

  it("applies the idle exit only after the last of several holds is released", async () => {
    const { spawn, children } = fakeProcesses();
    const run = createNativeSecurityHelperRunner("helper", { spawn, idleMs: 2_000 });
    const first = run.holdForRelay();
    const second = run.holdForRelay();
    await run(request);

    first();
    first();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(children[0]!.end).not.toHaveBeenCalled();

    second();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(children[0]!.end).toHaveBeenCalledOnce();
  });

  it("applies the idle exit to a request made after the hold was released", async () => {
    const { spawn, children } = fakeProcesses();
    const run = createNativeSecurityHelperRunner("helper", { spawn, idleMs: 2_000 });
    const release = run.holdForRelay();
    release();
    await run(request);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(children[0]!.end).toHaveBeenCalledOnce();
  });

  it("passes the hold through the security helper, and is a no-op for a runner without one", () => {
    const release = vi.fn();
    const holdForRelay = vi.fn(() => release);
    const held = new DesktopNativeSecurityHelper({
      run: Object.assign(async () => ({ ok: true }), { holdForRelay }),
      store: memoryStore(),
    });
    held.holdForRelay()();
    expect(holdForRelay).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();

    const plain = new DesktopNativeSecurityHelper({
      run: async () => ({ ok: true }),
      store: memoryStore(),
    });
    expect(() => plain.holdForRelay()()).not.toThrow();
  });
});

describe("public key reset notifications", () => {
  it("tells listeners when either key is reset, until they unsubscribe", async () => {
    const helper = new DesktopNativeSecurityHelper({
      run: async () => ({ ok: true }),
      store: memoryStore(),
    });
    const listener = vi.fn();
    const unsubscribe = helper.onPublicKeysChanged(listener);

    await helper.deleteAgreementKey();
    expect(listener).toHaveBeenCalledTimes(1);
    await helper.deleteSigningKey();
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    await helper.deleteAgreementKey();
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
