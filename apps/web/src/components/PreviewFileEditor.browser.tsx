import "../index.css";

import { page, userEvent } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { useState } from "react";
import { render } from "vitest-browser-react";

import { PreviewFileEditor } from "./PreviewFileEditor";
import { PREVIEW_FILE_UNSAFE_CSS } from "./PreviewFileStyles";

interface EditorHarnessProps {
  readonly cacheKey?: string;
  readonly initialContents?: string;
}

function EditorHarness({
  cacheKey = "preview-editor-browser-test",
  initialContents = "const answer = 41;\n",
}: EditorHarnessProps) {
  const [contents, setContents] = useState(initialContents);
  return (
    <div className="h-[420px]">
      <PreviewFileEditor
        cacheKey={cacheKey}
        className="block min-h-full"
        contents={contents}
        filePath="src/app.ts"
        language="typescript"
        onChange={setContents}
        options={{
          disableFileHeader: true,
          overflow: "scroll",
          theme: "pierre-light",
          themeType: "light",
          unsafeCSS: PREVIEW_FILE_UNSAFE_CSS,
        }}
      />
      <output aria-label="Current file contents">{contents}</output>
      <button type="button" onClick={() => setContents(initialContents)}>
        Reset contents
      </button>
    </div>
  );
}

describe("PreviewFileEditor", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("forwards edits from the real rich editor surface", async () => {
    const mounted = await render(<EditorHarness />);
    const editor = page.getByRole("textbox");

    await expect.element(editor).toBeInTheDocument();
    await userEvent.tripleClick(editor);
    await userEvent.keyboard("const answer = 42;");
    await expect
      .element(page.getByLabelText("Current file contents"))
      .toMatchTextContent("const answer = 42;");

    await page.getByRole("button", { name: "Reset contents" }).click();
    await expect.element(editor).toMatchTextContent("const answer = 41;");

    await mounted.unmount();
  });

  it("renders the caret after the glyph at the insertion boundary", async () => {
    const mounted = await render(<EditorHarness />);
    const editor = page.getByRole("textbox");

    await expect.element(editor).toBeInTheDocument();
    const editable = editor.element() as HTMLElement;
    const renderedLine = editable.querySelector<HTMLElement>("[data-line]");
    expect(renderedLine).not.toBeNull();

    const editableStyle = getComputedStyle(editable);
    const renderedLineStyle = getComputedStyle(renderedLine as HTMLElement);
    expect(editableStyle.fontFamily).toBe(renderedLineStyle.fontFamily);
    expect(editableStyle.fontSize).toBe(renderedLineStyle.fontSize);
    expect(editableStyle.lineHeight).toBe(renderedLineStyle.lineHeight);
    expect(editableStyle.letterSpacing).toBe(renderedLineStyle.letterSpacing);

    await userEvent.tripleClick(editor);
    await userEvent.keyboard("XX");
    await expect.element(editor).toMatchTextContent("XX");
    await vi.waitFor(() => {
      const currentLine = editable.querySelector<HTMLElement>(
        "[data-line][data-editor-active-line]",
      );
      const lastToken = currentLine?.lastElementChild;
      const caret = (editable.getRootNode() as ShadowRoot).querySelector<HTMLElement>(
        "[data-caret]",
      );
      expect(lastToken).not.toBeNull();
      expect(caret).not.toBeNull();
      expect(
        Math.abs(
          (lastToken as Element).getBoundingClientRect().right -
            (caret as HTMLElement).getBoundingClientRect().left,
        ),
      ).toBeLessThan(0.75);
    });

    await mounted.unmount();
  });

  it("places a mouse click after punctuation at the true end of the line", async () => {
    const initialContents = [
      "const semicolon = true;",
      "const comma = value,",
      "const period = value.",
      "",
    ].join("\n");
    const mounted = await render(
      <EditorHarness
        cacheKey="preview-editor-mouse-line-end-test"
        initialContents={initialContents}
      />,
    );
    const editor = page.getByRole("textbox");

    await expect.element(editor).toBeInTheDocument();
    const editable = editor.element() as HTMLElement;
    const editableRect = editable.getBoundingClientRect();
    const expectedLines = [
      "const semicolon = true;X",
      "const comma = value,X",
      "const period = value.X",
    ];
    for (const [index, expectedLine] of expectedLines.entries()) {
      const line = editable.querySelector<HTMLElement>(`[data-line="${index + 1}"]`);
      const lastToken = line?.lastElementChild;
      expect(line).not.toBeNull();
      expect(lastToken).not.toBeNull();

      const lineRect = (line as HTMLElement).getBoundingClientRect();
      const tokenRect = (lastToken as Element).getBoundingClientRect();
      await editor.click({
        position: {
          x: tokenRect.right - editableRect.left + 3,
          y: lineRect.top - editableRect.top + lineRect.height / 2,
        },
      });
      await userEvent.keyboard("X");
      await expect
        .element(page.getByLabelText("Current file contents"))
        .toMatchTextContent(expectedLine);
    }

    await mounted.unmount();
  });

  it("moves to the true end of a punctuation-terminated line with the keyboard", async () => {
    const initialContents = "const punctuation = value;,.\n";
    const mounted = await render(
      <EditorHarness
        cacheKey="preview-editor-keyboard-line-end-test"
        initialContents={initialContents}
      />,
    );
    const editor = page.getByRole("textbox");

    await expect.element(editor).toBeInTheDocument();
    const editable = editor.element() as HTMLElement;
    const line = editable.querySelector<HTMLElement>('[data-line="1"]');
    const firstToken = line?.firstElementChild;
    expect(line).not.toBeNull();
    expect(firstToken).not.toBeNull();

    const editableRect = editable.getBoundingClientRect();
    const lineRect = (line as HTMLElement).getBoundingClientRect();
    const tokenRect = (firstToken as Element).getBoundingClientRect();
    await editor.click({
      position: {
        x: tokenRect.left - editableRect.left + 2,
        y: lineRect.top - editableRect.top + lineRect.height / 2,
      },
    });
    await userEvent.keyboard("{Home}{End}");
    await vi.waitFor(() => {
      const currentLine = editable.querySelector<HTMLElement>(
        '[data-line="1"][data-editor-active-line]',
      );
      const lastToken = currentLine?.lastElementChild;
      const caret = (editable.getRootNode() as ShadowRoot).querySelector<HTMLElement>(
        "[data-caret]",
      );
      expect(lastToken).not.toBeNull();
      expect(caret).not.toBeNull();
      expect(
        Math.abs(
          (lastToken as Element).getBoundingClientRect().right -
            (caret as HTMLElement).getBoundingClientRect().left,
        ),
      ).toBeLessThan(0.75);
    });
    await userEvent.keyboard("X");

    await expect
      .element(page.getByLabelText("Current file contents"))
      .toMatchTextContent("const punctuation = value;,.X");

    await mounted.unmount();
  });
});
