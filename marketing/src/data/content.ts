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
    "Run Codex, Claude, Copilot, OpenCode, Cursor and Grok side by side. Local-first, open source and fast.",
  longDescription:
    "Ryco is a small, practical workspace for AI coding agents: a cross-platform desktop app and a local web CLI, with optional Cloud access to every machine you run it on.",
  repo: "https://github.com/saka-gg/ryco",
  releases: "https://github.com/saka-gg/ryco/releases",
  discord: "https://discord.gg/jn4EGJjrvv",
  cloud: "https://app.ryco.space",
  cloudHost: "app.ryco.space",
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
    detail: "Live usage windows surface right beside the composer.",
  },
  {
    id: "claude",
    name: "Claude",
    vendor: "Anthropic",
    brand: "anthropic",
    accent: "#d97757",
    via: "Claude Agent SDK",
    detail: "Full Agent SDK integration, usage windows included.",
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
    detail: "Use the bundled SDK, or point Ryco at your own OpenCode server.",
  },
  {
    id: "cursor",
    name: "Cursor",
    vendor: "Anysphere",
    brand: "cursor",
    accent: "#e4e4e7",
    via: "Cursor Agent over ACP",
    detail: "Agent Client Protocol, on Ryco's shared ACP runtime.",
    earlyAccess: true,
  },
  {
    id: "grok",
    name: "Grok",
    vendor: "xAI",
    brand: "grok",
    accent: "#c9c9cf",
    via: "Grok CLI over ACP",
    detail: "Sign in with an xAI API key or OAuth.",
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

/** Real product captures in /public/shots, dark mode, identities blurred. */
export interface Shot {
  src: string;
  title: string;
  caption: string;
  alt: string;
  /** Native width / height. */
  aspect: number;
}

export const SHOTS: Shot[] = [
  {
    src: "/shots/model-picker.webp",
    title: "Model picker",
    caption: "Every model from every provider in one picker, with ⌘1 to ⌘9 jumps.",
    alt: "Ryco model picker listing Claude models with keyboard shortcuts and a provider rail.",
    aspect: 1594 / 850,
  },
  {
    src: "/shots/diff.webp",
    title: "Review",
    caption: "Per-turn diffs. Click any line to open your editor right there.",
    alt: "Ryco review panel showing per-turn diffs of TypeScript files.",
    aspect: 1798 / 1894,
  },

  {
    src: "/shots/overview.webp",
    title: "Project overview",
    caption: "Issues, pull requests, Actions and Jira for the repo at a glance.",
    alt: "Ryco project overview with open issues, pull requests, Actions and Jira status.",
    aspect: 2660 / 1492,
  },

  {
    src: "/shots/providers.webp",
    title: "Providers",
    caption: "Live auth, version and subscription status per provider.",
    alt: "Ryco provider settings listing authenticated Codex, Claude, Copilot, Cursor and OpenCode.",
    aspect: 1946 / 1088,
  },
  {
    src: "/shots/themes.webp",
    title: "Appearance",
    caption: "Fonts, size, radius and a custom accent, tuned live.",
    alt: "Ryco appearance settings with font pickers, size, radius and accent colour.",
    aspect: 1946 / 1590,
  },
];

/** Ryco Cloud (the hosted Hub at app.ryco.space). Optional, free for now. */
export const CLOUD = {
  points: [
    {
      title: "Sign in with a passkey",
      body: "No passwords. One account for every machine you enroll.",
    },
    {
      title: "No ports to open",
      body: "Each machine dials out over one connection, so it works behind NAT and home routers.",
    },
    {
      title: "Your work stays home",
      body: "Projects, terminals and conversations live on your machines. Cloud relays an encrypted connection to them.",
    },
    {
      title: "One workspace, every machine",
      body: "Threads from your laptop and your build box show up side by side, each tagged with where it runs.",
    },
  ],
  serve: "npx ryco-cli serve --hub",
} as const;

export const FAQ = [
  {
    q: "Is Ryco local or cloud?",
    a: "Local-first. Ryco runs on your machine as a desktop app or a web CLI, and works with no account at all. Cloud is an optional extra for reaching your machines from somewhere else.",
  },
  {
    q: "What does Ryco Cloud cost?",
    a: "Nothing for now. Sign in at app.ryco.space with a passkey and connect a machine. If that ever changes, it will be announced well ahead of time.",
  },
  {
    q: "Does my code go through Ryco Cloud?",
    a: "Your projects, files, terminals and conversations stay on the machines that own them. Cloud relays an end-to-end encrypted connection to those machines; it is not a copy of your work.",
  },
  {
    q: "Which agents are supported?",
    a: "Codex, Claude, GitHub Copilot and OpenCode today, with Cursor and Grok in early access. Each one runs through its own SDK or protocol, using the subscription you already have.",
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
