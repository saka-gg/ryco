/**
 * Single source of truth for the marketing copy. Everything here is grounded
 * in the real product (README, docs/hub-connector.md, docs/hosted-hub-client.md)
 * so the motion can be loud while the claims stay honest.
 */
import type { BrandKey } from "@/assets/brands";

export const SITE = {
  name: "Ryco",
  tagline: "Every coding agent, one workspace.",
  oneLiner:
    "Run Codex, Claude, Copilot, OpenCode, Cursor and Grok side by side, on every machine you own. Local-first, open source and fast.",
  longDescription:
    "Ryco is a small, practical workspace for AI coding agents: a cross-platform desktop app and a local web CLI, with optional Cloud access to every machine you run it on and an iPhone app on the way.",
  repo: "https://github.com/saka-gg/ryco",
  releases: "https://github.com/saka-gg/ryco/releases",
  discord: "https://discord.gg/jn4EGJjrvv",
  cloud: "https://app.ryco.space",
  cloudHost: "app.ryco.space",
  /** Cloud is an invite-only beta: access requests go through the Discord. */
  cloudRequestAccess: "https://discord.gg/jn4EGJjrvv",
  npx: "npx ryco-cli",
  license: "MIT",
  company: "Ryco Inc.",
  maintainer: { name: "sak0a", url: "https://saka.at" },
} as const;

export interface Provider {
  id: string;
  name: string;
  vendor: string;
  brand: BrandKey;
  /** The vendor's own mark colour, used when the provider is "lit". */
  accent: string;
  /** How Ryco talks to it. */
  via: string;
  detail: string;
  earlyAccess?: boolean;
}

export const PROVIDERS: Provider[] = [
  {
    id: "codex",
    name: "Codex",
    vendor: "OpenAI",
    brand: "openai",
    accent: "#e8e8e6",
    via: "Codex app-server, JSON-RPC over stdio",
    detail: "Ultrafast speed tier, live usage windows and sign-in from Settings.",
  },
  {
    id: "claude",
    name: "Claude",
    vendor: "Anthropic",
    brand: "anthropic",
    accent: "#d97757",
    via: "Claude Agent SDK",
    detail: "Fast mode, a 1M context window, and subagents you can message mid-run.",
  },
  {
    id: "copilot",
    name: "Copilot",
    vendor: "GitHub",
    brand: "copilot",
    accent: "#b18cf9",
    via: "@github/copilot-sdk",
    detail: "A first-party driver wired straight into the Copilot SDK.",
  },
  {
    id: "opencode",
    name: "OpenCode",
    vendor: "OpenCode",
    brand: "opencode",
    accent: "#fab283",
    via: "@opencode-ai/sdk",
    detail: "OpenCode 1 and 2 with their own slash commands, or your own server.",
  },
  {
    id: "cursor",
    name: "Cursor",
    vendor: "Anysphere",
    brand: "cursor",
    accent: "#e4e4e7",
    via: "Cursor Agent over ACP",
    detail: "Agent Client Protocol, with Cursor's own slash commands per project.",
    earlyAccess: true,
  },
  {
    id: "grok",
    name: "Grok",
    vendor: "xAI",
    brand: "grok",
    accent: "#c9c9cf",
    via: "Grok CLI over ACP",
    detail: "Sign in with an xAI key or OAuth; billing credits show on Limits.",
    earlyAccess: true,
  },
];

export const providerById = (id: string) => PROVIDERS.find((p) => p.id === id)!;

export interface Platform {
  id: "macos" | "linux" | "windows";
  name: string;
  brand: BrandKey;
  format: string;
  arch: string;
  install: string;
}

export const PLATFORMS: Platform[] = [
  {
    id: "macos",
    name: "macOS",
    brand: "apple",
    format: ".dmg",
    arch: "Apple Silicon",
    install: "Open the DMG and run Install Ryco.command",
  },
  {
    id: "linux",
    name: "Linux",
    brand: "linux",
    format: ".AppImage",
    arch: "x64",
    install: "Or from the AUR: yay -S ryco-bin",
  },
  {
    id: "windows",
    name: "Windows",
    brand: "windows",
    format: ".exe",
    arch: "x64 NSIS installer",
    install: "Run the installer from Releases",
  },
];

/** Real product captures, dark mode, from an isolated demo node (no personal
 *  data). Stills live in /public/shots: `src` is the source PNG key and pages
 *  render its responsive WebP variants through screenshotImageProps(). A shot
 *  with `video` plays that loop from /public/media instead, `src` naming the
 *  path without extension. */
export interface Shot {
  src: string;
  title: string;
  caption: string;
  alt: string;
  /** Native width / height. */
  aspect: number;
  video?: boolean;
}

const DESKTOP = 2200 / 1560;

export const SHOTS: Shot[] = [
  {
    src: "/media/desktop-agent-work",
    video: true,
    title: "Watch it work",
    caption: "Live chapters, tool rows and the reasoning timeline, as the agent runs.",
    alt: "A Ryco thread mid-run: live work chapters and tool rows update as the agent reads and searches.",
    aspect: 1600 / 1134,
  },
  {
    src: "/shots/desktop-hero-agents.png",
    title: "Agents that delegate",
    caption: "A thread hands work to a subagent and keeps going. Everything active sits on top.",
    alt: "A Ryco thread delegating a review to a subagent, with the active threads listed in the sidebar.",
    aspect: DESKTOP,
  },
  {
    src: "/shots/desktop-review.png",
    title: "Review",
    caption: "Turn diffs or branch changes, staged and unstaged, with a file tree and find.",
    alt: "The Ryco review panel comparing branch changes with a diff of a test file.",
    aspect: DESKTOP,
  },
  {
    src: "/shots/desktop-pull-requests.png",
    title: "Pull requests",
    caption: "Every pull request that needs you, with checks, conflicts and size at a glance.",
    alt: "The Ryco pull requests page listing open pull requests of the public Ryco repository.",
    aspect: DESKTOP,
  },
  {
    src: "/shots/desktop-quick-open.png",
    title: "Quick open",
    caption: "⌘P finds any file in the project, and ⇧⌘F searches inside them.",
    alt: "Ryco's quick open dialog matching project files for the query automation.",
    aspect: DESKTOP,
  },
  {
    src: "/shots/desktop-terminal.png",
    title: "Terminal",
    caption: "Real terminals in a drawer, right under the thread that needs them.",
    alt: "A Ryco thread with the terminal drawer open below the conversation.",
    aspect: DESKTOP,
  },
  {
    src: "/shots/desktop-tasks.png",
    title: "Tasks",
    caption: "Your to-do list next to your chats. Start a chat from any task.",
    alt: "The Ryco Tasks page with three open tasks.",
    aspect: DESKTOP,
  },
  {
    src: "/shots/desktop-appearance.png",
    title: "Appearance",
    caption: "System, light and dark, theme palettes, and VS Code themes on import.",
    alt: "Ryco appearance settings with color modes and theme palettes.",
    aspect: DESKTOP,
  },
  {
    src: "/shots/web-conversation.png",
    title: "In any browser",
    caption: "The same app in a browser tab, from npx ryco-cli or Ryco Cloud.",
    alt: "Ryco running in a browser window, showing a finished conversation.",
    aspect: 2880 / 1800,
  },
];

/** Ryco Cloud (the hosted Hub at app.ryco.space): optional, free during an
 *  invite-only beta, for a limited number of devices per account. Security
 *  claims follow docs/hosted-hub-client.md, docs/relay-e2ee-protocol.md and
 *  docs/push-alerts.md: no blanket end-to-end promise. */
export const CLOUD = {
  badge: "Free beta · invite only",
  points: [
    {
      title: "Optional, and free",
      body: "Ryco never needs an account. Cloud is free during the beta, for a limited number of devices per account.",
    },
    {
      title: "Passkey first",
      body: "Sign in with a passkey, or a password plus a second factor. Remove a device, or the whole account, whenever you like.",
    },
    {
      title: "Encrypted end to end, where it can be",
      body: "When both ends support it, sessions are encrypted between your device and the machine that runs the work. Each connection says how it's protected, and a machine can refuse anything less.",
    },
    {
      title: "No ports to open",
      body: "Each machine dials out over one connection, so it works behind NAT, CGNAT and home routers.",
    },
    {
      title: "Your work stays home",
      body: "Projects, terminals and conversations live on your machines. Cloud relays the connection and stores none of it unless you turn on saved history.",
    },
    {
      title: "Alerts it can't read",
      body: "Your machine decides when to alert you and seals each alert to your phone, so Cloud delivers it without reading it.",
    },
  ],
  /** Desktop: "Connect Ryco account". Servers and headless boxes: the guided
   *  setup (background service, account, Tailscale, pairing), or link a
   *  running node directly. */
  setup: "npx ryco-cli setup",
  link: "ryco hub login",
} as const;

/** The native iPhone app (apps/mobile). Not in the App Store or TestFlight
 *  yet, so every surface labels it "coming soon". Chapters with a `shot`
 *  play in the pinned phone; the rest list below it. Shots are real
 *  simulator captures in /public/shots. */
export interface MobileChapter {
  title: string;
  body: string;
  /** Still (and poster stand-in) in /public/shots. */
  shot?: string;
  /** Optional loop in /public/media, path without extension. */
  video?: string;
  alt?: string;
}

export const MOBILE: {
  status: string;
  chapters: MobileChapter[];
} = {
  status: "Coming soon to iPhone and iPad",
  chapters: [
    {
      title: "Every thread, every machine",
      body: "One inbox across your projects and machines, each thread tagged with where it runs.",
      shot: "/shots/iphone-inbox.png",
      alt: "Ryco for iPhone: the inbox listing five active threads across two projects.",
    },
    {
      title: "Watch it stream, steer it live",
      body: "Replies stream in as the agent writes. Answer questions, approve tools, or queue a follow-up the machine sends when the agent is ready.",
      shot: "/shots/iphone-streaming.png",
      video: "/media/iphone-reply-stream",
      alt: "Ryco for iPhone: an agent's reply streaming into a running thread.",
    },
    {
      title: "Every agent at a glance",
      body: "See the agents a chat started, with live time, tokens and what each is thinking.",
      shot: "/shots/iphone-agents.png",
      alt: "Ryco for iPhone: the agents sheet with a running subagent and its reasoning state.",
    },
    {
      title: "Every model in your pocket",
      body: "Switch provider, model, reasoning effort and fast mode per thread, the same picker as on desktop.",
      shot: "/shots/iphone-provider-picker.png",
      alt: "Ryco for iPhone: the provider picker with Claude, Codex, Copilot, Grok and OpenCode.",
    },
    {
      title: "Review and merge",
      body: "A pull request's conversation, checks and diffs, with review, merge and branch updates.",
    },
    {
      title: "A real terminal",
      body: "Open a thread's terminal with paste and arrow keys, or watch and drive the agent's simulator.",
    },
    {
      title: "Alerts while it's closed",
      body: "Know the moment a thread finishes or needs you. Your machine seals each alert before it leaves.",
    },
    {
      title: "Lock Screen and widgets",
      body: "Running agents in the Dynamic Island, and what's left of each subscription on your Home Screen.",
    },
  ],
};

/** The rest of the latest releases, for the What's new marquee. Short,
 *  user-facing names; the changelog carries the detail. */
export const LATEST_MORE = [
  [
    "Chat tabs",
    "⌘P quick open",
    "⇧⌘F search in files",
    "VS Code themes",
    "Fork to another machine",
    "Side chats as threads",
    "Rescue snapshots",
    "Edit an earlier prompt",
    "Compare with any branch",
    "Snooze until a time",
    "Import Codex and Claude projects",
    "HEIC photos",
    "Ryco Nightly",
    "Today recap",
  ],
  [
    "ryco thread CLI",
    "OpenCode 2",
    "Weekday schedules",
    "Heartbeat schedules",
    "Private secret cards",
    "Pick page elements",
    "Dev servers per thread",
    "Node browser tabs",
    "Cost per token type",
    "Database backups",
    "ryco doctor",
    ".worktreeinclude",
    "Message a running subagent",
    "Sign in from Settings",
  ],
] as const;

export const FAQ = [
  {
    q: "Is Ryco local or cloud?",
    a: "Local-first. Ryco runs on your machine as a desktop app or a web CLI, and works with no account at all. Cloud is an optional extra for reaching your machines from somewhere else.",
  },
  {
    q: "What does Ryco Cloud cost?",
    a: "Nothing during the beta. Cloud is invite-only for now and free for a limited number of devices per account: ask for access in the Discord, then sign in at app.ryco.space.",
  },
  {
    q: "Does my code go through Ryco Cloud?",
    a: "Cloud stores none of it: projects, files, terminals and conversations stay on the machines that own them, unless you turn on saved thread history for a machine. When you open a thread remotely, Cloud relays that traffic, encrypted between your device and the machine when both support it. Every connection shows how it is protected, and starting a machine with --hub-require-e2ee makes it refuse anything else.",
  },
  {
    q: "Is there a mobile app?",
    a: "Coming soon. The iPhone and iPad app is in development and reaches your machines through Cloud, or directly over your network or Tailscale. It isn't in the App Store yet; the Discord is where you'll hear first.",
  },
  {
    q: "Can agents keep working while I'm away?",
    a: "Yes. Queued messages, goals, schedules and pull request watches run on the machine itself, so they carry on with every window closed. Ryco keeps the machine awake while agents work and tells you when a thread finishes or needs you.",
  },
  {
    q: "Which agents are supported?",
    a: "Codex, Claude, GitHub Copilot and OpenCode today, with Cursor and Grok in early access, plus any ACP agent you have installed. Each one runs through its own SDK or protocol, using the subscription you already have.",
  },
  {
    q: "Can I run more than one of the same agent?",
    a: "Yes. Named provider instances let you run codex_personal and claude_openrouter at once, each with its own config, environment, auth and models.",
  },
  {
    q: "Is it open source?",
    a: "Yes, MIT licensed. Ryco is very early, so expect rough edges and breaking changes. The Discord is the best place to follow along.",
  },
] as const;
