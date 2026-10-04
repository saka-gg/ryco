# Project browser

Open the workspace panel and choose **Browser**. A **Live preview** popover is also available beneath expanded sidebar projects and in Project overview. These surfaces share browser tabs for the same environment and project directory; worktree directories have their own scope.

Enter a website or `localhost:3000`, or select a discovered local service. Discovery checks listening ports on the desktop computer with bounded HTTP HEAD requests. It does not start servers, send credentials or forward remote ports. It labels a service as belonging to the project only when its process directory matches and the selected environment is the desktop's own backend. Other services remain explicitly labeled as computer-local. Windows uses netstat; macOS/Linux discovery requires lsof. HTTPS-only services can be opened by entering their URL.

Use the star to save a URL for this project. Tabs remain alive during panel switches and can be moved into a separate preview window with **Pop out**. **Bring back into Ryco** returns that page without reloading it. Closing a preview window retains its tab; closing a tab discards the page. Open tabs are session-only, while saved URLs and the separate Ryco browser profile persist. Up to 24 desktop tabs can be open at once.

The toolbar provides back/forward, reload/stop, viewport width presets, zoom, DevTools and external opening. In desktop page content, Cmd/Ctrl+L focuses the address bar, Cmd/Ctrl+R reloads and Cmd/Ctrl+W closes the tab. Width presets are constrained by available panel space; maximize or pop out for a larger viewport. Browser content hides beneath other Ryco dialogs and detaches when its surface closes or the shell reloads.

Manual browsing does not require computer-use permission. To let an agent use these same tabs, enable Agent Control and Ryco Browser in Computer use settings, start a fresh provider session and ask it to use `ryco_browser` with browser `ryco`. App consent, turn ownership and emergency stop still apply. Agent-created tabs also appear in the browser UI. **Stop agent** invokes the existing computer-use stop control.

Agent-created Ryco tabs stay in the background without opening a separate window or switching the workspace panel, including agent `visible:true` and `show` requests. A compact browser preview beneath the thread's desktop Overview opens the Browser panel when clicked. It pauses thumbnail capture while offscreen or while Ryco is hidden. Use **Pop out** yourself to open a separate preview window. The driver's separate `computer_browser_*` headless tabs appear in the computer preview beneath Overview; they do not share the built-in browser's tab strip or profile.

## Desktop sign-in popups

For a site that signs in through a popup, focus its docked browser tab, choose **Allow sign-in popup**, then click the site's sign-in button. This allows one popup for 30 seconds. A blocked-popup hint explains how to retry; Ryco does not replay a blocked URL because doing so would lose the opener or form POST body. Website content cannot grant this permission. Consent applies to the next eligible popup from that tab, so grant it only while deliberately signing in.

The popup uses the same persistent isolated Ryco profile and retains normal opener, redirect, POST and `window.close()` behavior. Its native title shows the current origin. It initially appears without taking foreground focus; click it to interact. **Close sign-in popup**, Escape or Cmd/Ctrl+W cancels it. A failed load or renderer crash releases the popup and offers a retry. Some identity providers prohibit embedded browser sign-in; Ryco does not bypass their restrictions.

Only one sign-in popup can exist at a time. Initial pages and subsequent navigation allow HTTPS, loopback HTTP and `about:blank` (for sites that open a blank child before navigating). Credentials in URLs, non-loopback HTTP, external schemes, nested popups and background-tab requests are denied. A grant cannot be consumed while the opener's window is in the background. Switching tabs/panels, moving the tab to a popout, docking it again, reloading/navigating the opener, closing its tab, restarting the shell or desktop, and **Stop agent** cancel the grant and popup. Return to the docked tab and authorize again to retry. Agents cannot arm sign-in; an agent command cancels an unused grant and cannot control the opener while its sign-in popup is open. Existing app consent, ownership and emergency-stop controls continue to apply.

Desktop pages and sign-in children run sandboxed without Node integration, a Ryco preload or access to desktop IPC. Page permission requests, downloads, unsolicited popup windows and external protocols remain blocked. This profile is separate from Chrome/Brave/Edge; their paired extensions remain available to agents as separate browser targets.

External browser profile/cookie import and password management are deferred; this feature neither reads installed browser credentials nor imports conversations or cookies.

On web, the browser provides a sandboxed iframe preview and an external-open link. Sites may reject framing, and the sandbox can restrict login/storage-dependent features. Desktop discovery and agent control are unavailable through that fallback. Remote localhost addresses need an explicitly reachable or forwarded URL; no remote-browser streaming is introduced. The frozen phone web surface is unchanged. Locked use remains a future feature.

## Validation

Focused checks:

```sh
bun run --cwd apps/desktop test src/browser src/computerUse
bun run --cwd apps/web test src/browser/browserState.test.ts
bun run --cwd apps/web test:browser src/browser/BrowserPanel.browser.tsx
node apps/desktop/scripts/computer-use-smoke.mjs signin
node apps/desktop/scripts/computer-use-smoke.mjs project
node apps/desktop/scripts/computer-use-smoke.mjs browser
node apps/desktop/scripts/computer-use-smoke.mjs integration
```

The project smoke uses disposable local pages and browser profiles to exercise docking, agent input, resize, stale-surface cleanup, popout/redock, guest isolation and shell reload. Its macOS window capture requires Screen Recording permission and captures only its own fixture window.

The sign-in smoke runs two disposable loopback origins under a temporary Electron user-data directory. It exercises native popup POST, blank-to-provider navigation, redirect/opener callback, denial, shared Ryco/default-profile isolation, focus behavior, agent exclusion and lifecycle/crash cleanup. It uses only fixture cookies and never contacts a real identity provider. Run native smokes serially because they briefly focus fixture windows.

Implementation references: [Electron window creation](https://www.electronjs.org/docs/latest/api/window-open) and [WebContents popup handling](https://www.electronjs.org/docs/latest/api/web-contents#contentssetwindowopenhandlerhandler). [Synara v0.9.0](https://github.com/Emanuele-web04/synara/tree/v0.9.0) and [v0.9.2](https://github.com/Emanuele-web04/synara/tree/v0.9.2) browser popup handling and the [changelog](https://www.trysynara.com/changelog) were inspected as references; no source was copied. Ryco uses explicit one-use authorization rather than automatic popup classification.
