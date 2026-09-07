# Computer and browser use

## Authorized outcome

The user requested a complete, opt-in desktop automation experience, including an independent visible agent cursor, background app navigation, Chrome and Brave selection, per-app denial, native permission setup, and provider integration. Implementation order and use of existing open-source automation components are authorized.

## Architecture

Ryco Desktop owns the machine controller, native helper, browser transports, local permissions, and visual overlays. The existing Agent Control session registry owns provider identity, exact active-turn authority, revocation, and in-flight cancellation. Computer tools are added to that private MCP listener, not to globally shared provider configuration. A loopback desktop bridge receives a secret through the existing backend bootstrap file descriptor; it is not exposed in renderer state or inherited agent environment variables.

The first native backend uses the Apache-2.0 Poracode helper, vendored at a recorded commit with its license and reproducible build. Ryco wraps it with its own policy, validates actual target identity before every operation, and does not expose arbitrary helper commands to agents. Platform capabilities and refusals remain explicit. Background requests never silently become foreground input. Locked desktops are not automatically unlocked.

Browser automation uses a shared bounded CDP interface for an isolated Electron browser and an opt-in Chromium extension for Chrome/Brave. External browser profiles require an explicit pairing. The model receives tabs, accessibility/DOM observations, screenshots, and bounded interaction tools. Raw CDP and arbitrary JavaScript evaluation are not public tools. Navigation invalidates element references. Observations and screenshots are bounded. Agent cursors and click rings are visual state driven by actual target actions and excluded from observations.

## Permissions and lifecycle

Computer use defaults off. Each app has ask/allow/block policy; browser enablement is separate and cannot override a blocked desktop app. OS Screen Recording/Accessibility permissions are requested only through user setup. Native dialogs resolve first-app requests. Explicit foreground takeover has separate consent. The agent cannot modify these policies or approve system permission dialogs.

Only trusted first-party renderer IPC may change local permissions. Turning off, blocking a target, stopping, session cancellation, disconnect, and shutdown abort pending work. Queued commands revalidate generation and policy immediately before execution. A cancelled turn cannot reacquire control. Target ownership prevents concurrent turns from operating the same window/tab. Remote hosted lifecycle and mutation-readiness remain authoritative; remote nodes never implicitly gain control of the viewer's desktop.

## Experience

Settings expose enablement, OS permission status, app discovery and access decisions, browser pairing/selection, foreground permission, and stop. The automation browser can run hidden or be shown. The desktop displays an independent cursor at the target point, an app activity badge, and a prominent takeover state; ⌘/Ctrl + Shift + Escape is an emergency stop. Preview and settings report real connection and permission state rather than optimistic readiness.

## Implementation stages

1. Shared schema, tested controller policy/lifecycle, native helper custody and build.
2. Browser transport, external extension, native driver, cursor/activity overlays.
3. Desktop IPC/settings and private server MCP integration with active-turn checks.
4. Tests for permission denial/revocation, stale work, target identity, disconnections, cursor behavior and browser navigation; local native/browser smoke checks; required repository, browser and desktop backstops.

## Review constraints

No credentials, captures, page text, typed values, or private operational details belong in logs or repository evidence. Native permissions may require a manual OS interaction; record actual tested capabilities and unresolved limitations. Do not claim cross-platform runtime validation from compilation alone.
