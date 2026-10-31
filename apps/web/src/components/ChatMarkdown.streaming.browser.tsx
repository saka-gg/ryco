import "../index.css";

import { page } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

// Counts the paragraph-level renders (p, li, blockquote, td, th) while keeping
// the real renderer.
const inlineRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock("./chat/SkillInlineText", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./chat/SkillInlineText")>();
  return {
    SkillInlineText: actual.SkillInlineText,
    renderSkillInlineMarkdownChildren: (
      ...args: Parameters<typeof actual.renderSkillInlineMarkdownChildren>
    ) => {
      inlineRenders.count += 1;
      return actual.renderSkillInlineMarkdownChildren(...args);
    },
  };
});

vi.mock("../workspaceFileNavigation", () => ({
  useWorkspaceFileOpener: () => ({ canOpen: () => false, open: () => true }),
}));

import ChatMarkdown from "./ChatMarkdown";
import { splitMarkdownBlocks } from "../markdown-blocks";

// Ten settled sections, then the streaming tail.
const SETTLED = Array.from(
  { length: 10 },
  (_, index) => `## Section ${index}\n\nParagraph ${index} has a needle.\n\n`,
).join("");

describe("ChatMarkdown streaming blocks", () => {
  afterEach(() => {
    inlineRenders.count = 0;
    document.body.innerHTML = "";
  });

  it("renders a streaming answer's settled blocks once while the tail grows", async () => {
    let text = `${SETTLED}## Tail\n\nStart`;
    expect(splitMarkdownBlocks(text).blocks).toHaveLength(11);
    const screen = await render(
      <ChatMarkdown text={text} cwd="/repo" isStreaming smoothStreaming={false} />,
    );
    try {
      const headings = [...document.querySelectorAll("h2")];
      const paragraphs = [...document.querySelectorAll("p")];
      expect(headings).toHaveLength(11);
      inlineRenders.count = 0;
      for (let chunk = 0; chunk < 20; chunk += 1) {
        text += ` word${chunk}`;
        await screen.rerender(
          <ChatMarkdown text={text} cwd="/repo" isStreaming smoothStreaming={false} />,
        );
      }
      await expect.element(page.getByText(/word19$/)).toBeInTheDocument();
      // Only the tail's paragraph renders per update, not the ten settled ones.
      expect(inlineRenders.count).toBe(20);
      expect([...document.querySelectorAll("h2")]).toEqual(headings);
      expect([...document.querySelectorAll("p")]).toEqual(paragraphs);

      await screen.rerender(<ChatMarkdown text={`${text} done.`} cwd="/repo" />);
      await expect.element(page.getByText(/word19 done\.$/)).toBeInTheDocument();
      expect(document.querySelectorAll("h2")).toHaveLength(11);
    } finally {
      await screen.unmount();
    }
  });

  it("numbers search hits across the whole message while it streams", async () => {
    // Settled blocks render first without a search, as when a reply streams
    // before the search opens; the hits then count from the message's start.
    const text = `${SETTLED}## Tail\n\nA tail needle and another needle`;
    const hit = (activeOccurrenceIndex: number) => ({ query: "needle", activeOccurrenceIndex });
    const screen = await render(
      <ChatMarkdown text={text} cwd="/repo" isStreaming smoothStreaming={false} />,
    );
    try {
      await screen.rerender(
        <ChatMarkdown
          text={text}
          cwd="/repo"
          isStreaming
          smoothStreaming={false}
          searchHighlight={hit(11)}
        />,
      );
      await vi.waitFor(() => expect(document.querySelectorAll("mark")).toHaveLength(12));
      const active = () =>
        document.querySelector<HTMLElement>("mark[data-thread-message-search-active]");
      const marks = () => [...document.querySelectorAll("mark")];
      expect(marks().indexOf(active()!)).toBe(11);
      expect(active()!.closest("p")!.textContent).toBe("A tail needle and another needle");

      // The tail grows with the search open: numbering stays document-wide.
      const grown = `${text} and a last needle`;
      await screen.rerender(
        <ChatMarkdown
          text={grown}
          cwd="/repo"
          isStreaming
          smoothStreaming={false}
          searchHighlight={hit(12)}
        />,
      );
      await vi.waitFor(() => expect(document.querySelectorAll("mark")).toHaveLength(13));
      expect(marks().indexOf(active()!)).toBe(12);
      await screen.rerender(
        <ChatMarkdown
          text={grown}
          cwd="/repo"
          isStreaming
          smoothStreaming={false}
          searchHighlight={hit(3)}
        />,
      );
      await vi.waitFor(() => expect(marks().indexOf(active()!)).toBe(3));
      expect(active()!.closest("p")!.textContent).toBe("Paragraph 3 has a needle.");

      // Closing the search clears every block's hits, settled ones included.
      await screen.rerender(
        <ChatMarkdown text={`${grown}.`} cwd="/repo" isStreaming smoothStreaming={false} />,
      );
      await vi.waitFor(() => expect(document.querySelectorAll("mark")).toHaveLength(0));
    } finally {
      await screen.unmount();
    }
  });

  it("relabels a settled block's file link when a later block names the same file", async () => {
    const start = "## One\n\nSee [a](./src/a.ts).\n\n## Two\n\nMore";
    const screen = await render(
      <ChatMarkdown text={start} cwd="/repo" isStreaming smoothStreaming={false} />,
    );
    try {
      await expect.element(page.getByRole("link", { name: "a.ts" })).toBeInTheDocument();
      const settled = document.querySelector("h2");
      // A web link reaches no renderer's link metadata: the settled block does
      // not render again, only the tail's paragraph and its new link.
      inlineRenders.count = 0;
      const withWebLink = `${start} and [docs](https://example.com/docs)`;
      await screen.rerender(
        <ChatMarkdown text={withWebLink} cwd="/repo" isStreaming smoothStreaming={false} />,
      );
      await expect.element(page.getByRole("link", { name: "docs" })).toBeInTheDocument();
      expect(inlineRenders.count).toBe(2);

      // A file link with the same basename disambiguates both labels.
      await screen.rerender(
        <ChatMarkdown
          text={`${withWebLink} and [b](./other/a.ts)`}
          cwd="/repo"
          isStreaming
          smoothStreaming={false}
        />,
      );
      await expect.element(page.getByRole("link", { name: "a.ts · ./src" })).toBeInTheDocument();
      await expect.element(page.getByRole("link", { name: "a.ts · ./other" })).toBeInTheDocument();
      expect(document.querySelector("h2")).toBe(settled);
    } finally {
      await screen.unmount();
    }
  });

  it("resolves a reference whose definition streams in after it", async () => {
    const start = "## One\n\nSee [the docs].\n\n## Two\n\n";
    const screen = await render(
      <ChatMarkdown text={start} cwd="/repo" isStreaming smoothStreaming={false} />,
    );
    try {
      await expect.element(page.getByText("See [the docs].")).toBeInTheDocument();
      // The definition is the still-streaming last line, then a settled one.
      for (const tail of ["", "\n\nThen more.\n\n## Three\n\nEnd"]) {
        await screen.rerender(
          <ChatMarkdown
            text={`${start}[the docs]: https://example.com/docs${tail}`}
            cwd="/repo"
            isStreaming
            smoothStreaming={false}
          />,
        );
        await expect
          .element(page.getByRole("link", { name: "the docs" }))
          .toHaveAttribute("href", "https://example.com/docs");
      }
      await expect.element(page.getByText("End")).toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });
});
