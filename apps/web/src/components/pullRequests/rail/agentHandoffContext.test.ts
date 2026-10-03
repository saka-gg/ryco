import {
  SOURCE_CONTROL_DETAIL_BODY_MAX_BYTES,
  SOURCE_CONTROL_DETAIL_MAX_COMMENTS,
} from "@ryco/contracts";
import { describe, expect, it } from "vitest";

import { fixtureDetail } from "../testing/pullRequestFixtures";
import { capHandoffContextDetail } from "./agentHandoffContext";

describe("capHandoffContextDetail", () => {
  it("bounds the page's full detail to the composer's caps and drops files and commits", () => {
    const detail = {
      ...fixtureDetail(703),
      body: "x".repeat(SOURCE_CONTROL_DETAIL_BODY_MAX_BYTES * 3),
      comments: Array.from({ length: SOURCE_CONTROL_DETAIL_MAX_COMMENTS + 4 }, (_, index) => ({
        ...fixtureDetail(703).comments[0]!,
        body: `comment ${index}`,
      })),
      truncated: false,
    };
    const capped = capHandoffContextDetail(detail);
    expect(new TextEncoder().encode(capped.body).byteLength).toBeLessThanOrEqual(
      SOURCE_CONTROL_DETAIL_BODY_MAX_BYTES,
    );
    expect(capped.comments).toHaveLength(SOURCE_CONTROL_DETAIL_MAX_COMMENTS);
    expect(capped.truncated).toBe(true);
    expect(capped).not.toHaveProperty("files");
    expect(capped).not.toHaveProperty("commits");
    expect(capped.number).toBe(703);
  });
});
