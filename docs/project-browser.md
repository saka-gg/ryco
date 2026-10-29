# Project browser

Open the workspace panel and choose **Browser**. A **Live preview** popover is also available beneath expanded sidebar projects and in Project overview. These surfaces share browser tabs for the same environment and project directory; worktree directories have their own scope.

Enter a website or `localhost:3000`, or select a discovered local service. Discovery checks listening ports on the desktop computer with bounded HTTP HEAD requests. It does not start servers, send credentials or forward remote ports. It labels a service as belonging to the project only when its process directory matches and the selected environment is the desktop's own backend. Other services remain explicitly labeled as computer-local. Windows uses netstat; macOS/Linux discovery requires lsof. HTTPS-only services can be opened by entering their URL.

Use the star to save a URL for this project. Tabs keep their page during panel switches, within the memory limits below, and can be moved into a separate preview window with **Pop out**. **Bring back into Ryco** returns that page without reloading it. Closing a preview window retains its tab; closing a tab discards the page. Open tabs are session-only, while saved URLs and the separate Ryco browser profile persist. Up to 24 desktop tabs can be open at once.

To bound memory, Ryco keeps at most 10 desktop tabs running, plus any of the exempt tabs listed below. A hidden tab you have not viewed for 10 minutes is suspended. So is the least recently used hidden tab past 10 running tabs, and, when one project has more than 6 tabs running (agent-opened tabs count as their own group), its least recently used tabs that have been hidden for over a minute. A suspended tab keeps its place, title and address, appears muted in the tab strip and reloads when you open it, which resets unsaved page state such as form input. The tab you viewed last, visible and popped-out tabs, tabs signing in, tabs with DevTools open or playing audio, tabs still loading (for up to 30 seconds after a reload), tabs shown in the thread's browser preview and tabs an agent used in the last minute stay running. Hidden tabs are throttled in the background unless an agent or the browser preview is using them. Suspended tabs still count toward the 24-tab limit.

The toolbar provides back/forward, reload/stop, viewport width presets, zoom, DevTools and external opening. In desktop page content, Cmd/Ctrl+L focuses the address bar, Cmd/Ctrl+R reloads and Cmd/Ctrl+W closes the tab. Width presets are constrained by available panel space; maximize or pop out for a larger viewport. Browser content hides beneath other Ryco dialogs and detaches when its surface closes or the shell reloads.

Manual browsing does not require computer-use permission. To let an agent use these same tabs, enable Agent Control and Ryco Browser in Computer use settings, start a fresh provider session and ask it to use `ryco_browser` with browser `ryco`. App consent, turn ownership and emergency stop still apply. Agent-created tabs also appear in the browser UI. **Stop agent** invokes the existing computer-use stop control.

Agent-created Ryco tabs stay in the background without opening a separate window or switching the workspace panel, including agent `visible:true` and `show` requests. An agent command on a suspended tab reloads it first, and the tool result says the page was reloaded; the agent then observes it again before interacting. A compact browser preview beneath the thread's desktop Overview opens the Browser panel when clicked. It pauses thumbnail capture while offscreen or while Ryco is hidden. Use **Pop out** yourself to open a separate preview window. The driver's separate `computer_browser_*` headless tabs appear in the computer preview beneath Overview; they do not share the built-in browser's tab strip or profile.

## Desktop sign-in popups

For a site that signs in through a popup, focus its docked browser tab, choose **Allow sign-in popup**, then click the site's sign-in button. This allows one popup for 30 seconds. A blocked-popup hint explains how to retry; Ryco does not replay a blocked URL because doing so would lose the opener or form POST body. Website content cannot grant this permission. Consent applies to the next eligible popup from that tab, so grant it only while deliberately signing in.

The popup uses the same persistent isolated Ryco profile and retains normal opener, redirect, POST and `window.close()` behavior. Its native title shows the current origin. It initially appears without taking foreground focus; click it to interact. **Close sign-in popup**, Escape or Cmd/Ctrl+W cancels it. A failed load or renderer crash releases the popup and offers a retry. Some identity providers prohibit embedded browser sign-in; Ryco does not bypass their restrictions.

Only one sign-in popup can exist at a time. Initial pages and subsequent navigation allow HTTPS, loopback HTTP and `about:blank` (for sites that open a blank child before navigating). Credentials in URLs, non-loopback HTTP, external schemes, nested popups and background-tab requests are denied. A grant cannot be consumed while the opener's window is in the background. Switching tabs/panels, moving the tab to a popout, docking it again, reloading/navigating the opener, closing its tab, restarting the shell or desktop, and **Stop agent** cancel the grant and popup. Return to the docked tab and authorize again to retry. Agents cannot arm sign-in; an agent command cancels an unused grant and cannot control the opener while its sign-in popup is open. Existing app consent, ownership and emergency-stop controls continue to apply.

Desktop pages and sign-in children run sandboxed without Node integration, a Ryco preload or access to desktop IPC. Page permission requests, downloads, unsolicited popup windows and external protocols remain blocked. This profile is separate from Chrome/Brave/Edge; their paired extensions remain available to agents as separate browser targets.

External browser profile/cookie import and password management are deferred; this feature neither reads installed browser credentials nor imports conversations or cookies.

On web, the browser provides a sandboxed iframe preview and an external-open link. Sites may reject framing, and the sandbox can restrict login/storage-dependent features. Desktop discovery and agent control are unavailable through that fallback. Remote localhost addresses need an explicitly reachable or forwarded URL; no remote-browser streaming is introduced. The frozen phone web surface is unchanged. Locked use remains a future feature.

## Point at page elements

In a thread's **Browser** panel on desktop, **Pick element** lets you show the agent exactly which part of the page you mean. Hover the page: Chromium's own inspect overlay outlines the element under the pointer and shows the DevTools tooltip (tag, size, colours, accessible name and role). Click one, and it stays highlighted in purple while a note box opens above the page. Write what you want changed (optional) and choose **Add to chat** (⌘↵ / Ctrl↵): the element waits in the thread's composer as a chip (`button "Save changes"`) whose tooltip shows the page, selector, role, box and your note. **Cancel picking**, Escape (in the page or in Ryco) or **Cancel** in the note box stops without adding anything. Picking the same element again with the same note refreshes its chip; with another note it adds a second chip, so no note is ever replaced (the page's query and hash are not kept, so one URL can stand for several pages). A message carries up to 32 page elements next to its file references. The chips belong to the draft like file references: they survive reloads, go out with the next send, come back if it fails, and travel with queued and steered messages. A sent message shows them as chips on web and in the mobile app.

The control is offered only in a thread's workspace Browser panel, while that thread's composer can take context, on a docked tab that loaded a page. It is not in the sidebar's **Live preview**, on the web iframe fallback (hosted web included), in popped-out windows, or on the frozen web phone layout.

How it works: the desktop main process drives the pick over the tab's own CDP session, the one agent browser tools use. It turns on Chromium's inspect mode, and when you click it describes the element by running a fixed function in an isolated world of the page. There is still no preload and nothing a page script can see or call; the overlay and highlights are drawn by Chromium, not added to the page. The description is bounded and redacted twice, in the main process and again in the client whenever a chip is created, restored or read back from a sent message:

- the page URL comes from the browser, never from the page, and keeps only its origin and path: credentials, the query and the hash are dropped, and path segments that look private (an email address, a token or JWT, a UUID, a long opaque id) or that follow a sensitive key such as `reset`, `invite`, `users` or `session` become `REDACTED`;
- text and names are cut to their limits (text 280 characters, names and the page title 256, the selector 1,024) and collapsed to one line, bidirectional controls are removed, and a `<` that starts something tag-like (such as `</browser_context>`) becomes `‹`;
- form values are never read: inputs, text areas, selects and editable regions (and containers holding a password or card field) carry no text, and names or text that look like credentials, email addresses or card numbers are dropped.

The agent receives the element in a `<browser_context>` block of the prompt (see [Files and chat](files-to-chat.md#what-the-agent-receives)). The block says that its page values are untrusted page data that only identify the element.

Agent precedence: while you pick, agent browser reads (tabs, observe, screenshot, wait, console, network) keep working and leave your pick alone, though a screenshot may show the overlay. An agent action that clicks, types, scrolls, navigates, reloads, closes, resizes or otherwise changes the tab ends your pick first, and the panel says **The agent used this tab, so picking stopped.** A pick does not start while the agent is acting on the tab. Navigation (**The page changed, so picking stopped.**), DevTools or another debugger taking over the page, two minutes without a click (**Picking timed out.**), switching tabs or panels, a covering Ryco dialog, and **Pop out** end a pick too.

Limits: elements inside embedded frames cannot be picked. A click inside a frame picks the `<iframe>` element that holds it in the page; when a frame on the way cannot be reached, the panel says the element can't be picked. Hover-only UI (menus that open on hover) cannot be reached, because the inspect tool takes the hover, as in DevTools. The note box and the picking hint sit above the page in the panel, so the page gets a little shorter while they show and reflows; the highlight follows the element.

## Validation

Focused checks:

```sh
bun run --cwd apps/desktop test src/browser src/computerUse
bun run --cwd packages/shared test src/browserElementReference.test.ts
bun run --cwd packages/client-runtime test src/state/composer
bun run --cwd apps/web test src/browser/browserState.test.ts
bun run --cwd apps/web test:browser src/browser/BrowserPanel.browser.tsx src/browser/browserElementPickScript.browser.tsx src/components/ChatView.BrowserElements.browser.tsx
bun run --cwd apps/mobile test src/features/threads/ThreadMessage.test.tsx
node apps/desktop/scripts/computer-use-smoke.mjs signin
node apps/desktop/scripts/computer-use-smoke.mjs project
node apps/desktop/scripts/computer-use-smoke.mjs picker
node apps/desktop/scripts/computer-use-smoke.mjs browser
node apps/desktop/scripts/computer-use-smoke.mjs integration
node apps/desktop/scripts/computer-use-smoke.mjs tab-budget
```

The project smoke uses disposable local pages and browser profiles to exercise docking, agent input, resize, stale-surface cleanup, popout/redock, guest isolation and shell reload. Its macOS window capture requires Screen Recording permission and captures only its own fixture window.

The picker smoke docks a disposable local page in a hidden fixture window and exercises the element picker: Chromium's inspect overlay and the picked highlight (checked in captures of its own page), picking, form-value redaction, end-pick, agent reads and "Stop agent" keeping a pick, an agent click ending it and reaching the page, navigation, Escape, panel switch, replacement, and cross-site and same-site frames. It sends synthetic input into its own fixture page only, never shows or focuses a window and needs no permissions. Set `RYCO_SMOKE_SHOT_DIR` to keep its captures.

The sign-in smoke runs two disposable loopback origins under a temporary Electron user-data directory. It exercises native popup POST, blank-to-provider navigation, redirect/opener callback, denial, shared Ryco/default-profile isolation, focus behavior, agent exclusion and lifecycle/crash cleanup. It uses only fixture cookies and never contacts a real identity provider. Run native smokes serially because they briefly focus fixture windows.

The tab-budget smoke opens 11 loopback fixture tabs in hidden windows under a temporary Electron user-data directory and checks the memory budget: the live cap, revival on show, capture and agent use, the per-project limit (it waits for the real 60-second timer), the 10-minute idle limit (on a virtual clock), background throttling and the browser preview's captures. It logs the renderer processes and their memory before and after suspension, counting only its own Electron process's helpers. It takes about two minutes and never shows or focuses a window.

Implementation references: [Electron window creation](https://www.electronjs.org/docs/latest/api/window-open) and [WebContents popup handling](https://www.electronjs.org/docs/latest/api/web-contents#contentssetwindowopenhandlerhandler). [Synara v0.9.0](https://github.com/Emanuele-web04/synara/tree/v0.9.0) and [v0.9.2](https://github.com/Emanuele-web04/synara/tree/v0.9.2) browser popup handling and the [changelog](https://www.trysynara.com/changelog) were inspected as references; no source was copied. Ryco uses explicit one-use authorization rather than automatic popup classification.
