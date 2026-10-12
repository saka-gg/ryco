import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ComposerCommandMenu, type ComposerCommandItem } from "./ComposerCommandMenu";

const PATH_ITEM: ComposerCommandItem = {
  id: "path:file:src/index.ts",
  type: "path",
  path: "src/index.ts",
  pathKind: "file",
  label: "index.ts",
  description: "src",
};

function render(props: Partial<Parameters<typeof ComposerCommandMenu>[0]>): string {
  return renderToStaticMarkup(
    <ComposerCommandMenu
      items={[]}
      resolvedTheme="light"
      isLoading={false}
      triggerKind="path"
      activeItemId={null}
      onHighlightedItemChange={() => undefined}
      onSelect={() => undefined}
      {...props}
    />,
  );
}

describe("ComposerCommandMenu", () => {
  it("shows the caller's loading text while nothing is listed", () => {
    const markup = render({ isLoading: true, loadingText: "Indexing workspace…" });
    expect(markup).toContain("Indexing workspace…");
  });

  it("shows a failed search with a retry instead of an empty result", () => {
    const markup = render({
      emptyStateText: "No matching files or folders.",
      errorText: "Couldn't search workspace files.",
      onRetry: () => undefined,
    });
    // Markup escapes the apostrophe.
    expect(markup).toContain("search workspace files.");
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Retry");
    expect(markup).not.toContain("No matching files or folders.");
  });

  it("keeps the loading line over a stale error while a retry runs", () => {
    const markup = render({
      isLoading: true,
      loadingText: "Searching workspace files…",
      errorText: "Couldn't search workspace files.",
    });
    expect(markup).toContain("Searching workspace files…");
    expect(markup).not.toContain('role="alert"');
  });

  it("notes partial results under an empty result too", () => {
    const markup = render({
      emptyStateText: "No matching files or folders.",
      footnote: "Showing results from part of the workspace.",
    });
    expect(markup).toContain("No matching files or folders.");
    expect(markup).toContain("Showing results from part of the workspace.");
  });

  it("notes partial results under the items", () => {
    const markup = render({
      items: [PATH_ITEM],
      footnote: "Showing results from part of the workspace.",
    });
    expect(markup).toContain("index.ts");
    expect(markup).toContain("Showing results from part of the workspace.");
  });
});
