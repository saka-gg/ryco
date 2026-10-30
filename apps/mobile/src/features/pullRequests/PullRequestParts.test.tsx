import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

// A pull request's description and comments are written by whoever can
// comment on the host, so a link in them must not reach the phone's other
// apps, calls or Ryco's own routes. Invoked as a plain function with the
// native views mocked (no React renderer exists in this suite).

const hoisted = vi.hoisted(() => ({
  openURL: vi.fn(async (_url: string) => true),
}));

vi.mock("expo-linking", () => ({ openURL: hoisted.openURL }));
vi.mock("react-native", () => ({ Pressable: "Pressable", ScrollView: "ScrollView", View: "View" }));
vi.mock("../../components/AppText", () => ({ AppText: "AppText" }));
vi.mock("../../native/SelectableMarkdownText", () => ({
  hasNativeSelectableMarkdownText: () => true,
  SelectableMarkdownText: "SelectableMarkdownText",
}));
vi.mock("../../native/useNativeMarkdownTextStyle", () => ({
  useNativeMarkdownTextStyle: () => ({}),
}));

import { PullRequestMarkdown } from "./PullRequestParts";

function tapLink(href: string): void {
  const element = PullRequestMarkdown({ markdown: `[link](${href})` }) as ReactElement<{
    readonly onLinkPress: (href: string) => void;
  }>;
  element.props.onLinkPress(href);
}

describe("PullRequestMarkdown links", () => {
  beforeEach(() => {
    hoisted.openURL.mockClear();
  });

  it("opens a web link in the browser", () => {
    tapLink("https://github.com/acme/app/pull/7");
    expect(hoisted.openURL).toHaveBeenCalledWith("https://github.com/acme/app/pull/7");
  });

  it("ignores calls, messages, other apps' links and Ryco's own routes", () => {
    for (const href of ["tel:+15550100", "sms:+15550100", "ryco://threads/abc", "docs/x.md"]) {
      tapLink(href);
    }
    expect(hoisted.openURL).not.toHaveBeenCalled();
  });
});
