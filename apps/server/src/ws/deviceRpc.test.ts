import { Effect, Option } from "effect";
import { describe, expect, it, vi } from "vitest";
import { AuthRpcError, DEVICE_WS_METHODS, DeviceRpcError } from "@ryco/contracts";
import { DeviceManager } from "../device/DeviceManager.ts";
import { FakeDeviceBackend } from "../device/FakeDeviceBackend.ts";
import { makeDeviceHandlers } from "./deviceRpc.ts";

const request = {
  type: "testing",
  input: { udid: "AAAA-1111", action: { type: "preset", value: "dark" } },
} as const;

describe("device testing RPC authorization", () => {
  it("executes lazily only inside the existing owner access boundary", async () => {
    const backend = new FakeDeviceBackend();
    const manager = new DeviceManager({ backend });
    const accesses: string[] = [];
    const denied = makeDeviceHandlers({
      deviceService: Option.some({ supported: true, manager }),
      withAccess: (access, method, _effect) => {
        accesses.push(`${access}:${method}`);
        return Effect.fail(new AuthRpcError({ status: 403, message: "Owner required" }));
      },
    });
    const testing = vi.spyOn(backend, "testing");
    const effect = denied[DEVICE_WS_METHODS.app](request);
    expect(testing).not.toHaveBeenCalled();
    await expect(Effect.runPromise(effect)).rejects.toThrow("Owner required");
    expect(accesses).toEqual(["owner:device.app"]);
    expect(testing).not.toHaveBeenCalled();
    const allowed = makeDeviceHandlers({
      deviceService: Option.some({ supported: true, manager }),
      withAccess: (_access, _method, operation) => operation,
    });
    await expect(Effect.runPromise(allowed[DEVICE_WS_METHODS.app](request))).resolves.toEqual({
      type: "testing",
    });
    expect(testing).toHaveBeenCalledWith(request.input);
    await manager.dispose();
  });

  it("preserves invalid-input failures without changing boot ownership", async () => {
    const backend = new FakeDeviceBackend();
    const manager = new DeviceManager({ backend });
    vi.spyOn(backend, "testing").mockRejectedValue(
      new DeviceRpcError({ code: "invalid-input", message: "Invalid JSON", retryable: false }),
    );
    const handlers = makeDeviceHandlers({
      deviceService: Option.some({ supported: true, manager }),
      withAccess: (_access, _method, operation) => operation,
    });
    const result = await Effect.runPromise(
      handlers[DEVICE_WS_METHODS.app](request).pipe(Effect.flip),
    );
    expect(result).toMatchObject({ code: "invalid-input", message: "Invalid JSON" });
    expect(backend.calls).toEqual([]);
    await manager.dispose();
  });
});
