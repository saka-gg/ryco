import {
  ASSISTANT_TEXT_SCAN_START,
  scanAssistantText,
  splitBufferedAssistantText,
} from "@ryco/shared/assistantStreaming";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { describe, expect, it } from "vite-plus/test";

// The node's paragraph splitter decides what clients render while a reply streams. It must
// agree with the renderer clients use: a released code block is never cut short.

function codeBlocks(markdown: string): string[] {
  const html = renderToStaticMarkup(
    <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>,
  );
  return html.match(/<pre>[\s\S]*?<\/pre>/g) ?? [];
}

const DOCUMENTS = [
  [
    "## Setup",
    "",
    "1. Install the tools:",
    "",
    "   ```bash",
    "   npm i",
    "",
    "   npm run build",
    "   ```",
    "",
    "2. Then run:",
    "    ```sh",
    "    npm test",
    "",
    "    ```",
    "- Nested:",
    "  - deeper",
    "    ~~~py",
    "    print(1)",
    "",
    "    ~~~",
    "",
    "````md",
    "```js",
    "inner",
    "```",
    "",
    "````",
    "Done.",
    "",
  ].join("\n"),
  "- item\n\n    ```\n    a\n\n       ```\n\nstill?\n\nmore\n\n",
  "    ```\nindented code\n```\n\ninside real fence\n\n```\nafter\n",
  "Here:\n\n    print(1)\n\n    print(2)\n\nDone\n\n    again\n\nend\n",
  "- a\nlazy\n  ```\n  code\n\n  x\n  ```\n\ntext\n2. foo\n      ```\n\nmore\n\n",
  "1. Install:\n   ```bash\n   npm i\n```\n2. Next\n\n```\n\nfinal\n",
  "-\t```\n\tx\n\n\t```\nDone\n\n>  ```\n> quoted\n\nafter\n\n",
  "Intro\r\n\r\n```ts\r\nconst a = 1;\r\n\r\nconst b = 2;\r\n```\r\n\r\nOutro\r\n\r\n",
];

/**
 * Streams `document` a character at a time like the node: whatever is ready is released,
 * and every `spillEvery` characters everything held goes out whole, as at the size cap.
 */
function streamAndCheck(document: string, spillEvery?: number) {
  const finalBlocks = codeBlocks(document);
  let released = "";
  let held = "";
  let scan = ASSISTANT_TEXT_SCAN_START;
  for (const [index, char] of [...document].entries()) {
    held += char;
    if (spillEvery !== undefined && (index + 1) % spillEvery === 0) {
      released += held;
      scan = scanAssistantText(held, scan);
      held = "";
      continue;
    }
    const split = splitBufferedAssistantText(held, scan);
    if (split.ready.length === 0) continue;
    released += split.ready;
    held = split.rest;
    scan = split.restScan;
    const blocks = codeBlocks(released);
    expect(blocks, `released through character ${released.length}`).toEqual(
      finalBlocks.slice(0, blocks.length),
    );
  }
  expect(released + held).toBe(document);
}

describe("paragraph streaming against the Markdown renderer", () => {
  it.each(DOCUMENTS)("never releases part of a code block: %j", (document) => {
    streamAndCheck(document);
  });

  it.each(DOCUMENTS)("recovers its place after text sent whole: %j", (document) => {
    for (const spillEvery of [7, 23, 41]) streamAndCheck(document, spillEvery);
  });
});
