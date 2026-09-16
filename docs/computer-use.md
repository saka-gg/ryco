# Desktop computer and browser use

Ryco desktop can give an agent permission to inspect and operate apps on the local computer. Native control uses a vendored Poracode helper; Ryco owns consent, turn authorization, cancellation, browser connections and the visible cursor. This does not embed or depend on the proprietary Codex or Claude desktop runtime.

## Enable it

1. Open **Settings → Integrations**, enable **Private Agent Control** for the local environment, then enable **Computer Use** on the same page. Configure browsers in its **Browser Use** subsection.
2. Permission badges refresh automatically on opening settings, returning to the app, and while the panel is visible. **Granted** is green, **Not granted** is red, and unverified states are neutral. You can also click **Check permissions**. On macOS, grant Accessibility and Screen Recording using the buttons and the system settings panes. Restart Ryco if macOS requests it. Development executables and installed/signed builds can have different permission identities.
3. Find an app and choose **Ask**, **Always allow**, or **Block**. Ask opens a native Ryco consent dialog on first use in each turn. Remembered rules remain editable even when an app is not running.
4. Enable the desired browsers. **Ryco Browser** uses a separate persistent profile. Chrome, Brave and Edge use the extension setup below.
5. Start a new provider session after enabling Agent Control. Ask the agent to use `ryco_computer` or `ryco_browser`, inspect the target, perform the task and verify the result.

Private tool injection supports the existing audited Agent Control integrations: Codex, Claude, Cursor and GitHub Copilot. OpenCode and Grok do not receive these tools through this integration. A hosted web page, mobile client or separately connected remote backend does not acquire control of the desktop implicitly.

## Existing browser profiles

Enable Chrome, Brave or Edge, then click **Pair**. **Open browser Extensions** opens the selected browser's extension manager. Choose **Show extension folder**, then **Copy folder path** to avoid searching through folders. Enable Developer mode and choose Load unpacked; on macOS use ⌘ + Shift + G in the folder chooser to paste the path. **Copy pairing configuration**, open **Ryco Browser Control** in the browser toolbar, and paste it there.

Canceling the browser’s debugging session (including taking over with DevTools) disconnects Ryco and disables automatic reconnection. Use the extension’s pairing flow to reconnect explicitly.

Pairing is scoped to that browser profile and replaces the previous connection for that browser. Pair again after restarting Ryco. The extension uses the browser's debugger API, so the browser may display its own debugger indicator. It works with the profile's existing sign-ins. Firefox and Safari are not supported by this extension.

Chrome's supported app-assisted install flow on macOS/Windows requires a published Web Store extension and user confirmation. Ryco's development extension is currently unpacked; this guide keeps Developer mode and installation under the user's control. See [Chrome distribution requirements](https://developer.chrome.com/docs/extensions/how-to/distribute/install-extensions).

Permission checks use a separate, fresh helper process and do not capture screenshots or interrupt active native input. App-discovery failures are reported separately. In development, the settings panel identifies the current app bundle so permissions can be granted to the correct build. An installed Ryco build and a development launcher may have separate macOS permissions.

## What the agent can do

| Native apps                                                    | Browsers                                                                          |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Discover installed/running apps and windows                    | List existing tabs or open an isolated/background tab                             |
| Capture one approved window and inspect its accessibility tree | Read a bounded page snapshot with element references and capture screenshots      |
| Click, double/right click, type, press keys, scroll and drag   | Click, hover, fill inputs, select options, type, press navigation keys and scroll |
| Find accessible controls, set their values and invoke actions  | Navigate, reload, go back/forward, show or close a tab                            |
| Launch apps; request explicit foreground activation            | Use the same browser controller for built-in and paired profiles                  |

Native actions display an independent animated cursor and a target badge. Browser actions display a cursor inside the page and a desktop activity badge. Background control does not move your physical pointer. Hidden/occluded targets can remain behind your work when the operating system and target app support it; show a browser tab to watch its page cursor.

The **Ryco Computer Use** menu-bar/tray indicator identifies the app and window or browser tab, labels the last action (including screen capture), and offers **Stop computer use**. The on-screen badge and cursor fade after eight seconds; the menu remains for up to one minute after the last action and disappears immediately on release or stop. On macOS, native window capture also opens a real ScreenCaptureKit stream: macOS 14 and newer show the purple sharing indicator with a live preview of the selected window and a stop control. Ending sharing in macOS stops all computer use and revokes the active turns; the agent cannot restart it within the stopped turn. Release, Ryco's stop shortcut, app shutdown, and one minute of inactivity end the native stream. Desktop and browser control share the same compact cursor.

**Stop all**, or **⌘/Ctrl + Shift + Escape** while enabled, cancels control. If another app owns that shortcut, use Stop all. Changing access also cancels current work. Stopped turns must be restarted. Concurrent turns cannot interleave actions in a claimed target; claims last 60 seconds after their last use or until the agent calls `release`.

For uninterrupted use, leave **Allow foreground takeover requests** off. Browser opens stay hidden/inactive by default; `show` and `visible:true` require the same explicit foreground permission as native activation. On macOS, background keyboard input uses the app's existing keyboard window and never sets `AXMain`, `AXFocused`, or raises the window. If a different window needs text, use `find_elements` + `set_element_value`; unsupported background input is refused. The macOS cursor overlay uses a non-activating panel.

Background support varies by app and operating system. Refused native operations remain refused; Ryco never silently switches to your physical mouse/keyboard. Foreground use requires enabling **Allow foreground takeover requests** and accepting a separate per-turn dialog. macOS Chromium/Electron native scroll and drag can be refused; use the browser connection for page interactions.

## Boundaries and current limits

- Both observation and input require a current provider turn and local opt-in. App denial is shared between canonical native Chrome/Brave/Edge identities and their extension routes. Ryco and macOS permission-management apps are excluded from native targets.
- Native window/process identity is rechecked before actions. Browser element references are scoped to the observed document and turn. Navigation invalidates them.
- Browser tools expose bounded actions, not arbitrary JavaScript or CDP commands. The built-in browser has no Ryco preload, denies downloads and site permissions, and does not launch external URL schemes. The current snapshot targets the main document and open shadow roots; iframe content and file upload/download workflows are not implemented.
- This policy governs these Ryco tools. It is not an OS sandbox around a provider's separately enabled shell, MCPs or other automation tools, nor does it constrain what an already approved terminal/scripting application could do.
- The bridge listens only on loopback, rejects web origins and requires an ephemeral backend credential passed privately through desktop bootstrap. Tokens are rotated on backend restart and never included in provider tool arguments. Browser pairing tokens remain local to the explicitly paired extension.
- Native control has been exercised on macOS. The upstream helper includes Windows and Linux implementations, but Ryco's native behavior on those systems still needs platform qualification. This is not a guarantee of complete Codex/Claude feature parity.

Locked use remains a future feature. Native control requires an unlocked desktop; granting Screen Recording and Accessibility does not enable operation through the macOS lock screen.

### Capturing a simulator phone

Xcode 27 replaces Simulator with **Device Hub**, under `Xcode.app/Contents/Applications/DeviceHub.app`. Use `apps` with `query: "Device"` (or `query: "Simulator"` for older Xcode), then `windows` and `observe` on the window for the intended device. Installed-app search covers both Xcode directory layouts, including renamed Xcode bundles. In Device Hub, use **Open in New Window** for a phone-only capture. A device window must be open; a booted headless device alone is not a desktop window. Avoid showing the same device in both the main hub and a detached window: Device Hub can expose the other view's accessibility coordinates. If clicks are refused or coordinates fall outside the window, reopen the intended view and list its windows/elements again. Ryco refuses ambiguous targets rather than clicking another window.

Observation returns the window image even when its accessibility tree is unavailable, provided the window identity and geometry still match. A sparse accessibility tree is not evidence of a blank phone screen. Use `accessibility: false` for screenshot-only observation and `max_dimension: 2400` (up to 3200) when small phone text needs more detail. Convert image coordinates to window coordinates by dividing by the returned screenshot `scale`.

`screenshotStatus` distinguishes `captured`, `unavailable`, and `not_requested`. If requested pixels are unavailable, the tool reports an error and retains any available text and failure notes; the agent must not claim visual verification. Screenshots are freshly requested from the same window filter as the live macOS sharing session, so the agent never receives a cached frame from before its latest action. The preview runs at five frames per second without audio; screenshots retain Retina detail. Only one window is shared at a time. If native sharing cannot start, capture reports a failure instead of silently falling back to an unindicated capture path. macOS 13 keeps a live sharing stream but uses its older screenshot API for still images. This captures the simulator window, not a direct connection to a physical iPhone.

Device Hub ignores process-targeted mouse clicks. Ryco routes a single background left click to an unambiguous, enabled accessibility control at that point instead. Ambiguous or unsupported clicks are refused; use `find_elements` with `invoke_element` or `set_element_value`, or explicitly request foreground input. Always inspect the resulting screen after input.

Browser element actions check visibility and whether the target is covered or has moved before delivering input. Fill/select also respect disabled and read-only controls. A replaced browser connection requires a fresh observation even if it reuses tab identifiers.

## Development and validation

On macOS, a permission toggle applies to a code identity, not just an app name. If permissions remain denied after granting them and restarting, check the app's signature with `codesign --verify --deep --strict /Applications/Ryco.app`. Invalid or unsealed Electron bundles can be attributed to an executable path instead of Ryco's bundle identity. Packaged Ryco diagnoses invalid app/helper signatures without changing the permission result or requesting access.

Non-notarized macOS artifacts are locally (ad hoc) signed after packaging, including their native helpers. They still require the unsigned-install procedure and are not Developer ID signed. Ad hoc signatures do not provide a durable identity across code updates; use Developer ID signing for distribution that preserves identity across versions. After replacing an invalid build with a correctly signed one, macOS may require the user to remove the old permission entry and add the current app again. Ryco does not automate these permission changes.

The helper's source commit and Apache-2.0 license are in `apps/desktop/native/computer-use-helper/UPSTREAM.md` and `LICENSE`. Install Rust 1.98.1 with `rustup toolchain install 1.98.1 --profile minimal`. `bun run build:desktop` builds and stages the helper and extension; macOS produces a universal helper. Source and lockfile are pinned, and startup verifies protocol version 3.

Use Bun 1.4.0 and `bun install --frozen-lockfile`. Focused automated checks:

```sh
bun run --cwd apps/desktop test src/computerUse
bun run --cwd apps/server test src/agentControl/Mcp/computerTools.test.ts
bun run --cwd apps/web test:browser src/components/settings/ComputerUseSettings.browser.tsx
```

Live tests use temporary profiles and disposable local fixtures. Run the native and simulator suites sequentially: independent helper processes share macOS capture/accessibility resources and concurrent live runs can time out. Normal Ryco operations are serialized by the computer-use controller.

```sh
bun run --cwd apps/web test:browser:install
bun apps/desktop/scripts/computer-use-native-smoke.ts
bun apps/desktop/scripts/computer-use-simulator-smoke.ts <booted-simulator-UDID>
node apps/desktop/scripts/computer-use-smoke.mjs browser
node apps/desktop/scripts/computer-use-smoke.mjs integration
```

The native test requires macOS and granted native permissions. The integration test exercises real MV3 extension pairing and background form control, bridge authentication, revocation, token rotation, and overlay movement without pointer/focus takeover. It does not connect to personal browser profiles.

The simulator test requires an iOS 26+ simulator with exactly one matching Device Hub/Simulator window open. Select a dedicated test device explicitly using its UDID from `xcrun simctl list devices booted`. The test installs a disposable SwiftUI fixture, verifies 20 background taps against the visible counter, enters Unicode text, checks fresh screenshots at two resolutions, and removes the fixture afterward. It leaves the device running. For local Expo development, `NODE_OPTIONS=--dns-result-order=ipv4first` prevents a localhost server from binding only IPv6 while advertising IPv4 bundle URLs.
