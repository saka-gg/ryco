import "../index.css";

import { page } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";
import { EnvironmentId, ProjectId } from "@ryco/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@ryco/contracts/settings";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";

const {
  codeToHtmlMock,
  contextMenuShowMock,
  getSharedHighlighterMock,
  openInPreferredEditorMock,
  readFileBinaryMock,
  readLocalApiMock,
  workspaceFileOpenerMock,
} = vi.hoisted(() => {
  const codeToHtmlMock = vi.fn((code: string) => `<pre class="shiki"><code>${code}</code></pre>`);
  const contextMenuShowMock = vi.fn(
    async (
      _items: ReadonlyArray<{ readonly id: string }>,
      _position?: { x: number; y: number },
    ): Promise<string | null> => null,
  );
  return {
    codeToHtmlMock,
    contextMenuShowMock,
    // Off a thread route by default: links keep opening the editor.
    workspaceFileOpenerMock: {
      canOpen: vi.fn(() => false),
      open: vi.fn(() => true),
    },
    getSharedHighlighterMock: vi.fn(async () => ({
      codeToHtml: codeToHtmlMock,
    })),
    openInPreferredEditorMock: vi.fn(async (_api: unknown, _target: string) => "vscode"),
    readFileBinaryMock: vi.fn(async () => ({
      relativePath: "assets/diagram.png",
      dataBase64: "aGVsbG8=",
      mimeType: "image/png",
      sizeBytes: 5,
    })),
    readLocalApiMock: vi.fn(() => ({
      server: { getConfig: vi.fn(async () => ({ availableEditors: ["vscode"] })) },
      shell: { openInEditor: vi.fn(async () => undefined) },
      contextMenu: { show: contextMenuShowMock },
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
  // Where a path opens (this machine, over SSH, or not at all) is `editorOpenRoute.test.ts`'s
  // concern; here every path opens on this machine.
  openPathInEditor: (_environmentId: unknown, target: string) =>
    openInPreferredEditorMock({}, target),
  canOpenInEditor: () => true,
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

vi.mock("../workspaceFileNavigation", () => ({
  useWorkspaceFileOpener: () => workspaceFileOpenerMock,
}));

import ChatMarkdown from "./ChatMarkdown";
import { resetCodeHighlightQueueForTests } from "./chat/codeHighlightQueue";
import { syncDocumentPresentationTier } from "../lib/presentationTier";
import { replaceClientSettingsSnapshot } from "../hooks/clientSettingsStore";
import { selectEnvironmentState, useStore } from "../store";
import { getProjectOrderKey } from "../logicalProject";
import { useUiStateStore } from "../uiStateStore";

/** The running opacity transitions of an element (the streaming fade-in). */
function opacityTransitions(element: Element) {
  return element
    .getAnimations()
    .filter(
      (animation) =>
        animation instanceof CSSTransition && animation.transitionProperty === "opacity",
    );
}

const nextFrame = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );

describe("ChatMarkdown", () => {
  afterEach(() => {
    openInPreferredEditorMock.mockClear();
    contextMenuShowMock.mockClear();
    workspaceFileOpenerMock.canOpen.mockReset().mockReturnValue(false);
    workspaceFileOpenerMock.open.mockReset().mockReturnValue(true);
    readLocalApiMock.mockClear();
    readFileBinaryMock.mockClear();
    getSharedHighlighterMock.mockClear();
    codeToHtmlMock.mockClear();
    resetCodeHighlightQueueForTests();
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

  it("fades in blocks that arrive while a message streams, and never in history", async () => {
    const screen = await render(
      <ChatMarkdown
        text={"First paragraph.\n\n"}
        cwd="/repo/project"
        isStreaming
        smoothStreaming={false}
      />,
    );

    try {
      const root = document.querySelector<HTMLElement>(".chat-markdown")!;
      expect(root.hasAttribute("data-streaming")).toBe(true);
      await screen.rerender(
        <ChatMarkdown
          text={"First paragraph.\n\n- one\n- two\n\n"}
          cwd="/repo/project"
          isStreaming
          smoothStreaming={false}
        />,
      );
      await vi.waitFor(() => expect(root.querySelector("ul")).not.toBeNull());
      const list = root.querySelector("ul")!;
      expect(getComputedStyle(list).transitionProperty).toBe("opacity");
      expect(getComputedStyle(list).transitionDuration).toBe("0.6s");
      expect(getComputedStyle(list.querySelector("li")!).transitionProperty).toBe("opacity");
      expect(opacityTransitions(list)).toHaveLength(1);

      await screen.rerender(
        <ChatMarkdown text={"First paragraph.\n\n- one\n- two\n\n"} cwd="/repo/project" />,
      );
      expect(root.hasAttribute("data-streaming")).toBe(false);
      expect(getComputedStyle(root.querySelector("p")!).transitionDuration).toBe("0s");
    } finally {
      await screen.unmount();
    }
  });

  it("does not fade in the blocks already there when a streaming message mounts", async () => {
    // Opening a thread mid-reply, or scrolling a row of the running turn back into view.
    const screen = await render(
      <ChatMarkdown
        text={"First.\n\n- one\n- two\n\n"}
        cwd="/repo/project"
        isStreaming
        smoothStreaming={false}
      />,
    );

    try {
      const root = document.querySelector<HTMLElement>(".chat-markdown")!;
      expect(root.hasAttribute("data-streaming")).toBe(true);
      await nextFrame();
      for (const block of root.querySelectorAll("p, ul, li")) {
        expect(opacityTransitions(block)).toEqual([]);
      }

      await screen.rerender(
        <ChatMarkdown
          text={"First.\n\n- one\n- two\n\nSecond.\n\n"}
          cwd="/repo/project"
          isStreaming
          smoothStreaming={false}
        />,
      );
      await vi.waitFor(() => expect(root.querySelectorAll("p")).toHaveLength(2));
      expect(opacityTransitions(root.querySelectorAll("p")[1]!)).toHaveLength(1);
      expect(opacityTransitions(root.querySelector("p")!)).toEqual([]);
    } finally {
      await screen.unmount();
    }
  });

  it("leaves text revealed token by token without the fade", async () => {
    // Token streaming and streaming reasoning keep the gradual reveal, which already
    // eases new text in; a fade on top would replay whenever a block changes shape.
    const screen = await render(
      <ChatMarkdown text={"Steps:\n\n"} cwd="/repo/project" isStreaming />,
    );

    try {
      const root = document.querySelector<HTMLElement>(".chat-markdown")!;
      await screen.rerender(
        <ChatMarkdown text={"Steps:\n\n- one\n\n"} cwd="/repo/project" isStreaming />,
      );
      expect(root.hasAttribute("data-streaming")).toBe(false);
      await vi.waitFor(() => expect(root.querySelector("ul")).not.toBeNull());
      expect(getComputedStyle(root.querySelector("ul")!).transitionDuration).toBe("0s");
    } finally {
      await screen.unmount();
    }
  });

  it("shows a released block whole when the reveal is not smoothed", async () => {
    const block = "Second paragraph with enough words to take several frames to reveal.";
    const screen = await render(
      <ChatMarkdown text={"First.\n\n"} cwd="/repo/project" isStreaming smoothStreaming={false} />,
    );

    try {
      const root = document.querySelector<HTMLElement>(".chat-markdown")!;
      const seen: string[] = [];
      const observer = new MutationObserver(() => {
        const text = root.querySelectorAll("p")[1]?.textContent;
        if (text !== undefined) seen.push(text);
      });
      observer.observe(root, { childList: true, subtree: true, characterData: true });
      await screen.rerender(
        <ChatMarkdown
          text={`First.\n\n${block}\n\n`}
          cwd="/repo/project"
          isStreaming
          smoothStreaming={false}
        />,
      );
      await vi.waitFor(() => expect(root.querySelectorAll("p")[1]?.textContent).toBe(block));
      observer.disconnect();
      // Never a partly revealed paragraph on the way.
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((text) => text === block)).toBe(true);
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
      await vi.waitFor(() => {
        expect(document.querySelector(".chat-markdown-shiki")).not.toBeNull();
      });
      expect(codeToHtmlMock).toHaveBeenCalledWith(
        "const finalValue = 1;\n",
        expect.objectContaining({ lang: "ts" }),
      );
    } finally {
      await screen.unmount();
    }
  });

  it("paints settled code blocks as plain text and highlights them after the commit", async () => {
    const screen = await render(
      <ChatMarkdown text={"```ts\nconst deferred = 1;\n```"} cwd="/repo/project" />,
    );

    try {
      // The first commit carries the plain block; Shiki never runs in render.
      expect(document.querySelector("pre code.language-ts")?.textContent).toBe(
        "const deferred = 1;\n",
      );
      expect(document.querySelector(".chat-markdown-shiki")).toBeNull();
      expect(codeToHtmlMock).not.toHaveBeenCalled();

      await vi.waitFor(() => {
        expect(document.querySelector(".chat-markdown-shiki")).not.toBeNull();
      });
      expect(document.querySelector("pre code.language-ts")).toBeNull();

      // A remount of the same block reads the cached HTML in its first commit.
      await screen.rerender(<div />);
      await screen.rerender(
        <ChatMarkdown text={"```ts\nconst deferred = 1;\n```"} cwd="/repo/project" />,
      );
      expect(document.querySelector(".chat-markdown-shiki")).not.toBeNull();
      expect(codeToHtmlMock).toHaveBeenCalledTimes(1);
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
      await expect.element(page.getByRole("status")).toMatchTextContent("Preparing files…");
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

describe("completed Mermaid Markdown boundary", () => {
  let stopTier: () => void;
  beforeEach(async () => {
    await page.viewport(1024, 768);
    stopTier = syncDocumentPresentationTier();
  });
  afterEach(() => stopTier());
  it("renders completed fences and copies their exact source", async () => {
    const source = "flowchart LR\nOriginal-->Source\n";
    const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const screen = await render(
      <ChatMarkdown cwd="/repo" text={`\`\`\`mermaid\n${source}\`\`\``} />,
    );
    await expect.element(screen.getByRole("img")).toBeVisible();
    await screen.getByRole("button", { name: "Copy code" }).click();
    expect(write).toHaveBeenCalledWith(source);
    write.mockRestore();
  });

  it("keeps streaming, unclosed and unsupported fences on code", async () => {
    const text = "```mermaid\nflowchart TD\nA-->B\n```";
    const screen = await render(<ChatMarkdown cwd="/repo" text={text} isStreaming />);
    expect(document.querySelector("[data-mermaid]")).toBeNull();
    await screen.rerender(<ChatMarkdown cwd="/repo" text={"```mermaid\nflowchart TD\nA-->B"} />);
    expect(document.querySelector("[data-mermaid]")).toBeNull();
    await screen.rerender(
      <ChatMarkdown
        cwd="/repo"
        text={"```mermaid\n---\nconfig: {}\n---\nflowchart TD\nA-->B\n```"}
      />,
    );
    expect(document.querySelector("[data-mermaid]")).toBeNull();
    await screen.rerender(<ChatMarkdown cwd="/repo" text={text} />);
    await expect.element(screen.getByRole("img")).toBeVisible();
  });
});

it("keeps the frozen phone tier on source", async () => {
  await page.viewport(390, 844);
  const stop = syncDocumentPresentationTier();
  try {
    await render(<ChatMarkdown cwd={undefined} text={"```mermaid\nflowchart TD\nA-->B\n```"} />);
    expect(document.querySelector("[data-mermaid]")).toBeNull();
  } finally {
    stop();
  }
});

it("resolves delegated result child and origin links within the current environment", async () => {
  const screen = await render(
    <ChatMarkdown
      text="[Open child](/ryco/thread/child) · [Open origin](/ryco/thread/parent)"
      cwd="/fixture"
      environmentId={EnvironmentId.make("fixture-env")}
    />,
  );
  await expect
    .element(screen.getByRole("link", { name: "Open child" }))
    .toHaveAttribute("href", "/fixture-env/child");
  await expect
    .element(screen.getByRole("link", { name: "Open origin" }))
    .toHaveAttribute("href", "/fixture-env/parent");
});

describe("file links open in Ryco", () => {
  let stopTier: () => void;
  beforeEach(async () => {
    await page.viewport(1024, 768);
    stopTier = syncDocumentPresentationTier();
  });
  afterEach(() => {
    stopTier();
    openInPreferredEditorMock.mockClear();
    contextMenuShowMock.mockClear();
    workspaceFileOpenerMock.canOpen.mockReset().mockReturnValue(false);
    workspaceFileOpenerMock.open.mockReset().mockReturnValue(true);
    document.body.innerHTML = "";
  });

  it("opens workspace file links in the Files panel at their line", async () => {
    workspaceFileOpenerMock.canOpen.mockReturnValue(true);
    const screen = await render(
      <ChatMarkdown
        text="See [app.ts](/repo/project/src/app.ts#L12) and [notes](docs/notes.md)."
        cwd="/repo/project"
      />,
    );

    try {
      await page.getByRole("link", { name: "app.ts · L12" }).click();
      expect(workspaceFileOpenerMock.open).toHaveBeenCalledWith({ path: "src/app.ts", line: 12 });
      await page.getByRole("link", { name: "notes.md" }).click();
      expect(workspaceFileOpenerMock.open).toHaveBeenLastCalledWith({
        path: "docs/notes.md",
        line: undefined,
      });
      expect(openInPreferredEditorMock).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("opens the editor on modifier clicks, outside the workspace and off a thread", async () => {
    workspaceFileOpenerMock.canOpen.mockReturnValue(true);
    const screen = await render(
      <ChatMarkdown
        text="[app.ts](/repo/project/src/app.ts) [other.ts](/elsewhere/other.ts)"
        cwd="/repo/project"
      />,
    );

    try {
      await page.getByRole("link", { name: "app.ts" }).click({ modifiers: ["ControlOrMeta"] });
      await vi.waitFor(() =>
        expect(openInPreferredEditorMock).toHaveBeenCalledWith(
          expect.anything(),
          "/repo/project/src/app.ts",
        ),
      );
      await page.getByRole("link", { name: "other.ts" }).click();
      await vi.waitFor(() =>
        expect(openInPreferredEditorMock).toHaveBeenLastCalledWith(
          expect.anything(),
          "/elsewhere/other.ts",
        ),
      );
      workspaceFileOpenerMock.canOpen.mockReturnValue(false);
      await page.getByRole("link", { name: "app.ts" }).click();
      await vi.waitFor(() => expect(openInPreferredEditorMock).toHaveBeenCalledTimes(3));
      expect(workspaceFileOpenerMock.open).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("offers Open in Ryco first in the file link menu when the file is in the workspace", async () => {
    workspaceFileOpenerMock.canOpen.mockReturnValue(true);
    contextMenuShowMock.mockResolvedValueOnce("open-ryco");
    const screen = await render(
      <ChatMarkdown text="[app.ts](/repo/project/src/app.ts#L3)" cwd="/repo/project" />,
    );

    try {
      await page.getByRole("link", { name: "app.ts · L3" }).click({ button: "right" });
      await vi.waitFor(() => expect(contextMenuShowMock).toHaveBeenCalled());
      expect(contextMenuShowMock.mock.calls[0]?.[0].map((item) => item.id)).toEqual([
        "open-ryco",
        "open",
        "copy-relative",
        "copy-full",
      ]);
      await vi.waitFor(() =>
        expect(workspaceFileOpenerMock.open).toHaveBeenCalledWith({ path: "src/app.ts", line: 3 }),
      );

      workspaceFileOpenerMock.canOpen.mockReturnValue(false);
      await page.getByRole("link", { name: "app.ts · L3" }).click({ button: "right" });
      await vi.waitFor(() => expect(contextMenuShowMock).toHaveBeenCalledTimes(2));
      expect(contextMenuShowMock.mock.calls[1]?.[0].map((item) => item.id)).toEqual([
        "open",
        "copy-relative",
        "copy-full",
      ]);
    } finally {
      await screen.unmount();
    }
  });

  it("keeps the frozen phone tier on the editor", async () => {
    await page.viewport(390, 844);
    workspaceFileOpenerMock.canOpen.mockReturnValue(true);
    const screen = await render(
      <ChatMarkdown text="[app.ts](/repo/project/src/app.ts)" cwd="/repo/project" />,
    );

    try {
      await page.getByRole("link", { name: "app.ts" }).click();
      await vi.waitFor(() =>
        expect(openInPreferredEditorMock).toHaveBeenCalledWith(
          expect.anything(),
          "/repo/project/src/app.ts",
        ),
      );
      expect(workspaceFileOpenerMock.open).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });
});

describe("document mode", () => {
  let stopTier: () => void;
  beforeEach(async () => {
    await page.viewport(1024, 768);
    stopTier = syncDocumentPresentationTier();
    workspaceFileOpenerMock.canOpen.mockReturnValue(true);
  });
  afterEach(() => {
    stopTier();
    openInPreferredEditorMock.mockClear();
    contextMenuShowMock.mockClear();
    readFileBinaryMock.mockClear();
    workspaceFileOpenerMock.canOpen.mockReset().mockReturnValue(false);
    workspaceFileOpenerMock.open.mockReset().mockReturnValue(true);
    document.body.innerHTML = "";
  });

  const renderDocument = (text: string) =>
    render(
      <ChatMarkdown
        text={text}
        cwd="/repo"
        documentFolder="/repo/docs"
        environmentId={EnvironmentId.make("local")}
      />,
    );

  it("opens workspace files from the document's own folder in the Files panel", async () => {
    const screen = await renderDocument("See [n](../notes.md) and [g](./guide.md#L4).");

    try {
      await page.getByRole("link", { name: "notes.md" }).click();
      expect(workspaceFileOpenerMock.open).toHaveBeenCalledWith({
        path: "notes.md",
        line: undefined,
      });
      await page.getByRole("link", { name: "guide.md · L4" }).click();
      expect(workspaceFileOpenerMock.open).toHaveBeenLastCalledWith({
        path: "docs/guide.md",
        line: 4,
      });
      expect(openInPreferredEditorMock).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("reads images relative to the document's folder, inside the workspace", async () => {
    const screen = await renderDocument("![Diagram](../assets/a.png)");

    try {
      await vi.waitFor(() =>
        expect(readFileBinaryMock).toHaveBeenCalledWith({
          cwd: "/repo",
          relativePath: "assets/a.png",
        }),
      );
    } finally {
      await screen.unmount();
    }
  });

  it("never opens the editor on a plain click outside the workspace", async () => {
    const screen = await renderDocument("[x](/etc/hosts) and [y](../../x.md)");

    try {
      await page.getByRole("link", { name: "hosts" }).click();
      await page.getByRole("link", { name: "x.md" }).click();
      await nextFrame();
      expect(workspaceFileOpenerMock.open).not.toHaveBeenCalled();
      expect(openInPreferredEditorMock).not.toHaveBeenCalled();

      // Cmd/Ctrl-click is an explicit choice, as in a reply.
      await page.getByRole("link", { name: "hosts" }).click({ modifiers: ["ControlOrMeta"] });
      await vi.waitFor(() =>
        expect(openInPreferredEditorMock).toHaveBeenCalledWith(expect.anything(), "/etc/hosts"),
      );
    } finally {
      await screen.unmount();
    }
  });

  it("renders anchors, other relative links and thread references inert", async () => {
    const location = window.location.href;
    const open = vi.spyOn(window, "open");
    const screen = await renderDocument(
      "[toc](#install) [l](LICENSE) [d](docs/) [t](/ryco/thread/abc) [j](javascript:alert(1))",
    );

    try {
      for (const name of ["toc", "l", "d", "t", "j"]) {
        await expect.element(page.getByText(name, { exact: true })).toBeInTheDocument();
        expect(page.getByRole("link", { name, exact: true }).query()).toBeNull();
        await page.getByText(name, { exact: true }).click();
      }
      expect(document.querySelectorAll(".chat-markdown a")).toHaveLength(0);
      expect(window.location.href).toBe(location);
      expect(open).not.toHaveBeenCalled();
      expect(workspaceFileOpenerMock.open).not.toHaveBeenCalled();
      expect(openInPreferredEditorMock).not.toHaveBeenCalled();
    } finally {
      open.mockRestore();
      await screen.unmount();
    }
  });

  it("keeps @thread mentions as text, in paragraphs, lists and tables", async () => {
    const screen = await renderDocument(
      [
        "See @thread:abc123 here.",
        "",
        "- also @thread:def456",
        "",
        "| Thread |",
        "| --- |",
        "| @thread:ghi789 |",
      ].join("\n"),
    );

    try {
      for (const id of ["abc123", "def456", "ghi789"]) {
        await expect.element(page.getByText(`@thread:${id}`, { exact: false })).toBeInTheDocument();
      }
      expect(document.querySelectorAll("[data-thread-mention-chip]")).toHaveLength(0);
      expect(document.querySelectorAll(".chat-markdown a")).toHaveLength(0);
    } finally {
      await screen.unmount();
    }
  });

  it("opens reference-style and linked-image file links in the Files panel", async () => {
    const screen = await renderDocument(
      [
        "See the [contributing guide][contrib].",
        "",
        "[![Logo](../assets/logo.png)](./guide.md)",
        "",
        "[contrib]: ../CONTRIBUTING.md",
      ].join("\n"),
    );

    try {
      await page.getByRole("link", { name: "CONTRIBUTING.md" }).click();
      expect(workspaceFileOpenerMock.open).toHaveBeenLastCalledWith({
        path: "CONTRIBUTING.md",
        line: undefined,
      });
      await page.getByRole("link", { name: "guide.md" }).click();
      expect(workspaceFileOpenerMock.open).toHaveBeenLastCalledWith({
        path: "docs/guide.md",
        line: undefined,
      });
      expect(openInPreferredEditorMock).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("keeps a middle click on a file link from opening its raw href", async () => {
    const screen = await renderDocument("[n](../notes.md) and [x](/etc/hosts)");

    try {
      for (const name of ["notes.md", "hosts"]) {
        const link = page.getByRole("link", { name }).element();
        const middleClick = new MouseEvent("auxclick", {
          bubbles: true,
          button: 1,
          cancelable: true,
        });
        link.dispatchEvent(middleClick);
        expect(middleClick.defaultPrevented).toBe(true);
      }
      expect(workspaceFileOpenerMock.open).not.toHaveBeenCalled();
      expect(openInPreferredEditorMock).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("keeps web and mail links as links that leave the app", async () => {
    const screen = await renderDocument(
      "[s](https://example.com/docs) [m](mailto:team@example.com)",
    );

    try {
      for (const [name, href] of [
        ["s", "https://example.com/docs"],
        ["m", "mailto:team@example.com"],
      ] as const) {
        const link = page.getByRole("link", { name, exact: true });
        await expect.element(link).toHaveAttribute("href", href);
        await expect.element(link).toHaveAttribute("target", "_blank");
        await expect.element(link).toHaveAttribute("rel", "noopener noreferrer");
      }
    } finally {
      await screen.unmount();
    }
  });

  it("leaves replies as they were: an anchor in a reply is still a link", async () => {
    const screen = await render(
      <ChatMarkdown
        text="[toc](#install) [t](/ryco/thread/abc)"
        cwd="/repo"
        environmentId={EnvironmentId.make("local")}
      />,
    );

    try {
      await expect
        .element(page.getByRole("link", { name: "toc", exact: true }))
        .toHaveAttribute("href", "#install");
      await expect
        .element(page.getByRole("link", { name: "t", exact: true }))
        .toHaveAttribute("href", "/local/abc");
    } finally {
      await screen.unmount();
    }
  });
});

describe("pull request links open on the Pull requests page", () => {
  const environmentId = EnvironmentId.make("links-env");
  const projectId = ProjectId.make("links-project");
  let stopTier: () => void;
  let initialStore: ReturnType<typeof useStore.getState>;
  /** `defaultPrevented` of each link click once React handled it; the guard keeps tabs closed. */
  let clicks: boolean[];
  const recordClick = (event: MouseEvent) => {
    if (!(event.target instanceof Element) || !event.target.closest("a")) return;
    clicks.push(event.defaultPrevented);
    event.preventDefault();
  };

  beforeEach(async () => {
    await page.viewport(1024, 768);
    stopTier = syncDocumentPresentationTier();
    clicks = [];
    window.addEventListener("click", recordClick);
    initialStore = useStore.getState();
    useStore.setState({
      environmentStateById: {
        [environmentId]: {
          ...selectEnvironmentState(initialStore, environmentId),
          projectIds: [projectId],
          projectById: {
            [projectId]: {
              id: projectId,
              environmentId,
              name: "app",
              cwd: "/repo/app",
              defaultModelSelection: null,
              scripts: [],
              repositoryIdentity: {
                canonicalKey: "github.com/acme/app",
                locator: {
                  source: "git-remote",
                  remoteName: "origin",
                  remoteUrl: "git@github.com:acme/app.git",
                },
                remotes: [],
              },
            },
          },
          bootstrapComplete: true,
        },
      },
    });
  });
  afterEach(() => {
    window.removeEventListener("click", recordClick);
    stopTier();
    useStore.setState(initialStore, true);
    replaceClientSettingsSnapshot(DEFAULT_CLIENT_SETTINGS);
    document.body.innerHTML = "";
  });

  async function mountInRouter(text: string) {
    const root = createRootRoute({
      component: () => (
        <>
          <ChatMarkdown text={text} cwd="/repo/app" environmentId={environmentId} />
          <Outlet />
        </>
      ),
    });
    const home = createRoute({ getParentRoute: () => root, path: "/", component: () => null });
    const pullRequests = createRoute({
      getParentRoute: () => root,
      path: "/pull-requests",
      component: () => <div data-testid="pull-requests-route" />,
    });
    const router = createRouter({
      routeTree: root.addChildren([home, pullRequests]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    const mounted = await render(<RouterProvider router={router} />);
    await vi.waitFor(() => expect(router.state.status).toBe("idle"));
    return { router, mounted };
  }

  it("opens a plain click on the Pull requests page and keeps the host link", async () => {
    const { router, mounted } = await mountInRouter(
      "See [the PR](https://github.com/acme/app/pull/12/files).",
    );
    try {
      const link = page.getByRole("link", { name: "the PR" });
      await expect
        .element(link)
        .toHaveAttribute("href", "https://github.com/acme/app/pull/12/files");
      await expect.element(link).toHaveAttribute("target", "_blank");
      await link.click();
      await vi.waitFor(() => expect(router.state.location.pathname).toBe("/pull-requests"));
      expect(router.state.location.search).toEqual({
        env: environmentId,
        project: projectId,
        pr: 12,
        tab: "files",
      });
      expect(clicks).toEqual([true]);
    } finally {
      await mounted.unmount();
    }
  });

  it("opens through the checkout the sidebar lists first", async () => {
    const cloneId = ProjectId.make("links-clone");
    const state = selectEnvironmentState(useStore.getState(), environmentId);
    const original = state.projectById[projectId]!;
    const clone = { ...original, id: cloneId, name: "app-clone", cwd: "/repo/app-clone" };
    useStore.setState({
      environmentStateById: {
        [environmentId]: {
          ...state,
          projectIds: [projectId, cloneId],
          projectById: { [projectId]: original, [cloneId]: clone },
        },
      },
    });
    const initialUiState = useUiStateStore.getState();
    useUiStateStore.setState({
      projectOrder: [getProjectOrderKey(clone), getProjectOrderKey(original)],
    });
    const { router, mounted } = await mountInRouter("[ours](https://github.com/acme/app/pull/12)");
    try {
      await page.getByRole("link", { name: "ours" }).click();
      await vi.waitFor(() => expect(router.state.location.pathname).toBe("/pull-requests"));
      expect(router.state.location.search).toEqual({
        env: environmentId,
        project: cloneId,
        pr: 12,
      });
    } finally {
      await mounted.unmount();
      useUiStateStore.setState(initialUiState, true);
    }
  });

  it("keeps modifier clicks, other repositories and comment links in the browser", async () => {
    const { router, mounted } = await mountInRouter(
      [
        "[ours](https://github.com/acme/app/pull/12)",
        "[theirs](https://github.com/other/repo/pull/1)",
        "[comment](https://github.com/acme/app/pull/12#issuecomment-5)",
      ].join(" "),
    );
    try {
      await page.getByRole("link", { name: "ours" }).click({ modifiers: ["ControlOrMeta"] });
      await page.getByRole("link", { name: "ours" }).click({ modifiers: ["Shift"] });
      await page.getByRole("link", { name: "theirs" }).click();
      await page.getByRole("link", { name: "comment" }).click();
      await vi.waitFor(() => expect(clicks).toEqual([false, false, false, false]));
      expect(router.state.location.pathname).toBe("/");
    } finally {
      await mounted.unmount();
    }
  });

  it("keeps every link in the browser with the Browser setting", async () => {
    replaceClientSettingsSnapshot({
      ...DEFAULT_CLIENT_SETTINGS,
      changeRequestLinkTarget: "browser",
    });
    const { router, mounted } = await mountInRouter("[ours](https://github.com/acme/app/pull/12)");
    try {
      await page.getByRole("link", { name: "ours" }).click();
      await vi.waitFor(() => expect(clicks).toEqual([false]));
      expect(router.state.location.pathname).toBe("/");
    } finally {
      await mounted.unmount();
    }
  });

  it("keeps the link in the browser while the project's environment is not connected", async () => {
    useStore.setState({
      environmentStateById: {
        [environmentId]: {
          ...selectEnvironmentState(useStore.getState(), environmentId),
          bootstrapComplete: false,
        },
      },
    });
    const { router, mounted } = await mountInRouter("[ours](https://github.com/acme/app/pull/12)");
    try {
      await page.getByRole("link", { name: "ours" }).click();
      await vi.waitFor(() => expect(clicks).toEqual([false]));
      expect(router.state.location.pathname).toBe("/");
    } finally {
      await mounted.unmount();
    }
  });

  it("keeps the browser outside a router, without a router warning", async () => {
    const warn = vi.spyOn(console, "warn");
    const screen = await render(
      <ChatMarkdown
        text="[ours](https://github.com/acme/app/pull/12)"
        cwd="/repo/app"
        environmentId={environmentId}
      />,
    );
    try {
      await page.getByRole("link", { name: "ours" }).click();
      await vi.waitFor(() => expect(clicks).toEqual([false]));
      expect(warn.mock.calls.flat().join(" ")).not.toMatch(/useRouter/u);
    } finally {
      warn.mockRestore();
      await screen.unmount();
    }
  });

  it("keeps the frozen phone tier in the browser", async () => {
    await page.viewport(390, 844);
    const { router, mounted } = await mountInRouter("[ours](https://github.com/acme/app/pull/12)");
    try {
      await page.getByRole("link", { name: "ours" }).click();
      await vi.waitFor(() => expect(clicks).toEqual([false]));
      expect(router.state.location.pathname).toBe("/");
    } finally {
      await mounted.unmount();
    }
  });
});
