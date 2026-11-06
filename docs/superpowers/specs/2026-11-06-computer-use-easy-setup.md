# Computer Use: setup and approval as easy as Codex (phase 3)

Status: implemented on `computer-use/3-easy-setup` (stacked on phase 1, restacked onto phase 2).

## Decisions (user, final)

- Required macOS permissions: Accessibility and Screen Recording. Input Monitoring is optional
  and only enables the physical Escape stop. Stop in chat and in the menu bar always work.
- One Turn on button. Computer Use is then available in every chat.
- Per-app approval like Codex.
- Phase 4 adds a signed `Ryco Computer Use.app` helper; the permission target must be one
  swappable value.

## Setup

- Settings → Computer Use shows **Turn on Computer Use** until it is on. The button:
  1. turns on Agent Control on this Mac when it is off (one line under the button says so),
  2. sets the `defaultEnabled` preference (now read as "use in every chat"),
  3. starts the existing guided setup (GrantCoach, deep links, auto-detection) for the missing
     required permissions only, in the order Accessibility → Screen Recording.
- Each permission row has a live status badge and a **Fix** link that opens setup for that one
  pane. Input Monitoring is a separate optional row, **Stop with Escape**.
- Turning Computer Use off clears `defaultEnabled` only. Agent Control stays as it is.
- Stale grants: after all required grants were seen once, the desktop records the build
  (`version` + executable mtime). If a later check finds a required grant missing on a
  different build, settings shows "macOS may still list an older Ryco. Remove Ryco with −, add
  it again, then quit and reopen." with Open System Settings and **Quit & Reopen** (the existing
  `restartApp` IPC).
- The bundle that receives TCC grants comes from one function,
  `resolveComputerUsePermissionTarget()` (`apps/desktop/src/computerUse/permissionTarget.ts`).
  Today it returns the running Ryco app; phase 4 returns the helper app instead.

## Every chat by default

- With Computer Use on, a send from the local desktop environment prepares a `chat` intent
  without `/computer-use`. `/computer-use <task>` keeps working as an explicit `request`, also
  when Computer Use is off.
- An implicit (default) send never blocks the message: unsupported provider, external OpenCode,
  Agent Control off or missing permissions send the message without Computer Use. Missing setup
  shows one toast per session pointing to Settings. Explicit `/computer-use` keeps today's
  blocking errors.
- The desktop's `prepare` decides about permissions, after refreshing them. The renderer never
  gates a send on the cached `getState`: its permissions read as unknown until a first check, so
  the first chat after a desktop start went without Computer tools
  (`resolveComputerSendIntent`).
- The global switch is **Use in every chat**. Generations and Stop semantics in `beta.ts` are
  unchanged: changing the switch invalidates queued work.

## Per-app approval

- Authority stays on the server in `ComputerApprovalGate`. The desktop only shows dialogs and
  manages the list in settings.
- Before a mutating Computer action, the tool layer names its target windows, pids and apps. The
  server resolves them to app names (cached window listing, running apps). Denylisted apps
  (password managers, System Settings, security agents) are refused without a dialog; Ryco itself
  stays excluded by the driver.
- `ComputerApprovalGate.requestApp` decides in this order: always allowed → allowed for this
  chat → denied in this turn → ask. Concurrent calls for the same chat and app share one dialog.
- Browser tools name the real browser: a bound target remembers the process it was bound
  from, and Chrome, Brave and Edge use one canonical identity
  (`@ryco/shared/computerBrowserIdentity`) shared with legacy app denial. Launching the
  driver's isolated browser asks nothing; its first action asks for it by name.
- Dialog: "Allow Ryco to use Safari?" with **Always allow**, **Allow for this chat**,
  **Don't allow**. Don't allow refuses that app for the rest of the turn. A target that cannot be
  named asks "Allow Ryco to use your Mac in this chat?" without Always allow.
- Always-allowed apps are stored next to the audit log in `computer-app-approvals.json`
  (`@ryco/shared/computerAppApprovals`). Only the server adds entries, and only from a dialog
  answer that came back over the authenticated bridge. Settings lists them and can remove them.
- Lock, sleep and session switches clear chat approvals (always-allowed apps stay). Stop ends the
  turn's denials and open dialogs.
- Clipboard reads/writes keep their own per-call dialog. Foreground takeover still needs the
  explicit visible-use request. Full-access turns skip routine approval as before.
- Unanswered dialogs keep today's lifetimes: five minutes once shown, 30 s per bridge request
  (the agent calls again to keep waiting), one re-ask after an expiry, two retries when no dialog
  could be shown. An answer that lands after its request stopped waiting is kept for the next
  request for that app.
- Remote, hosted and mobile clients still cannot start local desktop control: intents come only
  from the desktop's `prepare`, and the bridge is loopback with a private credential.

## Optional Input Monitoring

- `prepare()` requires Accessibility and Screen Recording only.
- With Input Monitoring granted, the Escape listener is required and behaves as today.
- Without it, the desktop does not start the listener, reports the listener as ready to the
  driver host and omits the Input Monitoring grant from permission checks, so the server does not
  list it as missing. Escape is then unavailable; settings says so.
- Foreground takeover still requires Input Monitoring (user decision). The desktop reports the
  grant and listener state with `state`; the server's foreground authorization
  (`computerForegroundEscapeStopBlock`) refuses with `foreground_needs_input_monitoring` when
  the grant is missing, unknown or the listener failed, in every foreground gate.

## Out of scope

Driver host operation queue, leases/lanes and the preview frame tap (phase 2), and the helper
app itself (phase 4).
