import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_LIFECYCLE_SUGGESTION_POLICY,
  LifecycleSuggestionPolicy,
} from "./workspaceLifecycle.ts";

const decodePolicy = Schema.decodeUnknownSync(LifecycleSuggestionPolicy);

describe("LifecycleSuggestionPolicy", () => {
  it("fills fields a sparse settings file omitted with their defaults", () => {
    expect(DEFAULT_LIFECYCLE_SUGGESTION_POLICY).toEqual({
      archiveInactiveThreadsDays: 30,
      removeArchivedCheckoutsDays: 7,
    });
    expect(decodePolicy({})).toEqual(DEFAULT_LIFECYCLE_SUGGESTION_POLICY);
    expect(decodePolicy({ archiveInactiveThreadsDays: 14 })).toEqual({
      archiveInactiveThreadsDays: 14,
      removeArchivedCheckoutsDays: 7,
    });
  });

  it("keeps an explicit null as a disabled suggestion and rejects out-of-range days", () => {
    expect(decodePolicy({ removeArchivedCheckoutsDays: null })).toEqual({
      archiveInactiveThreadsDays: 30,
      removeArchivedCheckoutsDays: null,
    });
    expect(() => decodePolicy({ archiveInactiveThreadsDays: 0 })).toThrow();
  });

  it("still encodes every field", () => {
    const policy = { archiveInactiveThreadsDays: 30, removeArchivedCheckoutsDays: null };
    expect(Schema.encodeSync(LifecycleSuggestionPolicy)(policy)).toEqual(policy);
  });
});
