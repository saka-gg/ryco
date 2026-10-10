# HTML renders

Agents can answer with a page instead of only text: a chart, table, diagram, image collage, or UI
mockup. Ask for one ("show this as a chart", "make a collage of these screenshots") and the agent
builds a self-contained HTML page, which appears in the thread above its written reply. Pages show
on web, desktop, and the mobile app.

## Requirements

HTML renders are part of [Agent Control](../agent-control.md). Turn on **Enable Agent Control**
under **Settings → Integrations**. Ryco then offers two private tools to the provider sessions it
starts (Codex, Claude, GitHub Copilot, and Cursor):

- `ryco_html_preview` renders a page in Ryco's own headless browser and returns a screenshot, the
  height the page needs, and its console output, so the agent can check its work.
- `ryco_html_render` shows the finished page in the thread.

Both work only during the agent's own turn in its own thread. OpenCode and Grok sessions do not
receive Agent Control tools, and standalone integrations never see these two tools.

## How pages look

Pages use your current theme, including custom themes, and follow light and dark mode as you
switch, even a page that reloads itself. A page sits on the thread's background and is as wide as
the reply column; Ryco fits the frame to the page's height at your window's width, so most pages
show without scrolling. Pages published by an earlier Ryco version get the current theme handling
each time they load; the stored page itself is not changed.

## Opening a page

On web and desktop, hover a page to show the expand button in its top-right corner (touch screens
always show it). It opens the page full size in a tab of the workspace panel on the right, with the
page's title, a **Source** toggle for the agent's HTML, and **Download** for the page as an `.html`
file; close it with the tab's ×. The tab belongs to the thread: switch threads and back, and it is
still there.
Keys you press inside the page, Escape included, stay with the page.

When a turn has pages and a written reply, the reply ends with a small card for each page: a
thumbnail of the page's top in your current light or dark mode, its title, and **Open**, which opens
the page the same way. A page Ryco could not take a thumbnail of, such as one published before its
preview browser was installed, shows an icon instead. A turn that is only pages has no cards; it
already ends with them.

The web app's phone layout has no workspace panel and no expand button; there a page's card opens
the page in a full-size view. The mobile app always shows the expand button, and the button and the
cards open the page full screen, with the agent's source; on iOS, **Share** sends the page as an
`.html` file (Android has no Share for pages yet).

## Safety

A page is agent output, not part of Ryco. It runs in a sandboxed frame with an opaque origin: its
scripts run, but it cannot reach Ryco, your session, cookies, or the rest of the app, open windows,
show dialogs, or navigate the thread. Links you click in a page open in your browser. Ryco never
serves a page from its own address; clients read the stored bytes and show them in the sandbox, and
the attachment download stays an inert file. Anyone who can read the thread, including a device
paired as a client, can open its pages.

Pages can load public resources such as a chart library from a CDN; use https, since readers on
an HTTPS connection block plain-http scripts and styles. The sandbox also means a page has no
storage: `localStorage`, `sessionStorage`, cookies and opening an IndexedDB database throw, for
readers and in previews alike.

## Local images

Agents can place local images in a page by absolute file path. Ryco embeds them when the page is
published, so the page keeps working after the original files move or are deleted. Only images
inside the thread's workspace or worktree and the system temp directory are embedded, and only real
image files: at most 10 MiB each and 25 MiB for the whole page. A path outside those folders, even
through a symbolic link, is refused, and so are hard-linked files; the agent is told why and can
copy such a file into the temp directory first.

## Storage

A published page is stored like a file the agent delivered: as an attachment on its own message in
that turn. It counts toward the turn's attachment budget (8 attachments, 50 MiB). Deleting the
thread, or reverting past the turn, deletes its pages. A page's HTML is at most 512,000 characters.
Its thumbnails are small images (under 36 KB each) kept with the attachment. Tool calls in the work
log show the page title or the preview's width and mode, never the page's markup.

## The preview browser

Previews use a small headless browser that Ryco keeps for itself; it never uses a browser you
installed. The first preview on a machine downloads it once (about 100 MB, verified against a pinned
checksum) into Ryco's data folder under `tools/chrome-headless-shell`, so that preview can take a
minute and the agent is told to try again shortly. A download that is cut off, by a lost connection
or by quitting Ryco, picks up where it stopped on the next try. Publishing never waits for the
download: pages publish without it, and Ryco measures their height and takes their card thumbnails
(in its default dark and light themes) only once the browser is installed, spending at most a few
seconds on each page.

The preview browser reaches only public internet addresses, never this machine or your local
network. Chrome's sandbox stays on; operators running Ryco as root in a container can set
`RYCO_HTML_PREVIEW_NO_SANDBOX=1` to turn it off for previews.
