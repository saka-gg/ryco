/**
 * The screenplay for the coded product replica. One coherent run: the user asks
 * Claude for relay reconnect backoff, the tool rows, diff and test output all
 * agree with each other (3 files, +131 −2 = 11 + 52 + 68; 9 tests in
 * backoff.test.ts, 42 in total), and five sibling threads run on the other
 * providers. Model names follow apps/server/src/provider/model-manifest.json.
 */

export const PROMPT =
  "Add exponential backoff to the relay client's reconnects, and cover it with tests.";

export const BRANCH = "feat/relay-backoff";

export interface ToolRow {
  verb: string;
  target: string;
  meta?: { add?: number; del?: number; text?: string };
}

export const TOOL_ROWS: ToolRow[] = [
  { verb: "Read", target: "relay/client.ts" },
  { verb: "Searched", target: "“reconnect”", meta: { text: "14 results" } },
  { verb: "Edited", target: "relay/client.ts", meta: { add: 11, del: 2 } },
  { verb: "Created", target: "relay/backoff.ts", meta: { add: 52 } },
  { verb: "Created", target: "relay/backoff.test.ts", meta: { add: 68 } },
  { verb: "Ran", target: "bun run test relay", meta: { text: "42 passed" } },
];

/** Totals for the change summary, the header counter and the worktree card. */
export const CHANGES = { files: 3, add: 131, del: 2 } as const;

export const ANSWER =
  "Reconnects now back off exponentially with jitter, capped at 30s, and the attempt counter resets after a stable minute. I added backoff.ts plus 9 tests for the cap, the jitter bounds and the reset.";

export interface SideThread {
  id: string;
  provider: string;
  title: string;
  age: string;
}

/** Sidebar threads (all six run at once); the first four also fill the
 *  parallel scene's split view, which the app caps at a 2x2 grid. */
export const THREADS: SideThread[] = [
  { id: "t1", provider: "claude", title: "Relay reconnect backoff", age: "now" },
  { id: "t2", provider: "codex", title: "Theme editor on tokens", age: "2m" },
  { id: "t3", provider: "copilot", title: "Fix flaky worktree test", age: "4m" },
  { id: "t4", provider: "opencode", title: "Draft v0.1.29 changelog", age: "9m" },
  { id: "t5", provider: "cursor", title: "Faster diff search", age: "12m" },
  { id: "t6", provider: "grok", title: "Audit MCP settings copy", age: "21m" },
];

export interface Pane {
  thread: string;
  model: string;
  rows: ToolRow[];
  text: string;
}

/** One per provider. The film shows the first four (split view holds four);
 *  the Agents roster previews all six. */
export const PANES: Pane[] = [
  {
    thread: "t1",
    model: "Opus 5.5",
    rows: [TOOL_ROWS[2], TOOL_ROWS[3], TOOL_ROWS[5]],
    text: "Reconnects back off with jitter, capped at 30s. 42 tests pass.",
  },
  {
    thread: "t2",
    model: "GPT-5.6 Sol",
    rows: [
      { verb: "Read", target: "themes/editor.tsx" },
      { verb: "Edited", target: "themes/tokens.ts", meta: { add: 84, del: 31 } },
    ],
    text: "Moving accent, radius and font scales onto CSS variables so presets stay live.",
  },
  {
    thread: "t3",
    model: "Copilot",
    rows: [
      { verb: "Ran", target: "bun run test worktree", meta: { text: "1 failed" } },
      { verb: "Edited", target: "worktree/cleanup.ts", meta: { add: 4, del: 1 } },
    ],
    text: "The race is in cleanup: the watcher closes after the dir is gone. Awaiting it fixes the flake.",
  },
  {
    thread: "t4",
    model: "OpenCode",
    rows: [{ verb: "Read", target: "git log v0.1.28..HEAD" }],
    text: "Drafting highlights: split panes, hosted sign-in, faster cold start and MCP profiles.",
  },
  {
    thread: "t5",
    model: "Cursor",
    rows: [
      { verb: "Searched", target: "“occurrence”", meta: { text: "6 results" } },
      { verb: "Edited", target: "diff/search.ts", meta: { add: 38, del: 22 } },
    ],
    text: "Indexing hunks once per turn instead of per keystroke. Search is now instant on large diffs.",
  },
  {
    thread: "t6",
    model: "Grok",
    rows: [{ verb: "Read", target: "settings/mcp.tsx" }],
    text: "Three labels disagree with the docs. Proposing shorter, consistent copy for each profile.",
  },
];

/** The review panel's diff for relay/client.ts (unified, with line numbers). */
export type DiffKind = "ctx" | "add" | "del";
export const DIFF: Array<{ n: number | null; kind: DiffKind; code: string }> = [
  { n: 78, kind: "ctx", code: "  private onClose(event: CloseEvent) {" },
  { n: 79, kind: "ctx", code: "    if (this.disposed) return;" },
  { n: null, kind: "del", code: "    setTimeout(() => this.connect(), 1_000);" },
  { n: 80, kind: "add", code: "    const delay = nextDelay(this.attempt++, this.policy);" },
  { n: 81, kind: "add", code: '    this.emit("reconnecting", { attempt: this.attempt, delay });' },
  { n: 82, kind: "add", code: "    this.timer = setTimeout(() => this.connect(), delay);" },
  { n: 83, kind: "ctx", code: "  }" },
  { n: 84, kind: "ctx", code: "" },
  { n: 85, kind: "ctx", code: "  private onOpen() {" },
  { n: null, kind: "del", code: "    this.attempt = 0;" },
  {
    n: 86,
    kind: "add",
    code: "    this.stable = setTimeout(() => (this.attempt = 0), STABLE_MS);",
  },
  { n: 87, kind: "ctx", code: '    this.emit("open");' },
  { n: 88, kind: "ctx", code: "  }" },
];

/** The diff row the scripted cursor clicks to jump into the editor. */
export const DIFF_CLICK_ROW = 3;

export const BACKOFF_FILE = [
  "export function nextDelay(attempt: number, p: BackoffPolicy) {",
  "  const exp = Math.min(p.maxMs, p.baseMs * 2 ** attempt);",
  "  const spread = exp * p.jitter;",
  "  return Math.round(exp - spread + Math.random() * spread * 2);",
  "}",
];

export const TERMINAL: Array<{ text: string; tone?: "ok" | "dim" | "cmd" | "bold" }> = [
  { text: " ✓ relay/backoff.test.ts (9 tests) 6ms", tone: "ok" },
  { text: " ✓ relay/client.test.ts (27 tests) 41ms", tone: "ok" },
  { text: " ✓ relay/reconnect.test.ts (6 tests) 18ms", tone: "ok" },
  { text: "" },
  { text: " Test Files  3 passed (3)", tone: "bold" },
  { text: "      Tests  42 passed (42)", tone: "bold" },
  { text: "   Duration  612ms", tone: "dim" },
];

export const TERMINAL_CMD = "bun run test relay";

/** Split view holds up to four threads (docs/thread-split-panes.md). */
export const SPLIT_PANES = PANES.slice(0, 4);
