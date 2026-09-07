# Project browser

Open the workspace panel and choose **Browser**. A **Live preview** popover is also available beneath expanded sidebar projects and in Project overview. These surfaces share browser tabs for the same environment and project directory; worktree directories have their own scope.

Enter a website or `localhost:3000`, or select a discovered local service. Discovery checks listening ports on the desktop computer with bounded HTTP HEAD requests. It does not start servers, send credentials or forward remote ports. It labels a service as belonging to the project only when its process directory matches and the selected environment is the desktop's own backend. Other services remain explicitly labeled as computer-local. Windows uses netstat; macOS/Linux discovery requires lsof. HTTPS-only services can be opened by entering their URL.

Use the star to save a URL for this project. Tabs remain alive during panel switches and can be moved into a separate preview window with **Pop out**. **Bring back into Ryco** returns that page without reloading it. Closing a preview window retains its tab; closing a tab discards the page. Open tabs are session-only, while saved URLs and the separate Ryco browser profile persist. Up to 24 desktop tabs can be open at once.

The toolbar provides back/forward, reload/stop, viewport width presets, zoom, DevTools and external opening. In desktop page content, Cmd/Ctrl+L focuses the address bar, Cmd/Ctrl+R reloads and Cmd/Ctrl+W closes the tab. Width presets are constrained by available panel space; maximize or pop out for a larger viewport. Browser content hides beneath other Ryco dialogs and detaches when its surface closes or the shell reloads.

Manual browsing does not require computer-use permission. To let an agent use these same tabs, enable Agent Control and Ryco Browser in Computer use settings, start a fresh provider session and ask it to use `ryco_browser` with browser `ryco`. App consent, turn ownership and emergency stop still apply. Agent-created tabs also appear in the browser UI. **Stop agent** invokes the existing computer-use stop control.

Desktop pages run in sandboxed Electron WebContentsViews without Node integration, a Ryco preload or access to desktop IPC. Page permission requests, downloads, unsolicited popup windows and external protocols remain blocked. This profile is separate from Chrome/Brave/Edge; their paired extensions remain available to agents as separate browser targets.

On web, the browser provides a sandboxed iframe preview and an external-open link. Sites may reject framing, and the sandbox can restrict login/storage-dependent features. Desktop discovery and agent control are unavailable through that fallback. Remote localhost addresses need an explicitly reachable or forwarded URL; no remote-browser streaming is introduced. The frozen phone web surface is unchanged. Locked use remains a future feature.

## Validation

Focused checks:

```sh
bun run --cwd apps/desktop test src/browser src/computerUse
bun run --cwd apps/web test src/browser/browserState.test.ts
bun run --cwd apps/web test:browser src/browser/BrowserPanel.browser.tsx
node apps/desktop/scripts/computer-use-smoke.mjs project
node apps/desktop/scripts/computer-use-smoke.mjs browser
node apps/desktop/scripts/computer-use-smoke.mjs integration
```

The project smoke uses disposable local pages and browser profiles to exercise docking, agent input, resize, stale-surface cleanup, popout/redock, guest isolation and shell reload. Its macOS window capture requires Screen Recording permission and captures only its own fixture window.
