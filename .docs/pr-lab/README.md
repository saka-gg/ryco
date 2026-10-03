# Pull Requests page lab

An interactive design lab for the dedicated Pull Requests page. A fake Ryco window has the app sidebar on the left and the page area on the right, and three directions mount into the page.

```sh
python3 .docs/pr-lab/serve.py 5801   # http://127.0.0.1:5801/  (no-cache static server)
```

## Files

| File                  | Role                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------ |
| `index.html`          | Window frame (app sidebar + `#page`) and load order: styles, data, core, dir-a/b/c, app                |
| `styles.css`          | Tokens (mirrored from `apps/web/src/index.css`, light + `.dark`), motion tokens, and shared primitives |
| `data.js`             | `window.PR_LAB_DATA` mock data (shape below)                                                           |
| `core.js`             | `window.PR_LAB` helpers (API below)                                                                    |
| `app.js`              | Shell: lab switcher, hash state, persistence, direction mounting, sidebar                              |
| `dir-{a,b,c}.js/.css` | One direction each. Scope its CSS under `.dir-a` / `.dir-b` / `.dir-c`                                 |

## Direction contract

```js
PR_LAB.registerDirection({
  id: "a",
  name: "Glyph",
  tagline: "One line",
  mount(rootEl, data, lab) {
    /* render into rootEl */ return () => {
      /* cleanup */
    };
  },
});
```

`rootEl` is `<div class="dir-root dir-a">`, absolutely filling `#page`, with overflow hidden, so each direction owns its own scroll regions. `#page` is a container named `page`, so narrow layouts use `@container page (max-width: 760px) { … }`. Window presets are 1440, 1180 and 920. The page area is the window width minus the 248px sidebar, so the 920 preset leaves a 672px page.

`lab` (labApi) provides:

- `getHashState()` and `setHashState(patch, { push })`. `setHashState` never calls your own listeners.
- `onHashChange(cb(state, { prev, changed }))`. It fires on back/forward, manual URL edits, and sidebar clicks.
- `on("theme" | "width" | "motion" | "sidebar" | "resize", cb)`.
- `theme()`, `width()`, `pageWidth()`, `reducedMotion()`, `sidebarOpen()`, `setSidebar(open)`, `toast`, `data`, `root`, `page`.

All listeners are removed automatically when the direction unmounts.

## Hash convention

The direction is the path segment, and state goes in the query: `#<dir>?key=value&…`. Keys are written in canonical order, and `theme`/`width` are always present, so every URL can be screenshotted as-is.

| Key                    | Values                                    | Meaning                                                                 |
| ---------------------- | ----------------------------------------- | ----------------------------------------------------------------------- |
| _(dir)_                | `a` `b` `c`                               | Active direction. Switching keeps all other keys, so states compare 1:1 |
| `pr`                   | number                                    | PR detail open. Absent means the list/inbox                             |
| `tab`                  | `conversation` `files` `checks` `commits` | Detail tab                                                              |
| `stack`                | `open`                                    | Stack panel/popover expanded                                            |
| `merge`                | `open`                                    | Merge box/menu expanded                                                 |
| `review`               | `open`                                    | Pending-review composer open                                            |
| `file`                 | path                                      | Files tab: focused file                                                 |
| `thread`               | thread id (`703-t1`)                      | Focused review thread                                                   |
| `commit`               | short sha                                 | Files scoped to one commit                                              |
| `view`                 | `unified` `split`                         | Diff mode                                                               |
| `job`                  | job id (`703-test-web`)                   | Checks: expanded job/log                                                |
| `q`, `group`, `filter` | string                                    | List search, group (`review` `mine` `others`), state filter             |
| `theme`                | `light` `dark`                            | Always written                                                          |
| `width`                | `1440` `1180` `920` (any px)              | Window width. Always written                                            |
| `motion`               | `reduced`                                 | Only written when on                                                    |
| `sb`                   | `0`                                       | App sidebar collapsed                                                   |
| `lab`                  | `0`                                       | Hides the lab switcher, for clean screenshots                           |

Examples: `#c?pr=703&tab=files&thread=703-t1&theme=dark&width=1440`, `#a?pr=703&stack=open&merge=open&theme=light&width=920`.

Keyboard: ⌥1/2/3 switch direction, ⌥T toggles theme, ⌥M toggles reduced motion, ⌥W cycles width, ⌥B toggles the sidebar, ⌥L hides the switcher.

## Motion

The CSS variables are `--ease`, `--gentle` and `--snappy`, plus the durations `--d-chip` (120ms), `--d-pop` (200ms), `--d-stack` (260ms) and `--d-pane` (360ms). `html.reduce-motion` zeroes them, forces every animation and transition to 0s, and pauses spinners through `--play`.

The JS helpers are `animate`, `flip`, `push` (lockstep push, never a cross-fade), and `indicator`/`syncIndicator` for sliding `.seg-ind`/`.tab-ind`. All of them respect reduced motion.
