import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { MarkdownView } from "./MarkdownView";

describe("MarkdownView", () => {
  it("strips HTML comments by default", () => {
    const markup = renderToStaticMarkup(
      <MarkdownView text={"Visible\n\n<!-- hidden -->\n\nAfter"} />,
    );
    expect(markup).not.toContain("hidden");
    expect(markup).toContain("Visible");
    expect(markup).toContain("After");
  });

  it("renders <details>/<summary> as actual disclosure elements", () => {
    const markup = renderToStaticMarkup(
      <MarkdownView
        text={"<details>\n<summary>Click to expand</summary>\n\nSecret payload\n\n</details>"}
      />,
    );
    expect(markup).toContain("<details");
    expect(markup).toContain("<summary");
    expect(markup).toContain("Click to expand");
    expect(markup).toContain("Secret payload");
  });

  it("renders GFM tables", () => {
    const markup = renderToStaticMarkup(<MarkdownView text={"| a | b |\n| - | - |\n| 1 | 2 |"} />);
    expect(markup).toContain("<table");
    expect(markup).toContain("<th");
    expect(markup).toContain("<td");
  });

  it("renders GFM strikethrough", () => {
    const markup = renderToStaticMarkup(<MarkdownView text={"~~gone~~"} />);
    expect(markup).toContain("<del");
  });

  it("renders task list checkboxes", () => {
    const markup = renderToStaticMarkup(<MarkdownView text={"- [ ] todo\n- [x] done"} />);
    expect(markup).toContain('type="checkbox"');
    expect(markup).toContain("checked=");
  });

  it("keeps task checkboxes disabled unless onToggleTask is passed", () => {
    const markup = renderToStaticMarkup(<MarkdownView text={"- [ ] todo"} />);
    expect(markup).toContain("disabled");
    expect(markup).not.toContain("data-task-offset");
  });

  it("reports each interactive task by its source offset, as the parser saw it", () => {
    const text = [
      "<!-- template: tick what applies -->",
      "<details>",
      "<summary>Checklist</summary>",
      "- [ ] docs (HTML block, renders as text)",
      "</details>",
      "",
      "```md",
      "- [ ] in code",
      "```",
      "",
      "    - [ ] indented code",
      "",
      "- [ ] tests <!-- note -->",
      "  - [x] nested **bold**",
      "> 1. [X] quoted",
      "",
      '<ul><li class="task-list-item"><input type="checkbox"> raw html</li></ul>',
    ].join("\n");
    const markup = renderToStaticMarkup(<MarkdownView text={text} onToggleTask={() => {}} />);
    const offsets = [...markup.matchAll(/data-task-offset="(\d+)"/gu)].map((match) =>
      Number(match[1]),
    );
    // Exactly the three parser-made tasks; each offset is its state character in `text`.
    expect(offsets.map((offset) => text.slice(offset - 3, offset + 2))).toEqual([
      "- [ ]",
      "- [x]",
      ". [X]",
    ]);
    expect(offsets[0]).toBe(text.indexOf("- [ ] tests") + 3);
    // The raw-HTML box stays a disabled, unreported checkbox.
    expect(
      markup.match(/<input[^>]*>/gu)?.filter((input) => input.includes("disabled")),
    ).toHaveLength(1);
  });

  it("names each interactive checkbox after its own task text", () => {
    const markup = renderToStaticMarkup(
      <MarkdownView
        text={"- [ ] Ship the **rail**\n  - [x] Nested child"}
        onToggleTask={() => {}}
      />,
    );
    const labels = [...markup.matchAll(/aria-label="([^"]*)"/gu)].map((match) => match[1]);
    expect(labels).toEqual(["Ship the rail", "Nested child"]);
  });

  it("strips dangerous HTML even when raw HTML is enabled", () => {
    const markup = renderToStaticMarkup(
      <MarkdownView
        text={'<details><summary>ok</summary><script>alert("xss")</script></details>'}
      />,
    );
    expect(markup).not.toContain("<script");
    expect(markup).not.toContain("alert(");
    expect(markup).toContain("<details");
  });

  it("shows raw source when raw=true", () => {
    const markup = renderToStaticMarkup(
      <MarkdownView raw text={"# heading\n\n<!-- comment -->\nbody"} />,
    );
    expect(markup).toContain("# heading");
    expect(markup).toContain("&lt;!-- comment --&gt;");
  });
});
