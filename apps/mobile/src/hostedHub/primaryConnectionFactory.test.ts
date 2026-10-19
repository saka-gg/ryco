import type { EnvironmentConnection } from "@ryco/client-runtime/connection";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createHostedEnvironmentConnectionIfLoaded,
  createHostedPrimaryConnectionIfLoaded,
  installHostedEnvironmentConnectionFactory,
  installHostedPrimaryConnectionFactory,
} from "./primaryConnectionFactory";

const deps = {} as Parameters<typeof createHostedPrimaryConnectionIfLoaded>[0];
const input = {} as Parameters<typeof createHostedEnvironmentConnectionIfLoaded>[0];

afterEach(() => {
  installHostedPrimaryConnectionFactory(null);
  installHostedEnvironmentConnectionFactory(null);
});

describe("hosted connection seam", () => {
  it("answers no connection while the hosted runtime is not loaded", () => {
    expect(createHostedPrimaryConnectionIfLoaded(deps)).toBeNull();
    expect(createHostedEnvironmentConnectionIfLoaded(input)).toBeNull();
  });

  it("delegates an environment's connection to the installed relay connection factory", () => {
    const connection = { kind: "primary" } as EnvironmentConnection;
    const factory = vi.fn(() => connection);
    installHostedEnvironmentConnectionFactory(factory);

    expect(createHostedEnvironmentConnectionIfLoaded(input)).toBe(connection);
    expect(factory).toHaveBeenCalledExactlyOnceWith(input);
    // The driver's selection-following primary is a separate entry: installing
    // the environment factory never builds one for it.
    expect(createHostedPrimaryConnectionIfLoaded(deps)).toBeNull();
  });

  it("delegates the driver's primary connection only to a factory installed for it", () => {
    const connection = { kind: "primary" } as EnvironmentConnection;
    const factory = vi.fn(() => connection);
    installHostedPrimaryConnectionFactory(factory);

    expect(createHostedPrimaryConnectionIfLoaded(deps)).toBe(connection);
    expect(factory).toHaveBeenCalledExactlyOnceWith(deps);
  });
});
