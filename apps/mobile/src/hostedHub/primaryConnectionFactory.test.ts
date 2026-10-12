import type { EnvironmentConnection } from "@ryco/client-runtime/connection";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createHostedPrimaryConnectionIfLoaded,
  installHostedPrimaryConnectionFactory,
} from "./primaryConnectionFactory";

const deps = {} as Parameters<typeof createHostedPrimaryConnectionIfLoaded>[0];

afterEach(() => installHostedPrimaryConnectionFactory(null));

describe("hosted primary connection seam", () => {
  it("answers no primary connection while the hosted runtime is not loaded", () => {
    expect(createHostedPrimaryConnectionIfLoaded(deps)).toBeNull();
  });

  it("delegates to the installed relay connection factory", () => {
    const connection = { kind: "primary" } as EnvironmentConnection;
    const factory = vi.fn(() => connection);
    installHostedPrimaryConnectionFactory(factory);

    expect(createHostedPrimaryConnectionIfLoaded(deps)).toBe(connection);
    expect(factory).toHaveBeenCalledExactlyOnceWith(deps);
  });
});
