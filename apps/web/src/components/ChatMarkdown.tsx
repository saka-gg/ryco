import { CheckIcon, CopyIcon } from "lucide-react";
import {
  isTerminalSnippetLanguage,
  terminalSnippetError,
} from "@ryco/client-runtime/state/terminal";
import { useTerminalSnippetAction } from "./chat/CodeBlockActions";
import {
  createHighlightCacheKey,
  readHighlightedCode,
  requestCodeHighlight,
} from "./chat/codeHighlightQueue";
import { terminalFenceSource } from "../lib/terminalFenceSource";
import type { EnvironmentId, ServerProviderSkill } from "@ryco/contracts";
import { isQuoteCitationHref, parseQuoteCitationHref } from "@ryco/shared/quoteCitations";
import {
  Children,
  type ComponentPropsWithoutRef,
  type MouseEvent as ReactMouseEvent,
  isValidElement,
  useCallback,
  memo,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  use,
  type ReactNode,
} from "react";
import { useRouter } from "@tanstack/react-router";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { createIncrementalMarkdownPlugin } from "../markdown-incremental";
import { VscodeEntryIcon } from "./chat/VscodeEntryIcon";
import { QuoteCitationChip } from "./chat/QuoteCitationChip";
import { QuoteCitationContext } from "./chat/quoteCitationContext";
import {
  renderSkillInlineMarkdownChildren,
  type SkillInlineTextSearchHighlight,
} from "./chat/SkillInlineText";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { openPathInEditor } from "../editorPreferences";
import { resolveDiffThemeName, type DiffThemeName } from "../lib/diffRendering";
import {
  isClosedMermaidFence,
  isMermaidLanguage,
  isSupportedMermaidSource,
} from "../lib/mermaidPolicy";
import { MermaidDiagram } from "./MermaidDiagram";
import { useTheme } from "../hooks/useTheme";
import { useLongPress } from "../hooks/useLongPress";
import { usePresentationTier } from "../hooks/usePresentationTier";
import { useEvent } from "../hooks/useEvent";
import { getClientSettings } from "../hooks/useSettings";
import { getPresentationTier } from "../lib/presentationTier";
import { readPrimaryEnvironmentDescriptor } from "../environments/primary";
import { buildPullRequestLocation } from "../pullRequestsRoute";
import { isSourceControlReadAdmitted } from "../rpc/sourceControlAtoms";
import {
  selectBootstrapCompleteForEnvironment,
  selectProjectsAcrossEnvironments,
  useStore,
} from "../store";
import { orderItemsByPreferredIds } from "./Sidebar.logic";
import { getProjectOrderKey } from "../logicalProject";
import { useUiStateStore } from "../uiStateStore";
import { useSmoothStreamedText } from "../hooks/useSmoothStreamedText";
import {
  isPlainLinkClick,
  resolveMarkdownChangeRequestCheckout,
  resolveMarkdownFileLinkMeta,
  resolveMarkdownThreadHref,
  rewriteMarkdownFileUriHref,
} from "../markdown-links";
import { readLocalApi } from "../localApi";
import { useWorkspaceFileOpener } from "../workspaceFileNavigation";
import { cn } from "../lib/utils";
import { usePerfMark } from "../perf/tabSwitchInstrumentation";
import { readEnvironmentApi } from "../environmentApi";
import {
  isSafeRemoteMarkdownImageSource,
  resolveMarkdownWorkspaceImagePath,
} from "../markdown-images";

interface ChatMarkdownProps {
  allowTerminalInsertion?: boolean;
  text: string;
  cwd: string | undefined;
  environmentId?: EnvironmentId;
  isStreaming?: boolean;
  /**
   * Reveal streaming text gradually (the default). Off for text that arrives as finished
   * blocks, such as paragraph-streamed replies: each block appears at once, and blocks that
   * arrive after the message is on screen fade in.
   */
  smoothStreaming?: boolean;
  skills?: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  searchHighlight?: Omit<SkillInlineTextSearchHighlight, "cursor" | "keyPrefix"> | undefined;
  /**
   * Set when this renders a workspace document (a Markdown file in the Files
   * panel) instead of a message: the document's own folder, which relative
   * links and images resolve against. Containment, workspace reads and the
   * Files panel stay scoped to `cwd`. It also switches links to document
   * mode: the text is third-party content, so a link may open a workspace
   * file in Ryco or an http(s)/mailto page, and nothing else; thread
   * references (`/ryco/thread/…` links, `@thread:` mentions) stay text.
   */
  documentFolder?: string | undefined;
}

const EMPTY_MARKDOWN_SKILLS: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">> = [];

const WorkspaceMarkdownImage = memo(function WorkspaceMarkdownImage(props: {
  environmentId: EnvironmentId;
  cwd: string;
  relativePath: string;
  alt: string;
  title?: string;
}) {
  const [source, setSource] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    setSource(null);
    setFailed(false);
    const api = readEnvironmentApi(props.environmentId);
    if (!api) {
      setFailed(true);
      return () => {
        active = false;
      };
    }

    void api.projects
      .readFileBinary({ cwd: props.cwd, relativePath: props.relativePath })
      .then((result) => {
        if (!active) return;
        setSource(`data:${result.mimeType};base64,${result.dataBase64}`);
      })
      .catch(() => {
        if (active) setFailed(true);
      });

    return () => {
      active = false;
    };
  }, [props.cwd, props.environmentId, props.relativePath]);

  if (failed) {
    return (
      <span className="text-xs text-muted-foreground">[{props.alt || "Image unavailable"}]</span>
    );
  }
  if (!source) {
    return <span className="text-xs text-muted-foreground">[Loading image…]</span>;
  }
  return (
    <img
      src={source}
      alt={props.alt}
      title={props.title}
      loading="lazy"
      decoding="async"
      draggable={false}
      className="max-h-[32rem] max-w-full rounded-lg border border-border/60 object-contain"
    />
  );
});

const CODE_FENCE_LANGUAGE_REGEX = /(?:^|\s)language-([^\s]+)/;
// Finalized code blocks render as plain text first and swap in Shiki output
// that `codeHighlightQueue` produces in idle time (blocks on screen first).
// Streaming blocks stay plain text to keep token updates off the Shiki path.

function extractFenceLanguage(className: string | undefined): string {
  const match = className?.match(CODE_FENCE_LANGUAGE_REGEX);
  const raw = match?.[1] ?? "text";
  // Shiki doesn't bundle a gitignore grammar; ini is a close match (#685)
  return raw === "gitignore" ? "ini" : raw;
}

function nodeToPlainText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map((child) => nodeToPlainText(child)).join("");
  }
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return nodeToPlainText(node.props.children);
  }
  return "";
}

function extractCodeBlock(
  children: ReactNode,
): { className: string | undefined; code: string } | null {
  const childNodes = Children.toArray(children);
  if (childNodes.length !== 1) {
    return null;
  }

  const onlyChild = childNodes[0];
  if (
    !isValidElement<{ className?: string; children?: ReactNode }>(onlyChild) ||
    onlyChild.type !== "code"
  ) {
    return null;
  }

  return {
    className: onlyChild.props.className,
    code: nodeToPlainText(onlyChild.props.children),
  };
}

function MarkdownCodeBlock({
  code,
  children,
  terminalSource,
}: {
  code: string;
  children: ReactNode;
  terminalSource?: string | undefined;
}) {
  const insert = useTerminalSnippetAction();
  const isPhone = usePresentationTier() === "phone";
  const [inserting, setInserting] = useState(false);
  const insertionError = terminalSource === undefined ? null : terminalSnippetError(terminalSource);
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleCopy = useCallback(() => {
    if (typeof navigator === "undefined" || navigator.clipboard == null) {
      return;
    }
    void navigator.clipboard
      .writeText(code)
      .then(() => {
        if (copiedTimerRef.current != null) {
          clearTimeout(copiedTimerRef.current);
        }
        setCopied(true);
        copiedTimerRef.current = setTimeout(() => {
          setCopied(false);
          copiedTimerRef.current = null;
        }, 1200);
      })
      .catch(() => undefined);
  }, [code]);

  useEffect(
    () => () => {
      if (copiedTimerRef.current != null) {
        clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = null;
      }
    },
    [],
  );

  return (
    <div className="chat-markdown-codeblock leading-snug">
      {insert && !isPhone && terminalSource !== undefined ? (
        <button
          type="button"
          className="chat-markdown-insert-button"
          disabled={inserting || insertionError !== null}
          title={
            insertionError ??
            "Insert in a new terminal for this thread. Review, then press Enter to execute."
          }
          onClick={() => {
            setInserting(true);
            void insert(terminalSource)
              .then(
                () => {
                  toastManager.add({
                    type: "success",
                    title: "Inserted in terminal",
                    description: "Review the snippet, then press Enter in the terminal to execute.",
                  });
                },
                (error: unknown) => {
                  toastManager.add(
                    stackedThreadToast({
                      type: "error",
                      title: "Unable to insert in terminal",
                      description:
                        error instanceof Error ? error.message : "Terminal insertion failed.",
                    }),
                  );
                },
              )
              .finally(() => setInserting(false));
          }}
        >
          {inserting ? "Inserting…" : "Insert in terminal"}
        </button>
      ) : null}
      <button
        type="button"
        className="chat-markdown-copy-button"
        onClick={handleCopy}
        title={copied ? "Copied" : "Copy code"}
        aria-label={copied ? "Copied" : "Copy code"}
      >
        {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
      </button>
      {children}
    </div>
  );
}

// Keep tier subscriptions below the stable Markdown component map. Replacing
// that map on resize remounts every code block and discards copy/focus state.
function MermaidFencePresentation({
  children,
  phoneFallback,
}: {
  children: ReactNode;
  phoneFallback: ReactNode;
}) {
  const isPhoneTier = usePresentationTier() === "phone";
  return isPhoneTier ? phoneFallback : children;
}

interface DeferredShikiCodeBlockProps {
  className: string | undefined;
  code: string;
  themeName: DiffThemeName;
  /** The plain rendering shown until the highlighted HTML is ready. */
  fallback: ReactNode;
}

function DeferredShikiCodeBlock({
  className,
  code,
  themeName,
  fallback,
}: DeferredShikiCodeBlockProps) {
  const language = extractFenceLanguage(className);
  const cacheKey = createHighlightCacheKey(code, language, themeName);
  const [highlighted, setHighlighted] = useState<{ key: string; html: string } | null>(null);
  const html = highlighted?.key === cacheKey ? highlighted.html : readHighlightedCode(cacheKey);
  const pendingRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (html !== null) return;
    return requestCodeHighlight(
      { key: cacheKey, code, language, themeName },
      (nextHtml) => setHighlighted({ key: cacheKey, html: nextHtml }),
      pendingRef.current,
    );
  }, [cacheKey, code, html, language, themeName]);

  if (html !== null) {
    return <div className="chat-markdown-shiki" dangerouslySetInnerHTML={{ __html: html }} />;
  }
  return <div ref={pendingRef}>{fallback}</div>;
}

function PlainCodeBlock({
  className,
  code,
  preProps,
}: {
  className: string | undefined;
  code: string;
  preProps: ComponentPropsWithoutRef<"pre">;
}) {
  return (
    <pre {...preProps}>
      <code className={className}>{code}</code>
    </pre>
  );
}

interface MarkdownFileLinkProps {
  href: string;
  targetPath: string;
  displayPath: string;
  filePath: string;
  /** The file inside the thread's workspace, when it is there; null otherwise. */
  workspacePath: string | null;
  line: number | undefined;
  label: string;
  theme: "light" | "dark";
  className?: string | undefined;
  /**
   * A plain click that cannot open the file in Ryco falls back to the editor
   * (the default, for agent replies). Off in a rendered document, whose links
   * reach the editor only on Cmd/Ctrl-click or from the link's menu.
   */
  editorOnPlainClick?: boolean | undefined;
  /** Where the thread runs: decides how Open in editor reaches the file. */
  environmentId: EnvironmentId | undefined;
}

type MarkdownFileLinkAction = "open-ryco" | "open" | "copy-relative" | "copy-full";

const MARKDOWN_LINK_HREF_PATTERN = /\[[^\]]*]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
// Plain inline flow — sizing and color live in the stylesheet so the chip sits
// on the same line box (and caret strut) as the prose around it.
const MARKDOWN_FILE_LINK_CLASS_NAME = "chat-markdown-file-link";
const MARKDOWN_FILE_LINK_ICON_CLASS_NAME = "chat-markdown-file-link-icon";
const MARKDOWN_FILE_LINK_LABEL_CLASS_NAME = "chat-markdown-file-link-label";
const DOCUMENT_WEB_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

/** A document link that may leave the app: an absolute http(s) or mailto URL. */
function isDocumentWebLink(href: string | undefined): boolean {
  if (!href) return false;
  try {
    return DOCUMENT_WEB_LINK_PROTOCOLS.has(new URL(href).protocol);
  } catch {
    return false;
  }
}

function pathParentSegments(path: string): string[] {
  const normalized = path.replaceAll("\\", "/");
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  return segments.slice(0, -1);
}

function buildFileLinkParentSuffixByPath(filePaths: ReadonlyArray<string>): Map<string, string> {
  const groups = new Map<string, Set<string>>();
  for (const filePath of filePaths) {
    const pathSegments = filePath
      .replaceAll("\\", "/")
      .split("/")
      .filter((segment) => segment.length > 0);
    const basename = pathSegments[pathSegments.length - 1];
    if (!basename) continue;
    const group = groups.get(basename) ?? new Set<string>();
    group.add(filePath);
    groups.set(basename, group);
  }

  const suffixByPath = new Map<string, string>();
  for (const group of groups.values()) {
    const uniquePaths = [...group];
    if (uniquePaths.length < 2) continue;

    const parentSegmentsByPath = new Map(
      uniquePaths.map((filePath) => [filePath, pathParentSegments(filePath)]),
    );
    const minUniqueDepthByPath = new Map<string, number>();

    for (const filePath of uniquePaths) {
      const segments = parentSegmentsByPath.get(filePath) ?? [];
      let resolvedDepth = segments.length;
      for (let depth = 1; depth <= segments.length; depth += 1) {
        const candidate = segments.slice(-depth).join("/");
        const collision = uniquePaths.some((otherPath) => {
          if (otherPath === filePath) return false;
          const otherSegments = parentSegmentsByPath.get(otherPath) ?? [];
          return otherSegments.slice(-depth).join("/") === candidate;
        });
        if (!collision) {
          resolvedDepth = depth;
          break;
        }
      }
      minUniqueDepthByPath.set(filePath, resolvedDepth);
    }

    for (const filePath of uniquePaths) {
      const segments = parentSegmentsByPath.get(filePath) ?? [];
      if (segments.length === 0) continue;
      const minUniqueDepth = minUniqueDepthByPath.get(filePath) ?? 1;
      const suffixDepth = Math.min(segments.length, Math.max(minUniqueDepth, 2));
      suffixByPath.set(filePath, segments.slice(-suffixDepth).join("/"));
    }
  }

  return suffixByPath;
}

function extractMarkdownLinkHrefs(text: string): string[] {
  const hrefs: string[] = [];
  for (const match of text.matchAll(MARKDOWN_LINK_HREF_PATTERN)) {
    const href = match[1]?.trim();
    if (!href) continue;
    hrefs.push(href);
  }
  return hrefs;
}

function normalizeMarkdownLinkHrefKey(href: string): string {
  return rewriteMarkdownFileUriHref(href.trim()) ?? href.trim();
}

const MarkdownFileLink = memo(function MarkdownFileLink({
  href,
  targetPath,
  displayPath,
  filePath,
  workspacePath,
  line,
  label,
  theme,
  className,
  editorOnPlainClick = true,
  environmentId,
}: MarkdownFileLinkProps) {
  // Phone tier: long-press mirrors right-click, presenting the same file
  // actions through the shared bottom action sheet. Its file actions stay
  // as they were (the web phone tier is frozen).
  const isPhoneTier = usePresentationTier() === "phone";
  const workspaceFileOpener = useWorkspaceFileOpener();
  // Ryco's own Files panel reads through the thread's node, so a file inside
  // the workspace opens there on hosted web and remote nodes alike.
  const canOpenInRyco = useCallback(
    () =>
      !isPhoneTier &&
      workspacePath !== null &&
      workspaceFileOpener.canOpen({ path: workspacePath, line }),
    [isPhoneTier, line, workspaceFileOpener, workspacePath],
  );
  const handleOpenInRyco = useCallback(
    () =>
      canOpenInRyco() &&
      workspacePath !== null &&
      workspaceFileOpener.open({ path: workspacePath, line }),
    [canOpenInRyco, line, workspaceFileOpener, workspacePath],
  );

  const handleOpen = useCallback(() => {
    void openPathInEditor(environmentId, targetPath).catch((error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to open file",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    });
  }, [environmentId, targetPath]);

  const handleCopy = useCallback((value: string, title: string) => {
    if (typeof window === "undefined" || !navigator.clipboard?.writeText) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Failed to copy ${title.toLowerCase()}`,
          description: "Clipboard API unavailable.",
        }),
      );
      return;
    }

    void navigator.clipboard.writeText(value).then(
      () => {
        toastManager.add({
          type: "success",
          title: `${title} copied`,
          description: value,
        });
      },
      (error) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: `Failed to copy ${title.toLowerCase()}`,
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      },
    );
  }, []);

  const openFileLinkMenu = useCallback(
    async (position: { x: number; y: number }) => {
      const api = readLocalApi();
      if (!api) return;

      const clicked = await api.contextMenu.show<MarkdownFileLinkAction>(
        [
          ...(canOpenInRyco() ? [{ id: "open-ryco" as const, label: "Open in Ryco" }] : []),
          { id: "open", label: "Open in editor" },
          { id: "copy-relative", label: "Copy relative path" },
          { id: "copy-full", label: "Copy full path" },
        ],
        position,
      );

      if (clicked === "open-ryco") {
        if (!handleOpenInRyco()) handleOpen();
        return;
      }
      if (clicked === "open") {
        handleOpen();
        return;
      }
      if (clicked === "copy-relative") {
        handleCopy(displayPath, "Relative path");
        return;
      }
      if (clicked === "copy-full") {
        handleCopy(targetPath, "Full path");
      }
    },
    [canOpenInRyco, displayPath, handleCopy, handleOpen, handleOpenInRyco, targetPath],
  );

  const handleContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
      event.stopPropagation();
      void openFileLinkMenu({ x: event.clientX, y: event.clientY });
    },
    [openFileLinkMenu],
  );

  const longPress = useLongPress(
    (point) => {
      void openFileLinkMenu(point);
    },
    { disabled: !isPhoneTier },
  );

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <a
            href={href}
            className={cn(MARKDOWN_FILE_LINK_CLASS_NAME, className)}
            onPointerDown={longPress.onPointerDown}
            onPointerMove={longPress.onPointerMove}
            onPointerUp={longPress.onPointerUp}
            onPointerCancel={longPress.onPointerCancel}
            onPointerLeave={longPress.onPointerLeave}
            onClickCapture={longPress.onClickCapture}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              // Cmd/Ctrl-click asks for the editor; a plain click opens the
              // file in Ryco when it can.
              if (event.metaKey || event.ctrlKey) handleOpen();
              else if (!handleOpenInRyco()) {
                if (editorOnPlainClick) handleOpen();
                else
                  toastManager.add({
                    type: "info",
                    title:
                      workspacePath === null
                        ? "This file is outside the thread's workspace."
                        : "This file cannot be opened here.",
                  });
              }
            }}
            {...(editorOnPlainClick
              ? {}
              : {
                  // A document's href is its own relative text: a middle click
                  // would open it against the app's origin in a new tab (or,
                  // in the desktop app, in the external browser).
                  onAuxClick: (event: ReactMouseEvent<HTMLAnchorElement>) => {
                    event.preventDefault();
                    event.stopPropagation();
                  },
                })}
            onContextMenu={(event) => {
              // A fired long-press already presented the menu; swallow the
              // platform's synthetic contextmenu instead of double-firing.
              longPress.onContextMenu(event);
              if (event.defaultPrevented) return;
              handleContextMenu(event);
            }}
          >
            <VscodeEntryIcon
              pathValue={filePath}
              kind="file"
              theme={theme}
              className={cn(MARKDOWN_FILE_LINK_ICON_CLASS_NAME, "text-current")}
            />
            <span className={MARKDOWN_FILE_LINK_LABEL_CLASS_NAME}>{label}</span>
          </a>
        }
      />
      <TooltipPopup
        side="top"
        className="max-w-[min(40rem,calc(100vw-2rem))] font-mono text-[11px] leading-tight"
      >
        <div className="markdown-file-link-tooltip-scroll overflow-x-auto whitespace-nowrap">
          {displayPath}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}, areMarkdownFileLinkPropsEqual);

function areMarkdownFileLinkPropsEqual(
  previous: Readonly<MarkdownFileLinkProps>,
  next: Readonly<MarkdownFileLinkProps>,
): boolean {
  return (
    previous.href === next.href &&
    previous.targetPath === next.targetPath &&
    previous.displayPath === next.displayPath &&
    previous.filePath === next.filePath &&
    previous.workspacePath === next.workspacePath &&
    previous.line === next.line &&
    previous.label === next.label &&
    previous.theme === next.theme &&
    previous.className === next.className &&
    previous.editorOnPlainClick === next.editorOnPlainClick &&
    previous.environmentId === next.environmentId
  );
}

function ChatMarkdown(props: ChatMarkdownProps) {
  const isStreaming = Boolean(props.isStreaming);
  // Reveal streamed text at a steady, adaptive cadence so tokens appear fluidly
  // instead of in the bursts that land in the store. Governs cadence only.
  const smoothedText = useSmoothStreamedText(
    props.text,
    isStreaming && props.smoothStreaming !== false,
  );
  // Bounding the markdown re-parse is the deferred value's job, not a fixed
  // timer's: React coalesces adaptively, so a cheap parse updates every frame
  // (which is what makes the smoothing above visible) while an expensive one
  // backs off on its own. A fixed throttle stepped the reveal at a constant
  // ~13fps regardless of how much headroom there was.
  const deferredText = useDeferredValue(smoothedText);
  const displayText = isStreaming ? deferredText : smoothedText;

  return <RenderedChatMarkdown {...props} text={displayText} />;
}

const RenderedChatMarkdown = memo(function RenderedChatMarkdown({
  text,
  cwd,
  environmentId,
  isStreaming = false,
  smoothStreaming = true,
  skills = EMPTY_MARKDOWN_SKILLS,
  searchHighlight,
  allowTerminalInsertion = false,
  documentFolder,
}: ChatMarkdownProps) {
  usePerfMark("ChatMarkdown");
  const rootRef = useRef<HTMLDivElement>(null);
  const fadeArrivingBlocks = isStreaming && !smoothStreaming;
  // Arms the fade of arriving blocks (index.css) only once the blocks already on screen
  // have their styles, so mounting or remounting a streaming message never fades it in.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    if (!fadeArrivingBlocks) {
      root.removeAttribute("data-streaming");
      return;
    }
    if (root.hasAttribute("data-streaming")) return;
    // Reading a computed style styles the current blocks first; @starting-style then
    // applies only to blocks inserted later.
    if (root.lastElementChild) void getComputedStyle(root.lastElementChild).opacity;
    root.setAttribute("data-streaming", "");
  }, [fadeArrivingBlocks]);
  const completedText = isStreaming ? "" : text;
  const { resolvedTheme } = useTheme();
  const diffThemeName = resolveDiffThemeName(resolvedTheme);
  const incrementalParsing = isStreaming && /(?:^|\n) {0,3}(?:`{3}|~{3})/.test(text);
  // Own the cache for this streaming renderer only; completion returns to the
  // full parser so final replacements and highlighting always take effect.
  const remarkPlugins = useMemo(
    () => [remarkGfm, ...(incrementalParsing ? [createIncrementalMarkdownPlugin()] : [])],
    [incrementalParsing],
  );
  const searchHighlightCursorRef = useRef({ occurrenceIndex: 0 });
  searchHighlightCursorRef.current.occurrenceIndex = 0;
  const markdownSearchHighlightRef = useRef<SkillInlineTextSearchHighlight | undefined>(undefined);
  markdownSearchHighlightRef.current = searchHighlight
    ? {
        ...searchHighlight,
        cursor: searchHighlightCursorRef.current,
        keyPrefix: "chat-markdown",
      }
    : undefined;
  // Growing prose/code must not recreate every custom Markdown component (and
  // remount completed images/code blocks) when the link destinations are unchanged.
  const markdownLinkHrefsKey = JSON.stringify(extractMarkdownLinkHrefs(text));
  const markdownFileLinkMetaByHref = useMemo(() => {
    const metaByHref = new Map<
      string,
      NonNullable<ReturnType<typeof resolveMarkdownFileLinkMeta>>
    >();
    for (const href of JSON.parse(markdownLinkHrefsKey) as string[]) {
      const normalizedHref = normalizeMarkdownLinkHrefKey(href);
      if (metaByHref.has(normalizedHref)) continue;
      const meta = resolveMarkdownFileLinkMeta(normalizedHref, cwd, documentFolder);
      if (meta) {
        metaByHref.set(normalizedHref, meta);
      }
    }
    return metaByHref;
  }, [cwd, documentFolder, markdownLinkHrefsKey]);
  const fileLinkParentSuffixByPath = useMemo(() => {
    const filePaths = [...markdownFileLinkMetaByHref.values()].map((meta) => meta.filePath);
    return buildFileLinkParentSuffixByPath(filePaths);
  }, [markdownFileLinkMetaByHref]);
  // Quote links render as chips, and only inside a sent user message. One
  // that does not parse is an unsafe link like any other.
  const rendersQuoteCitations = use(QuoteCitationContext) !== null;
  const markdownUrlTransform = useCallback(
    (href: string) => {
      if (rendersQuoteCitations && parseQuoteCitationHref(href) !== null) return href;
      return rewriteMarkdownFileUriHref(href) ?? defaultUrlTransform(href);
    },
    [rendersQuoteCitations],
  );
  // A rendered workspace file is third-party content: it never names threads,
  // so its `@thread:` text stays text instead of a chip that opens one.
  const documentMode = documentFolder !== undefined;
  const inlineEnvironmentId = documentMode ? undefined : environmentId;
  // Absent outside a router (isolated renders): links then keep opening the browser.
  const router: ReturnType<typeof useRouter> | null | undefined = useRouter({ warn: false });
  // A plain click on a pull request link opens it on the Pull requests page when one of the
  // projects holds its repository. Everything is read at click time, so markdown never
  // re-renders for project, settings or connection changes.
  const handleChangeRequestLinkClick = useEvent(
    (event: ReactMouseEvent<HTMLAnchorElement>, href: string | undefined) => {
      if (!router || event.defaultPrevented || !isPlainLinkClick(event)) return;
      if (getClientSettings().changeRequestLinkTarget === "browser") return;
      // The frozen phone tier has no Pull requests page.
      if (getPresentationTier() === "phone") return;
      const state = useStore.getState();
      const target = resolveMarkdownChangeRequestCheckout({
        href,
        // The sidebar's order, so a repository opens through the checkout the Pull requests
        // page leads with.
        projects: orderItemsByPreferredIds({
          items: selectProjectsAcrossEnvironments(state),
          preferredIds: useUiStateStore.getState().projectOrder,
          getId: getProjectOrderKey,
        }),
        threadEnvironmentId: environmentId,
        primaryEnvironmentId: readPrimaryEnvironmentDescriptor()?.environmentId ?? null,
        isEnvironmentAvailable: (candidate) =>
          selectBootstrapCompleteForEnvironment(state, candidate) &&
          isSourceControlReadAdmitted(candidate),
      });
      if (target === null) return;
      event.preventDefault();
      void router.navigate(buildPullRequestLocation(target));
    },
  );
  const markdownComponents = useMemo<Components>(
    () => ({
      p({ node: _node, children, ...props }) {
        return (
          <p {...props}>
            {renderSkillInlineMarkdownChildren(
              children,
              skills,
              markdownSearchHighlightRef.current,
              inlineEnvironmentId,
            )}
          </p>
        );
      },
      li({ node: _node, children, ...props }) {
        return (
          <li {...props}>
            {renderSkillInlineMarkdownChildren(
              children,
              skills,
              markdownSearchHighlightRef.current,
              inlineEnvironmentId,
            )}
          </li>
        );
      },
      blockquote({ node: _node, children, ...props }) {
        return (
          <blockquote {...props}>
            {renderSkillInlineMarkdownChildren(
              children,
              skills,
              markdownSearchHighlightRef.current,
              inlineEnvironmentId,
            )}
          </blockquote>
        );
      },
      table({ node: _node, children, ...props }) {
        // Timeline rows clip horizontal overflow, so wide tables need their own
        // contained horizontal scroll instead of being silently cut off.
        return (
          <div className="chat-markdown-table-scroll">
            <table {...props}>{children}</table>
          </div>
        );
      },
      td({ node: _node, children, ...props }) {
        return (
          <td {...props}>
            {renderSkillInlineMarkdownChildren(
              children,
              skills,
              markdownSearchHighlightRef.current,
              inlineEnvironmentId,
            )}
          </td>
        );
      },
      th({ node: _node, children, ...props }) {
        return (
          <th {...props}>
            {renderSkillInlineMarkdownChildren(
              children,
              skills,
              markdownSearchHighlightRef.current,
              inlineEnvironmentId,
            )}
          </th>
        );
      },
      a({ node: _node, href, ...props }) {
        const quoteCitation =
          rendersQuoteCitations && isQuoteCitationHref(href) ? parseQuoteCitationHref(href) : null;
        if (quoteCitation) return <QuoteCitationChip citation={quoteCitation} />;
        const threadHref = documentMode ? null : resolveMarkdownThreadHref(href, environmentId);
        if (threadHref)
          return (
            <a {...props} href={threadHref}>
              {props.children}
            </a>
          );
        const normalizedHref = href ? normalizeMarkdownLinkHrefKey(href) : "";
        // The precomputed map holds inline links only; a document's reference
        // links (`[x][ref]`) and linked images resolve from the href here.
        const fileLinkMeta = normalizedHref
          ? (markdownFileLinkMetaByHref.get(normalizedHref) ??
            (documentMode
              ? resolveMarkdownFileLinkMeta(normalizedHref, cwd, documentFolder)
              : null))
          : null;
        if (!fileLinkMeta && documentMode && !isDocumentWebLink(href)) {
          // Anchors, other relative links and emptied hrefs do nothing in a
          // document: no new tab of the app's own origin, no external browser.
          return (
            <span className="chat-markdown-inert-link" title={href || undefined}>
              {renderSkillInlineMarkdownChildren(
                props.children,
                skills,
                markdownSearchHighlightRef.current,
              )}
            </span>
          );
        }
        if (!fileLinkMeta) {
          return (
            <a
              {...props}
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(event) => handleChangeRequestLinkClick(event, href)}
            >
              {renderSkillInlineMarkdownChildren(
                props.children,
                skills,
                markdownSearchHighlightRef.current,
              )}
            </a>
          );
        }

        const parentSuffix = fileLinkParentSuffixByPath.get(fileLinkMeta.filePath);
        const labelParts = [fileLinkMeta.basename];
        if (typeof parentSuffix === "string" && parentSuffix.length > 0) {
          labelParts.push(parentSuffix);
        }
        // A bare `L1` says nothing a link to the file doesn't already say — it
        // is where the file opens anyway — so only a real position is worth the
        // extra label segment. `L1:C12` still points somewhere, so it stays.
        if (fileLinkMeta.line && (fileLinkMeta.line !== 1 || fileLinkMeta.column)) {
          labelParts.push(
            `L${fileLinkMeta.line}${fileLinkMeta.column ? `:C${fileLinkMeta.column}` : ""}`,
          );
        }

        return (
          <MarkdownFileLink
            href={href ?? fileLinkMeta.targetPath}
            targetPath={fileLinkMeta.targetPath}
            displayPath={fileLinkMeta.displayPath}
            filePath={fileLinkMeta.filePath}
            workspacePath={fileLinkMeta.workspacePath}
            line={fileLinkMeta.line}
            label={labelParts.join(" · ")}
            theme={resolvedTheme}
            className={props.className}
            {...(documentMode ? { editorOnPlainClick: false } : {})}
            environmentId={environmentId}
          />
        );
      },
      img({ node: _node, src, alt, title }) {
        const relativePath = resolveMarkdownWorkspaceImagePath(src, cwd, documentFolder);
        if (relativePath && cwd && environmentId) {
          return (
            <WorkspaceMarkdownImage
              environmentId={environmentId}
              cwd={cwd}
              relativePath={relativePath}
              alt={alt ?? ""}
              {...(title ? { title } : {})}
            />
          );
        }
        if (!isSafeRemoteMarkdownImageSource(src)) {
          return (
            <span className="text-xs text-muted-foreground">[{alt || "Image unavailable"}]</span>
          );
        }
        return (
          <img
            src={src}
            alt={alt ?? ""}
            title={title}
            loading="lazy"
            decoding="async"
            draggable={false}
            referrerPolicy="no-referrer"
            className="max-h-[32rem] max-w-full rounded-lg border border-border/60 object-contain"
          />
        );
      },
      pre({ node, children, ...props }) {
        const codeBlock = extractCodeBlock(children);
        if (!codeBlock) {
          return <pre {...props}>{children}</pre>;
        }

        if (isStreaming) {
          if (codeBlock.className?.split(/\s+/).includes("language-ryco-attachments")) {
            return (
              <p className="text-xs text-muted-foreground" role="status">
                Preparing files…
              </p>
            );
          }
          return (
            <MarkdownCodeBlock code={codeBlock.code}>
              <PlainCodeBlock
                className={codeBlock.className}
                code={codeBlock.code}
                preProps={props}
              />
            </MarkdownCodeBlock>
          );
        }

        const highlightedCode = (
          <DeferredShikiCodeBlock
            className={codeBlock.className}
            code={codeBlock.code}
            themeName={diffThemeName}
            fallback={<pre {...props}>{children}</pre>}
          />
        );
        if (isMermaidLanguage(extractFenceLanguage(codeBlock.className))) {
          const fallback = (
            <PlainCodeBlock
              className={codeBlock.className}
              code={codeBlock.code}
              preProps={props}
            />
          );
          return (
            <MarkdownCodeBlock code={codeBlock.code}>
              <MermaidFencePresentation phoneFallback={highlightedCode}>
                {isClosedMermaidFence(
                  completedText,
                  node?.position?.start.offset,
                  node?.position?.end.offset,
                ) && isSupportedMermaidSource(codeBlock.code) ? (
                  <MermaidDiagram
                    key={JSON.stringify([resolvedTheme, codeBlock.code])}
                    source={codeBlock.code}
                    theme={resolvedTheme}
                    fallback={fallback}
                  />
                ) : (
                  fallback
                )}
              </MermaidFencePresentation>
            </MarkdownCodeBlock>
          );
        }

        const terminalSource =
          allowTerminalInsertion &&
          isTerminalSnippetLanguage(extractFenceLanguage(codeBlock.className))
            ? terminalFenceSource(
                completedText,
                node?.position?.start.offset,
                node?.position?.end.offset,
                codeBlock.code,
              )
            : undefined;
        return (
          <MarkdownCodeBlock code={codeBlock.code} terminalSource={terminalSource}>
            {highlightedCode}
          </MarkdownCodeBlock>
        );
      },
    }),
    [
      diffThemeName,
      cwd,
      documentFolder,
      documentMode,
      environmentId,
      fileLinkParentSuffixByPath,
      inlineEnvironmentId,
      isStreaming,
      completedText,
      markdownFileLinkMetaByHref,
      resolvedTheme,
      skills,
      allowTerminalInsertion,
      rendersQuoteCitations,
      handleChangeRequestLinkClick,
    ],
  );

  return (
    <div
      ref={rootRef}
      className="chat-markdown w-full min-w-0 text-sm leading-relaxed text-foreground/80"
    >
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        components={markdownComponents}
        urlTransform={markdownUrlTransform}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

export default memo(ChatMarkdown);
