export interface ChangelogHighlight {
  title: string;
  summary: string;
}

export interface ChangelogRelease {
  version: string;
  date: string;
  dateTime: string;
  summary: string;
  highlights: ChangelogHighlight[];
  releaseUrl: string;
}

const RELEASE_BASE = "https://github.com/saka-gg/ryco/releases/tag";

/**
 * Editorial summaries of every public Ryco release on GitHub.
 * Keep these focused on user-facing outcomes; the linked release remains the
 * source of truth for the complete pull-request list and install notes.
 */
export const CHANGELOG_RELEASES: ChangelogRelease[] = [
  {
    version: "0.1.23",
    date: "September 9, 2026",
    dateTime: "2026-09-09",
    summary:
      "Settings become easier to navigate, desktop quitting becomes configurable, and busy workspaces do less background work.",
    releaseUrl: `${RELEASE_BASE}/v0.1.23`,
    highlights: [
      {
        title: "Find and preview your preferences",
        summary:
          "Settings gain focused subsections, theme previews, dedicated composer controls, and shared diff layout preferences that carry through to source control.",
      },
      {
        title: "Choose how the desktop app quits",
        summary:
          "Configurable quit gestures include visible feedback and saved preferences, helping prevent accidental exits while keeping your preferred shortcut close at hand.",
      },
      {
        title: "Less background work in large projects",
        summary:
          "Sidebar activity follows visible rows, thread prewarming waits for idle time, and source control avoids redundant status refreshes while preserving current results.",
      },
      {
        title: "Attachments keep their proportions",
        summary:
          "Images attached to your messages preserve their original proportions instead of filling a fixed grid, making wide and tall images easier to inspect.",
      },
    ],
  },
  {
    version: "0.1.22",
    date: "September 7, 2026",
    dateTime: "2026-09-07",
    summary:
      "Agents can deliver generated files directly in chat, use computer controls, and share live project previews while long-running work stays easier to follow.",
    releaseUrl: `${RELEASE_BASE}/v0.1.22`,
    highlights: [
      {
        title: "Generated files stay with the conversation",
        summary:
          "Assistant messages can deliver persistent file attachments with image previews, audio and video playback, and downloads. General files can also be attached to your own turns.",
      },
      {
        title: "Computer use and live project previews",
        summary:
          "Cross-platform computer-use support, a project browser, and shared live previews bring more of the working environment into Ryco, with improved macOS permission attribution.",
      },
      {
        title: "Keep long-running work organized",
        summary:
          "Snooze threads, preview destination-aware context handoffs in the Inbox, and keep thread goals synchronized with provider runtimes. Subagent activity and liveness are clearer too.",
      },
      {
        title: "More reliable provider history and context",
        summary:
          "Missed history is recovered, failed runtimes are retired, stale requests expire, and authoritative context resets remain intact. OpenCode Go gains usage limits and context fallbacks.",
      },
      {
        title: "A smoother everyday workspace",
        summary:
          "The composer shrinks while you read, new worktrees fetch current origin refs, and resource diagnostics help explain runtime load alongside faster event processing and asset delivery.",
      },
    ],
  },
  {
    version: "0.1.21",
    date: "September 5, 2026",
    dateTime: "2026-09-05",
    summary:
      "Account login now establishes end-to-end encrypted device connections automatically whenever the client can support them.",
    releaseUrl: `${RELEASE_BASE}/v0.1.21`,
    highlights: [
      {
        title: "Encrypted without manual pairing",
        summary:
          "Desktop, mobile, and supported web clients enroll after account login, receive Hub-signed device grants, and negotiate the strongest available E2EE mode without asking users to transfer a code.",
      },
      {
        title: "Trust stays visible",
        summary:
          "Verification codes, key hashes, device enrollment, and connection security remain inspectable so automatic setup never turns trust into a hidden black box.",
      },
      {
        title: "Startup and recovery are fail-safe",
        summary:
          "Initialized node policy, bounded retries, isolated grants, and protected relay bootstrap buffering keep automatic connections reliable while failing closed on invalid or unsupported security state.",
      },
      {
        title: "OpenCode and ACP show more of the work",
        summary:
          "OpenCode now reports token usage, todos, permission types, and retries more faithfully, while ACP-backed providers normalize reasoning chunks and file diffs into shared runtime events.",
      },
    ],
  },
  {
    version: "0.1.20",
    date: "September 3, 2026",
    dateTime: "2026-09-03",
    summary: "The model picker becomes quieter and lets the available models speak for themselves.",
    releaseUrl: `${RELEASE_BASE}/v0.1.20`,
    highlights: [
      {
        title: "No more temporary model badges",
        summary:
          "The model-level NEW label and its supporting catalog metadata are removed, keeping model selection consistent as remote catalogs evolve.",
      },
    ],
  },
  {
    version: "0.1.19",
    date: "September 3, 2026",
    dateTime: "2026-09-03",
    summary:
      "Claude models can evolve between app releases while local logs and activity history stay bounded.",
    releaseUrl: `${RELEASE_BASE}/v0.1.19`,
    highlights: [
      {
        title: "Claude Fable 5.1 arrives",
        summary:
          "The Claude catalog adds Fable 5.1 with its supported effort levels, aliases, context options, and a clear upgrade prompt when the installed CLI is too old.",
      },
      {
        title: "Model updates no longer require an app release",
        summary:
          "A validated remote manifest can refresh Claude model metadata, with last-known-good caching and the bundled catalog as safe fallbacks.",
      },
      {
        title: "User data growth stays controlled",
        summary:
          "Old provider logs are swept, native and canonical streams rotate independently, and oversized activity payloads are bounded before reaching persistent history.",
      },
    ],
  },
  {
    version: "0.1.18",
    date: "August 31, 2026",
    dateTime: "2026-08-31",
    summary:
      "A calmer Inbox uses less work while idle and can safely settle inactive tasks for you.",
    releaseUrl: `${RELEASE_BASE}/v0.1.18`,
    highlights: [
      {
        title: "Less rendering when nothing changes",
        summary:
          "The Inbox reduces compositor and off-screen rendering work, improving efficiency without relying on constant polling.",
      },
      {
        title: "Optional automatic settling",
        summary:
          "A shared web and native setting can settle inactive tasks after a chosen delay, with centralized safeguards and exact boundary scheduling.",
      },
    ],
  },
  {
    version: "0.1.17",
    date: "August 30, 2026",
    dateTime: "2026-08-30",
    summary: "macOS releases now focus on the Apple Silicon systems Ryco actively supports.",
    releaseUrl: `${RELEASE_BASE}/v0.1.17`,
    highlights: [
      {
        title: "A simpler macOS release path",
        summary:
          "Intel builds and universal updater merging are removed, while local packaging, downloads, and support guidance consistently target Apple Silicon.",
      },
    ],
  },
  {
    version: "0.1.16",
    date: "August 30, 2026",
    dateTime: "2026-08-30",
    summary:
      "Local projects resolve to one clear device target, and interrupted diagnostics explain themselves without sounding like failures.",
    releaseUrl: `${RELEASE_BASE}/v0.1.16`,
    highlights: [
      {
        title: "One canonical local workspace",
        summary:
          "Desktop remains the source of truth for local projects and This device execution, preventing a Hub alias from creating duplicate workspaces or connections.",
      },
      {
        title: "Interruptions are not failures",
        summary:
          "Interrupted diagnostic spans remain visible with neutral presentation instead of inheriting stale causes or alarming failure styling.",
      },
    ],
  },
  {
    version: "0.1.15",
    date: "August 30, 2026",
    dateTime: "2026-08-30",
    summary:
      "Provider sessions, workspace content, and long-running threads now stay safer and more predictable through failures.",
    releaseUrl: `${RELEASE_BASE}/v0.1.15`,
    highlights: [
      {
        title: "Workspace images stay inside the workspace",
        summary:
          "Markdown images now load through the contained binary file boundary, with strict path checks, raster validation, private caching, and hardened download headers.",
      },
      {
        title: "Provider sessions recover cleanly",
        summary:
          "Authenticated health checks, durable resumes, cancellation-safe prompts, recovered child approvals, and shared local server ownership prevent duplicate processes and stuck sessions.",
      },
      {
        title: "Failures remain visible and actionable",
        summary:
          "Pull-request polling reports provider failures with bounded backoff, model catalogs survive transient outages, and temporarily unavailable selections remain visible instead of silently changing.",
      },
      {
        title: "Long histories replay reliably",
        summary:
          "Projection recovery resumes from the durable event high-water mark, while bounded title retries repair temporary generation failures without blocking thread creation.",
      },
      {
        title: "Large inputs stay responsive",
        summary:
          "Linear-time protocol framing, bounded composer link parsing, and provider-neutral subagent model and effort metadata improve performance and make delegated work easier to understand.",
      },
    ],
  },
  {
    version: "0.1.14",
    date: "August 30, 2026",
    dateTime: "2026-08-30",
    summary:
      "Everyday agent work becomes safer and more resilient, from reconnects and worktrees to attachments and provider controls.",
    releaseUrl: `${RELEASE_BASE}/v0.1.14`,
    highlights: [
      {
        title: "Files reach the providers that can use them",
        summary:
          "Provider-aware attachments add bounded general-file support, preserve workspace references elsewhere, and harden server reads against unsafe paths and file swaps.",
      },
      {
        title: "Sessions recover instead of getting stuck",
        summary:
          "Reconnect refreshes, bounded activity persistence, safer interrupts, terminal snapshots, and startup reconciliation keep long-running work responsive through failures.",
      },
      {
        title: "Worktrees repair themselves",
        summary:
          "New worktrees initialize submodules, missing recorded worktrees can be recreated, partial bootstraps can be retried, and feature branches publish under the correct name.",
      },
      {
        title: "Provider lifecycles get sharper",
        summary:
          "Context compaction, stable subagent attribution, hardened child sessions, current multi-agent events, and recoverable approvals improve behavior across providers.",
      },
      {
        title: "Faster controls with clearer feedback",
        summary:
          "Provider settings gain a responsive master-detail editor, threads gain keyboard pinning, and native session failures now explain what users can safely do next.",
      },
    ],
  },
  {
    version: "0.1.13",
    date: "August 30, 2026",
    dateTime: "2026-08-30",
    summary:
      "Hosted node configuration now reaches native clients reliably across startup and reconnect.",
    releaseUrl: `${RELEASE_BASE}/v0.1.13`,
    highlights: [
      {
        title: "Native clients see the right node configuration",
        summary:
          "Hub configuration projection is repaired so phone and desktop clients stay aligned with the node they are actually using.",
      },
    ],
  },
  {
    version: "0.1.12",
    date: "August 29, 2026",
    dateTime: "2026-08-29",
    summary: "Desktop settings remain bound to the node that owns them, even as routing changes.",
    releaseUrl: `${RELEASE_BASE}/v0.1.12`,
    highlights: [
      {
        title: "Desktop settings stay on their machine",
        summary:
          "Routed desktop sessions keep settings reads and writes on the intended node instead of silently falling back to another environment.",
      },
    ],
  },
  {
    version: "0.1.11",
    date: "August 29, 2026",
    dateTime: "2026-08-29",
    summary: "Selecting another node now routes its settings requests to the correct machine.",
    releaseUrl: `${RELEASE_BASE}/v0.1.11`,
    highlights: [
      {
        title: "Settings follow the selected node",
        summary:
          "Machine-specific settings now load and save through the active routed connection, making multi-node administration predictable.",
      },
    ],
  },
  {
    version: "0.1.10",
    date: "August 29, 2026",
    dateTime: "2026-08-29",
    summary:
      "Cross-node trust, hosted recovery, and machine-scoped settings become safer and clearer.",
    releaseUrl: `${RELEASE_BASE}/v0.1.10`,
    highlights: [
      {
        title: "Stronger cross-node boundaries",
        summary:
          "Trust establishment, request targeting, and client parity are hardened so remote nodes agree on identity and authority before accepting work.",
      },
      {
        title: "Hosted sessions recover without losing their place",
        summary:
          "Cold routes survive node recovery, desktop claims retry safely, and mobile source-control connections stay fenced to their active lifecycle.",
      },
      {
        title: "Settings explain where they live",
        summary:
          "Machine-scoped values now show their provenance, making it easier to understand which node owns each setting.",
      },
      {
        title: "A browsable release history",
        summary:
          "The marketing site gains a dedicated changelog with editorial summaries and direct links to every public release.",
      },
    ],
  },
  {
    version: "0.1.9",
    date: "August 29, 2026",
    dateTime: "2026-08-29",
    summary:
      "Ryco grows from a desktop workspace into a secure, cross-device control plane for coding agents.",
    releaseUrl: `${RELEASE_BASE}/v0.1.9`,
    highlights: [
      {
        title: "Ryco goes mobile",
        summary:
          "A native iOS app brings threads, reviews, connections, settings, model controls, and Hub authentication to the phone experience.",
      },
      {
        title: "Secure hosted access",
        summary:
          "Hosted Hub onboarding, relay recovery, node management, passkeys, account security, and end-to-end encrypted channels make remote work safer and more resilient.",
      },
      {
        title: "One runtime across every client",
        summary:
          "The shared client runtime now owns transport, connection supervision, authorization, relay behavior, and core state for web, desktop, and mobile.",
      },
      {
        title: "A calmer way to track work",
        summary:
          "AI Focus ranks the unified inbox while timeline folds, a chat minimap, richer statistics, and subagent observability keep busy workspaces legible.",
      },
      {
        title: "More agents, stronger handoffs",
        summary:
          "Grok joins the provider roster, durable cross-provider handoffs preserve context, and automatic runtime mode keeps sessions aligned with each client.",
      },
    ],
  },
  {
    version: "0.1.8",
    date: "July 11, 2026",
    dateTime: "2026-07-11",
    summary:
      "Search, planning, and pull request preparation move closer to the conversation where the work happens.",
    releaseUrl: `${RELEASE_BASE}/v0.1.8`,
    highlights: [
      {
        title: "Ask before you build",
        summary:
          "Ask mode is available across providers and the composer, giving research and planning turns a clear home before implementation begins.",
      },
      {
        title: "Find any message faster",
        summary:
          "Message search is now part of the command palette, so long-running threads stay easy to navigate.",
      },
      {
        title: "Pull request drafts from real changes",
        summary:
          "A dedicated PR content generator turns the actual change set into a useful GitHub pull request title and description.",
      },
      {
        title: "A public home for Ryco",
        summary:
          "The standalone marketing site launched with real product views, provider details, downloads, and a clearer introduction to the project.",
      },
    ],
  },
  {
    version: "0.1.7",
    date: "July 2, 2026",
    dateTime: "2026-07-02",
    summary:
      "Managed subagents become easier to follow, measure, and control across active projects.",
    releaseUrl: `${RELEASE_BASE}/v0.1.7`,
    highlights: [
      {
        title: "Subagents become first-class work",
        summary:
          "Managed thread orchestration, reliable replay and interrupts, stable codenames, and recognizable avatars make delegated work easier to follow.",
      },
      {
        title: "Workspace statistics arrive",
        summary:
          "New server queries and UI panels expose activity and usage patterns without sending operational data away from Ryco.",
      },
      {
        title: "A more useful overview",
        summary:
          "The overview panel gains a flexible layout system and an interactive design lab for refining the workspace around current work.",
      },
      {
        title: "Provider controls get sharper",
        summary:
          "Claude Fable 5 and ultracode effort are supported, provider update checks can be disabled, and thread rows can be renamed in place.",
      },
    ],
  },
  {
    version: "0.1.6",
    date: "June 17, 2026",
    dateTime: "2026-06-17",
    summary:
      "Subagent activity gets its own workspace while diagnostics make runtime behavior easier to inspect.",
    releaseUrl: `${RELEASE_BASE}/v0.1.6`,
    highlights: [
      {
        title: "Dedicated subagent panels",
        summary:
          "Live subagent streams can open beside the primary conversation, keeping parallel work visible without mixing every update into one timeline.",
      },
      {
        title: "Runtime diagnostics",
        summary:
          "Queue and projection metrics join a dedicated diagnostics settings page for a clearer view of performance under load.",
      },
      {
        title: "Less composer clutter",
        summary:
          "Wide composer labels collapse automatically, while send flow and project settings logic move into clearer shared modules.",
      },
    ],
  },
  {
    version: "0.1.5",
    date: "June 12, 2026",
    dateTime: "2026-06-12",
    summary: "Jira work can now move directly into an isolated coding workspace.",
    releaseUrl: `${RELEASE_BASE}/v0.1.5`,
    highlights: [
      {
        title: "Jira-linked worktrees",
        summary:
          "Create and track a worktree from a Jira work item, keeping the issue, branch, and coding session connected from the start.",
      },
    ],
  },
  {
    version: "0.1.4",
    date: "June 11, 2026",
    dateTime: "2026-06-11",
    summary:
      "The workspace becomes faster, more coherent, and easier to shape around projects and provider instances.",
    releaseUrl: `${RELEASE_BASE}/v0.1.4`,
    highlights: [
      {
        title: "A redesigned workspace overview",
        summary:
          "Chat overview and side panels were recomposed, explorer headers were simplified, and sidebar status language now stays consistent.",
      },
      {
        title: "Projects stay close at hand",
        summary:
          "Local folders join the project sidebar and workflow runs group naturally by pull request or branch.",
      },
      {
        title: "Faster startup under load",
        summary:
          "Runtime load control, refreshed bundling, TypeScript 6 configuration, and updated tests reduce startup work and improve maintainability.",
      },
      {
        title: "More precise appearance and state",
        summary:
          "Surface transparency controls arrive, composer traits are keyed by provider instance, and pull request status refreshes more reliably after push.",
      },
    ],
  },
  {
    version: "0.1.3",
    date: "June 1, 2026",
    dateTime: "2026-06-01",
    summary:
      "Source control moves deeper into the workspace, backed by substantial streaming and rendering performance work.",
    releaseUrl: `${RELEASE_BASE}/v0.1.3`,
    highlights: [
      {
        title: "Issues become ready-to-code worktrees",
        summary:
          "Branch names can be generated from issue metadata, worktrees can start from a chosen base branch, and changed files open directly from the timeline.",
      },
      {
        title: "Smoother live sessions",
        summary:
          "Provider streams, chat updates, and terminal output are coalesced and batched, reducing churn during fast assistant output.",
      },
      {
        title: "GitHub checks inside Ryco",
        summary:
          "Browse Actions status, see pull request checks in source control, and rerun workflows without leaving the project view.",
      },
      {
        title: "Better issue and PR conversations",
        summary:
          "Redesigned detail dialogs support comment posting, quote replies, linked numbers in the chat header, and clearer authorship metadata.",
      },
    ],
  },
  {
    version: "0.1.2",
    date: "May 28, 2026",
    dateTime: "2026-05-28",
    summary:
      "Desktop startup and macOS installation get friendlier while appearance controls gain familiar presets.",
    releaseUrl: `${RELEASE_BASE}/v0.1.2`,
    highlights: [
      {
        title: "A real desktop startup state",
        summary:
          "A lightweight bootstrap shell appears while the backend starts, replacing the empty wait with clear progress.",
      },
      {
        title: "VS Code theme presets",
        summary:
          "Familiar color presets and expanded appearance controls make it faster to tune Ryco to an existing editor setup.",
      },
      {
        title: "Safer unsigned macOS updates",
        summary:
          "Release guidance and installer fallbacks make installation and updates more predictable before notarized builds are available.",
      },
      {
        title: "A cleaner validation pipeline",
        summary:
          "GitHub CI moves to a shared validation workflow and the published server package now includes its own README.",
      },
    ],
  },
  {
    version: "0.1.1",
    date: "May 22, 2026",
    dateTime: "2026-05-22",
    summary:
      "Ryco's first public release establishes the local multi-agent workspace and the workflows around it.",
    releaseUrl: `${RELEASE_BASE}/v0.1.1`,
    highlights: [
      {
        title: "A workspace that feels like yours",
        summary:
          "Custom themes, preferred editor settings, JetBrains support, file previews, diff search, and editor-linked line numbers shape the core workspace.",
      },
      {
        title: "Multiple coding agents, one home",
        summary:
          "Provider settings, GitHub Copilot support, usage visibility, model short names, and reliable early-event handling establish the multi-provider runtime.",
      },
      {
        title: "Source control beyond GitHub",
        summary:
          "GitLab, Bitbucket, Azure DevOps, Forgejo, and Jira context can flow into threads alongside GitHub issues and pull requests.",
      },
      {
        title: "Worktrees built into the conversation",
        summary:
          "Fresh worktrees, staged attachments, terminal tabs, issue creation, project avatars, and safe branch cleanup bring everyday repository work into chat.",
      },
      {
        title: "Extensible from day one",
        summary:
          "MCP server management, provider MCP settings, plugins, skill mentions, interactive keybindings, and faster startup create room for different workflows.",
      },
    ],
  },
];
