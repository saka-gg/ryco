# Project browser and live previews

## Outcome

Enable the existing Browser launcher in the right workspace panel. Provide real desktop browser tabs with address entry, navigation, loading/error state, reload/stop, zoom, responsive viewport presets, DevTools and external opening. The empty browser shows saved project URLs and discovered local HTTP services. Project overview offers a compact live-preview popover and a path into the complete browser panel.

## Architecture

Reuse the existing Ryco browser transport as the authoritative owner of desktop tabs. Replace its window-only presentation with sandboxed WebContentsViews that can move between the workspace panel and a separate preview window. Agent tools continue to address the same webContents IDs. UI browsing is available independently of agent-control consent; agent calls still pass through the existing private bridge and policy controller.

Desktop UI IPC is accepted only from the main Ryco window and its main frame. Guest pages have no Ryco preload, Node integration, or IPC privileges. Only HTTP(S) navigation is accepted; external protocols, permission requests, downloads and unsolicited popup windows remain blocked. Browser state does not contain page bodies or cookies. The compact preview attaches the same native guest view on demand; closing it detaches the view while retaining the tab.

A renderer surface reports its viewport bounds and visibility with a unique owner token. Closing, hiding, switching or unmounting a surface detaches its native view. Main-process bounds validation and owner fencing prevent stale cleanup from detaching a newer surface. Native guest views must hide while Ryco dialogs/popovers overlap them. Tab closure and app shutdown explicitly destroy guest webContents.

## Discovery and scope

Desktop discovery inspects listening local TCP ports, then performs bounded unauthenticated HTTP probes. It never starts project commands. Results identify local-computer services and associate a project only when process working-directory evidence supports it. Saved URLs are scoped by environment and project directory. Remote environment localhost URLs are not silently rewritten or claimed to be reachable locally.

The browser empty view supports entering any HTTP(S) URL, reopening a saved site, and refreshing discovery. Discovery runs only while a discovery surface is visible, with bounded concurrency, timeouts and deduplication. Failures retain manual navigation.

## Presentation

The right panel shares its existing tab bar, resizing and maximization. The browser owns a compact internal tab strip and toolbar. The project overview preview uses the same tab content and offers a separate preview window. Opening the Browser workspace for that project shows those same tabs. An independent agent cursor remains visible when the agent operates the page. A Stop control exposes the existing emergency cancellation.

The web fallback embeds HTTP(S) pages in a sandboxed iframe and offers external opening. It cannot bypass site framing policies or make remote localhost addresses reachable. The frozen web phone tier receives no new browser surface. Full hosted browser streaming and locked computer use remain future work.

## Validation

Test URL validation, port parsing and bounded probing; native tab lifetime, navigation, surface fencing and guest isolation; route/tab integration and browser UI behavior. Exercise real Electron views and agent access against disposable local fixtures, including panel attachment, detach, popup, resize, navigation and cancellation. Run the repository backstop and browser suite for this cross-cutting desktop/web change, recording baseline failures separately. Publish the implementation as a draft PR based on the computer-use branch.
