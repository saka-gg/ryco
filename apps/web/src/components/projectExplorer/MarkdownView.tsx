import { createContext, memo, useContext, useMemo, useRef, type ComponentProps } from "react";
import ReactMarkdown, {
  defaultUrlTransform,
  type Components,
  type ExtraProps,
  type Options as ReactMarkdownOptions,
} from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema, type Options as SanitizeOptions } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { cn } from "~/lib/utils";
import {
  stripHtmlComments,
  stripHtmlCommentsWithSourceMap,
  type StrippedMarkdown,
} from "./markdownPreprocess";
import {
  MarkdownImage,
  MarkdownImageGallery,
  MarkdownLink,
  MarkdownPicture,
} from "./MarkdownImages";

interface MarkdownViewProps {
  text: string;
  className?: string;
  raw?: boolean;
  /**
   * Makes task-list checkboxes interactive. Called with the offset in `text`
   * of the task's state character (the one between the brackets) and the
   * state the user asked for; the caller rewrites the source, so each
   * checkbox stays controlled by `text`. Only boxes the Markdown parser made
   * from a `- [ ]` item are interactive, never ones written as raw HTML.
   */
  onToggleTask?: ((offset: number, checked: boolean) => void) | undefined;
}

// Allow GitHub-flavored disclosure widgets, alignment attributes on table cells, and basic
// inline styling that PR/issue bodies commonly rely on. We extend the safe default schema
// rather than replacing it so things like <script> stay disallowed.
const sanitizeSchema: SanitizeOptions = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), "details", "summary"],
  attributes: {
    ...defaultSchema.attributes,
    details: ["open"],
    summary: ["className"],
    "*": [...(defaultSchema.attributes?.["*"] ?? []), "align"],
  },
};

const markdownComponents: Components = {
  a: MarkdownLink,
  img: MarkdownImage,
  picture: MarkdownPicture,
  details({ node: _node, className, ...props }) {
    return (
      <details
        {...props}
        className={cn(
          "my-2 rounded-md border border-border/60 bg-muted/24 px-3 py-2 [&_summary]:cursor-pointer",
          className,
        )}
      />
    );
  },
  summary({ node: _node, className, ...props }) {
    return (
      <summary {...props} className={cn("font-medium text-sm text-foreground/90", className)} />
    );
  },
  pre({ node: _node, className, ...props }) {
    return (
      <pre
        {...props}
        className={cn(
          "my-2 w-full min-w-0 overflow-x-auto rounded-md border border-border/50 bg-muted/30 p-3 text-foreground/85 text-xs leading-relaxed",
          className,
        )}
      />
    );
  },
  code({ node: _node, className, ...props }) {
    // Inline `code` (no language class) keeps its inline styling; block code is wrapped in <pre>
    // and uses the default rendering inside it.
    if (className && className.includes("language-")) {
      return <code {...props} className={className} />;
    }
    return (
      <code
        {...props}
        className={cn(
          "rounded bg-muted/50 px-1 py-0.5 font-mono text-[0.85em] text-foreground/85",
          className,
        )}
      />
    );
  },
};

function ignoreChange() {}

type HastElement = NonNullable<ExtraProps["node"]>;
type HastNode = HastElement["children"][number];

/** The rendered (comment-stripped) Markdown, with its map back to `text`. */
const TaskSourceContext = createContext<StrippedMarkdown | null>(null);

interface TaskItem {
  /** The checkbox the parser made for this item (raw HTML ones never match). */
  readonly checkbox: HastElement;
  /** Offset in `text` of the state character between the brackets. */
  readonly offset: number;
  /** The item's own text, which names its checkbox. */
  readonly label: string;
}

const TaskItemContext = createContext<TaskItem | null>(null);

/** A GFM task item's marker and box, read from where the parser says the item starts. */
const TASK_ITEM_HEAD = /(?:[-*+]|\d{1,9}[.)])[ \t]+\[[ \txX]\]/y;

function firstElement(nodes: ReadonlyArray<HastNode>): HastElement | null {
  for (const node of nodes) if (node.type === "element") return node;
  return null;
}

/** The parser puts a task's checkbox first in the item, or first in its first paragraph. */
function taskCheckbox(item: HastElement): HastElement | null {
  const first = firstElement(item.children);
  const candidate = first?.tagName === "p" ? firstElement(first.children) : first;
  return candidate?.tagName === "input" && candidate.properties.type === "checkbox"
    ? candidate
    : null;
}

/** The item's text without its checkbox or nested lists, whitespace collapsed. */
function taskLabel(item: HastElement, checkbox: HastElement): string {
  let text = "";
  const collect = (nodes: ReadonlyArray<HastNode>) => {
    for (const node of nodes) {
      if (node.type === "text") text += node.value;
      else if (
        node.type === "element" &&
        node !== checkbox &&
        node.tagName !== "ul" &&
        node.tagName !== "ol"
      ) {
        collect(node.children);
      }
    }
  };
  collect(item.children);
  return text.replace(/\s+/gu, " ").trim();
}

/**
 * Maps a rendered `li.task-list-item` back to its source. Positions come from
 * the parser, so a raw-HTML item (whose position points at `<li`) or one inside
 * an HTML block never resolves, and the offset is exact however the body nests.
 */
function resolveTaskItem(item: HastElement, source: StrippedMarkdown): TaskItem | null {
  const className = item.properties.className;
  if (!Array.isArray(className) || !className.includes("task-list-item")) return null;
  const start = item.position?.start.offset;
  if (start === undefined) return null;
  TASK_ITEM_HEAD.lastIndex = start;
  const head = TASK_ITEM_HEAD.exec(source.text);
  const checkbox = head ? taskCheckbox(item) : null;
  if (!head || !checkbox) return null;
  return {
    checkbox,
    offset: source.toSourceOffset(start + head[0].length - 2),
    label: taskLabel(item, checkbox) || "Task",
  };
}

function TaskListItem({ node, ...props }: ComponentProps<"li"> & ExtraProps) {
  const source = useContext(TaskSourceContext);
  const task = useMemo(
    () => (node && source ? resolveTaskItem(node, source) : null),
    [node, source],
  );
  const item = <li {...props} />;
  return task ? <TaskItemContext value={task}>{item}</TaskItemContext> : item;
}

function TaskCheckbox({ node, type, disabled, ...props }: ComponentProps<"input"> & ExtraProps) {
  const task = useContext(TaskItemContext);
  if (type !== "checkbox" || task === null || task.checkbox !== node) {
    return <input {...props} type={type} disabled={disabled} />;
  }
  // Sanitized task boxes arrive disabled; this one is enabled but stays
  // controlled (`checked` comes from the source). The container's change
  // handler reports `data-task-offset`.
  return (
    <input
      {...props}
      type="checkbox"
      checked={props.checked === true}
      onChange={ignoreChange}
      aria-label={task.label}
      data-task-offset={task.offset}
      className={cn("cursor-pointer", props.className)}
    />
  );
}

const interactiveTaskComponents: Components = {
  ...markdownComponents,
  li: TaskListItem,
  input: TaskCheckbox,
};

const remarkPlugins: ReactMarkdownOptions["remarkPlugins"] = [remarkGfm];
const rehypePlugins: ReactMarkdownOptions["rehypePlugins"] = [
  rehypeRaw,
  [rehypeSanitize, sanitizeSchema],
];

function urlTransform(href: string): string {
  return defaultUrlTransform(href);
}

export const MarkdownView = memo(function MarkdownView({
  text,
  className,
  raw = false,
  onToggleTask,
}: MarkdownViewProps) {
  const interactive = onToggleTask !== undefined;
  // Interactive task lists also need the map from rendered offsets back to `text`.
  const source = useMemo<StrippedMarkdown | null>(
    () => (raw || !interactive ? null : stripHtmlCommentsWithSourceMap(text)),
    [text, raw, interactive],
  );
  const containerRef = useRef<HTMLDivElement>(null);
  const stripped = useMemo(
    () => (raw ? text : (source?.text ?? stripHtmlComments(text))),
    [text, raw, source],
  );

  if (stripped.trim().length === 0) {
    return <p className="text-muted-foreground text-sm italic">No description provided.</p>;
  }

  if (raw) {
    return (
      <pre
        className={cn(
          "w-full min-w-0 overflow-x-auto rounded-md border border-border/50 bg-muted/30 p-3 text-foreground/85 text-xs leading-relaxed",
          className,
        )}
      >
        {text}
      </pre>
    );
  }

  return (
    <div
      ref={containerRef}
      className={cn(
        "chat-markdown w-full min-w-0 text-foreground/90 text-sm leading-relaxed",
        className,
      )}
      onChange={
        onToggleTask
          ? (event) => {
              const target = event.target;
              if (!(target instanceof HTMLInputElement) || target.type !== "checkbox") return;
              // Only parser-made task boxes carry an offset (see `TaskCheckbox`).
              const offset = target.dataset.taskOffset;
              if (offset !== undefined) onToggleTask(Number(offset), target.checked);
            }
          : undefined
      }
    >
      <MarkdownImageGallery container={containerRef}>
        <TaskSourceContext value={source}>
          <ReactMarkdown
            remarkPlugins={remarkPlugins}
            rehypePlugins={rehypePlugins}
            components={interactive ? interactiveTaskComponents : markdownComponents}
            urlTransform={urlTransform}
          >
            {stripped}
          </ReactMarkdown>
        </TaskSourceContext>
      </MarkdownImageGallery>
    </div>
  );
});
