import "../index.css";

import { page } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";
import { EnvironmentId } from "@ryco/contracts";

const {
  codeToHtmlMock,
  getSharedHighlighterMock,
  openInPreferredEditorMock,
  readFileBinaryMock,
  readLocalApiMock,
} = vi.hoisted(() => {
  const codeToHtmlMock = vi.fn((code: string) => `<pre class="shiki"><code>${code}</code></pre>`);
  return {
    codeToHtmlMock,
    getSharedHighlighterMock: vi.fn(async () => ({
      codeToHtml: codeToHtmlMock,
    })),
    openInPreferredEditorMock: vi.fn(async () => "vscode"),
    readFileBinaryMock: vi.fn(async () => ({
      relativePath: "assets/diagram.png",
      dataBase64: "aGVsbG8=",
      mimeType: "image/png",
      sizeBytes: 5,
    })),
    readLocalApiMock: vi.fn(() => ({
      server: { getConfig: vi.fn(async () => ({ availableEditors: ["vscode"] })) },
      shell: { openInEditor: vi.fn(async () => undefined) },
    })),
  };
});

vi.mock("../environmentApi", () => {
  const readEnvironmentApi = vi.fn(() => ({
    projects: { readFileBinary: readFileBinaryMock },
  }));
  return { readEnvironmentApi, ensureEnvironmentApi: readEnvironmentApi };
});

vi.mock("../editorPreferences", () => ({
  openInPreferredEditor: openInPreferredEditorMock,
}));

vi.mock("../localApi", () => ({
  ensureLocalApi: vi.fn(() => {
    throw new Error("ensureLocalApi not implemented in browser test");
  }),
  readLocalApi: readLocalApiMock,
}));

vi.mock("@pierre/diffs", () => ({
  getSharedHighlighter: getSharedHighlighterMock,
}));

import ChatMarkdown from "./ChatMarkdown";

describe("ChatMarkdown", () => {
  afterEach(() => {
    openInPreferredEditorMock.mockClear();
    readLocalApiMock.mockClear();
    readFileBinaryMock.mockClear();
    getSharedHighlighterMock.mockClear();
    codeToHtmlMock.mockClear();
    localStorage.clear();
    document.body.innerHTML = "";
  });

  it("rewrites file uri hrefs into direct paths before rendering", async () => {
    const filePath =
      "/Users/yashsingh/p/sco/claude-code-extract/src/utils/permissions/PermissionRule.ts";
    const screen = await render(
      <ChatMarkdown text={`[PermissionRule.ts](file://${filePath})`} cwd="/repo/project" />,
    );

    try {
      const link = page.getByRole("link", { name: "PermissionRule.ts" });
      await expect.element(link).toBeInTheDocument();
      await expect.element(link).toHaveAttribute("href", filePath);

      await link.click();

      await vi.waitFor(() => {
        expect(openInPreferredEditorMock).toHaveBeenCalledWith(expect.anything(), filePath);
      });
    } finally {
      await screen.unmount();
    }
  });

  it("keeps line anchors working after rewriting file uri hrefs", async () => {
    const filePath =
      "/Users/yashsingh/p/sco/claude-code-extract/src/utils/permissions/PermissionRule.ts";
    const screen = await render(
      <ChatMarkdown text={`[PermissionRule.ts:1](file://${filePath}#L1)`} cwd="/repo/project" />,
    );

    try {
      // `L1` is dropped from the label — it is where the file opens anyway —
      // but the anchor and the position it resolves to must survive.
      const link = page.getByRole("link", { name: "PermissionRule.ts" });
      await expect.element(link).toBeInTheDocument();
      await expect.element(link).toHaveAttribute("href", `${filePath}#L1`);

      await link.click();

      await vi.waitFor(() => {
        expect(openInPreferredEditorMock).toHaveBeenCalledWith(expect.anything(), `${filePath}:1`);
      });
    } finally {
      await screen.unmount();
    }
  });

  it("shows column information inline when present", async () => {
    const filePath =
      "/Users/yashsingh/p/sco/claude-code-extract/src/utils/permissions/PermissionRule.ts";
    const screen = await render(
      <ChatMarkdown text={`[PermissionRule.ts](file://${filePath}#L1C7)`} cwd="/repo/project" />,
    );

    try {
      const link = page.getByRole("link", { name: "PermissionRule.ts · L1:C7" });
      await expect.element(link).toBeInTheDocument();
      await expect.element(link).toHaveAttribute("href", `${filePath}#L1C7`);

      await link.click();

      await vi.waitFor(() => {
        expect(openInPreferredEditorMock).toHaveBeenCalledWith(
          expect.anything(),
          `${filePath}:1:7`,
        );
      });
    } finally {
      await screen.unmount();
    }
  });

  it("disambiguates duplicate file basenames inline", async () => {
    const firstPath = "/Users/yashsingh/p/ryco/apps/web/src/components/chat/MessagesTimeline.tsx";
    const secondPath = "/Users/yashsingh/p/ryco/apps/web/src/components/MessagesTimeline.tsx";
    const screen = await render(
      <ChatMarkdown
        text={`See [MessagesTimeline.tsx](file://${firstPath}) and [MessagesTimeline.tsx](file://${secondPath}).`}
        cwd="/repo/project"
      />,
    );

    try {
      await expect
        .element(page.getByRole("link", { name: "MessagesTimeline.tsx · components/chat" }))
        .toBeInTheDocument();
      await expect
        .element(page.getByRole("link", { name: "MessagesTimeline.tsx · src/components" }))
        .toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("keeps normal web links unchanged", async () => {
    const screen = await render(
      <ChatMarkdown text="[OpenAI](https://openai.com/docs)" cwd="/repo/project" />,
    );

    try {
      const link = page.getByRole("link", { name: "OpenAI" });
      await expect.element(link).toBeInTheDocument();
      await expect.element(link).toHaveAttribute("href", "https://openai.com/docs");
      await expect.element(link).toHaveAttribute("target", "_blank");
    } finally {
      await screen.unmount();
    }
  });

  it("loads local Markdown images through the workspace-contained binary RPC", async () => {
    const screen = await render(
      <ChatMarkdown
        text="![Architecture](./assets/diagram.png)"
        cwd="/repo/project"
        environmentId={EnvironmentId.make("local")}
      />,
    );

    try {
      await vi.waitFor(() => {
        expect(readFileBinaryMock).toHaveBeenCalledWith({
          cwd: "/repo/project",
          relativePath: "assets/diagram.png",
        });
      });
      const image = page.getByRole("img", { name: "Architecture" });
      await expect.element(image).toHaveAttribute("src", "data:image/png;base64,aGVsbG8=");
    } finally {
      await screen.unmount();
    }
  });

  it("does not request Markdown images that escape the workspace", async () => {
    const screen = await render(
      <ChatMarkdown
        text="![Secret](../../secret.png)"
        cwd="/repo/project"
        environmentId={EnvironmentId.make("local")}
      />,
    );

    try {
      await expect.element(page.getByText("[Secret]")).toBeInTheDocument();
      expect(readFileBinaryMock).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("renders streaming code blocks without starting the Shiki highlighter", async () => {
    const screen = await render(
      <ChatMarkdown text={"```ts\nconst value = 1;\n```"} cwd="/repo/project" isStreaming />,
    );

    try {
      const codeBlock = document.querySelector("pre code.language-ts");
      expect(codeBlock?.textContent).toBe("const value = 1;\n");
      expect(document.querySelector(".chat-markdown-shiki")).toBeNull();
      expect(getSharedHighlighterMock).not.toHaveBeenCalled();
      expect(codeToHtmlMock).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("does not show the previous finalized message when a new stream is throttled", async () => {
    vi.useFakeTimers();
    const screen = await render(
      <ChatMarkdown text="previous completed message" cwd="/repo/project" />,
    );

    try {
      await screen.rerender(
        <ChatMarkdown text="fresh streaming token" cwd="/repo/project" isStreaming />,
      );
      await screen.rerender(
        <ChatMarkdown text="fresh streaming token continued" cwd="/repo/project" isStreaming />,
      );

      expect(document.body.textContent).not.toContain("previous completed message");
    } finally {
      vi.useRealTimers();
      await screen.unmount();
    }
  });

  it("uses Shiki for finalized code blocks", async () => {
    const screen = await render(
      <ChatMarkdown text={"```ts\nconst finalValue = 1;\n```"} cwd="/repo/project" />,
    );

    try {
      await vi.waitFor(() => {
        expect(getSharedHighlighterMock).toHaveBeenCalledTimes(1);
      });
      expect(codeToHtmlMock).toHaveBeenCalledWith(
        "const finalValue = 1;\n",
        expect.objectContaining({ lang: "ts" }),
      );
      expect(document.querySelector(".chat-markdown-shiki")).not.toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("retains completed DOM and workspace images across streaming suffix updates", async () => {
    const prefix = "![Architecture](./assets/diagram.png)\n\n```ts\nconst retained = 1;\n```\n\n";
    const props = {
      cwd: "/repo/project",
      environmentId: EnvironmentId.make("local"),
      isStreaming: true,
    };
    const screen = await render(<ChatMarkdown {...props} text={prefix + "start"} />);
    try {
      await vi.waitFor(() => expect(readFileBinaryMock).toHaveBeenCalledTimes(1));
      const image = document.querySelector("img");
      const code = document.querySelector("pre code");
      for (let update = 1; update <= 4; update++) {
        const tail = `start ${"word ".repeat(update)}end`;
        await screen.rerender(<ChatMarkdown {...props} text={prefix + tail} />);
        await vi.waitFor(() => expect(document.body.textContent).toContain(tail));
        expect(document.querySelector("pre code")).toBe(code);
        expect(document.querySelector("img")).toBe(image);
      }
      expect(readFileBinaryMock).toHaveBeenCalledTimes(1);
      expect(getSharedHighlighterMock).not.toHaveBeenCalled();
      await screen.rerender(
        <ChatMarkdown
          {...props}
          isStreaming={false}
          text={prefix.replace("retained = 1", "final = 2") + "Final update"}
        />,
      );
      await vi.waitFor(() =>
        expect(codeToHtmlMock).toHaveBeenCalledWith("const final = 2;\n", expect.anything()),
      );
      await expect.element(page.getByText("Final update")).toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("refreshes completed link labels and search hits when the suffix or search changes", async () => {
    const prefix = "needle [one](./src/a.ts)\n\n```ts\nconst search = 1;\n```\n\n";
    const screen = await render(<ChatMarkdown cwd="/repo" text={prefix} isStreaming />);
    try {
      const text = prefix + "needle [two](./other/a.ts)";
      await screen.rerender(
        <ChatMarkdown
          cwd="/repo"
          text={text}
          isStreaming
          searchHighlight={{ query: "needle", activeOccurrenceIndex: 1 }}
        />,
      );
      await expect.element(page.getByRole("link", { name: "a.ts · ./src" })).toBeInTheDocument();
      await expect.element(page.getByRole("link", { name: "a.ts · ./other" })).toBeInTheDocument();
      await vi.waitFor(() => expect(document.querySelectorAll("mark")).toHaveLength(2));
      expect(
        document.querySelectorAll("mark")[1]?.getAttribute("data-thread-message-search-active"),
      ).toBe("true");
      await screen.rerender(
        <ChatMarkdown
          cwd="/repo"
          text={text}
          isStreaming
          searchHighlight={{ query: "absent", activeOccurrenceIndex: null }}
        />,
      );
      expect(document.querySelectorAll("mark")).toHaveLength(0);
    } finally {
      await screen.unmount();
    }
  });

  it("keeps streaming attachment manifests hidden and applies a final replacement immediately", async () => {
    const prefix = "```ts\nconst beforeFiles = 1;\n```\n\n";
    const screen = await render(
      <ChatMarkdown
        cwd="/repo/project"
        text={prefix + '```ryco-attachments\n{"files":['}
        isStreaming
      />,
    );
    try {
      await expect.element(page.getByRole("status")).toHaveTextContent("Preparing files…");
      const manifest =
        '```ryco-attachments\n{"files":[{"path":"output/result.png"}]}\n```\n\nReady';
      await screen.rerender(
        <ChatMarkdown cwd="/repo/project" text={prefix + manifest} isStreaming />,
      );
      await vi.waitFor(() => expect(document.body.textContent).toContain("Ready"));
      expect(document.body.textContent).not.toContain("output/result.png");
      // The attachment projection removes manifests on completion. Its final
      // replacement must bypass the deferred stream and any cached prefix.
      await screen.rerender(<ChatMarkdown cwd="/repo/project" text="Your files are ready." />);
      await expect.element(page.getByText("Your files are ready.")).toBeInTheDocument();
      expect(document.querySelector("[role=status]")).toBeNull();
      expect(document.body.textContent).not.toContain("beforeFiles");
    } finally {
      await screen.unmount();
    }
  });
});
