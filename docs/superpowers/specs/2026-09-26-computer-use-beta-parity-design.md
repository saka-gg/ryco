# Computer Use beta parity with Synara

Status: implemented and validated with automated tests and native builds. Live
macOS permission, input, and capture qualification remains outstanding.

## Requested result

Bring Synara's released Computer Use beta functionality, interaction mechanics,
and preview into Ryco. Match Synara 0.9.1, including the feature introduced in
0.9.0, using Ryco's branding, component system, provider identities, and runtime
boundaries. This is a full feature port, including its native runtime behavior.

The reference is the public `v0.9.1` release, resolved to commit
`eaa61eded31b6755d4f30ba8eabc5d905cf817cb`. Unreleased default-branch changes and
historical qualification reports are not acceptance evidence for Ryco.

Reference sources:

- [0.9.0 release notes](https://www.trysynara.com/changelog/v0.9.0)
- [0.9.1 release notes](https://www.trysynara.com/changelog/v0.9.1)
- [Released source](https://github.com/Emanuele-web04/synara/tree/eaa61eded31b6755d4f30ba8eabc5d905cf817cb)
- [Current feature documentation at that release](https://github.com/Emanuele-web04/synara/blob/eaa61eded31b6755d4f30ba8eabc5d905cf817cb/apps/marketing/content/docs/features/computer-use.mdx)
- [Runtime and lifecycle specification](https://github.com/Emanuele-web04/synara/blob/eaa61eded31b6755d4f30ba8eabc5d905cf817cb/docs/computer-use-cua/README.md)
- [Preview behavior](https://github.com/Emanuele-web04/synara/blob/eaa61eded31b6755d4f30ba8eabc5d905cf817cb/docs/computer-use-cua/native-preview.md)

## Audit of Ryco

Ryco already has an authenticated loopback desktop bridge, native control through
a vendored Poracode helper, background browser control, per-app consent, target
leases, a cursor overlay, and an emergency shortcut. Its implementation includes
meaningful refusal, target-identity, cancellation, and browser-isolation checks.
These remain useful compatibility and regression requirements.

| Surface         | Current Ryco                                                                           | Required delta                                                                                                                       |
| --------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Invocation      | Computer tools are installed through Private Agent Control and gated by desktop policy | Explicit `/computer-use` request plus a separate default-on preference; durable per-turn intent and conditional tool exposure        |
| Native runtime  | Poracode helper, protocol 3                                                            | Pinned Cua 0.28.2 plus Synara native revision 39, adapted behind a Ryco-owned host                                                   |
| Permissions     | Accessibility and Screen Recording checks and settings links                           | Guided Accessibility → Input Monitoring → Screen Recording setup for the exact running app, with independent listener-health checks  |
| Approval        | Native per-app dialogs and foreground opt-in                                           | Shared task approval in approval-required mode, separate clipboard/risk review, and explicit foreground intent                       |
| Cancellation    | Global stop and revocation of observed turns                                           | Task-specific Stop, physical Escape interruption, drained-input acknowledgement, fresh-observation recovery, and lock/sleep handling |
| Preview         | OS sharing preview, cursor and tray indicator                                          | In-chat target-window/tab preview, native frames plus bounded still fallback, drag/expand/hide, and task-owned lifetime              |
| Native actions  | Observe, click, type, keys, scroll, drag, AX search/value/action, launch/activate      | Text selection, menus, window controls, clipboard routes, bounded batches, inspection/help, and effect reporting                     |
| Browser actions | Embedded Ryco browser and paired Chrome/Brave/Edge profiles                            | Separate driver-owned isolated browser route with dialogs, uploads/downloads, exact tab binding, and recovery gates                  |
| Activity        | Current target/action in desktop state                                                 | Human-readable transcript actions, setup/denial notices, effect distinctions, and bounded recent-action history                      |
| Providers       | Audited injection for Codex, Claude, Cursor, Copilot                                   | Per-turn activation for these adapters; isolated managed OpenCode integration and explicit unavailability for unsupported runtimes   |

Important code boundaries inspected:

- `apps/desktop/src/computerUse/{runtime,policy,native,helper,browser,permissions,ipc,overlay}.ts`
- `apps/desktop/native/computer-use-helper/src/backend/macos/stream.rs`
- `apps/server/src/agentControl/Mcp/computerTools.ts`
- `apps/server/src/agentControl/ProviderInjection.ts`
- `packages/contracts/src/{computerUse,ipc}.ts`
- `apps/web/src/components/settings/ComputerUseSettings.tsx`

The existing macOS ScreenCaptureKit stream supplies the system sharing indicator;
its frame callback does not deliver frames to Ryco's renderer. It cannot become
the requested preview merely by adding an image component.

## Approaches and recommendation

1. **Port the released native stack behind Ryco's existing boundaries
   (recommended).** Reuse the pinned driver patch, target/effect semantics, and
   lifecycle logic; adapt consent, orchestration, transport, and presentation to
   Ryco. This has the largest integration and validation scope, but directly
   supports the requested mechanical parity.
2. Extend the current Poracode runtime. This preserves more existing code but
   requires independently implementing and qualifying the additional native
   capabilities and interruption protocol. It carries greater behavioral drift.
3. Add the visible preview and setup controls first. This is smaller, but only
   achieves presentation parity and would leave the requested runtime work open.

Proceed with option 1 as one overall feature, implemented in dependency order.
Intermediate milestones must not be described as complete parity.

## Architecture

### Native host and package boundaries

The Electron process owns the native driver, exact running-bundle identity,
physical-input listener, permission guide, preview helper, and lifecycle hooks.
The server owns task authorization, scheduling, observation identities, provider
tool exposure, and audit outcomes. The renderer presents state and explicit user
actions; it cannot assert permissions, fabricate target authority, or supply a
native executable/socket path.

Place shared wire schemas in `packages/contracts`; keep that package schema-only.
Put reusable pure invocation, frame, grant, and presentation helpers in explicit
`packages/shared` subpaths. Any client connection/state integration belongs in
`packages/client-runtime` and must remain free of DOM and React Native imports.
Keep Electron, Node transport, and native-process ownership in their app layers.

Port the driver-facing dependency closure deliberately. Synara's host and backend
import product-specific modules; copying their top-level files alone is not a
working integration. Adapt those seams instead of importing its whole application
or creating a second Ryco authorization system.

Preserve the native source pin, patch checksums, license notices, and reproducible
provisioning. The source reference pins Cua 0.28.2, source commit
`7fe7c33f741ee2dd5961ba80044d59f93b48ba47`, native revision 39, and Rust 1.97.1.
Verify those artifacts during build/staging and verify the expected runtime
protocol/capabilities at startup. Do not silently accept an unpatched driver.

### Invocation and provider lifecycle

Recognize `/computer-use` only in the opening command of the current human-authored
request. Persist its intent with queued and dispatched turn metadata. Preserve
the command in the user's transcript and remove it from provider prompt text.
Quoted commands, attachments, imported messages, agent messages, and app names do
not enable control. An empty command remains editable.

Expose Computer tools and concise guidance only for an invoked task or an explicit
default-on setting. Changing capability during an active turn must use the
provider's supported turn/session transition, with old work fenced. A later
ordinary request does not inherit one-shot authorization.

Before sending a local invocation, check actual permissions. Missing setup opens
the guide and preserves the unsent composer contents. Finishing setup never sends
the task. Unsupported providers and remote environments receive an actionable
availability explanation before dispatch.

Adapt all currently supported Ryco injection paths. For managed OpenCode, establish
a thread-isolated MCP connection and verify readiness before advertising tools.
Do not put credentials into directory-wide configuration shared by threads.
External OpenCode servers and runtimes without a safe per-session connection stay
explicitly unavailable; they must never appear enabled with missing tools.

### Consent, concurrency, and interruption

Use one approval rendezvous for routine Computer actions in an active task when
Ryco's selected approval mode requires review. Concurrent first calls share the
same pending request. Declines, Stop, session exit, and terminal turn events fence
pending and queued calls. Clipboard reads retain a separate review rule.

Foreground access additionally requires explicit human intent to show/activate
the target. Full access and an application name alone do not provide it. Carry
that intent through routine human continuations, ending it at new-task,
background, stop, imported-message, and automation boundaries.

Serialize native input transactions. Preserve exact process/window ownership for
background operations; use exclusive ownership for foreground, clipboard, and
drag operations. Stopping an idle or queued task must not revoke unrelated tasks.
Dispatched native input must drain before new input can resume.

Physical Escape interrupts the current action without disabling future tasks.
Recovery requires a fresh model observation of the same task and target after
the acknowledged cancellation epoch. A preview, discovery call, permission check,
or another task's observation cannot satisfy recovery. Native and browser routes
have separate observation gates. Missing cleanup acknowledgement leaves input
paused. Never replay a possibly dispatched mutation automatically.

Background work tolerates ordinary human typing and app switches. Physical input
interrupts an active foreground action. Lock, sleep, and inactive desktop sessions
pause input; resumption requires fresh observation and renewed task consent where
the selected approval mode requires it. Permission/listener loss also closes
input admission.

### Native and browser capabilities

Port the released advertised catalog and its specialist routes: bounded state
and screenshots, window/app discovery, exact-element interaction, text selection,
keyboard/pointer operations, menus, app launch/activation/visibility/termination,
window resize/minimize, clipboard, zoom, verification, Space inspection, and help.
Batch execution validates up to 25 known native steps before dispatch and stops
on failure by default. Retain the reference's restrictions on raw driver,
recording, session, and configuration operations.

Actions distinguish not dispatched, dispatched with unconfirmed effect, verified
effect, refusal, and failure. A changed tree or successful input delivery is not
proof of task success. Repeated refusals and uncertain action loops terminate
without implicit foreground escalation.

Add the driver-owned isolated browser route with exact tab identity, navigation,
state, pointer/field/key operations, dialogs, upload, and completed-download
receipts. Preserve workspace file-access rules. Personal browser cookies are not
inherited. Keep Ryco's existing project browser and explicitly paired profiles as
separate supported surfaces; they do not silently become the Cua profile.

### Guided setup and settings

Provide one desktop-owned guide for Accessibility, Input Monitoring, and Screen
Recording, in that order. Skip confirmed grants. Show the exact running app copy,
support app-chip drag where accepted by macOS, and offer Show in Finder. Check
bundle resolution before requesting grants and explain wrong-copy/stale-grant
recovery. Passive checks do not register apps or mutate permissions.

Use fresh bounded helper checks, advancing while System Settings is foreground.
Monitor only during an explicit setup attempt; end on success, dismissal,
shutdown, or timeout. Native listener health is independent of its permission
badge. Never automate granting permissions or treat a listed app as a grant.

Settings include a dismissible/reopenable getting-started guide, default Computer
activation, setup/status, cursor presentation, automatic preview, preview size,
and recent action history. History loads on demand, is bounded, and omits typed
values, clipboard contents, arguments, target titles, and filesystem paths.

### Preview and activity presentation

The owning visible chat gets a compact view-only target preview. It can float,
drag, expand, and dock; clamp it when the viewport changes. Show the targeted app
window or browser tab and a human-readable current action. Use Ryco typography,
icons, colors, and existing motion/accessibility conventions.

Prefer window-scoped native frames bounded to 960 pixels and 15 fps with one
encode in flight; drop frames rather than queue them. Use bounded target stills
when native frames are unavailable, at the reference's default one-second cadence.
Retain the last decoded frame during brief gaps on the same target. Clear it on
target or task replacement. Never fall back to whole-desktop capture.

Track armed, live, hidden-for-task, and ended phases. Close hides the preview for
that task; chat Stop ends the task. Only visible live presentations subscribe.
Completion, target replacement, helper death, shutdown, and navigation each clean
up their owned resources. Explicit first-frame failure must be visible; a hidden
preview must not reopen on a late error.

Preview frames remain transient local feedback, separate from explicit tool
screenshots delivered to the model. They are not attachments, transcript entries,
or automatic model context. They cannot authorize or verify an input operation.

Render native/browser tool activity with contextual labels and setup/denial
cards. Do not display typed text or clipboard contents in those summaries.

## Compatibility and rollout

Released Computer Use parity targets macOS desktop. Do not advertise the reference's
experimental Linux paths as released support. Preserve unrelated Ryco Windows,
Linux, project-browser, and paired-browser functionality while gating the new
native backend accurately.

Preserve existing explicit app denials during migration. Old remembered app
allows do not stand in for new task consent. Keep the user's existing opt-in
choice, but require current permission/listener checks and a new authorized task
before the new driver can mutate anything. Old queued turns cannot inherit the
new runtime generation. Retire obsolete native paths only after their callers
and regression coverage have migrated.

Hosted browsers and mobile clients do not gain access to the local Mac merely
through UI state or a reconnect. Preserve hosted lifecycle ownership, relay
authorization, and the frozen web phone tier. No native input implementation is
added to mobile or shared client code.

## Implementation order

1. Add licensed driver provenance, reproducible provisioning, protocol validation,
   native host ownership, and cancellation/lifecycle tests.
2. Adapt the native backend, exact-target/effect rules, isolated browser route,
   permission service, and guide.
3. Integrate task invocation, durable metadata, catalog exposure, approval,
   provider readiness, and task-scoped stop through existing orchestration.
4. Add preview transport and ownership, chat presentation/action cards, settings,
   and bounded history; migrate existing settings and tool compatibility.
5. Run cross-package validation and real disposable native/browser fixtures,
   correct failures, then update user documentation and the parity matrix with
   actual Ryco results and remaining platform/provider qualification limits.

## Acceptance and validation

Use Bun 1.4.0 and `bun install --frozen-lockfile`. During implementation, run
focused checks for each changed boundary. The completed port is cross-cutting
and high risk, so run the repository backstop required by AGENTS.md:

```sh
bun fmt
bun run fmt:check
bun lint
bun typecheck
bun run test
bun run build
bun run build --filter=@ryco/web
bun run --cwd apps/web test:browser:install
bun run --cwd apps/web test:browser
bun run build:desktop
```

Install the browser runtime only if absent. Run `bun run release:smoke` if the
implementation materially changes release workflows. Never use `bun test`.

Required focused cases include spoofed/quoted invocation, disabled-turn catalog,
queued-generation revocation, concurrent approval, stale approval responses,
exact target replacement, ambiguous refs, uncertain delivery, Stop isolation,
Escape drain/recovery, human foreground takeover, lock/sleep, grant/listener loss,
upload/download boundaries, preview source handoff, stale frame rejection,
hidden-task persistence, first-frame errors, and hidden-view subscription cleanup.

Browser tests exercise setup without auto-send, getting-started/settings controls,
action cards, preview dragging/expansion/docking, resizing, split chats, completion,
and the distinction between preview close and chat Stop.

Live qualification uses disposable native and browser fixtures and the exact
built app identity. Verify background input without pointer/focus takeover, fresh
screenshots, physical Escape, foreground takeover recovery, native permission
transitions, target-specific preview, and native process teardown. Report blocked
live checks separately from passing mocks; upstream reports never count as Ryco
test results. Do not alter personal app content or permission grants to fabricate
qualification.

## Design self-review

The feature target and source revision are fixed. The native runtime migration,
Ryco integration seams, separate browser surfaces, task consent, platform scope,
preview lifetime, and validation obligations are explicit. Implementation follows this approved design. Live native qualification must be reported separately from automated validation.
