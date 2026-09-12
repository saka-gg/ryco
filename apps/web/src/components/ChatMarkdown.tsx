import {
  getSharedHighlighter,
  type DiffsHighlighter,
  type SupportedLanguages,
} from "@pierre/diffs";
import { CheckIcon, CopyIcon } from "lucide-react";
import type { EnvironmentId, ServerProviderSkill } from "@ryco/contracts";
import React, {
  Children,
  Suspense,
  type MouseEvent as ReactMouseEvent,
  isValidElement,
  use,
  useCallback,
  memo,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { createIncrementalMarkdownPlugin } from "../markdown-incremental";
import { VscodeEntryIcon } from "./chat/VscodeEntryIcon";
import {
  renderSkillInlineMarkdownChildren,
  type SkillInlineTextSearchHighlight,
} from "./chat/SkillInlineText";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { openInPreferredEditor } from "../editorPreferences";
import { resolveDiffThemeName, type DiffThemeName } from "../lib/diffRendering";
import { fnv1a32 } from "../lib/diffRendering";
import { LRUCache } from "../lib/lruCache";
import { useTheme } from "../hooks/useTheme";
import { useLongPress } from "../hooks/useLongPress";
import { usePresentationTier } from "../hooks/usePresentationTier";
import { useSmoothStreamedText } from "../hooks/useSmoothStreamedText";
import { resolveMarkdownFileLinkMeta, rewriteMarkdownFileUriHref } from "../markdown-links";
import { readLocalApi } from "../localApi";
import { cn } from "../lib/utils";
import { usePerfMark } from "../perf/tabSwitchInstrumentation";
import { readEnvironmentApi } from "../environmentApi";
import {
  isSafeRemoteMarkdownImageSource,
  resolveMarkdownWorkspaceImagePath,
} from "../markdown-images";

class CodeHighlightErrorBoundary extends React.Component<
  { fallback: ReactNode; children: ReactNode },
  { hasError: boolean }
> {
  constructor(props: { fallback: ReactNode; children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  override render() {
    if (this.state.hasError) {
      return this.props.fallback;
    }
    return this.props.children;
  }
}

interface ChatMarkdownProps {
  text: string;
  cwd: string | undefined;
  environmentId?: EnvironmentId;
  isStreaming?: boolean;
  skills?: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  searchHighlight?: Omit<SkillInlineTextSearchHighlight, "cursor" | "keyPrefix"> | undefined;
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
const MAX_HIGHLIGHT_CACHE_ENTRIES = 500;
const MAX_HIGHLIGHT_CACHE_MEMORY_BYTES = 50 * 1024 * 1024;
const highlightedCodeCache = new LRUCache<string>(
  MAX_HIGHLIGHT_CACHE_ENTRIES,
  MAX_HIGHLIGHT_CACHE_MEMORY_BYTES,
);
const highlighterPromiseCache = new Map<string, Promise<DiffsHighlighter>>();
// Chat markdown is rendered outside the lazily mounted diff worker provider, so
// finalized code blocks stay on the shared Suspense highlighter path for now.
// Streaming blocks are still plain text to keep token updates off the Shiki path.

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

function createHighlightCacheKey(code: string, language: string, themeName: DiffThemeName): string {
  return `${fnv1a32(code).toString(36)}:${code.length}:${language}:${themeName}`;
}

function estimateHighlightedSize(html: string, code: string): number {
  return Math.max(html.length * 2, code.length * 3);
}

function getHighlighterPromise(language: string): Promise<DiffsHighlighter> {
  const cached = highlighterPromiseCache.get(language);
  if (cached) return cached;

  const promise = getSharedHighlighter({
    themes: [resolveDiffThemeName("dark"), resolveDiffThemeName("light")],
    langs: [language as SupportedLanguages],
    preferredHighlighter: "shiki-js",
  }).catch((err) => {
    highlighterPromiseCache.delete(language);
    if (language === "text") {
      // "text" itself failed — Shiki cannot initialize at all, surface the error
      throw err;
    }
    // Language not supported by Shiki — fall back to "text"
    return getHighlighterPromise("text");
  });
  highlighterPromiseCache.set(language, promise);
  return promise;
}

function MarkdownCodeBlock({ code, children }: { code: string; children: ReactNode }) {
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

interface SuspenseShikiCodeBlockProps {
  className: string | undefined;
  code: string;
  themeName: DiffThemeName;
}

function SuspenseShikiCodeBlock({ className, code, themeName }: SuspenseShikiCodeBlockProps) {
  const language = extractFenceLanguage(className);
  const cacheKey = createHighlightCacheKey(code, language, themeName);
  const cachedHighlightedHtml = highlightedCodeCache.get(cacheKey);

  if (cachedHighlightedHtml != null) {
    return (
      <div
        className="chat-markdown-shiki"
        dangerouslySetInnerHTML={{ __html: cachedHighlightedHtml }}
      />
    );
  }

  return (
    <UncachedShikiCodeBlock
      code={code}
      language={language}
      themeName={themeName}
      cacheKey={cacheKey}
    />
  );
}

interface UncachedShikiCodeBlockProps {
  code: string;
  language: string;
  themeName: DiffThemeName;
  cacheKey: string;
}

function UncachedShikiCodeBlock({
  code,
  language,
  themeName,
  cacheKey,
}: UncachedShikiCodeBlockProps) {
  const highlighter = use(getHighlighterPromise(language));
  const highlightedHtml = useMemo(() => {
    try {
      return highlighter.codeToHtml(code, { lang: language, theme: themeName });
    } catch (error) {
      // Log highlighting failures for debugging while falling back to plain text
      console.warn(
        `Code highlighting failed for language "${language}", falling back to plain text.`,
        error instanceof Error ? error.message : error,
      );
      // If highlighting fails for this language, render as plain text
      return highlighter.codeToHtml(code, { lang: "text", theme: themeName });
    }
  }, [code, highlighter, language, themeName]);

  useEffect(() => {
    highlightedCodeCache.set(
      cacheKey,
      highlightedHtml,
      estimateHighlightedSize(highlightedHtml, code),
    );
  }, [cacheKey, code, highlightedHtml]);

  return (
    <div className="chat-markdown-shiki" dangerouslySetInnerHTML={{ __html: highlightedHtml }} />
  );
}

function PlainCodeBlock({
  className,
  code,
  preProps,
}: {
  className: string | undefined;
  code: string;
  preProps: React.ComponentPropsWithoutRef<"pre">;
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
  label: string;
  theme: "light" | "dark";
  className?: string | undefined;
}

const MARKDOWN_LINK_HREF_PATTERN = /\[[^\]]*]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
// Plain inline flow — sizing and color live in the stylesheet so the chip sits
// on the same line box (and caret strut) as the prose around it.
const MARKDOWN_FILE_LINK_CLASS_NAME = "chat-markdown-file-link";
const MARKDOWN_FILE_LINK_ICON_CLASS_NAME = "chat-markdown-file-link-icon";
const MARKDOWN_FILE_LINK_LABEL_CLASS_NAME = "chat-markdown-file-link-label";

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
  label,
  theme,
  className,
}: MarkdownFileLinkProps) {
  const handleOpen = useCallback(() => {
    const api = readLocalApi();
    if (!api) {
      toastManager.add({
        type: "error",
        title: "Open in editor is unavailable",
      });
      return;
    }

    void openInPreferredEditor(api, targetPath).catch((error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to open file",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    });
  }, [targetPath]);

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

      const clicked = await api.contextMenu.show(
        [
          { id: "open", label: "Open in editor" },
          { id: "copy-relative", label: "Copy relative path" },
          { id: "copy-full", label: "Copy full path" },
        ] as const,
        position,
      );

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
    [displayPath, handleCopy, handleOpen, targetPath],
  );

  const handleContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
      event.stopPropagation();
      void openFileLinkMenu({ x: event.clientX, y: event.clientY });
    },
    [openFileLinkMenu],
  );

  // Phone tier: long-press mirrors right-click, presenting the same file
  // actions through the shared bottom action sheet.
  const isPhoneTier = usePresentationTier() === "phone";
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
              handleOpen();
            }}
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
    previous.label === next.label &&
    previous.theme === next.theme &&
    previous.className === next.className
  );
}

function ChatMarkdown(props: ChatMarkdownProps) {
  const isStreaming = Boolean(props.isStreaming);
  // Reveal streamed text at a steady, adaptive cadence so tokens appear fluidly
  // instead of in the bursts that land in the store. Governs cadence only.
  const smoothedText = useSmoothStreamedText(props.text, isStreaming);
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
  skills = EMPTY_MARKDOWN_SKILLS,
  searchHighlight,
}: ChatMarkdownProps) {
  usePerfMark("ChatMarkdown");
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
      const meta = resolveMarkdownFileLinkMeta(normalizedHref, cwd);
      if (meta) {
        metaByHref.set(normalizedHref, meta);
      }
    }
    return metaByHref;
  }, [cwd, markdownLinkHrefsKey]);
  const fileLinkParentSuffixByPath = useMemo(() => {
    const filePaths = [...markdownFileLinkMetaByHref.values()].map((meta) => meta.filePath);
    return buildFileLinkParentSuffixByPath(filePaths);
  }, [markdownFileLinkMetaByHref]);
  const markdownUrlTransform = useCallback((href: string) => {
    return rewriteMarkdownFileUriHref(href) ?? defaultUrlTransform(href);
  }, []);
  const markdownComponents = useMemo<Components>(
    () => ({
      p({ node: _node, children, ...props }) {
        return (
          <p {...props}>
            {renderSkillInlineMarkdownChildren(
              children,
              skills,
              markdownSearchHighlightRef.current,
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
            )}
          </th>
        );
      },
      a({ node: _node, href, ...props }) {
        const normalizedHref = href ? normalizeMarkdownLinkHrefKey(href) : "";
        const fileLinkMeta = normalizedHref ? markdownFileLinkMetaByHref.get(normalizedHref) : null;
        if (!fileLinkMeta) {
          return (
            <a {...props} href={href} target="_blank" rel="noopener noreferrer">
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
            label={labelParts.join(" · ")}
            theme={resolvedTheme}
            className={props.className}
          />
        );
      },
      img({ node: _node, src, alt, title }) {
        const relativePath = resolveMarkdownWorkspaceImagePath(src, cwd);
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
      pre({ node: _node, children, ...props }) {
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

        return (
          <MarkdownCodeBlock code={codeBlock.code}>
            <CodeHighlightErrorBoundary fallback={<pre {...props}>{children}</pre>}>
              <Suspense fallback={<pre {...props}>{children}</pre>}>
                <SuspenseShikiCodeBlock
                  className={codeBlock.className}
                  code={codeBlock.code}
                  themeName={diffThemeName}
                />
              </Suspense>
            </CodeHighlightErrorBoundary>
          </MarkdownCodeBlock>
        );
      },
    }),
    [
      diffThemeName,
      cwd,
      environmentId,
      fileLinkParentSuffixByPath,
      isStreaming,
      markdownFileLinkMetaByHref,
      resolvedTheme,
      skills,
    ],
  );

  return (
    <div className="chat-markdown w-full min-w-0 text-sm leading-relaxed text-foreground/80">
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
