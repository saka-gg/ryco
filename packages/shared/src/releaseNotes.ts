/**
 * Release notes for every public Ryco release: one source for the marketing
 * site's changelog (`marketing/`) and the app's What's new dialog.
 *
 * Pure data with no imports, so the standalone marketing app can import this
 * file by path. Keep entries newest first, focused on user-facing outcomes;
 * the linked GitHub release stays the source of truth for the complete
 * pull-request list and install notes.
 */

export interface ChangelogHighlight {
  readonly title: string;
  readonly summary: string;
}

export interface ChangelogRelease {
  /** The release's version without the leading "v", e.g. "0.1.44". */
  readonly version: string;
  /** Display date, e.g. "November 9, 2026". */
  readonly date: string;
  /** ISO date, e.g. "2026-11-09". */
  readonly dateTime: string;
  readonly summary: string;
  readonly highlights: ReadonlyArray<ChangelogHighlight>;
  readonly releaseUrl: string;
}

const RELEASE_BASE = "https://github.com/saka-gg/ryco/releases/tag";

/** The marketing site's changelog page, with every release. */
export const CHANGELOG_PAGE_URL = "https://ryco.space/changelog";

export const CHANGELOG_RELEASES: ReadonlyArray<ChangelogRelease> = [
  {
    version: "0.1.44",
    date: "November 9, 2026",
    dateTime: "2026-11-09",
    summary:
      "Full access agents drive simulators without asking, a new Ryco Cloud sign-in, and the coming iPhone app gains Git, files, scripts, dev servers and scheduled tasks.",
    releaseUrl: `${RELEASE_BASE}/v0.1.44`,
    highlights: [
      {
        title: "Devices without the prompts",
        summary:
          "A chat in Full access can boot, attach and control simulators and emulators on its own, so an agent testing your app no longer stops to ask at every tap.",
      },
      {
        title: "A new Cloud sign-in",
        summary: "Signing in to Ryco Cloud opens on a redesigned split-screen page.",
      },
      {
        title: "Your projects on the phone",
        summary:
          "The iPhone app, still in development, now covers branches, commits, staging, compare and blame, edits files and searches inside them, runs project scripts and dev servers with a browser preview, manages simulators, browses issues, Actions and Jira, and lists scheduled tasks.",
      },
    ],
  },
  {
    version: "0.1.43",
    date: "November 9, 2026",
    dateTime: "2026-11-09",
    summary:
      "A thread list that survives SQLite 3.54, and the coming iPhone app gains tabs, pull request review and Tasks.",
    releaseUrl: `${RELEASE_BASE}/v0.1.43`,
    highlights: [
      {
        title: "Thread lists keep loading",
        summary:
          "A held follow-up queue no longer breaks the thread list on machines with SQLite 3.54.",
      },
      {
        title: "Pull requests on the phone",
        summary:
          "The iPhone app's new PRs tab opens a pull request, reviews it file by file with viewed state and line comments, and edits its title, reviewers and labels while checks update live.",
      },
      {
        title: "A phone app with tabs",
        summary:
          "Chats, global search, usage, Tasks and Settings each get a tab. Tasks span every machine, can be captured from anywhere and start a chat in one tap, and the chat screen gains a floating header with live status.",
      },
    ],
  },
  {
    version: "0.1.42",
    date: "November 8, 2026",
    dateTime: "2026-11-08",
    summary:
      "Queued messages from agents and automations go out without a review stop, and the coming iPhone app gets swipe actions, dictation, a share extension and richer notifications.",
    releaseUrl: `${RELEASE_BASE}/v0.1.42`,
    highlights: [
      {
        title: "Automations keep moving",
        summary:
          "A message an agent or automation queued sends without the Claude resume review, and Claude wake turns keep the tools bound to that turn.",
      },
      {
        title: "Quicker on the phone",
        summary:
          "In the iPhone app, swipe a chat to pin or archive it, search messages, dictate on the device, attach any file, share into Ryco from other apps, and act on notifications without opening the app. A Live Activity and a widget show what your agents are doing.",
      },
    ],
  },
  {
    version: "0.1.41",
    date: "November 7, 2026",
    dateTime: "2026-11-07",
    summary: "Computer Use reads more clearly in the chat and stays on for normal sends.",
    releaseUrl: `${RELEASE_BASE}/v0.1.41`,
    highlights: [
      {
        title: "Computer Use in plain words",
        summary:
          "Computer Use calls show in the chat as what they do, not as tool names, and normal sends no longer skip Computer Use on a Mac where it is granted.",
      },
      {
        title: "Sturdier on macOS",
        summary:
          "Several chats can keep using the computer after one brings an app to the front, and Mac releases sign and staple more reliably.",
      },
    ],
  },
  {
    version: "0.1.40",
    date: "November 7, 2026",
    dateTime: "2026-11-07",
    summary: "Computer Use recognises your Mac when you connect through Ryco Cloud.",
    releaseUrl: `${RELEASE_BASE}/v0.1.40`,
    highlights: [
      {
        title: "Computer Use through Cloud",
        summary:
          "Ryco knows this Mac by its Cloud id too, so Computer Use works from chats you open through Ryco Cloud.",
      },
    ],
  },
  {
    version: "0.1.39",
    date: "November 7, 2026",
    dateTime: "2026-11-07",
    summary:
      "Simulators and emulators in the chat, Computer Use as its own signed app, and several chats at the computer at once.",
    releaseUrl: `${RELEASE_BASE}/v0.1.39`,
    highlights: [
      {
        title: "Phones next to the chat",
        summary:
          "Run an iOS Simulator or Android emulator inside Ryco with live video and touch, keys, paste and rotation, float it over the chat or keep it in a tab, and view it in 3D. Agents read its screen and drive it, a setup wizard installs what is missing, and it streams through Cloud to the browser and phone too.",
      },
      {
        title: "Computer Use, set up in one click",
        summary:
          "Computer Use runs as its own signed helper app with one-button setup, approval per app and Input Monitoring only if you want it. Several chats can use the computer at the same time, and the menu bar shows one calm status.",
      },
      {
        title: "Codex asks in the chat",
        summary:
          "When Codex needs an answer from an MCP server, such as an app approval for OpenAI's Computer Use, the question appears in the chat.",
      },
      {
        title: "Composer and copies",
        summary:
          "The composer footer is simpler, the model picker groups providers in tabs along the top, and folders that aren't Git repositories copy to another machine too.",
      },
    ],
  },
  {
    version: "0.1.38",
    date: "November 6, 2026",
    dateTime: "2026-11-06",
    summary:
      "Redesigned settings for every device at once, projects you can copy to another machine, and a rounder, calmer window.",
    releaseUrl: `${RELEASE_BASE}/v0.1.38`,
    highlights: [
      {
        title: "Settings for every device",
        summary:
          "One settings page covers this app and each of your machines. See every device's value side by side, share a setting across devices with overrides where one differs, and restore providers to the devices you choose.",
      },
      {
        title: "Copy a project to another machine",
        summary:
          "Send a project to another machine with its unpushed commits and changes, pick machines and folders when you add a project, and see every machine in the project selector.",
      },
      {
        title: "A softer look",
        summary:
          "Rounded corners throughout, solid dialog buttons, a translucent Mac window without dark flashes, and drafts that wait in the Inbox until you finish them.",
      },
    ],
  },
  {
    version: "0.1.37",
    date: "November 1, 2026",
    dateTime: "2026-11-01",
    summary:
      "Chat tabs, VS Code themes, agents that watch and wait for you, updates that install themselves, and a markedly faster app.",
    releaseUrl: `${RELEASE_BASE}/v0.1.37`,
    highlights: [
      {
        title: "Tabs, forks and other machines",
        summary:
          "Open chats stay as tabs in the chat header. A side chat continues as its own forked thread (⌘⌥S), Fork from here can carry a conversation to another of your machines, and whole Codex and Claude Code projects import in one go.",
      },
      {
        title: "Agents that watch, wait and ask",
        summary:
          "Agents can watch a command and wake only when its output changes, link the pull requests they open to their chat, move into a new worktree and carry on, and ask for an API key through a private card that writes it to your .env, never into the chat. You can message a running Claude subagent without stopping it, and cap how deep agents delegate.",
      },
      {
        title: "Review against any branch",
        summary:
          "The diff panel compares your working tree with any branch, jumps between hunks and browses changed files as a tree. The Create PR dialog takes your own title and description, opens drafts and commits local changes first.",
      },
      {
        title: "Make it yours",
        summary:
          "Import VS Code color themes with contrast repair and light/dark pairing, pick dark mode's palette on its own, make text and borders stronger or softer, and export your preferences to set up another machine.",
      },
      {
        title: "Updates that look after themselves",
        summary:
          "With automatic updates on, the desktop app downloads updates and installs them when you quit, and CLI nodes and provider CLIs update while nobody is using them; ryco update does the same from a terminal. Ryco Nightly is now its own app, with its own data and update channel.",
      },
      {
        title: "Faster everywhere",
        summary:
          "Code highlighting runs on a WebAssembly highlighter about ten times faster than before, long streaming answers update in about a millisecond, live streaming to remote clients uses roughly half the traffic, and pull request badges spend about 78% fewer GitHub API points.",
      },
    ],
  },
  {
    version: "0.1.36",
    date: "October 30, 2026",
    dateTime: "2026-10-30",
    summary:
      "One-click updates for every machine, pull requests you can ship and watch from anywhere, a follow-up queue that lives on the node, and goals agents keep working toward.",
    releaseUrl: `${RELEASE_BASE}/v0.1.36`,
    highlights: [
      {
        title: "Update everything in one click",
        summary:
          "Update every machine, its provider CLIs and the app itself from one button, on desktop or phone, and leave out any update you want to skip. A node update that fails to start rolls back on its own, database included.",
      },
      {
        title: "Ship, watch and fix pull requests",
        summary:
          "Ship commits, pushes and opens the pull request in one click from the Crown. Agents watch a pull request instead of polling and wake when a check fails or someone reviews, Auto-fix CI turns failures into fixes, and every pull request that needs you, across repositories and machines, sits on one page.",
      },
      {
        title: "A queue and goals on the node",
        summary:
          "Messages you send to a busy chat queue on the node and go out in order, even with every window closed. Give a thread a goal and it keeps working after each clean turn until the agent marks it done or blocked. Schedules can run on weekdays at a set time, or feed an existing chat as a heartbeat.",
      },
      {
        title: "Keyboard first",
        summary:
          "Open any file with ⌘P, search contents with ⇧⌘F, go back and forward with ⌘[ and ⌘], close and reopen tabs with ⌘W and ⇧⌘T, jump to the next thread that needs you, and settle or snooze many inbox threads at once with one Undo.",
      },
      {
        title: "Write, quote and undo",
        summary:
          "Large pastes fold into attachments, ↑ recalls earlier prompts, assistant text can be quoted back as a chip with your comment, and macOS app windows drop straight into the composer. Edit an earlier prompt and keep the agent's file changes, or undo a turn's changes with a rescue snapshot taken first.",
      },
      {
        title: "Providers, usage and alerts",
        summary:
          "Sign in to Codex, Claude, Cursor, Grok and OpenCode from Settings, run OpenCode 2, and compact Claude and Codex conversations on request. Statistics gains a Today recap and cost by token type, and Ryco alerts you with toasts, notifications, sound and a badge when any connected thread finishes or needs you.",
      },
      {
        title: "A sturdier node",
        summary:
          "Ryco keeps the machine awake while agents work, runs them at a lower CPU priority, backs up the database before every migration and adds ryco db backup, ryco db restore and ryco doctor. Git actions keep running through dropped connections and pick up again after reconnecting.",
      },
    ],
  },
  {
    version: "0.1.35",
    date: "October 21, 2026",
    dateTime: "2026-10-21",
    summary: "A calmer Hub inbox that follows each machine's own settled state.",
    releaseUrl: `${RELEASE_BASE}/v0.1.35`,
    highlights: [
      {
        title: "Old errors stop topping the inbox",
        summary:
          "The Hub takes the settled state from your machines, so a thread that failed earlier and was dealt with no longer floats to the top of the inbox.",
      },
    ],
  },
  {
    version: "0.1.34",
    date: "October 20, 2026",
    dateTime: "2026-10-20",
    summary: "Machines report their Ryco version when they connect to the Hub.",
    releaseUrl: `${RELEASE_BASE}/v0.1.34`,
    highlights: [
      {
        title: "Know what each machine runs",
        summary:
          "A node reports its version when it connects to the Hub, so the apps can tell which machines are behind.",
      },
    ],
  },
  {
    version: "0.1.33",
    date: "October 20, 2026",
    dateTime: "2026-10-20",
    summary:
      "Tasks inside Ryco, a translucent Mac window, thread artifacts, and instant switching between your machines.",
    releaseUrl: `${RELEASE_BASE}/v0.1.33`,
    highlights: [
      {
        title: "Tasks, built in",
        summary:
          "A Tasks workspace keeps your to-do list next to your chats. Start a chat from a task and it stays linked to it.",
      },
      {
        title: "Switch machines instantly",
        summary:
          "Ryco keeps recent machines warm, so moving between them through the Hub is instant and project icons stay in place.",
      },
      {
        title: "A translucent window on macOS",
        summary: "The desktop app can let your wallpaper through, with adjustable translucency.",
      },
      {
        title: "Mentions, artifacts and terminals",
        summary:
          "Drag a thread into the composer to mention it, find a thread's pages and files in its own Artifacts tab, and see terminal counts and running status across thread views.",
      },
      {
        title: "Git text your way",
        summary:
          "Give Ryco your own instructions for generated commit messages and pull request text. Idle temporary chat folders clean themselves up.",
      },
    ],
  },
  {
    version: "0.1.32",
    date: "October 16, 2026",
    dateTime: "2026-10-16",
    summary:
      "Fork any chat, edit queued messages, follow worktree setup live, and open, reconnect and boot noticeably faster.",
    releaseUrl: `${RELEASE_BASE}/v0.1.32`,
    highlights: [
      {
        title: "Fork a chat",
        summary:
          "Branch any conversation into a new thread and take it in another direction, on desktop, web and mobile.",
      },
      {
        title: "Edit what's queued",
        summary:
          "Queued messages can be edited before they send, and background subagents fold into one work-log row, grouped by the batch that spawned them.",
      },
      {
        title: "Worktrees that tell you more",
        summary:
          "Watch worktree setup progress live, switch a new thread to a worktree in one click, see each checkout's disk usage, and link several pull requests to one workspace.",
      },
      {
        title: "Usage through CLIProxyAPI",
        summary:
          "Accounts routed through a CLIProxyAPI hub show their usage in Ryco like any other provider.",
      },
      {
        title: "Faster to open",
        summary:
          "Cold boot, first page opens and reconnects are quicker, and archived threads travel as slim stubs instead of full records.",
      },
      {
        title: "Stronger Hub sessions",
        summary:
          "Relay tickets are now minted by the Hub over your account connection, relay responses are compressed inside the encrypted payload, and credentials never reach the client's copy of the server settings.",
      },
    ],
  },
  {
    version: "0.1.31",
    date: "October 10, 2026",
    dateTime: "2026-10-10",
    summary:
      "Live work chapters, a pull requests page, settings as their own page, chats without a project, and new speed and context options for Codex and Claude.",
    releaseUrl: `${RELEASE_BASE}/v0.1.31`,
    highlights: [
      {
        title: "Watch the work as it happens",
        summary:
          "A running turn reads as live chapters with a reasoning timeline, and the inbox uses compact rows with status glyphs and motion.",
      },
      {
        title: "Pull requests, front and centre",
        summary:
          "A dedicated pull requests page and a workspace pull request tab, image previews in pull requests and diffs, and inline HTML previews on mobile and web.",
      },
      {
        title: "The Crown and a new settings page",
        summary:
          "The overview rail shows the project's logo, clickable CI checks, workflow cards, git actions and per-worktree Notes. Settings moved to a dedicated page, with morphing dialogs throughout.",
      },
      {
        title: "Projects, workspaces and chats",
        summary:
          "A projects map, safe workspace deletion and an Automations dialog that tells you about missed runs. Chats can start without a project and be promoted into one later.",
      },
      {
        title: "Speed and context options",
        summary:
          "Codex gains an Ultrafast speed tier; Claude Opus 5.5 gains fast mode and a 1M context window, now the default. The composer tunes models in place and the context meter shows Claude's prompt cache. Model comparison launches were retired.",
      },
      {
        title: "Cloud that heals itself",
        summary:
          "Cloud connections recover on their own, hosted browser sessions persist across devices, device trust gaps are closed, and thread history in Cloud is opt-in. Standalone MCP clients can use Agent Control with approval-gated thread and workspace actions.",
      },
    ],
  },
  {
    version: "0.1.30",
    date: "October 1, 2026",
    dateTime: "2026-10-01",
    summary:
      "Set a machine up for your other devices with ryco setup, keep it running as a background service, and resume streams after a reconnect.",
    releaseUrl: `${RELEASE_BASE}/v0.1.30`,
    highlights: [
      {
        title: "ryco setup and a background service",
        summary:
          "An interactive guide sets up the background service, your Ryco account, Tailscale and pairing. The service starts at login and restarts if it stops.",
      },
      {
        title: "Reconnects that resume",
        summary:
          "Remote machines reconnect more resiliently, and streaming replies resume where they left off instead of starting over.",
      },
    ],
  },
  {
    version: "0.1.29",
    date: "September 30, 2026",
    dateTime: "2026-09-30",
    summary: "A fix release for draft authorization and desktop diagnostics.",
    releaseUrl: `${RELEASE_BASE}/v0.1.29`,
    highlights: [
      {
        title: "Tighter drafts, working diagnostics",
        summary: "Draft requests are authorized more strictly, and desktop diagnostics work again.",
      },
    ],
  },
  {
    version: "0.1.28",
    date: "September 30, 2026",
    dateTime: "2026-09-30",
    summary:
      "Compare models side by side, keep worktrees tidy, and undo sidebar actions, with beta computer use and steadier long-running sessions.",
    releaseUrl: `${RELEASE_BASE}/v0.1.28`,
    highlights: [
      {
        title: "Compare models on the same prompt",
        summary:
          "Send one prompt to two to four models at once. Each runs in its own thread, branch, and worktree, so you can review the results side by side and keep the best one.",
      },
      {
        title: "Worktrees and project settings under control",
        summary:
          "See what worktrees use on disk, preview cleanup before anything is removed, and opt into retention rules. Submodule setup is configurable, and projects can set default models, environments, and branch prefixes for new threads.",
      },
      {
        title: "Undo, snippets, and imported history",
        summary:
          "Archive, settle, snooze, and unpin offer a five-second Undo. Completed shell code blocks can be pasted into a fresh terminal pane without running them, and existing Codex and Claude histories can be imported into Ryco.",
      },
      {
        title: "Beta computer use and optional questions",
        summary:
          "Agents can use your desktop in a beta with approvals and safety controls. Codex can ask non-blocking questions while it keeps working, and the in-app browser allows one-time sign-in popups.",
      },
      {
        title: "A calmer inbox and timeline",
        summary:
          "Inbox order stays put while turns stream, with a Pinned section and live pull request badges and stacks. Tool runs collapse into one summary row, Agent Control activity stays with its thread, and provider notices sit dismissibly above the composer.",
      },
      {
        title: "Steadier sessions and model choices",
        summary:
          "Long Codex threads resume without reloading their entire history, streaming replies are stored incrementally, and failed uploads retry after reconnecting. Claude Opus 5.5 and Sonnet 5.5 are available, favorites remember reasoning effort, and usage history covers OpenCode and Cursor.",
      },
    ],
  },
  {
    version: "0.1.27",
    date: "September 16, 2026",
    dateTime: "2026-09-16",
    summary:
      "Review code across revisions, work in multiple chats, and manage project automations with a more capable desktop workspace.",
    releaseUrl: `${RELEASE_BASE}/v0.1.27`,
    highlights: [
      {
        title: "Review the changes that matter",
        summary:
          "Compare your branch or a commit with HEAD, inspect line blame at the right revision, and navigate files without losing your place. Staged and unstaged changes get separate views with guarded staging actions.",
      },
      {
        title: "Keep several conversations in view",
        summary:
          "Split the workspace into up to four thread panes, send selected assistant text to a current, side, or new chat, and export a complete thread as Markdown. Completed messages can display bounded Mermaid diagrams.",
      },
      {
        title: "Plan and review scheduled work",
        summary:
          "Project settings gain an automation centre for schedules and recent runs. Each due run still requires its own approval, and governed workspace tools keep agent-initiated lifecycle actions under review.",
      },
      {
        title: "A smoother path from setup to editing",
        summary:
          "First-run local setup walks through providers and projects, while editor autosave protects against conflicting changes. Pending questions and approvals recover more predictably after interruptions.",
      },
      {
        title: "Clearer device and desktop control",
        summary:
          "The simulator panel gains a dedicated device frame, and macOS computer-use capture keeps its live sharing stream resilient and visible while an agent works.",
      },
    ],
  },
  {
    version: "0.1.26",
    date: "September 14, 2026",
    dateTime: "2026-09-14",
    summary:
      "Work with attachments, side questions, simulators, and more provider workflows without losing track of the main task.",
    releaseUrl: `${RELEASE_BASE}/v0.1.26`,
    highlights: [
      {
        title: "Preview more files in chat",
        summary:
          "PDF and text attachments open inside the app, and queued send retries preserve drafts and attachments. Streaming Markdown also reuses completed content to keep long answers responsive.",
      },
      {
        title: "Ask a quick side question",
        summary:
          "An isolated, read-only Side chat and /btw let you ask without derailing the current task. Approval history stays scoped to the active thread.",
      },
      {
        title: "Test on more devices",
        summary:
          "Simulator controls cover iOS and Android, including multiple simulator hosts over SSH, with lifecycle safeguards for device testing.",
      },
      {
        title: "More providers and review context",
        summary:
          "Verified ACP Registry providers can be added, OpenCode Task subagents show their lifecycles, and GitHub review remembers which files you have viewed.",
      },
      {
        title: "Worktrees and sessions stay dependable",
        summary:
          "Set a worktree branch prefix, keep Codex child cancellation predictable, and find project paths and settings directly from thread menus.",
      },
    ],
  },
  {
    version: "0.1.25",
    date: "September 11, 2026",
    dateTime: "2026-09-11",
    summary:
      "Desktop startup gets faster, local projects return reliably, and device customization and hosted Inbox preferences stay consistent.",
    releaseUrl: `${RELEASE_BASE}/v0.1.25`,
    highlights: [
      {
        title: "Get back to your local projects",
        summary:
          "Startup restores access to existing local projects and preserves device preferences. The desktop app stays responsive and requests system permissions when you use the related feature.",
      },
      {
        title: "Recognize every device",
        summary:
          "Device names stay consistent between settings and execution targets, and customizable icons help you recognize your devices across desktop, web, and mobile.",
      },
      {
        title: "A more dependable hosted Inbox",
        summary:
          "Project artwork, snooze, and auto-settle work again on hosted nodes, with Inbox preferences retained after reloads. Centered device icons and larger project names make rows easier to scan.",
      },
    ],
  },
  {
    version: "0.1.24",
    date: "September 11, 2026",
    dateTime: "2026-09-11",
    summary:
      "Cloud sign-in takes fewer steps, settings make their scope clearer, and mobile and desktop connections recover more reliably.",
    releaseUrl: `${RELEASE_BASE}/v0.1.24`,
    highlights: [
      {
        title: "Simpler Cloud sign-in",
        summary:
          "GitHub sign-in restores saved accounts, uses the default Cloud address, and enrolls desktop nodes automatically. Devices select supported encryption and credential storage without manual setup.",
      },
      {
        title: "Know which settings you are changing",
        summary:
          "This app and This browser preferences are separate from named-node settings. Appearance stays local, node configuration follows the selected node and its permissions, and advanced security controls live under Connections.",
      },
      {
        title: "Reconnect and resume with confidence",
        summary:
          "Mobile and desktop connections recover after network interruptions and node or Hub restarts. Editing becomes available again after fresh authorization and synchronization.",
      },
      {
        title: "More responsive desktop nodes",
        summary:
          "Slow project-icon reads no longer block core node services, and quitting the desktop app waits for its backend to stop. Local Mac development launchers also help Keychain retain access decisions across rebuilds.",
      },
      {
        title: "Safer diagnostic exports",
        summary:
          "Sensitive authentication headers are redacted before HTTP traces are exported, keeping credentials out of shared diagnostics.",
      },
    ],
  },
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
