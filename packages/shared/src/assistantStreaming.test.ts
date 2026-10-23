import { describe, expect, it } from "vite-plus/test";

import {
  ASSISTANT_TEXT_SCAN_START,
  type AssistantTextScan,
  scanAssistantText,
  splitBufferedAssistantText,
  type SplitAssistantTextOptions,
} from "./assistantStreaming.ts";

const split = (
  text: string,
  scan: AssistantTextScan = ASSISTANT_TEXT_SCAN_START,
  options?: SplitAssistantTextOptions,
) => {
  const { ready, rest } = splitBufferedAssistantText(text, scan, options);
  return { ready, rest };
};

/** Splits `text` as it would be held after `sent` went out whole (a spill or tokens). */
const splitAfter = (sent: string, text: string) =>
  split(text, scanAssistantText(sent, ASSISTANT_TEXT_SCAN_START));

/** Streams `document` a character at a time, releasing what is ready like the server. */
function streamDocument(document: string, options?: SplitAssistantTextOptions) {
  let released = "";
  let buffered = "";
  let scan = ASSISTANT_TEXT_SCAN_START;
  const boundaries: number[] = [];
  for (const char of document) {
    buffered += char;
    const result = splitBufferedAssistantText(buffered, scan, options);
    expect(result.ready + result.rest).toBe(buffered);
    if (result.ready.length > 0) {
      released += result.ready;
      boundaries.push(released.length);
      buffered = result.rest;
      scan = result.restScan;
    }
  }
  expect(released + buffered).toBe(document);
  return { boundaries, held: buffered };
}

describe("splitBufferedAssistantText", () => {
  it("holds text until a paragraph ends with a blank line", () => {
    expect(split("Hello world")).toEqual({ ready: "", rest: "Hello world" });
    expect(split("Hello world\n")).toEqual({ ready: "", rest: "Hello world\n" });
    expect(split("Hello world\n\n")).toEqual({ ready: "Hello world\n\n", rest: "" });
    expect(split("One\n\nTwo\n\nThr")).toEqual({ ready: "One\n\nTwo\n\n", rest: "Thr" });
  });

  it("never releases a leading blank line on its own", () => {
    expect(split("\n")).toEqual({ ready: "", rest: "\n" });
    expect(split("\nHello\n\n")).toEqual({ ready: "\nHello\n\n", rest: "" });
  });

  it("counts spaces and tabs as blank, but not a no-break space", () => {
    expect(split("One\n \t \nTwo")).toEqual({ ready: "One\n \t \n", rest: "Two" });
    expect(split("One\n\u00a0\nTwo")).toEqual({ ready: "", rest: "One\n\u00a0\nTwo" });
  });

  it("handles CRLF line endings", () => {
    expect(split("One\r\n\r\nTwo")).toEqual({ ready: "One\r\n\r\n", rest: "Two" });
    expect(split("```\r\na\r\n\r\nb\r\n```\r\nc")).toEqual({
      ready: "```\r\na\r\n\r\nb\r\n```\r\n",
      rest: "c",
    });
  });

  it("never releases inside an unclosed fence", () => {
    expect(split("Intro\n\n```ts\nconst a = 1;\n\nconst b = 2;\n\n")).toEqual({
      ready: "Intro\n\n",
      rest: "```ts\nconst a = 1;\n\nconst b = 2;\n\n",
    });
    expect(split("```\n\n\n")).toEqual({ ready: "", rest: "```\n\n\n" });
  });

  it("releases through a closing fence once its line ends", () => {
    expect(split("```ts\nx()\n```")).toEqual({ ready: "", rest: "```ts\nx()\n```" });
    expect(split("```ts\nx()\n```\nAfter")).toEqual({ ready: "```ts\nx()\n```\n", rest: "After" });
    expect(split("```ts\nx()\n```   \nAfter")).toEqual({
      ready: "```ts\nx()\n```   \n",
      rest: "After",
    });
  });

  it("closes tilde fences only with tildes", () => {
    const open = "~~~python\nprint(1)\n```\n\n";
    expect(split(open)).toEqual({ ready: "", rest: open });
    expect(split(`${open}~~~\nAfter`)).toEqual({ ready: `${open}~~~\n`, rest: "After" });
  });

  it("requires a closer at least as long as the opener", () => {
    const open = "````md\n```js\nx\n```\n\n";
    expect(split(open)).toEqual({ ready: "", rest: open });
    expect(split(`${open}\`\`\`\`\`\nAfter`)).toEqual({
      ready: `${open}\`\`\`\`\`\n`,
      rest: "After",
    });
  });

  it("does not close a fence with a line that has an info string", () => {
    const text = "```\nfirst\n```js\n\nsecond\n";
    expect(split(text)).toEqual({ ready: "", rest: text });
  });

  it("does not treat a backtick line with a backtick in its info string as a fence", () => {
    expect(split("```a`b```\n\nNext")).toEqual({ ready: "```a`b```\n\n", rest: "Next" });
    // A tilde fence's info string may contain backticks.
    const tilde = "~~~ a`b\n\ncode\n";
    expect(split(tilde)).toEqual({ ready: "", rest: tilde });
  });

  it("tracks fences indented inside list items", () => {
    const item = "1. Run:\n\n   ```bash\n   npm i\n\n   npm test\n";
    expect(split(item)).toEqual({
      ready: "1. Run:\n\n",
      rest: "   ```bash\n   npm i\n\n   npm test\n",
    });
    expect(split(`${item}   \`\`\`\nDone`)).toEqual({
      ready: `${item}   \`\`\`\n`,
      rest: "Done",
    });
    // A fence may open on the list marker's own line.
    const onMarker = "- ```bash\n  npm i\n\n  npm test\n";
    expect(split(onMarker)).toEqual({ ready: "", rest: onMarker });
    expect(split(`${onMarker}  \`\`\`\nDone`)).toEqual({
      ready: `${onMarker}  \`\`\`\n`,
      rest: "Done",
    });
    // Tabs count to the next tab stop, like CommonMark's columns.
    expect(split("-\t```\n\tx\n\n\t```\nDone")).toEqual({
      ready: "-\t```\n\tx\n\n\t```\n",
      rest: "Done",
    });
  });

  it("treats a closer indented more than three columns past its container as code", () => {
    const text = "```\ncode\n    ```\n\nmore\n";
    expect(split(text)).toEqual({ ready: "", rest: text });
    expect(split(`${text}   \`\`\`\nAfter`)).toEqual({
      ready: `${text}   \`\`\`\n`,
      rest: "After",
    });
    // In a list item the columns count from the item's content, not from the opener.
    const item = "- item\n\n    ```\n    a\n\n       ```\n\n";
    expect(split(item)).toEqual({ ready: "- item\n\n", rest: item.slice(8) });
  });

  it("ends a list item's fence with the item", () => {
    // Code has no lazy lines: a line indented less than the item's content ends the item,
    // and the fence in it. Here that line opens a new fence at the top level.
    const text = "1. Install:\n   ```bash\n   npm i\n```\n2. Next\n\n";
    expect(split(text)).toEqual({ ready: "", rest: text });
    const unindented = "- a\n  ```\n  x\n\nfree text\n\n";
    expect(split(unindented)).toEqual({ ready: unindented, rest: "" });
  });

  it("does not open a fence indented four columns outside a list item", () => {
    // The first line is an indented code block; the third opens a real fence.
    const text = "    ```\nindented code\n```\n\ninside real fence\n\n";
    expect(split(text)).toEqual({ ready: "    ```\n", rest: text.slice(8) });
    // After a paragraph, the indented line continues it.
    const continued = "text\n    ```\n    code\n\n    ```\n";
    expect(split(continued)).toEqual({
      ready: "text\n    ```\n    code\n\n",
      rest: "    ```\n",
    });
  });

  it("opens a fence indented past a list item's content by up to three columns", () => {
    const text = "- item\n\n    ```\n    a\n\n    b\n";
    expect(split(text)).toEqual({ ready: "- item\n\n", rest: text.slice(8) });
    // A lazy line keeps the item open, so the next fence is still in it.
    const lazy = "- a\nlazy\n  ```\n  code\n\n  x\n";
    expect(split(lazy)).toEqual({ ready: "", rest: lazy });
    expect(split(`${lazy}  \`\`\`\n`)).toEqual({ ready: `${lazy}  \`\`\`\n`, rest: "" });
  });

  it("follows CommonMark on which list items may interrupt a paragraph", () => {
    // "2." cannot interrupt a paragraph, so the indented fence-like line is paragraph text.
    const text = "text\n2. foo\n      ```\n\nmore\n";
    expect(split(text)).toEqual({ ready: "text\n2. foo\n      ```\n\n", rest: "more\n" });
    // "1." can: the fence then sits in the item.
    const item = "text\n1. foo\n   ```\n\n   more\n";
    expect(split(item)).toEqual({ ready: "", rest: item });
  });

  it("holds an indented code block until a line ends it", () => {
    const text = "Here:\n\n    print(1)\n\n    print(2)\n\n";
    expect(split(text)).toEqual({ ready: "Here:\n\n", rest: text.slice(7) });
    expect(split(`${text}Done\n`)).toEqual({ ready: text, rest: "Done\n" });
  });

  it("holds a fence the caller names, even once it closes", () => {
    const holdFence = (info: string) => info === "ryco-attachments";
    const text = 'Done.\n\n```ryco-attachments\n{"files":[]}\n```\n\nThanks.\n\n';
    expect(split(text, ASSISTANT_TEXT_SCAN_START, { holdFence })).toEqual({
      ready: "Done.\n\n",
      rest: text.slice(7),
    });
    // Another fence of the same kind is not held.
    expect(split("```ts\nx\n```\n\n", ASSISTANT_TEXT_SCAN_START, { holdFence }).ready).toBe(
      "```ts\nx\n```\n\n",
    );
  });

  it("continues the scan of text sent before it", () => {
    // A spill that ended inside a code block: its closer ends a block and prose follows.
    const sent = "Intro\n\n```ts\nconst a = 1;\n\n";
    expect(splitAfter(sent, "const b = 2;\n```\n\nExplanation.\n\n```\nbare\n\nx\n")).toEqual({
      ready: "const b = 2;\n```\n\nExplanation.\n\n",
      rest: "```\nbare\n\nx\n",
    });
    // A fence opened by text sent before holds what follows.
    expect(splitAfter("```\n", "a\n\nb\n\n")).toEqual({ ready: "", rest: "a\n\nb\n\n" });
    // A line begun before the split is read whole.
    expect(splitAfter("Intro\n\n``", "`ts\ncode\n\nmore\n")).toEqual({
      ready: "",
      rest: "`ts\ncode\n\nmore\n",
    });
    // List items stay open across a release.
    const first = splitBufferedAssistantText("- item\n\n    ```\n    a\n\n");
    expect(first.ready).toBe("- item\n\n");
    expect(split(`${first.rest}    b\n`, first.restScan)).toEqual({
      ready: "",
      rest: `${first.rest}    b\n`,
    });
  });

  it("keeps a bounded start of an unfinished line", () => {
    const scan = scanAssistantText(`Intro\n\n${"x".repeat(5_000)}`, ASSISTANT_TEXT_SCAN_START);
    expect(scan.partialLine).toHaveLength(1_024);
    expect(split(" end\n\nNext\n", scan)).toEqual({ ready: " end\n\n", rest: "Next\n" });
  });

  it("releases only whole blocks while a document streams in", () => {
    const document = [
      "Intro paragraph that wraps\nonto a second line.",
      "",
      "```ts",
      "const a = 1;",
      "",
      "const b = 2;",
      "```",
      "- item one",
      "",
      "~~~~text",
      "~~~",
      "",
      "~~~~",
      "Outro.",
      "",
      "",
    ].join("\n");
    const fences = [
      [document.indexOf("```ts"), document.indexOf("```\n- item") + 4],
      [document.indexOf("~~~~text"), document.indexOf("~~~~\nOutro") + 5],
    ] as const;

    const { boundaries, held } = streamDocument(document);
    expect(held).toBe("");
    for (const boundary of boundaries) {
      for (const [start, end] of fences) {
        expect(boundary > start && boundary < end).toBe(false);
      }
    }
    expect(boundaries).toEqual([
      document.indexOf("```ts"),
      fences[0][1],
      document.indexOf("~~~~text"),
      fences[1][1],
      document.length,
    ]);
  });

  it("streams fences inside list items without releasing inside them", () => {
    const document = [
      "1. Install:",
      "",
      "    ```bash",
      "    npm i",
      "",
      "    npm test",
      "    ```",
      "",
      "2. Run it.",
      "",
      "Done.",
      "",
      "",
    ].join("\n");
    const fence = [document.indexOf("    ```bash"), document.indexOf("    ```\n\n2.") + 8];
    const { boundaries } = streamDocument(document);
    for (const boundary of boundaries) {
      expect(boundary > fence[0]! && boundary < fence[1]!).toBe(false);
    }
    expect(boundaries).toEqual([
      document.indexOf("    ```bash"),
      fence[1],
      document.indexOf("Done."),
      document.length,
    ]);
  });
});
