import {
  SOURCE_CONTROL_DETAIL_BODY_MAX_BYTES,
  SOURCE_CONTROL_DETAIL_MAX_COMMENTS,
} from "@ryco/contracts/source-control";
import { describe, expect, it } from "vite-plus/test";

import { truncateSourceControlDetailContent } from "./sourceControlDetailContent.ts";

describe("truncateSourceControlDetailContent", () => {
  it("returns input unchanged when within caps", () => {
    const result = truncateSourceControlDetailContent({
      body: "short body",
      comments: [{ author: "a", body: "small", createdAt: new Date().toISOString() }],
    });
    expect(result.truncated).toBe(false);
    expect(result.body).toBe("short body");
    expect(result.comments).toHaveLength(1);
  });

  it("truncates body when over byte cap", () => {
    const big = "x".repeat(SOURCE_CONTROL_DETAIL_BODY_MAX_BYTES + 100);
    const result = truncateSourceControlDetailContent({ body: big, comments: [] });
    expect(result.truncated).toBe(true);
    expect(result.body.length).toBeLessThanOrEqual(SOURCE_CONTROL_DETAIL_BODY_MAX_BYTES);
  });

  it("does not split multi-byte characters at the byte cap", () => {
    const prefix = "x".repeat(SOURCE_CONTROL_DETAIL_BODY_MAX_BYTES - 1);
    const result = truncateSourceControlDetailContent({ body: `${prefix}\u{1f4be}`, comments: [] });
    expect(result.truncated).toBe(true);
    expect(result.body).toBe(prefix);
  });

  it("keeps only last N comments", () => {
    const comments = Array.from({ length: SOURCE_CONTROL_DETAIL_MAX_COMMENTS + 3 }, (_, i) => ({
      author: "a",
      body: `c${i}`,
      createdAt: new Date(2026, 0, i + 1).toISOString(),
    }));
    const result = truncateSourceControlDetailContent({ body: "ok", comments });
    expect(result.truncated).toBe(true);
    expect(result.comments).toHaveLength(SOURCE_CONTROL_DETAIL_MAX_COMMENTS);
    expect(result.comments[0]?.body).toBe(
      `c${comments.length - SOURCE_CONTROL_DETAIL_MAX_COMMENTS}`,
    );
  });

  it("preserves extra fields on each comment", () => {
    const comments = [
      {
        author: "a",
        body: "first",
        createdAt: "2026-03-14T10:00:00Z",
        authorAssociation: "OWNER",
      },
      {
        author: "b",
        body: "second",
        createdAt: "2026-03-14T11:00:00Z",
        authorAssociation: "MEMBER",
      },
    ];
    const result = truncateSourceControlDetailContent({ body: "body", comments });
    expect(result.comments[0]?.authorAssociation).toBe("OWNER");
    expect(result.comments[1]?.authorAssociation).toBe("MEMBER");
  });
});
