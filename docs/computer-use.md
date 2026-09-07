# Desktop computer and browser use

Ryco desktop can give an agent permission to inspect and operate apps on the local computer. Native control uses a vendored Poracode helper; Ryco owns consent, turn authorization, cancellation, browser connections and the visible cursor. This does not embed or depend on the proprietary Codex or Claude desktop runtime.

## Enable it

1. Enable **Agent Control** for the local environment in **Settings → Integrations**, then open the separate **Settings → Computer use** tab and enable computer use.
2. Permission badges refresh automatically on opening settings, returning to the app, and while the panel is visible. **Granted** is green, **Not granted** is red, and unverified states are neutral. You can also click **Check permissions**. On macOS, grant Accessibility and Screen Recording using the buttons and the system settings panes. Restart Ryco if macOS requests it. Development executables and installed/signed builds can have different permission identities.
3. Find an app and choose **Ask**, **Always allow**, or **Block**. Ask opens a native Ryco consent dialog on first use in each turn. Remembered rules remain editable even when an app is not running.
4. Enable the desired browsers. **Ryco Browser** uses a separate persistent profile. Chrome, Brave and Edge use the extension setup below.
5. Start a new provider session after enabling Agent Control. Ask the agent to use `ryco_computer` or `ryco_browser`, inspect the target, perform the task and verify the result.

Private tool injection supports the existing audited Agent Control integrations: Codex, Claude, Cursor and GitHub Copilot. OpenCode and Grok do not receive these tools through this integration. A hosted web page, mobile client or separately connected remote backend does not acquire control of the desktop implicitly.

## Existing browser profiles

Enable Chrome, Brave or Edge, then click **Pair**. **Open browser Extensions** opens the selected browser's extension manager. Choose **Show extension folder**, then **Copy folder path** to avoid searching through folders. Enable Developer mode and choose Load unpacked; on macOS use ⌘ + Shift + G in the folder chooser to paste the path. **Copy pairing configuration**, open **Ryco Browser Control** in the browser toolbar, and paste it there.

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

**Stop all**, or **⌘/Ctrl + Shift + Escape** while enabled, cancels control. If another app owns that shortcut, use Stop all. Changing access also cancels current work. Stopped turns must be restarted. Concurrent turns cannot interleave actions in a claimed target; claims last 60 seconds after their last use or until the agent calls `release`.

Background support varies by app and operating system. Refused native operations remain refused; Ryco never silently switches to your physical mouse/keyboard. Foreground use requires enabling **Allow foreground takeover requests** and accepting a separate per-turn dialog. macOS Chromium/Electron native scroll and drag can be refused; use the browser connection for page interactions.

## Boundaries and current limits

- Both observation and input require a current provider turn and local opt-in. App denial is shared between canonical native Chrome/Brave/Edge identities and their extension routes. Ryco and macOS permission-management apps are excluded from native targets.
- Native window/process identity is rechecked before actions. Browser element references are scoped to the observed document and turn. Navigation invalidates them.
- Browser tools expose bounded actions, not arbitrary JavaScript or CDP commands. The built-in browser has no Ryco preload, denies downloads and site permissions, and does not launch external URL schemes. The current snapshot targets the main document and open shadow roots; iframe content and file upload/download workflows are not implemented.
- This policy governs these Ryco tools. It is not an OS sandbox around a provider's separately enabled shell, MCPs or other automation tools, nor does it constrain what an already approved terminal/scripting application could do.
- The bridge listens only on loopback, rejects web origins and requires an ephemeral backend credential passed privately through desktop bootstrap. Tokens are rotated on backend restart and never included in provider tool arguments. Browser pairing tokens remain local to the explicitly paired extension.
- Native control has been exercised on macOS. The upstream helper includes Windows and Linux implementations, but Ryco's native behavior on those systems still needs platform qualification. This is not a guarantee of complete Codex/Claude feature parity.

## Development and validation

The helper's source commit and Apache-2.0 license are in `apps/desktop/native/computer-use-helper/UPSTREAM.md` and `LICENSE`. Install Rust 1.98.1 with `rustup toolchain install 1.98.1 --profile minimal`. `bun run build:desktop` builds and stages the helper and extension; macOS produces a universal helper. Source and lockfile are pinned, and startup verifies protocol version 3.

Use Bun 1.4.0 and `bun install --frozen-lockfile`. Focused automated checks:

```sh
bun run --cwd apps/desktop test src/computerUse
bun run --cwd apps/server test src/agentControl/Mcp/computerTools.test.ts
bun run --cwd apps/web test:browser src/components/settings/ComputerUseSettings.browser.tsx
```

Live tests use temporary profiles and disposable local fixtures:

```sh
bun run --cwd apps/web test:browser:install
bun apps/desktop/scripts/computer-use-native-smoke.ts
node apps/desktop/scripts/computer-use-smoke.mjs browser
node apps/desktop/scripts/computer-use-smoke.mjs integration
```

The native test requires macOS and granted native permissions. The integration test exercises real MV3 extension pairing and background form control, bridge authentication, revocation, token rotation, and overlay movement without pointer/focus takeover. It does not connect to personal browser profiles.
