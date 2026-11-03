import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

// The mark invoked as a plain function with react-native mocked (no React renderer exists in
// this suite): its words and its warning color.

vi.mock("react-native", () => ({ View: "View" }));
vi.mock("./AppText", () => ({ AppText: "Text" }));

import { FollowUpQueueMark } from "./FollowUpQueueMark";

type Node = ReactElement<{ className: string; children: Node | string }>;

describe("follow-up queue mark", () => {
  it("says queued in words, in the quiet color", () => {
    const root = FollowUpQueueMark({
      badge: { label: "2 queued", title: "2 queued follow-ups", held: false },
    }) as Node;
    const text = root.props.children as Node;
    expect(text.props.children).toBe("2 queued");
    expect(root.props.className).toContain("border-border");
    expect(text.props.className).toContain("text-foreground-tertiary");
    expect(text.props.className).not.toContain("text-warning");
  });

  it("says held in words, not only in the warning color", () => {
    const root = FollowUpQueueMark({
      badge: { label: "1 held", title: "1 queued follow-up: Paused after Stop", held: true },
    }) as Node;
    const text = root.props.children as Node;
    expect(text.props.children).toBe("1 held");
    expect(root.props.className).toContain("border-warning");
    expect(text.props.className).toContain("text-warning");
  });
});
