/* ============================================================
   Direction C · Editorial Document
   The pull request reads as one calm, scrolling document: a big
   title, one meta line, the description, then the timeline as a
   quiet left-rail narrative. A slim margin rail (not a card) holds
   the sticky facts: the next-action control, checks ring, reviews,
   conversations, stack mini-map, labels and assignees. Files is a
   full-bleed reading mode that slides over the document. The list
   is a collapsible column that folds to a 52px glyph strip.

   State mutations happen on a private deep clone of PR_LAB_DATA
   (swapped in on mount, restored on unmount) so the shared model
   helpers see them and other directions stay pristine.
   ============================================================ */
(function () {
  "use strict";
  const L = window.PR_LAB;
  const { html, raw, esc, h, $, $$, on, icon, plural } = L;
  const M = L.model;

  const TABS = ["conversation", "files", "checks", "commits"];
  const BODY_TABS = ["conversation", "checks", "commits"];
  const TAB_LABEL = {
    conversation: "Conversation",
    files: "Files",
    checks: "Checks",
    commits: "Commits",
  };
  const STATE_WORD = { open: "Open", draft: "Draft", merged: "Merged", closed: "Closed" };
  const METHOD = {
    squash: "Squash and merge",
    rebase: "Rebase and merge",
    merge: "Create a merge commit",
  };
  const METHOD_SHORT = { squash: "Squash", rebase: "Rebase", merge: "Merge commit" };
  const DEC = {
    approved: ["Approved", "ok"],
    changes_requested: ["Changes requested", "err"],
    review_required: ["Review required", "warn"],
  };
  const KIND_WORD = {
    pass: "Passed",
    fail: "Failed",
    run: "Running",
    queued: "Queued",
    skip: "Skipped",
    none: "",
  };
  const REVIEW_VERB = {
    approved: "approved these changes",
    changes_requested: "requested changes",
    commented: "reviewed",
    dismissed: "had a review dismissed",
  };
  const LIST_W = 296;
  const AUTO_COLLAPSE_BELOW = 1100;

  /* Inline SVG bits that need exact geometry */
  const CHECK_DRAW = `<svg class="c-draw" viewBox="0 0 16 16" aria-hidden="true"><path pathLength="1" d="M3.5 8.4l2.9 2.9 6.1-6.6" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const BOX_CHECK = `<svg viewBox="0 0 12 12" aria-hidden="true"><path pathLength="1" d="M2.6 6.3l2.3 2.3 4.6-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

  L.registerDirection({
    id: "c",
    name: "Editorial Document",
    tagline: "One calm document with a sticky margin rail; files slide over as a reading mode",
    mount(root, _data, lab) {
      /* ------------------------------------------------------ private data */
      const ORIG = window.PR_LAB_DATA;
      const D = structuredClone(ORIG);
      window.PR_LAB_DATA = D;
      M._synth = {};
      const VIEWER = D.viewer.login;
      const offs = [];
      const timers = new Set();
      const later = (fn, ms) => {
        const t = setTimeout(() => {
          timers.delete(t);
          fn();
        }, ms);
        timers.add(t);
        return t;
      };
      const reduced = () => lab.reducedMotion();
      let tick = 0;
      const stamp = () => new Date(Date.parse(D.now) + ++tick * 1000).toISOString();
      let seq = 0;
      const nid = (p) => `${p}-c${++seq}`;
      const hex7 = () => Math.random().toString(16).slice(2, 9).padEnd(7, "0");
      const set = (node, tpl) => {
        if (node) node.innerHTML = String(tpl);
      };

      /* ------------------------------------------------------ state */
      const st = {
        pr: null,
        tab: "conversation",
        q: "",
        group: "",
        filter: "open",
        file: null,
        thread: null,
        commit: null,
        view: "unified",
        job: null,
      };
      const ui = {
        list: null, // "open" | "collapsed" | null (auto by width)
        listTemp: false, // collapsed temporarily by the Files reading mode
        peek: false,
        grpClosed: new Set(),
        tree: true,
        treeAuto: true,
        seen: new Set(),
        openPush: new Set(),
        openJobs: new Set(),
        openSteps: new Set(),
        openResolved: new Set(),
        expandedViewed: new Set(),
        collapsedFiles: new Set(),
        composer: null,
        reply: null,
        editTitle: false,
        editBody: false,
        reviewEvent: "comment",
        reviewBody: "",
        method: null,
        delBranch: D.repo.deleteBranchOnMerge,
        busy: {},
        donutSig: {},
        treeQ: "",
        bodyTab: "conversation",
      };

      const readHash = () => {
        const s = lab.getHashState();
        return {
          pr: s.pr,
          tab: TABS.includes(s.tab) ? s.tab : "conversation",
          stack: s.stack,
          merge: s.merge,
          review: s.review,
          file: s.file || null,
          thread: s.thread || null,
          commit: s.commit || null,
          view: s.view === "split" ? "split" : "unified",
          job: s.job || null,
          q: s.q || "",
          group: ["review", "mine", "others"].includes(s.group) ? s.group : "",
          filter: ["open", "draft", "merged", "closed", "all"].includes(s.filter)
            ? s.filter
            : "open",
        };
      };
      const setHash = (patch, push = false) => lab.setHashState(patch, { push });

      const narrow = () => R.detail.clientWidth <= 820;
      const cur = () => (st.pr != null ? M.pr(st.pr) : null);
      const curD = () => (st.pr != null ? M.detail(st.pr) : null);
      const mine = (p) => p.author === VIEWER;
      const isRequested = (p) =>
        p.involvement === "review-requested" ||
        (p.reviewers || []).some((r) => r.login === VIEWER && r.state === "pending");
      const pendingN = (d) => d?.pendingReview?.comments?.length || 0;
      const firstLine = (s) =>
        String(s || "")
          .replace(/```[\s\S]*?```/g, "")
          .replace(/[#>*_`]/g, "")
          .trim()
          .split("\n")[0];
      const splitPath = (p) => {
        const i = p.lastIndexOf("/");
        return i < 0 ? ["", p] : [p.slice(0, i + 1), p.slice(i + 1)];
      };
      /* dir (truncates from the left, never the filename) + name */
      const pathHTML = (p) => {
        const i = p.lastIndexOf("/");
        return i < 0
          ? html`<span class="nm">${p}</span>`
          : html`<span class="dir">${p.slice(0, i)}</span><span class="sl">/</span
              ><span class="nm">${p.slice(i + 1)}</span>`;
      };

      /* ------------------------------------------------------ skeleton */
      root.innerHTML = String(html`<div class="c-app">
        <aside class="c-list" aria-label="Pull requests">
          <div class="c-list-panel">
            <div class="c-list-top">
              <button
                class="ib c-list-tog"
                type="button"
                data-act="list-toggle"
                data-tip="Collapse list"
                data-kbd="L"
              >
                ${icon("sidebar")}
              </button>
              <label class="c-search"
                >${icon("search")}<input
                  type="text"
                  spellcheck="false"
                  autocomplete="off"
                  placeholder="Search or paste a PR link"
                  aria-label="Search pull requests"
                /><kbd>/</kbd></label
              >
              <button class="ib c-filter-b" type="button" data-act="list-filter" data-tip="Filter">
                ${icon("filter")}<i class="c-dot"></i>
              </button>
            </div>
            <div class="c-list-scroll scroll">
              <div class="c-list-in">
                <i class="c-list-sel" aria-hidden="true"></i>
                <div class="c-list-rows"></div>
              </div>
            </div>
          </div>
        </aside>
        <main class="c-detail">
          <header class="c-head"><div class="c-head-in"></div></header>
          <div class="c-body">
            <div class="c-doc scroll"></div>
            <section class="c-sheet" aria-label="Changed files" inert></section>
            <div class="c-rbar"></div>
            <div class="c-selchip" hidden>
              <button class="chip agent" type="button" data-act="ask-selection">
                ${icon("sparkle")}Ask agent
              </button>
            </div>
          </div>
        </main>
      </div>`);
      const R = {
        app: $(".c-app", root),
        list: $(".c-list", root),
        panel: $(".c-list-panel", root),
        search: $(".c-search input", root),
        listScroll: $(".c-list-scroll", root),
        listIn: $(".c-list-in", root),
        rows: $(".c-list-rows", root),
        sel: $(".c-list-sel", root),
        detail: $(".c-detail", root),
        head: $(".c-head-in", root),
        body: $(".c-body", root),
        doc: $(".c-doc", root),
        sheet: $(".c-sheet", root),
        rbar: $(".c-rbar", root),
        selchip: $(".c-selchip", root),
        grid: null,
        mast: null,
        rail: null,
        docbody: null,
        actblk: null,
        facts: null,
      };

      /* ------------------------------------------------------ reveal (first view only) */
      let revealArmedAt = 0;
      const io = new IntersectionObserver(
        (entries) => {
          const late = performance.now() - revealArmedAt > 260;
          for (const en of entries) {
            if (!en.isIntersecting) continue;
            const el = en.target;
            if (late) el.style.setProperty("--i", "0");
            el.classList.add("in");
            ui.seen.add(el.dataset.rvKey);
            io.unobserve(el);
          }
        },
        { root: R.doc, rootMargin: "0px 0px -16px 0px" },
      );
      function armReveal(scope, opts = {}) {
        revealArmedAt = performance.now();
        const vp = R.doc.getBoundingClientRect();
        let i = 0;
        for (const el of $$(".c-rv", scope)) {
          const key = `${st.pr}:${el.dataset.rv}`;
          el.dataset.rvKey = key;
          if (reduced() || ui.seen.has(key) || opts.all) {
            el.classList.add("in");
            ui.seen.add(key);
            continue;
          }
          if (opts.instantVisible) {
            const r = el.getBoundingClientRect();
            if (r.top < vp.bottom && r.bottom > vp.top) {
              el.classList.add("in");
              ui.seen.add(key);
              continue;
            }
          }
          el.style.setProperty("--i", String(Math.min(i++, 7)));
          io.observe(el);
        }
      }

      /* Header condenses: the small title appears only while the big one is out of view */
      const titleIO = new IntersectionObserver(
        ([en]) => {
          if (!en) return;
          R.detail.classList.toggle(
            "condensed",
            !en.isIntersecting && en.boundingClientRect.top < en.rootBounds.top + 1,
          );
        },
        { root: R.doc, threshold: 0 },
      );

      /* ------------------------------------------------------ list */
      function shortAction(na) {
        const map = {
          review: "Your review",
          merge: "Ready to merge",
          "mark-ready": "Mark ready",
          draft: "Draft",
          "wait-checks": "Checks running",
          "await-review": "Awaiting review",
          "auto-merge": "Auto-merge on",
        };
        return map[na.key] || na.label;
      }
      function matchQ(p, q) {
        const num = q.replace(/^#/, "");
        if (/^\d+$/.test(num)) return String(p.number).startsWith(num);
        return (
          p.title.toLowerCase().includes(q) ||
          p.author.toLowerCase().includes(q) ||
          p.headRefName.toLowerCase().includes(q) ||
          p.labels.some((l) => l.includes(q))
        );
      }
      function listGroups() {
        const q = st.q.trim().toLowerCase();
        const isRef = /\/pull\/\d+/.test(q);
        let prs = D.pullRequests;
        if (q && !isRef) prs = prs.filter((p) => matchQ(p, q));
        if (isRef) {
          const n = M.parseRef(q);
          prs = prs.filter((p) => p.number === n);
        }
        const groups = M.groups(prs, { state: q ? "all" : st.filter });
        return groups.filter((g) => !st.group || g.key === st.group);
      }
      function rowHTML(p, i, arr) {
        const na = M.nextAction(p);
        const prev = arr[i - 1];
        const next = arr[i + 1];
        const sid = p.stack?.id;
        const linkUp = sid && prev?.stack?.id === sid;
        const linkDown = sid && next?.stack?.id === sid;
        const stk = linkUp && linkDown ? "stk-mid" : linkDown ? "stk-top" : linkUp ? "stk-bot" : "";
        const who = mine(p)
          ? ""
          : html`<span class="c-row-who">${p.author.replace(/\[bot\]$/, "")}</span>`;
        return html`<button
          class="c-row ${stk} ${p.unread ? "unread" : ""} ${p.number === st.pr ? "sel" : ""}"
          type="button"
          data-act="open-pr"
          data-pr="${p.number}"
          aria-current="${p.number === st.pr ? "page" : "false"}"
        >
          <span class="c-row-g"
            >${L.stateGlyph(p, { tip: false })}<i class="c-pip t-${na.tone}"></i
          ></span>
          <span class="c-row-t">${p.title}</span>
          <span class="c-row-time tnum">${L.ago(p.updatedAt)}</span>
          <span class="c-row-s"
            ><span class="tnum">#${p.number}</span>${who}<span class="c-row-na t-${na.tone}"
              >${shortAction(na)}</span
            ></span
          >
          ${p.stack ? html`<span class="c-row-x tnum">${icon("stack")}${p.stack.position}/${p.stack.size}</span>` : ""}
        </button>`;
      }
      function renderList(opts = {}) {
        const groups = listGroups();
        const searching = !!st.q.trim();
        const total = groups.reduce((a, g) => a + g.prs.length, 0);
        const mutate = () => {
          set(
            R.rows,
            html`${groups.map((g) => {
              if (!g.prs.length && searching) return "";
              const open = searching || !ui.grpClosed.has(g.key);
              return html`<section class="c-grp" data-g="${g.key}">
                <button
                  class="c-grp-h"
                  type="button"
                  data-act="grp"
                  data-g="${g.key}"
                  aria-expanded="${String(open)}"
                >
                  <i class="c-grp-rule"></i><span class="c-grp-t">${g.label}</span
                  ><span class="c-grp-n tnum">${g.prs.length}</span
                  >${icon("chevron", { cls: "chev" })}
                </button>
                <div class="disc ${open ? "open" : ""}">
                  <div>
                    <div class="c-grp-rows">
                      ${g.prs.map((p, i, a) => rowHTML(p, i, a))}${g.prs.length ? "" : html`<div class="c-grp-empty">Nothing here</div>`}
                    </div>
                  </div>
                </div>
              </section>`;
            })}${
              !total && searching
                ? html`<div class="c-list-empty">
                    ${icon("search")}
                    <p>No pull requests match <b>${st.q}</b></p>
                    <button class="btn sm" type="button" data-act="clear-search">
                      Clear search
                    </button>
                  </div>`
                : ""
            }`,
          );
        };
        if (opts.flip && !reduced()) flipRows(mutate);
        else mutate();
        const filtered = st.filter !== "open" || st.group;
        $(".c-filter-b", root).classList.toggle("on", !!filtered);
        syncSel(!opts.flip);
      }
      function flipRows(mutate) {
        const before = new Map(
          $$(".c-row", R.rows).map((r) => [r.dataset.pr, r.getBoundingClientRect()]),
        );
        mutate();
        for (const r of $$(".c-row", R.rows)) {
          const b = before.get(r.dataset.pr);
          if (!b) {
            L.animate(
              r,
              [
                { opacity: 0, transform: "translateY(6px)" },
                { opacity: 1, transform: "none" },
              ],
              { duration: "stack" },
            );
            continue;
          }
          const a = r.getBoundingClientRect();
          const dy = b.top - a.top;
          if (Math.abs(dy) > 1)
            L.animate(r, [{ transform: `translateY(${dy}px)` }, { transform: "none" }], {
              duration: "stack",
              easing: "gentle",
            });
        }
      }
      /* Sliding selection indicator (house idiom), sized to the selected row */
      function syncSel(instant) {
        const row = $(".c-row.sel", R.rows);
        const ind = R.sel;
        const visible = row && row.offsetParent && row.closest(".disc.open, .c-grp-rows");
        if (!row || !visible || row.closest(".disc:not(.open)")) {
          ind.style.opacity = "0";
          return;
        }
        const top = row.getBoundingClientRect().top - R.listIn.getBoundingClientRect().top;
        if (instant || !ind.dataset.ready) ind.style.transition = "none";
        ind.style.opacity = "1";
        ind.style.height = row.offsetHeight + "px";
        ind.style.transform = `translateY(${top}px)`;
        if (instant || !ind.dataset.ready) {
          void ind.offsetWidth;
          ind.style.transition = "";
          ind.dataset.ready = "1";
        }
      }
      function markSelRows() {
        for (const r of $$(".c-row", R.rows)) {
          const s = Number(r.dataset.pr) === st.pr;
          r.classList.toggle("sel", s);
          r.setAttribute("aria-current", s ? "page" : "false");
        }
        syncSel(false);
      }

      /* list collapse / peek */
      function listMode() {
        if (ui.listTemp) return "collapsed";
        if (ui.list) return ui.list;
        return lab.pageWidth() < AUTO_COLLAPSE_BELOW ? "collapsed" : "open";
      }
      function applyListMode() {
        const mode = listMode();
        R.app.classList.toggle("collapsed", mode === "collapsed");
        R.app.classList.toggle("peek", mode === "collapsed" && ui.peek);
        const tog = $(".c-list-tog", root);
        tog.dataset.tip = mode === "collapsed" ? "Expand list" : "Collapse list";
        L.tip.refresh();
      }
      let peekT = 0;
      R.list.addEventListener("pointerenter", () => {
        if (listMode() !== "collapsed") return;
        clearTimeout(peekT);
        peekT = setTimeout(() => {
          ui.peek = true;
          applyListMode();
          later(() => syncSel(true), 0);
        }, 150);
      });
      R.list.addEventListener("pointerleave", () => {
        clearTimeout(peekT);
        if (!ui.peek) return;
        if (R.list.contains(document.activeElement) && document.activeElement === R.search) return;
        peekT = setTimeout(() => {
          ui.peek = false;
          applyListMode();
        }, 220);
      });
      R.search.addEventListener("focus", () => {
        if (listMode() === "collapsed" && !ui.peek) {
          ui.peek = true;
          applyListMode();
        }
      });
      R.search.addEventListener("blur", () => {
        if (ui.peek && !R.list.matches(":hover")) {
          ui.peek = false;
          applyListMode();
        }
      });

      /* search: filter as you type, paste a link to open it */
      R.search.addEventListener("input", () => {
        st.q = R.search.value;
        renderList();
        setHash({ q: st.q || null });
      });
      R.search.addEventListener("paste", (e) => {
        const text = e.clipboardData?.getData("text") || "";
        const n = /\/pull\/\d+/.test(text) ? M.parseRef(text) : null;
        if (n && M.pr(n)) {
          e.preventDefault();
          R.search.value = "";
          st.q = "";
          renderList();
          openPR(n);
          L.toast(`Opened #${n} from the pasted link`, { icon: "link" });
        }
      });
      R.search.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          const n = M.parseRef(R.search.value);
          const first = $(".c-row", R.rows);
          const target = n && M.pr(n) ? n : first ? Number(first.dataset.pr) : null;
          if (target) {
            if (/\/pull\/\d+|^#\d+$/.test(R.search.value.trim())) {
              R.search.value = "";
              st.q = "";
              renderList();
              setHash({ q: null });
            }
            openPR(target);
            R.search.blur();
          }
        } else if (e.key === "Escape") {
          if (R.search.value) {
            R.search.value = "";
            st.q = "";
            renderList();
            setHash({ q: null });
          } else R.search.blur();
          e.stopPropagation();
        } else if (e.key === "ArrowDown") {
          e.preventDefault();
          $(".c-row", R.rows)?.focus();
        }
      });
      R.listScroll.addEventListener("scroll", () => {}, { passive: true });

      /* ------------------------------------------------------ header */
      let tabsOff = null;
      let segOff = null;
      function renderHead() {
        tabsOff?.();
        segOff?.();
        tabsOff = segOff = null;
        const p = cur();
        if (!p) {
          set(
            R.head,
            html`<div class="c-head-crumb">
              <b>Pull requests</b><span class="dim">${D.repo.nameWithOwner}</span>
            </div>`,
          );
          return;
        }
        const d = curD();
        const filesN = d.files.length || p.changedFiles || 0;
        const commitsN = d.commits.length || p.commitsCount || 0;
        set(
          R.head,
          html`<div class="c-head-l">
              <nav class="c-tabs tabs" role="tablist" aria-label="Pull request sections">
                <i class="tab-ind"></i>
                ${TABS.map(
                  (t) =>
                    html`<button
                      class="tab"
                      role="tab"
                      type="button"
                      data-act="tab"
                      data-tab="${t}"
                      aria-selected="${String(st.tab === t)}"
                    >
                      ${TAB_LABEL[t]}${t === "files" && filesN ? html`<span class="cnt tnum">${filesN}</span>` : ""}${t === "commits" && commitsN ? html`<span class="cnt tnum">${commitsN}</span>` : ""}
                    </button>`,
                )}
              </nav>
              <div class="c-head-title" aria-hidden="true">
                <span class="trunc">${p.title}</span>
              </div>
            </div>
            <div class="c-head-tools">${headTools(p, d)}</div>`,
        );
        tabsOff = L.indicator($(".c-tabs", R.head));
        const seg = $(".c-seg", R.head);
        if (seg) segOff = L.indicator(seg);
      }
      function headTools(p, d) {
        if (st.tab === "files") {
          const c = st.commit ? d.commits.find((x) => x.short === st.commit) : null;
          return html`${p.stack ? html`<button class="btn sm ghost c-stk-chip" type="button" data-act="stack-open" data-tip="Stack navigator" data-kbd="S">${icon("stack")}<span class="tnum">${p.stack.position}/${p.stack.size}</span></button>` : ""}
            <span class="c-scope ${c ? "on" : ""}">
              <button
                class="btn sm ghost c-scope-b"
                type="button"
                data-act="commit-menu"
                data-tip="Review one commit at a time"
                data-kbd="C"
              >
                ${icon("commit")}${c ? html`<code>${c.short}</code><span class="trunc c-scope-m">${c.message}</span>` : html`<span class="c-scope-l">All commits</span>`}${icon("chevron-down")}
              </button>
              ${c ? html`<button class="ib sm" type="button" data-act="commit-clear" data-tip="Show all commits">${icon("x")}</button>` : ""}
            </span>
            <div class="seg c-seg" role="radiogroup" aria-label="Diff layout">
              <i class="seg-ind"></i>
              <button
                class="seg-opt"
                type="button"
                role="radio"
                data-act="view"
                data-view="unified"
                aria-checked="${String(st.view === "unified")}"
                data-tip="Unified"
                data-kbd="U"
              >
                ${icon("unified")}
              </button>
              <button
                class="seg-opt"
                type="button"
                role="radio"
                data-act="view"
                data-view="split"
                aria-checked="${String(st.view === "split")}"
                data-tip="Split"
                data-kbd="U"
              >
                ${icon("split")}
              </button>
            </div>
            <button
              class="ib"
              type="button"
              data-act="tree-toggle"
              data-tip="${ui.tree ? "Hide file tree" : "Show file tree"}"
              data-kbd="F"
              aria-pressed="${String(ui.tree)}"
            >
              ${icon("folder")}
            </button>
            <button class="ib" type="button" data-act="more" data-tip="More">
              ${icon("more")}
            </button>`;
        }
        return html`<button class="ib" type="button" data-act="copy-link" data-tip="Copy link">
            ${icon("link")}
          </button>
          <a
            class="ib"
            href="${p.url || D.repo.url + "/pull/" + p.number}"
            target="_blank"
            rel="noreferrer"
            data-tip="Open on GitHub"
            >${icon("external")}</a
          >
          <button class="ib" type="button" data-act="more" data-tip="More">
            ${icon("more")}
          </button>`;
      }
      function renderHeadTools() {
        const p = cur();
        if (!p) return;
        segOff?.();
        segOff = null;
        const tools = $(".c-head-tools", R.head);
        if (!tools) return renderHead();
        set(tools, headTools(p, curD()));
        const seg = $(".c-seg", R.head);
        if (seg) segOff = L.indicator(seg);
      }
      function syncTabs() {
        for (const b of $$(".c-tabs .tab", R.head))
          b.setAttribute("aria-selected", String(b.dataset.tab === st.tab));
        R.detail.classList.toggle("files", st.tab === "files");
      }

      /* ------------------------------------------------------ document grid */
      function buildGrid() {
        const p = cur();
        const d = curD();
        const grid = h("div", "c-docgrid");
        grid.innerHTML = String(html`<div class="c-mast"></div>
          <aside class="c-rail" aria-label="Status">
            <div class="c-actblk"></div>
            <div class="c-facts"></div>
          </aside>
          <div class="c-docbody"></div>`);
        R.grid = grid;
        R.mast = $(".c-mast", grid);
        R.rail = $(".c-rail", grid);
        R.actblk = $(".c-actblk", grid);
        R.facts = $(".c-facts", grid);
        R.docbody = $(".c-docbody", grid);
        R.actMain = null;
        renderMast(p, d);
        renderRail(p, d, { morph: false });
        set(R.docbody, bodyHTML(ui.bodyTab, p, d));
        return grid;
      }

      /* ---------- masthead: title + one meta line */
      function renderMast(p = cur(), d = curD()) {
        const s = L.prState(p);
        const title = ui.editTitle
          ? html`<form class="c-title-edit" data-form="title">
              <input class="c-title-in" value="${p.title}" aria-label="Title" /><button
                class="btn sm pri"
                type="submit"
              >
                Save</button
              ><button class="btn sm ghost" type="button" data-act="title-cancel">Cancel</button>
            </form>`
          : html`<h1 class="c-title">
              <span class="c-title-t">${p.title}</span
              >${mine(p) && p.state === "open" ? html`<button class="ib sm c-title-ed" type="button" data-act="edit-title" data-tip="Edit title">${icon("edit")}</button>` : ""}
            </h1>`;
        set(
          R.mast,
          html`<div class="c-rv" data-rv="title">${title}</div>
            <div class="c-meta c-rv" data-rv="meta">
              <span class="c-state s-${s}"
                >${L.stateGlyph(p, { size: 14, tip: false })}${STATE_WORD[s]}</span
              >
              <span class="tnum c-num">#${p.number}</span>
              <span class="c-by"
                >${L.avatar(p.author, { size: 16 })}<b>${p.author}</b> opened
                ${L.fmtDate(p.createdAt, { time: false })}</span
              >
              <span class="c-brs"
                ><button
                  class="c-br"
                  type="button"
                  data-act="copy"
                  data-copy="${p.headRefName}"
                  data-label="branch name"
                  data-tip="Copy branch name"
                >
                  ${p.headRefName}</button
                >${icon("arrow-right")}<span class="c-br base">${p.baseRefName}</span></span
              >
              ${L.diffStat(p.additions, p.deletions)}
            </div>`,
        );
        const t = $(".c-title", R.mast) || $(".c-title-edit", R.mast);
        titleIO.disconnect();
        if (t) titleIO.observe(t);
        if (ui.editTitle) {
          const inp = $(".c-title-in", R.mast);
          inp.focus();
          inp.select();
        }
      }

      /* ---------- rail: next action + facts */
      function actionFor(p) {
        const busy = ui.busy[p.number];
        if (busy) {
          const word = {
            merging: "Merging…",
            updating: "Updating branch…",
            closing: "Closing…",
            rerun: "Checks running…",
          }[busy];
          return { key: "busy-" + busy, label: word, tone: "wait", ic: "spin" };
        }
        const na = M.nextAction(p);
        const method = ui.method || D.repo.defaultMergeMethod;
        const plan = p.stack ? M.mergePlan(p.number) : null;
        switch (na.key) {
          case "merged":
            return { key: na.key, label: "Merged", tone: "merged", ic: "draw" };
          case "closed":
            return { key: na.key, label: "Reopen", tone: "neutral", ic: "pr-open", run: reopen };
          case "review":
            return {
              key: na.key,
              label: "Review changes",
              tone: "pri",
              ic: "file-diff",
              run: () => setTab("files"),
            };
          case "mark-ready":
            return {
              key: na.key,
              label: "Mark ready for review",
              tone: "pri",
              ic: "eye",
              run: markReady,
            };
          case "draft":
            return { key: na.key, label: "Draft", tone: "wait", ic: "pr-draft", run: null };
          case "resolve-conflicts":
            return {
              key: na.key,
              label: "Resolve conflicts",
              tone: "pri",
              ic: "alert",
              run: openConflicts,
            };
          case "fix-checks":
            return {
              key: na.key,
              label:
                p.checks.failed > 1
                  ? `Show ${p.checks.failed} failing checks`
                  : "Show failing check",
              tone: "pri",
              ic: "check-fail",
              run: gotoFailing,
            };
          case "address-review":
            return {
              key: na.key,
              label: p.unresolvedThreads
                ? `Address ${plural(p.unresolvedThreads, "thread")}`
                : "Address review",
              tone: "pri",
              ic: "comment",
              run: gotoThread,
            };
          case "wait-checks":
            return {
              key: na.key,
              label: "Checks running…",
              tone: "wait",
              ic: "spin",
              run: () => setTab("checks"),
            };
          case "await-review":
            return {
              key: na.key,
              label: "Awaiting review",
              tone: "wait",
              ic: "clock",
              run: (e) => pickerPop(e?.currentTarget || R.actMain, "reviewers"),
            };
          case "blocked-by-stack": {
            const b = plan?.blockedBy?.pr;
            return {
              key: na.key,
              label: na.label,
              tone: "wait",
              ic: "stack",
              run: b
                ? () =>
                    openPR(b.number, { anim: b.stack.position > p.stack.position ? "up" : "down" })
                : null,
            };
          }
          case "update-branch":
            return {
              key: na.key,
              label: "Update branch",
              tone: "pri",
              ic: "update-branch",
              run: updateBranch,
            };
          case "auto-merge":
            return {
              key: na.key,
              label: "Auto-merge on",
              tone: "auto",
              ic: "clock",
              run: () => openMergeMenu(),
            };
          case "merge-stack":
            return {
              key: na.key,
              label: plan.label,
              tone: "go",
              ic: "pr-merged",
              run: () => doMerge(p.number),
            };
          case "merge":
          default:
            return {
              key: "merge",
              label: METHOD[method],
              tone: "go",
              ic: "pr-merged",
              run: () => doMerge(p.number),
            };
        }
      }
      function faceHTML(A) {
        const ic =
          A.ic === "spin"
            ? `<i class="c-spin"></i>`
            : A.ic === "draw"
              ? CHECK_DRAW
              : String(icon(A.ic));
        return `<span class="c-act-face">${ic}<span>${esc(A.label)}</span></span>`;
      }
      /* an instruction that belongs to someone else stays quiet (outlined), never a filled CTA */
      function actionTone(p, A) {
        if (A.tone !== "pri") return A;
        const na = M.nextAction(p);
        return na.owner && na.owner !== "you" && na.key !== "review"
          ? { ...A, tone: "neutral" }
          : A;
      }
      function renderAction(p) {
        const A = actionTone(p, actionFor(p));
        const hasMore = true;
        R.actblk.innerHTML = `<div class="c-act t-${A.tone}" data-key="${esc(A.key)}">
            <button class="c-act-main" type="button" data-act="next" ${A.run ? "" : 'aria-disabled="true"'}><span class="c-act-lbl">${faceHTML(A)}</span></button>
            ${hasMore ? `<button class="c-act-more" type="button" data-act="merge-menu" aria-label="Merge options" data-tip="Merge options" data-kbd="M">${icon("chevron-down")}</button>` : ""}
          </div><div class="c-act-notes"></div>`;
        R.actMain = $(".c-act-main", R.actblk);
        R.actSig = A.key + "|" + A.label + "|" + A.tone;
        R.actRun = A.run;
        set($(".c-act-notes", R.actblk), html`${notesHTML(p, A)}`);
      }
      /* Morph: width springs between label widths; the old label rolls up and out while the new one rolls in (push, never a cross-fade). */
      function morphAction(p) {
        const A = actionTone(p, actionFor(p));
        const sig = A.key + "|" + A.label + "|" + A.tone;
        R.actRun = A.run;
        set($(".c-act-notes", R.actblk), html`${notesHTML(p, A)}`);
        if (sig === R.actSig) return;
        R.actSig = sig;
        const wrap = $(".c-act", R.actblk);
        const main = R.actMain;
        const lbl = $(".c-act-lbl", main);
        const old = $$(".c-act-face", lbl);
        wrap.className = `c-act t-${A.tone}`;
        wrap.dataset.key = A.key;
        if (A.run) main.removeAttribute("aria-disabled");
        else main.setAttribute("aria-disabled", "true");
        if (reduced()) {
          lbl.innerHTML = faceHTML(A);
          return;
        }
        const w0 = main.getBoundingClientRect().width;
        lbl.insertAdjacentHTML("beforeend", faceHTML(A));
        const fresh = lbl.lastElementChild;
        old.forEach((o) => (o.style.display = "none"));
        main.style.width = "";
        const w1 = main.getBoundingClientRect().width;
        old.forEach((o) => {
          o.style.display = "";
          o.classList.add("leaving");
        });
        main.getAnimations().forEach((a) => a.cancel());
        L.animate(main, [{ width: w0 + "px" }, { width: w1 + "px" }], {
          duration: "stack",
          easing: "snappy",
        });
        for (const o of old) {
          const a = L.animate(
            o,
            [{ transform: "translateY(0)" }, { transform: "translateY(-120%)" }],
            { duration: "stack", easing: "gentle", fill: "forwards" },
          );
          if (a) a.finished.then(() => o.remove()).catch(() => o.remove());
          else o.remove();
        }
        L.animate(fresh, [{ transform: "translateY(120%)" }, { transform: "translateY(0)" }], {
          duration: "stack",
          easing: "gentle",
        });
      }
      function notesHTML(p, A) {
        const d = curD();
        const out = [];
        const working = (d.linkedThreads || []).filter((t) => t.state === "working");
        for (const t of working)
          out.push(
            html`<button
              class="c-note c-note-agent"
              type="button"
              data-act="open-agent"
              data-tip="Open the agent's thread"
            >
              <span class="g g-working"></span
              ><span class="trunc">${t.provider === "codex" ? "Codex" : "Claude"} · ${t.title}</span
              ><span class="dim tnum">${L.ago(t.startedAt)}</span>
            </button>`,
          );
        const agent = (kind, label) =>
          html`<button class="c-note c-note-q" type="button" data-act="handoff" data-kind="${kind}">
            ${icon("sparkle")}<span>${label}</span>
          </button>`;
        switch (A.key) {
          case "busy-merging": {
            const plan = M.mergePlan(p.number);
            out.push(
              html`<span class="c-note"
                >${plan.layers.length > 1 ? `Landing ${plan.layers.map((l) => "#" + l.number).join(", ")}` : `Landing in`}
                <code>${plan.base}</code>…</span
              >`,
            );
            break;
          }
          case "busy-updating":
            out.push(
              html`<span class="c-note"
                >Merging <code>${p.baseRefName}</code> into this branch…</span
              >`,
            );
            break;
          case "fix-checks":
            if (!working.length) out.push(agent("fix-checks", "Fix with agent"));
            break;
          case "resolve-conflicts":
            out.push(agent("resolve-conflicts", "Resolve with agent"));
            break;
          case "address-review":
            if (!working.length) out.push(agent("address-review", "Address with agent"));
            break;
          case "wait-checks":
          case "await-review":
          case "blocked-by-stack":
            if (D.repo.autoMergeAllowed && p.state === "open")
              out.push(
                html`<button class="c-note c-note-q" type="button" data-act="auto-merge-on">
                  ${icon("clock")}<span>Merge automatically when ready</span>
                </button>`,
              );
            break;
          case "auto-merge":
            out.push(
              html`<span class="c-note"
                >${METHOD_SHORT[p.autoMerge.method] || "Squash"} when every requirement
                passes<button class="c-link" type="button" data-act="auto-merge-off">
                  Cancel
                </button></span
              >`,
            );
            break;
          case "merge":
          case "merge-stack": {
            if (A.key === "merge-stack") {
              const plan = M.mergePlan(p.number);
              out.push(
                html`<span class="c-note"
                  >Lands ${plan.layers.map((l) => "#" + l.number).join(", ")} into
                  <code>${plan.base}</code></span
                >`,
              );
            }
            out.push(
              html`<button
                class="c-note c-cbx ${ui.delBranch ? "on" : ""}"
                type="button"
                role="checkbox"
                aria-checked="${String(ui.delBranch)}"
                data-act="toggle-del-branch"
              >
                <i class="c-box">${raw(BOX_CHECK)}</i><span>Delete branch after merge</span>
              </button>`,
            );
            break;
          }
          case "merged":
            out.push(
              p.branchDeleted
                ? html`<span class="c-note"
                    >Head branch deleted<button
                      class="c-link"
                      type="button"
                      data-act="restore-branch"
                    >
                      Restore
                    </button></span
                  >`
                : html`<span class="c-note"
                    >Head branch kept<button class="c-link" type="button" data-act="delete-branch">
                      Delete
                    </button></span
                  >`,
            );
            break;
        }
        return out;
      }

      function donutHTML(c, animate) {
        const size = 30;
        const r = 12;
        const C = 2 * Math.PI * r;
        const segs = [
          ...Array(c.failed || 0).fill("fail"),
          ...Array(c.running || 0).fill("run"),
          ...Array(c.skipped || 0).fill("skip"),
          ...Array(Math.max(0, c.passed || 0)).fill("pass"),
        ];
        const n = segs.length;
        if (!n)
          return `<svg class="c-donut" viewBox="0 0 ${size} ${size}" aria-hidden="true"><circle class="trk" cx="15" cy="15" r="${r}"/></svg>`;
        const gapDeg = n > 1 ? Math.min(9, 80 / n) : 0;
        const segDeg = 360 / n - gapDeg;
        const len = (segDeg / 360) * C;
        const parts = segs
          .map((k, i) => {
            const rot = -90 + i * (360 / n) + gapDeg / 2;
            return `<circle class="seg s-${k}" cx="15" cy="15" r="${r}" stroke-dasharray="${len.toFixed(2)} ${C.toFixed(2)}" transform="rotate(${rot.toFixed(2)} 15 15)" style="--len:${len.toFixed(2)};--i:${i}"/>`;
          })
          .join("");
        return `<svg class="c-donut ${animate ? "draw" : ""}" viewBox="0 0 ${size} ${size}" aria-hidden="true">${parts}</svg>`;
      }
      function factsHTML(p, d) {
        const C = M.checks(d);
        const c = p.checks;
        const sig = `${c.passed}|${c.failed}|${c.running}|${c.skipped}|${c.total}`;
        const animate = ui.donutSig[p.number] !== sig;
        ui.donutSig[p.number] = sig;
        const bad = C.jobs.filter((j) => ["fail", "run", "queued"].includes(L.runKind(j)));
        const badStatuses = C.statuses.filter((s) => L.checkKind(s.state) === "fail");
        const out = [];
        out.push(html`<section class="c-fact" data-k="checks">
          <button
            class="c-fact-h"
            type="button"
            data-act="goto-checks"
            data-tip="Open checks"
            data-kbd="3"
          >
            ${raw(donutHTML(c, animate))}<span class="k">Checks</span
            ><span class="v tnum"
              >${c.total ? html`${c.passed}<span class="of">/${c.total}</span>` : html`<span class="of">None</span>`}</span
            >
          </button>
          ${
            bad.length || badStatuses.length || (c.failed && !C.jobs.length)
              ? html`<div class="c-fact-b c-cks">
                  ${bad.map(
                    (j) =>
                      html`<button
                        class="c-ck k-${L.runKind(j)}"
                        type="button"
                        data-act="goto-job"
                        data-job="${j.id}"
                      >
                        ${L.checkGlyph(j, { size: 12, tip: false })}<span class="trunc"
                          >${j.name}</span
                        ><span class="c-ck-st">${KIND_WORD[L.runKind(j)]}</span>
                      </button>`,
                  )}${badStatuses.map((s) => html`<span class="c-ck k-fail">${L.checkGlyph(s.state, { size: 12, tip: false })}<span class="trunc">${s.name}</span></span>`)}${!C.jobs.length && c.failed ? html`<span class="c-ck k-fail">${L.checkGlyph("fail", { size: 12, tip: false })}<span class="trunc">${plural(c.failed, "check")} failing</span></span>` : ""}
                </div>`
              : ""
          }
        </section>`);
        const dec = DEC[p.reviewDecision];
        const revs = (d.reviewers && d.reviewers.length ? d.reviewers : p.reviewers) || [];
        out.push(html`<section class="c-fact" data-k="reviews">
          <div class="c-fact-h">
            <span class="k"
              >Reviews${p.state === "open" ? html`<button class="ib sm c-edit" type="button" data-act="edit-reviewers" data-tip="Request reviewers">${icon("plus")}</button>` : ""}</span
            ><span class="v ${dec ? "t-" + dec[1] : "dim"}">${dec ? dec[0] : "None yet"}</span>
          </div>
          <div class="c-fact-b c-revs">
            ${revs.map((r) => {
              const u = M.user(r.login);
              const name =
                r.login === VIEWER ? "You" : u.team ? "@" + r.login.split("/").pop() : r.login;
              const tip =
                r.state === "pending"
                  ? "Review requested"
                  : `${{ approved: "Approved", changes_requested: "Requested changes", commented: "Commented", dismissed: "Dismissed" }[r.state] || ""}${r.submittedAt ? " · " + L.agoLong(r.submittedAt) : ""}`;
              return html`<div class="c-rev-r">
                ${L.avatar(r.login, { size: 18 })}<span class="trunc">${name}</span
                >${L.reviewGlyph(r.state, { size: 13, tip })}
              </div>`;
            })}${revs.length ? "" : html`<span class="c-none">No reviewers</span>`}
          </div>
        </section>`);
        const threads = d.threads || [];
        const open = d.synthetic
          ? p.unresolvedThreads || 0
          : threads.filter((t) => !t.isResolved).length;
        if (threads.length || open)
          out.push(html`<section class="c-fact" data-k="threads">
            <button
              class="c-fact-h"
              type="button"
              data-act="goto-thread"
              ${open ? "" : "disabled"}
              data-tip="${open ? "Jump to the next unresolved conversation" : ""}"
              data-kbd="${open ? "N" : ""}"
            >
              <span class="k">Conversations</span
              ><span class="v ${open ? "t-warn" : "dim"} tnum"
                >${open ? `${open} unresolved` : "All resolved"}</span
              >
            </button>
          </section>`);
        if (p.stack) out.push(stackFactHTML(p));
        out.push(html`<section class="c-fact" data-k="labels">
          <div class="c-fact-h">
            <span class="k"
              >Labels${p.state !== "merged" ? html`<button class="ib sm c-edit" type="button" data-act="edit-labels" data-tip="Edit labels">${icon("plus")}</button>` : ""}</span
            >
          </div>
          <div class="c-fact-b c-lbls">
            ${p.labels.length ? p.labels.map((l) => L.labelChip(l)) : html`<span class="c-none">None</span>`}
          </div>
        </section>`);
        out.push(html`<section class="c-fact" data-k="assignees">
          <div class="c-fact-h">
            <span class="k"
              >Assignees${p.state !== "merged" ? html`<button class="ib sm c-edit" type="button" data-act="edit-assignees" data-tip="Edit assignees">${icon("plus")}</button>` : ""}</span
            >
          </div>
          <div class="c-fact-b c-asg">
            ${(p.assignees || []).length ? p.assignees.map((a) => html`<span class="c-asg-i">${L.avatar(a, { size: 18 })}<span>${a === VIEWER ? "You" : a}</span></span>`) : html`<span class="c-none">Nobody</span>`}
          </div>
        </section>`);
        return out;
      }
      function stackFactHTML(p) {
        const s = M.stackOf(p);
        const top = [...s.entries].reverse();
        return html`<section class="c-fact" data-k="stack">
          <button
            class="c-fact-h"
            type="button"
            data-act="stack-open"
            data-tip="Stack navigator"
            data-kbd="S"
          >
            <span class="k">${icon("stack")}Stack #${s.number}</span
            ><span class="v tnum">${s.position}<span class="of"> of ${s.size}</span></span>
          </button>
          <ol class="c-fact-b c-smap">
            ${top.map((e) => {
              const na = M.nextAction(e);
              const isCur = e.number === p.number;
              return html`<li>
                <button
                  class="c-smap-i ${isCur ? "cur" : ""} s-${L.prState(e)} t-${na.tone}"
                  type="button"
                  data-act="stack-go"
                  data-pr="${e.number}"
                  ${isCur ? raw('aria-current="page"') : ""}
                  data-tip="${`#${e.number} · ${shortAction(na)}`}"
                >
                  <i class="c-smap-dot"></i><span class="n tnum">#${e.number}</span
                  ><span class="t trunc">${e.title.replace(/^[A-Z][\w-]*:\s*/, "")}</span>
                </button>
              </li>`;
            })}
            <li class="c-smap-base"><i class="c-smap-dot"></i><span>${s.baseRefName}</span></li>
          </ol>
        </section>`;
      }
      function renderRail(p = cur(), d = curD(), opts = {}) {
        if (!R.actblk) return;
        if (opts.morph && R.actMain && R.actMain.isConnected) morphAction(p);
        else renderAction(p);
        const scroll = R.facts.scrollTop;
        set(R.facts, html`${factsHTML(p, d)}`);
        R.facts.scrollTop = scroll;
      }

      /* ---------- document bodies */
      function bodyHTML(tab, p, d) {
        if (tab === "checks") return checksHTML(p, d);
        if (tab === "commits") return commitsHTML(p, d);
        return convHTML(p, d);
      }

      /* conversation */
      function timelineItems(d) {
        const items = [];
        const sameTime = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) < 5 * 60e3;
        for (const e of d.timeline) {
          if (e.kind === "opened") continue;
          const prev = items[items.length - 1];
          if (e.kind === "commits" && prev?.kind === "commits" && prev.actor === e.actor) {
            prev.commits = [...prev.commits, ...e.commits];
            prev.at = e.at;
            continue;
          }
          if (
            e.kind === "labeled" &&
            prev?.kind === "labeled" &&
            prev.actor === e.actor &&
            sameTime(prev.at, e.at)
          ) {
            prev.labels.push(e.label);
            continue;
          }
          if (
            e.kind === "review_requested" &&
            prev?.kind === "review_requested" &&
            prev.actor === e.actor &&
            sameTime(prev.at, e.at)
          ) {
            prev.reviewers.push(e.reviewer);
            continue;
          }
          const it = { ...e };
          if (e.kind === "commits") it.commits = [...e.commits];
          if (e.kind === "labeled") it.labels = [e.label];
          if (e.kind === "review_requested") it.reviewers = [e.reviewer];
          items.push(it);
        }
        return items;
      }
      const actorB = (login) => html`<b class="c-actor">${login === VIEWER ? "You" : login}</b>`;
      const timeT = (at) =>
        html`<time class="c-t tnum" datetime="${at}" data-tip="${L.fmtDate(at)}"
          >${L.ago(at)}</time
        >`;
      function evLine(it, node, text, extra = "") {
        return html`<li class="c-ti c-ev c-rv ${extra}" data-rv="${it.id}">
          <span class="c-ti-n">${node}</span>
          <div class="c-ti-c">
            <span class="c-ev-tx">${actorB(it.actor)} ${text}</span>${timeT(it.at)}
          </div>
        </li>`;
      }
      function tlItemHTML(it, p, d) {
        switch (it.kind) {
          case "labeled":
            return evLine(it, icon("tag"), html`added ${it.labels.map((l) => L.labelChip(l))}`);
          case "unlabeled":
            return evLine(it, icon("tag"), html`removed ${L.labelChip(it.label)}`);
          case "review_requested":
            return evLine(
              it,
              icon("eye"),
              html`requested review from
              ${it.reviewers.map((r, i) => html`${i ? (i === it.reviewers.length - 1 ? " and " : ", ") : ""}<span class="c-who">${L.avatar(r, { size: 14, tip: false })}${r === VIEWER ? "you" : r}</span>`)}`,
            );
          case "review_request_removed":
            return evLine(it, icon("eye-off"), html`removed the review request for ${it.reviewer}`);
          case "renamed":
            return evLine(it, icon("edit"), html`changed the title from <del>${it.from}</del>`);
          case "ready_for_review":
            return evLine(it, icon("eye"), "marked this ready for review");
          case "convert_to_draft":
            return evLine(it, icon("pr-draft"), "converted this to a draft");
          case "base_changed":
            return evLine(
              it,
              icon("branch"),
              html`changed the base from <code>${it.from}</code> to <code>${it.to}</code>`,
            );
          case "assigned":
            return evLine(
              it,
              icon("user"),
              it.assignee === it.actor ? "self-assigned this" : html`assigned ${it.assignee}`,
            );
          case "unassigned":
            return evLine(it, icon("user"), html`unassigned ${it.assignee}`);
          case "force_pushed":
            return evLine(
              it,
              icon("rerun"),
              html`force-pushed <code>${String(it.before).slice(0, 7)}</code> →
                <code>${String(it.after).slice(0, 7)}</code
                >${it.note ? html`<span class="c-ev-note">${it.note}</span>` : ""}`,
            );
          case "merged":
            return evLine(
              it,
              raw(`<span class="c-ev-ic s-merged">${icon("pr-merged")}</span>`),
              html`merged ${it.layers ? plural(it.layers, "pull request") : "this"} into
                <code>${it.base || p.baseRefName}</code
                >${it.commit ? html` as <code>${String(it.commit).slice(0, 7)}</code>` : ""}`,
              "tone-merged",
            );
          case "closed":
            return evLine(
              it,
              raw(`<span class="c-ev-ic s-closed">${icon("pr-closed")}</span>`),
              "closed this without merging",
              "tone-closed",
            );
          case "reopened":
            return evLine(
              it,
              raw(`<span class="c-ev-ic s-open">${icon("pr-open")}</span>`),
              "reopened this",
            );
          case "auto_merge_enabled":
            return evLine(
              it,
              icon("clock"),
              html`enabled auto-merge (${METHOD_SHORT[it.method] || "squash"})`,
            );
          case "auto_merge_disabled":
            return evLine(it, icon("clock"), "disabled auto-merge");
          case "head_ref_deleted":
            return evLine(it, icon("trash"), "deleted the branch");
          case "head_ref_restored":
            return evLine(it, icon("branch"), "restored the branch");
          case "update_branch":
            return evLine(
              it,
              icon("update-branch"),
              html`merged <code>${p.baseRefName}</code> into this branch`,
            );
          case "commits":
            return pushHTML(it, d);
          case "review":
            return reviewHTML(it, p, d);
          case "comment":
            return commentBlockHTML(it, p);
          default:
            return "";
        }
      }
      function pushHTML(it, d) {
        const open = ui.openPush.has(it.id);
        const known = new Set(d.commits.map((c) => c.short));
        const n = it.commits.length;
        return html`<li class="c-ti c-ev c-push c-rv ${open ? "open" : ""}" data-rv="${it.id}">
          <span class="c-ti-n">${icon("commit")}</span>
          <div class="c-ti-c">
            <button
              class="c-push-h"
              type="button"
              data-act="push"
              data-id="${it.id}"
              aria-expanded="${String(open)}"
            >
              <span class="c-ev-tx">${actorB(it.actor)} pushed ${plural(n, "commit")}</span
              >${icon("chevron", { cls: "chev" })}
            </button>
            ${timeT(it.at)}
            <div class="disc c-push-b ${open ? "open" : ""}">
              <div>
                <ul class="c-push-l">
                  ${it.commits.map((c) => {
                    const ok = known.has(c.short);
                    const full = d.commits.find((x) => x.short === c.short);
                    return html`<li>
                      <button
                        class="c-pc ${ok ? "" : "gone"}"
                        type="button"
                        data-act="commit-scope"
                        data-sha="${c.short}"
                        ${ok ? "" : raw('data-tip="Rewritten by a later force-push"')}
                      >
                        ${full ? L.checkGlyph(full.checks || "none", { size: 12, tip: false }) : raw('<i class="c-pc-gone"></i>')}<span
                          class="trunc"
                          >${c.message}</span
                        ><code>${c.short}</code>
                      </button>
                    </li>`;
                  })}
                </ul>
              </div>
            </div>
          </div>
        </li>`;
      }
      function reviewHTML(it, p, d) {
        const threads = (it.threadIds || [])
          .map((id) => d.threads.find((t) => t.id === id))
          .filter(Boolean);
        const tone =
          { approved: "ok", changes_requested: "err", commented: "muted", dismissed: "muted" }[
            it.state
          ] || "muted";
        return html`<li
          class="c-ti c-rev c-rv tone-${tone}"
          data-rv="${it.id}"
          data-review="${it.id}"
        >
          <span class="c-ti-n">${L.avatar(it.actor, { size: 24 })}</span>
          <div class="c-ti-c">
            <div class="c-blk-h">
              ${actorB(it.actor)}<span class="c-verdict t-${tone}"
                >${it.state !== "commented" ? L.reviewGlyph(it.state, { size: 14, tip: false }) : ""}${REVIEW_VERB[it.state] || "reviewed"}</span
              >${timeT(it.at)}
            </div>
            ${it.body ? html`<div class="md c-blk-b">${L.markdown(it.body)}</div>` : ""}
            ${threads.length ? html`<div class="c-blk-thr">${threads.map((t) => threadHTML(t, "timeline"))}</div>` : ""}
          </div>
        </li>`;
      }
      function commentBlockHTML(it, p) {
        const bot = M.user(it.actor).bot;
        return html`<li class="c-ti c-cmt c-rv" data-rv="${it.id}" data-comment="${it.id}">
          <span class="c-ti-n">${L.avatar(it.actor, { size: 24 })}</span>
          <div class="c-ti-c">
            <div class="c-blk-h">
              ${actorB(it.actor)}${bot ? html`<span class="c-bot">bot</span>` : ""}${it.actor === p.author && !bot ? html`<span class="c-bot">author</span>` : ""}${timeT(it.at)}${it.editedAt ? html`<span class="c-edited" data-tip="${"Edited " + L.agoLong(it.editedAt)}">edited</span>` : ""}
            </div>
            <div class="md c-blk-b">${L.markdown(it.body)}</div>
            ${reactionsHTML(it)}
          </div>
        </li>`;
      }
      function reactionsHTML(c) {
        const rs = (c.reactions || []).filter((r) => r.count > 0);
        return html`<div class="c-rx">
          ${rs.map((r) => html`<button class="c-rx-b ${r.viewerReacted ? "on" : ""}" type="button" data-act="react" data-c="${c.id}" data-e="${r.emoji}"><span>${r.emoji}</span><span class="tnum">${r.count}</span></button>`)}<button
            class="c-rx-add"
            type="button"
            data-act="react-add"
            data-c="${c.id}"
            aria-label="Add reaction"
            data-tip="Add reaction"
          >
            ${icon("smile")}
          </button>
        </div>`;
      }
      function hunkExcerpt(t) {
        if (!t.diffHunk) return "";
        const rows = L.parsePatch(t.diffHunk).filter((r) => r.kind !== "hunk");
        const tail = rows.slice(-4);
        return L.renderDiff(tail, {
          path: t.path,
          wrap: true,
          lineClass: (ref) =>
            t.line != null && ref.line === t.line && ref.side === t.side ? "sel" : "",
        });
      }
      function threadHTML(t, ctx) {
        const first = t.comments[0];
        if (t.isResolved && !ui.openResolved.has(t.id)) {
          return html`<div class="c-thr is-resolved is-min" data-thread="${t.id}">
            <button class="c-thr-min" type="button" data-act="thr-expand" data-thread="${t.id}">
              ${icon("resolve")}<span class="c-thr-min-l">Resolved</span
              >${ctx === "timeline" ? html`<span class="c-thr-min-p">${splitPath(t.path)[1]}</span>` : ""}<span
                class="trunc c-thr-min-q"
                >${first.author}: ${firstLine(first.body)}</span
              >${icon("chevron-down", { cls: "c-thr-min-c" })}
            </button>
          </div>`;
        }
        const [dir, name] = splitPath(t.path);
        const p = cur();
        const replying = ui.reply === t.id;
        return html`<div
          class="c-thr ${t.pending ? "is-pending" : ""} ${t.isResolved ? "is-resolved" : ""} ${t.isOutdated ? "is-outdated" : ""}"
          data-thread="${t.id}"
        >
          ${
            ctx === "timeline"
              ? html`<button
                    class="c-thr-path"
                    type="button"
                    data-act="thr-open-file"
                    data-thread="${t.id}"
                    data-tip="Open in Files"
                  >
                    ${icon("file")}${pathHTML(t.path)}${t.line != null ? html`<span class="ln tnum">L${t.line}</span>` : ""}${t.isOutdated ? html`<span class="c-tag">Outdated</span>` : ""}</button
                  >${hunkExcerpt(t)}`
              : ""
          }
          <div class="c-thr-cs">${t.comments.map((c) => threadCommentHTML(c, t, p))}</div>
          ${
            t.pending
              ? html`<div class="c-thr-f">
                  <span class="c-tag pend">Pending</span><span class="sp"></span
                  ><button
                    class="btn sm ghost"
                    type="button"
                    data-act="pending-del"
                    data-thread="${t.id}"
                  >
                    ${icon("trash")}Delete
                  </button>
                </div>`
              : replying
                ? html`<form class="c-thr-reply" data-form="reply" data-thread="${t.id}">
                    <textarea
                      class="input"
                      rows="3"
                      placeholder="Reply…"
                      aria-label="Reply"
                    ></textarea>
                    <div class="c-cmp-acts">
                      <span class="c-hint">Markdown · ⌘↵ to send</span><span class="sp"></span
                      ><button class="btn sm ghost" type="button" data-act="reply-cancel">
                        Cancel</button
                      ><button class="btn sm pri" type="submit">Reply</button>
                    </div>
                  </form>`
                : html`<div class="c-thr-f">
                    <button class="c-thr-rin" type="button" data-act="reply" data-thread="${t.id}">
                      Reply…
                    </button>
                    <button
                      class="ib sm c-quiet"
                      type="button"
                      data-act="ask-thread"
                      data-thread="${t.id}"
                      data-tip="Ask agent about this thread"
                    >
                      ${icon("sparkle")}
                    </button>
                    <button class="btn sm" type="button" data-act="resolve" data-thread="${t.id}">
                      ${t.isResolved ? "Unresolve" : "Resolve"}
                    </button>
                  </div>`
          }
        </div>`;
      }
      function threadCommentHTML(c, t, p) {
        const hasSug = /```suggestion/.test(c.body || "");
        const canCommit = hasSug && !t.isResolved && mine(p) && p.state === "open";
        return html`<div class="c-tc" data-comment="${c.id}">
          <div class="c-tc-h">
            ${L.avatar(c.author, { size: 20 })}${actorB(c.author)}${c.createdAt ? timeT(c.createdAt) : ""}
          </div>
          <div class="md c-tc-b">
            ${L.markdown(c.body, { suggestionBase: t.lineText, suggestionLine: t.line || t.originalLine })}
          </div>
          ${canCommit ? html`<div class="c-sug-acts"><button class="btn sm" type="button" data-act="commit-suggestion" data-thread="${t.id}">${icon("check")}Commit suggestion</button></div>` : ""}
          ${t.pending ? "" : reactionsHTML(c)}
        </div>`;
      }
      function composerHTML(p) {
        return html`<form class="c-compose c-rv" data-rv="compose" data-form="comment">
          <span class="c-ti-n">${L.avatar(VIEWER, { size: 24 })}</span>
          <div class="c-compose-box">
            <textarea
              class="c-compose-t"
              rows="1"
              placeholder="${p.state === "open" ? "Add to the conversation…" : "Comment on this pull request…"}"
              aria-label="Comment"
            ></textarea>
            <div class="disc c-compose-acts-w">
              <div>
                <div class="c-cmp-acts">
                  <span class="c-hint">Markdown · ⌘↵ to send</span
                  ><span class="sp"></span
                  >${p.state === "open" && mine(p) ? html`<button class="btn sm ghost" type="button" data-act="close-pr">Close pull request</button>` : ""}<button
                    class="btn sm pri"
                    type="submit"
                  >
                    Comment
                  </button>
                </div>
              </div>
            </div>
          </div>
        </form>`;
      }
      function convHTML(p, d) {
        const items = timelineItems(d);
        const desc = ui.editBody
          ? html`<form class="c-desc-edit" data-form="body">
              <textarea class="input" rows="14" aria-label="Description">${d.body}</textarea>
              <div class="c-cmp-acts">
                <span class="c-hint">Markdown</span><span class="sp"></span
                ><button class="btn sm ghost" type="button" data-act="body-cancel">Cancel</button
                ><button class="btn sm pri" type="submit">Save</button>
              </div>
            </form>`
          : html`<div class="c-desc md">${L.markdown(d.body)}</div>
              ${mine(p) && p.state === "open" ? html`<button class="btn sm ghost c-desc-ed" type="button" data-act="edit-body">${icon("edit")}Edit</button>` : ""}`;
        return html`<div class="c-conv">
          <section class="c-desc-w c-rv" data-rv="desc">${desc}</section>
          <div class="c-sec-h c-rv" data-rv="activity"><span>Activity</span></div>
          <ol class="c-tl">
            ${items.map((it) => tlItemHTML(it, p, d))}
          </ol>
          ${composerHTML(p)}
        </div>`;
      }

      /* checks */
      function checksHTML(p, d) {
        const C = M.checks(d);
        if (!C.workflows.length && !C.statuses.length)
          return html`<div class="c-blank c-rv" data-rv="ck-none">
            ${L.checkGlyph("none", { size: 16, tip: false })}
            <p>${C.note || "No checks have reported for this pull request."}</p>
          </div>`;
        const head = d.headSha || p.headSha;
        return html`<div class="c-checks">
          <div class="c-sec-h c-rv" data-rv="ck-h">
            <span>Checks for <code>${String(head).slice(0, 7)}</code></span>
          </div>
          ${C.workflows.map((w) => wfHTML(w))}
          ${
            C.statuses.length
              ? html`<section class="c-wf c-rv" data-rv="statuses">
                  <div class="c-wf-h"><h3>Commit statuses</h3></div>
                  <ul class="c-jobs">
                    ${C.statuses.map(
                      (s) =>
                        html`<li class="c-job">
                          <a class="c-job-h" href="${s.url}" target="_blank" rel="noreferrer"
                            >${L.checkGlyph(s.state, { size: 14, tip: false })}<span class="nm"
                              >${s.name}</span
                            ><span class="c-job-d">${s.description}</span
                            ><span class="sp"></span>${icon("external", { cls: "c-job-x" })}</a
                          >
                        </li>`,
                    )}
                  </ul>
                </section>`
              : ""
          }
        </div>`;
      }
      function wfHTML(w) {
        const failed = w.jobs.filter((j) => L.runKind(j) === "fail");
        const running = w.jobs.some((j) => ["run", "queued"].includes(L.runKind(j)));
        return html`<section class="c-wf c-rv" data-rv="${w.id}" data-wf="${w.id}">
          <div class="c-wf-h">
            <h3>${w.name}</h3>
            <span class="c-wf-m tnum"
              >#${w.runNumber}${w.attempt > 1 ? ` · attempt ${w.attempt}` : ""} ·
              ${w.event}${w.durationSec && !running ? " · " + L.dur(w.durationSec) : ""}</span
            >
            <span class="sp"></span>
            ${
              failed.length && !running
                ? html`<button
                    class="btn sm"
                    type="button"
                    data-act="rerun-failed"
                    data-wf="${w.id}"
                  >
                    ${icon("rerun")}Re-run failed
                  </button>`
                : html`<button
                    class="ib sm"
                    type="button"
                    data-act="rerun-all"
                    data-wf="${w.id}"
                    data-tip="Re-run all jobs"
                    ${running ? raw('aria-disabled="true"') : ""}
                  >
                    ${icon("rerun")}
                  </button>`
            }
            <a
              class="ib sm"
              href="${w.url}"
              target="_blank"
              rel="noreferrer"
              data-tip="Open run on GitHub"
              >${icon("external")}</a
            >
          </div>
          <ul class="c-jobs">
            ${w.jobs.map((j) => jobHTML(j))}
          </ul>
        </section>`;
      }
      function mainStepN(j) {
        const cmd = (j.log?.[0] || "").replace(/^\$\s*/, "");
        const failing = j.steps.find((s) => L.runKind(s) === "fail");
        if (failing) return failing.n;
        const m = j.steps.find((s) => cmd && s.name === cmd);
        return m ? m.n : null;
      }
      function jobHTML(j) {
        const k = L.runKind(j);
        const open = ui.openJobs.has(j.id);
        const main = mainStepN(j);
        return html`<li
          class="c-job k-${k} ${open ? "open" : ""} ${st.job === j.id ? "focus" : ""}"
          data-job="${j.id}"
        >
          <button
            class="c-job-h"
            type="button"
            data-act="job"
            data-job="${j.id}"
            aria-expanded="${String(open)}"
          >
            ${L.checkGlyph(j, { size: 14, tip: false })}<span class="nm">${j.name}</span
            >${j.required ? html`<span class="c-req">Required</span>` : ""} <span class="sp"></span
            ><span class="dur tnum"
              >${k === "run" ? "Running…" : k === "queued" ? "Queued" : L.dur(j.durationSec)}</span
            >${icon("chevron", { cls: "chev" })}
          </button>
          <div class="disc ${open ? "open" : ""}">
            <div>
              <div class="c-job-b">
                <ol class="c-steps">
                  ${j.steps.map((s) => stepHTML(s, j, main))}
                </ol>
                <div class="c-job-acts">
                  ${k === "fail" ? html`<button class="chip agent" type="button" data-act="fix-job" data-job="${j.id}">${icon("sparkle")}Fix with agent</button>` : ""}
                  <button
                    class="chip"
                    type="button"
                    data-act="rerun-job"
                    data-job="${j.id}"
                    ${["run", "queued"].includes(k) ? raw('aria-disabled="true"') : ""}
                  >
                    ${icon("rerun")}Re-run job
                  </button>
                  <a class="chip" href="${j.url}" target="_blank" rel="noreferrer"
                    >${icon("external")}View on GitHub</a
                  >
                </div>
              </div>
            </div>
          </div>
        </li>`;
      }
      function stepHTML(s, j, main) {
        const k = L.runKind(s);
        const hasLog = j.log && j.log.length && s.n === main && !["run", "queued"].includes(k);
        const key = `${j.id}:${s.n}`;
        const open = hasLog && ui.openSteps.has(key);
        return html`<li class="c-step k-${k} ${open ? "open" : ""} ${hasLog ? "has-log" : ""}">
          <button
            class="c-step-h"
            type="button"
            data-act="step"
            data-key="${key}"
            ${hasLog ? "" : raw("disabled")}
            aria-expanded="${String(!!open)}"
          >
            ${L.checkGlyph(s, { size: 12, tip: false })}<span class="n tnum">${s.n}</span
            ><span class="nm trunc">${s.name}</span
            ><span class="sp"></span>${hasLog ? icon("terminal", { cls: "c-step-log" }) : ""}<span
              class="dur tnum"
              >${k === "run" ? "…" : L.dur(s.durationSec)}</span
            >
          </button>
          ${hasLog ? html`<div class="disc ${open ? "open" : ""}"><div>${logHTML(j)}</div></div>` : ""}
        </li>`;
      }
      function logHTML(j) {
        const all = j.log;
        const start = Math.max(0, all.length - 34);
        const lines = all.slice(start);
        const cls = (l) =>
          /^\$ /.test(l)
            ? "cmd"
            : /(×|FAIL|Error|error:|##\[error\]|failed|Expected|Received|^\s*[-+] )/.test(l) &&
                !/✓/.test(l)
              ? "err"
              : /✓|passed|successful/.test(l)
                ? "ok"
                : "";
        const body = lines
          .map((l) => {
            let s = esc(l);
            s = s.replace(
              /((?:src|apps|packages)\/[\w./-]+\.(?:tsx?|jsx?)):(\d+):(\d+)/g,
              (m0, path, line) =>
                `<button class="c-loglink" type="button" data-act="log-link" data-path="${path}" data-line="${line}">${m0}</button>`,
            );
            return `<span class="log-l ${cls(l)}">${s || " "}</span>`;
          })
          .join("");
        return html`<div class="c-log">
          <div class="c-log-h">
            <span>Log${start ? ` · last ${lines.length} of ${all.length} lines` : ""}</span
            ><button
              class="ib sm"
              type="button"
              data-act="copy"
              data-copy="${all.join("\n")}"
              data-label="log"
              data-tip="Copy log"
            >
              ${icon("copy")}
            </button>
          </div>
          <div class="log" style="counter-reset: log ${start}">${raw(body)}</div>
        </div>`;
      }

      /* commits */
      function commitsHTML(p, d) {
        if (!d.commits.length)
          return html`<div class="c-blank c-rv" data-rv="cm-none">
            ${icon("commit")}
            <p>Commits aren't mocked for this pull request.</p>
          </div>`;
        const days = [];
        const pushes = d.timeline.filter((e) => e.kind === "force_pushed");
        for (const c of d.commits) {
          const day = L.fmtDate(c.committedAt, { time: false });
          let g = days[days.length - 1];
          if (!g || g.day !== day) days.push((g = { day, items: [] }));
          for (const fp of pushes)
            if (!fp._placed && Date.parse(fp.at) <= Date.parse(c.committedAt)) {
              fp._placed = true;
              g.items.push({ fp });
            }
          g.items.push({ c });
        }
        for (const fp of pushes) delete fp._placed;
        return html`<div class="c-commits">
          ${days.map(
            (g) => html`<section class="c-day c-rv" data-rv="${"day-" + g.day}">
              <div class="c-sec-h"><span>${g.day}</span></div>
              <ol class="c-cl">
                ${g.items.map((it) =>
                  it.fp
                    ? html`<li class="c-cfp">
                        ${icon("rerun")}<span
                          >${actorB(it.fp.actor)}
                          force-pushed${it.fp.note ? " · " + it.fp.note : ""}</span
                        >${timeT(it.fp.at)}
                      </li>`
                    : html`<li>
                        <button
                          class="c-commit ${st.commit === it.c.short ? "on" : ""}"
                          type="button"
                          data-act="commit-scope"
                          data-sha="${it.c.short}"
                          data-tip="Review this commit's files"
                        >
                          ${L.checkGlyph(it.c.checks || "none", { size: 14, tip: false })}<span
                            class="c-commit-m trunc"
                            >${it.c.message}</span
                          >
                          <span class="c-commit-a"
                            >${L.avatar(it.c.author, { size: 16, tip: false })}</span
                          ><code class="c-sha">${it.c.short}</code>${timeT(it.c.committedAt)}
                        </button>
                      </li>`,
                )}
              </ol>
            </section>`,
          )}
        </div>`;
      }

      /* ------------------------------------------------------ files sheet */
      function scopedFiles(d) {
        return st.commit ? d.files.filter((f) => (f.commits || []).includes(st.commit)) : d.files;
      }
      function treeHTML(nodes, depth, d) {
        return nodes.map((n) => {
          if (n.kind === "dir")
            return html`<li class="c-tn dir" style="--d:${depth}">
              <div class="c-tn-row">${icon("folder-open")}<span class="trunc">${n.name}</span></div>
              <ul>
                ${treeHTML(n.children, depth + 1, d)}
              </ul>
            </li>`;
          const f = n.file;
          const th = M.threadsFor(d, f.path).filter((t) => !t.isResolved).length;
          const stl = { added: "A", removed: "D", renamed: "R" }[f.status] || "M";
          return html`<li
            class="c-tn file ${f.viewed === "viewed" ? "viewed" : ""} ${st.file === f.path ? "cur" : ""}"
            style="--d:${depth}"
            data-path="${f.path}"
          >
            <button
              class="c-tn-row"
              type="button"
              data-act="tree-file"
              data-path="${f.path}"
              title="${f.path}"
            >
              <span class="c-fs s-${f.status}">${stl}</span
              ><span class="nm trunc">${n.name}</span
              >${th ? html`<span class="c-tn-th tnum">${icon("comment")}${th}</span>` : ""}
              <span
                class="c-vck"
                role="checkbox"
                aria-checked="${String(f.viewed === "viewed")}"
                data-act="viewed"
                data-path="${f.path}"
                data-tip="Mark viewed"
                data-kbd="V"
                >${raw(BOX_CHECK)}</span
              >
            </button>
          </li>`;
        });
      }
      function annoFor(ref, anchored, path) {
        const out = [];
        for (const t of anchored)
          if (t.side === ref.side && t.line === ref.line) out.push(threadHTML(t, "diff"));
        const c = ui.composer;
        if (c && c.path === path && c.side === ref.side && c.line === ref.line)
          out.push(lineComposerHTML(c));
        return out.length ? html`${out}` : null;
      }
      function lineComposerHTML(c) {
        const d = curD();
        const pend = pendingN(d);
        return html`<form class="c-cmp" data-form="line">
          <div class="c-cmp-h">
            ${L.avatar(VIEWER, { size: 20 })}<span
              >Comment on line <b class="tnum">${c.side === "LEFT" ? "L" : "R"}${c.line}</b></span
            >
          </div>
          <textarea
            class="input"
            rows="3"
            placeholder="Leave a comment · \`\`\`suggestion for a change"
            aria-label="Line comment"
          ></textarea>
          <div class="c-cmp-acts">
            <button
              class="chip"
              type="button"
              data-act="insert-suggestion"
              data-tip="Suggest a change to this line"
            >
              ${icon("file-diff")}Suggest
            </button>
            <span class="sp"></span>
            <button class="btn sm ghost" type="button" data-act="cmp-cancel">Cancel</button>
            ${pend ? "" : html`<button class="btn sm" type="submit" data-mode="single">Add single comment</button>`}
            <button class="btn sm pri" type="submit" data-mode="review">
              ${pend ? "Add review comment" : "Start a review"}
            </button>
          </div>
        </form>`;
      }
      function fileHTML(f, d, p) {
        const threads = M.threadsFor(d, f.path);
        const viewed = f.viewed === "viewed";
        const collapsed = viewed ? !ui.expandedViewed.has(f.path) : ui.collapsedFiles.has(f.path);
        const anchored = threads.filter((t) => t.line != null);
        const outdated = threads.filter((t) => t.line == null);
        const focusT = st.thread ? anchored.find((t) => t.id === st.thread) : null;
        const commentable = !st.commit && p.state === "open";
        const [dir, name] = splitPath(f.path);
        const rows = L.parsePatch(f.patch || "");
        const diff = collapsed
          ? ""
          : L.renderDiff(rows, {
              mode: st.view,
              path: f.path,
              wrap: true,
              commentable,
              annotate: (ref) => annoFor(ref, anchored, f.path),
              lineClass: (ref) => {
                const c = ui.composer;
                if (c && c.path === f.path && c.side === ref.side && c.line === ref.line)
                  return "sel";
                if (focusT && focusT.side === ref.side && focusT.line === ref.line)
                  return "sel has-thread";
                return anchored.some((t) => t.side === ref.side && t.line === ref.line)
                  ? "has-thread"
                  : "";
              },
            });
        const unresolved = threads.filter((t) => !t.isResolved).length;
        return html`<article
          class="c-file ${viewed ? "viewed" : ""} ${collapsed ? "collapsed" : ""}"
          data-path="${f.path}"
        >
          <header class="c-file-h">
            <button
              class="c-file-tog"
              type="button"
              data-act="file-toggle"
              data-path="${f.path}"
              aria-expanded="${String(!collapsed)}"
            >
              ${icon("chevron", { cls: "chev" })}<span class="c-file-p">${pathHTML(f.path)}</span
              >${f.status === "added" ? html`<span class="c-tag">New</span>` : ""}
            </button>
            <span class="sp"></span>
            ${unresolved ? html`<span class="c-file-th tnum" data-tip="${plural(unresolved, "unresolved thread")}">${icon("comment")}${unresolved}</span>` : ""}
            ${L.diffStat(f.additions, f.deletions)}
            <button
              class="c-viewed ${viewed ? "on" : ""}"
              type="button"
              role="checkbox"
              aria-checked="${String(viewed)}"
              data-act="viewed"
              data-path="${f.path}"
              data-tip="Mark viewed and fold"
              data-kbd="V"
            >
              <i class="c-box">${raw(BOX_CHECK)}</i><span>Viewed</span>
            </button>
            <button
              class="ib sm"
              type="button"
              data-act="file-more"
              data-path="${f.path}"
              data-tip="File actions"
            >
              ${icon("more")}
            </button>
          </header>
          <div class="disc ${collapsed ? "" : "open"}">
            <div class="c-file-b">
              ${
                outdated.length
                  ? html`<div class="c-outdated">
                      <div class="c-outdated-h">
                        ${icon("clock")}${plural(outdated.length, "outdated conversation")}
                      </div>
                      ${outdated.map((t) => threadHTML(t, "timeline"))}
                    </div>`
                  : ""
              }
              ${diff}
            </div>
          </div>
        </article>`;
      }
      function renderSheet(opts = {}) {
        const p = cur();
        const d = curD();
        if (!p) return;
        const diffs0 = $(".c-diffs", R.sheet);
        const keep = opts.keepScroll && diffs0 ? diffs0.scrollTop : null;
        const treeKeep = $(".c-tree-scroll", R.sheet)?.scrollTop || 0;
        const files = scopedFiles(d);
        const viewedN = files.filter((f) => f.viewed === "viewed").length;
        const tree = L.buildFileTree(files);
        R.sheet.classList.toggle("no-tree", !ui.tree);
        set(
          R.sheet,
          html`<aside class="c-tree" aria-label="File tree">
              <div class="c-tree-top">
                <label class="field c-tree-q"
                  >${icon("search")}<input
                    type="text"
                    placeholder="Filter files"
                    value="${ui.treeQ}"
                    aria-label="Filter files"
                    spellcheck="false"
                /></label>
                <div class="c-prog">
                  <span class="tnum"
                    ><b class="c-prog-n">${viewedN}</b> of ${files.length} viewed</span
                  ><i class="c-prog-bar"
                    ><i style="transform:scaleX(${files.length ? viewedN / files.length : 0})"></i
                  ></i>
                </div>
              </div>
              <div class="c-tree-scroll scroll">
                <ul class="c-tree-l">
                  ${treeHTML(tree, 0, d)}
                </ul>
              </div>
            </aside>
            <div class="c-diffs scroll">
              ${
                files.length
                  ? files.map((f) => fileHTML(f, d, p))
                  : html`<div class="c-blank">
                      ${icon("file-diff")}
                      <p>
                        ${d.synthetic ? "Files aren't mocked for this pull request." : "No files in this commit."}
                      </p>
                    </div>`
              }
              ${files.length ? html`<div class="c-diffs-end">${icon("check")}End of changes</div>` : ""}
            </div>`,
        );
        applyTreeFilter();
        const diffs = $(".c-diffs", R.sheet);
        if (keep != null) diffs.scrollTop = keep;
        $(".c-tree-scroll", R.sheet).scrollTop = treeKeep;
        diffs.addEventListener("scroll", onDiffScroll, { passive: true });
        const q = $(".c-tree-q input", R.sheet);
        q.addEventListener("input", () => {
          ui.treeQ = q.value;
          applyTreeFilter();
        });
      }
      function applyTreeFilter() {
        const q = ui.treeQ.trim().toLowerCase();
        for (const li of $$(".c-tn.file", R.sheet))
          li.hidden = !!q && !li.dataset.path.toLowerCase().includes(q);
        for (const li of $$(".c-tn.dir", R.sheet).reverse())
          li.hidden = !$$(":scope > ul > li", li).some((c) => !c.hidden);
      }
      let spyRaf = 0;
      function onDiffScroll() {
        R.selchip.hidden = true;
        if (spyRaf) return;
        spyRaf = requestAnimationFrame(() => {
          spyRaf = 0;
          const diffs = $(".c-diffs", R.sheet);
          if (!diffs) return;
          const top = diffs.getBoundingClientRect().top + 12;
          let curPath = null;
          for (const a of $$(".c-file", diffs)) {
            if (a.getBoundingClientRect().top <= top) curPath = a.dataset.path;
            else break;
          }
          curPath ||= $(".c-file", diffs)?.dataset.path || null;
          if (curPath !== st.file) {
            st.file = curPath;
            for (const li of $$(".c-tn.file", R.sheet))
              li.classList.toggle("cur", li.dataset.path === curPath);
          }
        });
      }
      function scrollToFile(path, opts = {}) {
        const diffs = $(".c-diffs", R.sheet);
        const a = diffs && $(`.c-file[data-path="${CSS.escape(path)}"]`, diffs);
        if (!a) return;
        const top = a.offsetTop;
        diffs.scrollTo({ top, behavior: opts.smooth && !reduced() ? "smooth" : "auto" });
        st.file = path;
        for (const li of $$(".c-tn.file", R.sheet))
          li.classList.toggle("cur", li.dataset.path === path);
      }
      function scrollToThread(id, scope) {
        const box = scope === "doc" ? R.doc : $(".c-diffs", R.sheet);
        const t = box && $(`.c-thr[data-thread="${CSS.escape(id)}"]`, box);
        if (!t) return false;
        const rb = box.getBoundingClientRect();
        const rt = t.getBoundingClientRect();
        box.scrollTop += rt.top - rb.top - Math.min(140, rb.height * 0.22);
        t.classList.remove("flash");
        void t.offsetWidth;
        t.classList.add("flash");
        return true;
      }
      function openSheet() {
        if (ui.treeAuto) {
          const want = R.detail.clientWidth >= 820;
          if (want !== ui.tree) {
            // an automatic tree change lands instantly so the diff never reflows under the reader
            R.sheet.classList.add("c-instant");
            later(() => R.sheet.classList.remove("c-instant"), 30);
          }
          ui.tree = want;
        }
        renderSheet();
        R.body.classList.add("files-on");
        R.sheet.inert = false;
        if (listMode() === "open" && lab.pageWidth() < 1500) {
          ui.listTemp = true;
          applyListMode();
        }
      }
      function closeSheet() {
        R.body.classList.remove("files-on");
        R.sheet.inert = true;
        R.selchip.hidden = true;
        if (ui.listTemp) {
          ui.listTemp = false;
          applyListMode();
          later(() => syncSel(true), 0);
        }
      }
      /* selection → quiet "Ask agent" chip */
      function onDiffMouseUp() {
        const sel = getSelection();
        if (!sel || sel.isCollapsed || !sel.rangeCount) return void (R.selchip.hidden = true);
        const range = sel.getRangeAt(0);
        const host =
          range.commonAncestorContainer.nodeType === 1
            ? range.commonAncestorContainer
            : range.commonAncestorContainer.parentElement;
        if (!host?.closest(".c-diffs .diff")) return void (R.selchip.hidden = true);
        const rr = range.getBoundingClientRect();
        const rb = R.body.getBoundingClientRect();
        R.selchip.hidden = false;
        R.selchip.style.left = `${Math.min(rr.right - rb.left + 6, rb.width - 120)}px`;
        R.selchip.style.top = `${rr.bottom - rb.top + 6}px`;
        R.selchip.dataset.text = sel.toString();
        R.selchip.dataset.path = host.closest(".c-file")?.dataset.path || "";
        if (!reduced())
          L.animate(
            R.selchip,
            [
              { opacity: 0, transform: "translateY(-3px) scale(.96)" },
              { opacity: 1, transform: "none" },
            ],
            { duration: "pop", easing: "snappy" },
          );
      }
      R.sheet.addEventListener("mouseup", () => setTimeout(onDiffMouseUp, 0));

      /* ------------------------------------------------------ pending review bar */
      let lastPend = -1;
      function renderRBar() {
        const p = cur();
        const d = curD();
        const n = pendingN(d);
        const show =
          !!p &&
          p.state === "open" &&
          (n > 0 || (st.tab === "files" && isRequested(p) && !mine(p)));
        R.rbar.classList.toggle("on", show);
        if (!show) {
          lastPend = -1;
          return;
        }
        set(
          R.rbar,
          html`<button
            class="c-rbar-b"
            type="button"
            data-act="review-open"
            aria-haspopup="dialog"
            data-kbd="R"
            data-tip="Finish your review"
          >
            ${n ? html`<span class="c-rbar-n tnum">${n}</span><span>pending ${n === 1 ? "comment" : "comments"}</span><i class="c-rbar-sep"></i>` : ""}<b>${n ? "Submit review" : "Finish your review"}</b>${icon("chevron-up")}
          </button>`,
        );
        if (lastPend >= 0 && n !== lastPend && !reduced()) {
          const num = $(".c-rbar-n", R.rbar);
          if (num)
            L.animate(
              num,
              [
                { transform: `translateY(${n > lastPend ? 8 : -8}px)`, opacity: 0 },
                { transform: "none", opacity: 1 },
              ],
              { duration: "stack", easing: "snappy" },
            );
        }
        lastPend = n;
      }
      /* lift the bar while a toast is up so they never overlap */
      const toastEl = $(".toast");
      const toastMO = toastEl
        ? new MutationObserver(() =>
            R.rbar.classList.toggle("lift", toastEl.classList.contains("on")),
          )
        : null;
      toastMO?.observe(toastEl, { attributes: true, attributeFilter: ["class"] });

      /* ------------------------------------------------------ PR selection + tabs */
      function initPRui(p) {
        const d = M.detail(p.number);
        ui.openJobs = new Set();
        ui.openSteps = new Set();
        for (const j of M.checks(d).jobs)
          if (L.runKind(j) === "fail") {
            ui.openJobs.add(j.id);
            const mn = mainStepN(j);
            if (mn) ui.openSteps.add(`${j.id}:${mn}`);
          }
        ui.composer = null;
        ui.reply = null;
        ui.editTitle = ui.editBody = false;
        ui.expandedViewed = new Set();
        ui.collapsedFiles = new Set();
        ui.treeQ = "";
        ui.reviewBody = "";
        ui.reviewEvent = "comment";
      }
      function openPR(n, opts = {}) {
        if (n === st.pr && !opts.force) return;
        const keep = opts.keepTab && st.tab !== "files" ? st.tab : "conversation";
        const patch = {
          pr: n,
          tab: keep === "conversation" ? null : keep,
          file: null,
          thread: null,
          commit: null,
          job: null,
          stack: null,
          merge: null,
          review: null,
        };
        st.tab = keep;
        st.file = st.thread = st.commit = st.job = null;
        setHash(patch, true);
        selectPR(n, opts);
      }
      function selectPR(n, opts = {}) {
        const p = n != null ? M.pr(n) : null;
        const prev = st.pr;
        st.pr = p ? p.number : null;
        L.closeLayers();
        markSelRows();
        if (!p) {
          R.detail.classList.add("is-empty");
          closeSheet();
          renderHead();
          R.doc.replaceChildren(emptyNode());
          R.grid = null;
          renderRBar();
          return;
        }
        R.detail.classList.remove("is-empty");
        if (prev !== st.pr || opts.force) {
          initPRui(p);
          opts.afterInit?.(p);
        }
        ui.bodyTab = BODY_TABS.includes(st.tab) ? st.tab : "conversation";
        renderHead();
        syncTabs();
        const grid = buildGrid();
        if ((opts.anim === "up" || opts.anim === "down") && R.doc.firstElementChild && !reduced()) {
          pushSwap(R.doc, grid, {
            axis: "y",
            dir: opts.anim === "up" ? -1 : 1,
            scroller: R.doc,
            targetScroll: 0,
          });
          armReveal(grid, { all: true });
        } else {
          R.doc.replaceChildren(grid);
          R.doc.scrollTop = 0;
          armReveal(grid);
        }
        if (st.tab === "files") {
          if (R.body.classList.contains("files-on")) renderSheet();
          else openSheet();
        } else closeSheet();
        renderRBar();
      }
      function emptyNode() {
        const n = h("div", "c-empty");
        n.innerHTML = String(
          html`<div class="c-empty-in">
            ${icon("pr-open", { size: 22 })}
            <h2>Choose a pull request</h2>
            <p>Pick one from the list, or paste a link into search.</p>
            <div class="c-empty-k">
              <span><kbd>J</kbd><kbd>K</kbd> move</span><span><kbd>/</kbd> search</span
              ><span><kbd>?</kbd> shortcuts</span>
            </div>
          </div>`,
        );
        return n;
      }
      /* lockstep push of the old and new content (never a cross-fade); keeps the old content where the reader saw it */
      function pushSwap(container, node, { axis = "x", dir = 1, scroller, targetScroll } = {}) {
        const sc = scroller || container;
        const olds = [...container.childNodes];
        if (reduced() || !olds.length || !container.isConnected) {
          container.replaceChildren(node);
          if (targetScroll != null) sc.scrollTop = targetScroll;
          return Promise.resolve();
        }
        const st0 = sc.scrollTop;
        const top0 = container.getBoundingClientRect().top;
        const w = container.getBoundingClientRect().width;
        const out = h("div", "c-push-out");
        out.append(...olds);
        const inn = h("div", "c-push-in");
        inn.append(node);
        container.classList.add("c-pushing");
        container.append(out, inn);
        if (targetScroll != null) sc.scrollTop = targetScroll;
        if (sc === container) out.style.top = `${-st0}px`;
        else out.style.top = `${top0 - container.getBoundingClientRect().top}px`;
        const dist = axis === "x" ? w : sc.clientHeight;
        const ax = axis === "x" ? "X" : "Y";
        const o = { duration: "pane", easing: "ease", fill: "both" };
        const a1 = L.animate(
          out,
          [{ transform: "none" }, { transform: `translate${ax}(${-dir * dist}px)` }],
          o,
        );
        const a2 = L.animate(
          inn,
          [{ transform: `translate${ax}(${dir * dist}px)` }, { transform: "none" }],
          o,
        );
        return Promise.all([a1, a2].filter(Boolean).map((a) => a.finished.catch(() => {}))).then(
          () => {
            out.remove();
            if (inn.isConnected) inn.replaceWith(...inn.childNodes);
            container.classList.remove("c-pushing");
          },
        );
      }
      function setTab(tab, opts = {}) {
        if (!cur()) return;
        const prev = st.tab;
        if (prev === tab && !opts.force) return;
        st.tab = tab;
        syncTabs();
        renderHeadTools();
        if (!opts.fromHash)
          setHash(
            {
              tab: tab === "conversation" ? null : tab,
              file: null,
              thread: tab === "files" ? st.thread : null,
              job: tab === "checks" ? st.job : null,
            },
            true,
          );
        if (tab === "files") {
          openSheet();
          renderRBar();
          if (st.thread) later(() => scrollToThread(st.thread, "sheet"), 30);
          else if (st.file) later(() => scrollToFile(st.file), 30);
          return;
        }
        const fromFiles = prev === "files";
        if (ui.bodyTab !== tab) {
          const p = cur();
          const d = curD();
          const dir = BODY_TABS.indexOf(tab) > BODY_TABS.indexOf(ui.bodyTab) ? 1 : -1;
          ui.bodyTab = tab;
          const node = h("div", "c-body-in");
          node.innerHTML = String(bodyHTML(tab, p, d));
          const mastBottom = R.mast.offsetTop + R.mast.offsetHeight;
          const target = Math.min(R.doc.scrollTop, Math.max(0, mastBottom - 8));
          if (fromFiles || reduced()) {
            R.docbody.replaceChildren(...node.childNodes);
            R.doc.scrollTop = target;
            armReveal(R.docbody, { all: true });
          } else {
            pushSwap(R.docbody, node, {
              axis: "x",
              dir,
              scroller: R.doc,
              targetScroll: target,
            }).then(() => {
              const inner = $(".c-body-in", R.docbody);
              if (inner) inner.replaceWith(...inner.childNodes);
            });
            armReveal(R.docbody, { instantVisible: true });
          }
        }
        if (fromFiles) closeSheet();
        renderRBar();
        if (tab === "checks" && st.job) later(() => focusJob(st.job), fromFiles ? 0 : 40);
      }

      /* re-render after a mutation, keeping scroll, motion only for what changed */
      function refresh(o = {}) {
        const {
          list = true,
          mast = true,
          rail = true,
          body = true,
          sheet = false,
          head = true,
        } = o;
        if (list) renderList({ flip: true });
        const p = cur();
        if (!p || !R.grid) return;
        const d = curD();
        if (head) {
          const prevTab = st.tab;
          renderHead();
          st.tab = prevTab;
          syncTabs();
        }
        if (mast) renderMast(p, d);
        if (rail) renderRail(p, d, { morph: true });
        if (body) {
          const sc = R.doc.scrollTop;
          set(R.docbody, bodyHTML(ui.bodyTab, p, d));
          R.doc.scrollTop = sc;
          armReveal(R.grid);
        } else armReveal(R.mast);
        if (sheet && st.tab === "files") renderSheet({ keepScroll: true });
        renderRBar();
      }

      /* ------------------------------------------------------ navigation helpers */
      function gotoFailing() {
        const d = curD();
        const j = M.checks(d).jobs.find((x) => L.runKind(x) === "fail");
        st.job = j?.id || null;
        if (j) {
          ui.openJobs.add(j.id);
          const mn = mainStepN(j);
          if (mn) ui.openSteps.add(`${j.id}:${mn}`);
        }
        setHash({ job: st.job });
        if (st.tab === "checks") focusJob(st.job);
        else setTab("checks");
      }
      function focusJob(id) {
        if (!id) return;
        const li = $(`.c-job[data-job="${CSS.escape(id)}"]`, R.docbody);
        if (!li) return;
        if (!ui.openJobs.has(id)) {
          ui.openJobs.add(id);
          li.classList.add("open");
          $(":scope > .disc", li)?.classList.add("open");
        }
        for (const x of $$(".c-job.focus", R.docbody)) x.classList.remove("focus");
        li.classList.add("focus");
        const rb = R.doc.getBoundingClientRect();
        const r = li.getBoundingClientRect();
        if (r.top < rb.top + 40 || r.top > rb.bottom - 120)
          R.doc.scrollTo({
            top: R.doc.scrollTop + r.top - rb.top - 24,
            behavior: reduced() ? "auto" : "smooth",
          });
      }
      function gotoThread(dirn = 1) {
        const d = curD();
        const open = M.threadsFor(d).filter((t) => !t.isResolved && !t.pending && t.line != null);
        if (!open.length) return L.toast("No unresolved conversations");
        const i = open.findIndex((t) => t.id === st.thread);
        const t = open[(i + (dirn > 0 ? 1 : -1) + open.length) % open.length] || open[0];
        st.thread = t.id;
        const f = d.files.find((x) => x.path === t.path);
        if (f && f.viewed === "viewed") ui.expandedViewed.add(f.path);
        setHash({ thread: t.id });
        if (st.tab !== "files") setTab("files");
        else {
          renderSheet({ keepScroll: true });
          later(() => scrollToThread(t.id, "sheet"), 0);
        }
      }
      function stackStep(delta) {
        const p = cur();
        if (!p?.stack) return;
        const s = M.stackOf(p);
        const next = s.entries.find((e) => e.stack.position === p.stack.position + delta);
        if (next) openPR(next.number, { anim: delta > 0 ? "up" : "down", keepTab: true });
      }
      function moveList(delta) {
        const rows = $$(".c-row", R.rows).filter((r) => !r.closest(".disc:not(.open)"));
        if (!rows.length) return;
        const i = rows.findIndex((r) => Number(r.dataset.pr) === st.pr);
        const next = rows[Math.max(0, Math.min(rows.length - 1, i < 0 ? 0 : i + delta))];
        openPR(Number(next.dataset.pr));
        next.scrollIntoView({ block: "nearest" });
      }

      /* ------------------------------------------------------ layers: stack, merge, review, pickers */
      function stackNavNode(p) {
        const s = M.stackOf(p);
        const top = [...s.entries].reverse();
        const a = s.assessment;
        const aTone = { ready: "ok", blocked: "err", pending: "warn", merged: "merged" }[a.state];
        const node = h("div", "c-stk");
        node.innerHTML = String(html`<div class="c-stk-h">
            <div class="c-stk-t">
              ${icon("stack")}<b>Stack #${s.number}</b
              ><span class="dim">${s.size} layers into <code>${s.baseRefName}</code></span>
            </div>
            <div class="c-stk-a t-${aTone}">
              <i class="c-dotc"></i
              >${a.state === "ready" ? "Every layer can merge" : a.state === "merged" ? "Stack merged" : a.label}
            </div>
          </div>
          <ol class="c-stk-l">
            ${top.map((e) => {
              const na = M.nextAction(e);
              const plan = M.mergePlan(e.number);
              const isCur = e.number === p.number;
              const canMerge = e.state === "open" && !e.isDraft;
              return html`<li class="c-stk-i ${isCur ? "cur" : ""}">
                <button
                  class="c-stk-row"
                  type="button"
                  data-act="stack-go"
                  data-pr="${e.number}"
                  ${isCur ? raw('aria-current="page"') : ""}
                >
                  <span class="c-stk-g">${L.stateGlyph(e, { size: 14, tip: false })}</span>
                  <span class="c-stk-tx"
                    ><span class="c-stk-ti"><span class="tnum">#${e.number}</span> ${e.title}</span
                    ><span class="c-stk-na t-${na.tone}"
                      >${isCur ? "This pull request · " : ""}${shortAction(na)}</span
                    ></span
                  >
                </button>
                ${
                  canMerge
                    ? html`<button
                        class="btn sm c-stk-m"
                        type="button"
                        data-act="stack-merge"
                        data-pr="${e.number}"
                        ${plan.blockedBy ? raw(`aria-disabled="true" data-tip="${esc(`#${plan.blockedBy.pr.number}: ${plan.blockedBy.reason}`)}"`) : raw(`data-tip="${esc(`Merge ${plan.layers.map((l) => "#" + l.number).join(", ")} into ${plan.base}`)}"`)}
                      >
                        ${plan.layers.length > 1 ? `Merge ${plan.layers.length}` : "Merge"}
                      </button>`
                    : ""
                }
              </li>`;
            })}
            <li class="c-stk-base">
              <span class="c-stk-g"><i></i></span><code>${s.baseRefName}</code>
            </li>
          </ol>
          <div class="c-stk-f">
            <span><kbd>[</kbd><kbd>]</kbd> move between layers</span>
          </div>`);
        return node;
      }
      function openStackPop(fromHash) {
        const p = cur();
        if (!p?.stack) return;
        const anchor =
          st.tab === "files"
            ? $(".c-stk-chip", R.head)
            : $('.c-fact[data-k="stack"] .c-fact-h', R.rail);
        if (!anchor) return;
        const below = st.tab === "files" || narrow();
        L.popover.open(anchor, stackNavNode(p), {
          side: below ? "bottom" : "left",
          align: st.tab === "files" ? "end" : "start",
          offset: 12,
          width: 380,
          cls: "c-pop c-pop-stack",
          onClose: () => {
            if (lab.getHashState().stack) setHash({ stack: null });
          },
        });
        if (!fromHash) setHash({ stack: true });
      }
      function mergeMenuItems(p) {
        const items = [];
        const method = ui.method || D.repo.defaultMergeMethod;
        if (p.state === "open") {
          items.push({ head: "Merge method" });
          for (const m of ["squash", "rebase", "merge"])
            items.push({
              label: METHOD[m],
              checked: method === m,
              disabled: !D.repo.mergeMethods[m],
              reason: "Disabled in the repository settings",
              run: () => {
                ui.method = m;
                refresh({ list: false, body: false, mast: false, head: false });
              },
            });
          if (p.stack) {
            const s = M.stackOf(p);
            items.push({ sep: true }, { head: `Stack #${s.number}` });
            for (const e of [...s.entries].reverse()) {
              if (e.state !== "open") continue;
              const plan = M.mergePlan(e.number);
              items.push({
                label:
                  plan.layers.length > 1
                    ? `Merge stack through #${e.number} (${plan.layers.length})`
                    : `Merge #${e.number}`,
                sub: plan.blockedBy
                  ? `#${plan.blockedBy.pr.number}: ${plan.blockedBy.reason}`
                  : `Lands ${plan.layers.map((l) => "#" + l.number).join(", ")} into ${plan.base}`,
                icon: "stack",
                disabled: !!plan.blockedBy,
                run: () => doMerge(e.number),
              });
            }
          }
          items.push({ sep: true });
          if (D.repo.autoMergeAllowed)
            items.push(
              p.autoMerge
                ? { label: "Disable auto-merge", icon: "clock", run: autoMergeOff }
                : {
                    label: "Enable auto-merge",
                    sub: "Merge when every requirement passes",
                    icon: "clock",
                    run: autoMergeOn,
                  },
            );
          items.push({
            label: "Update branch",
            sub:
              p.mergeStateStatus === "BEHIND"
                ? `${p.behindBy || "Some"} commits behind ${p.baseRefName}`
                : `Up to date with ${p.baseRefName}`,
            icon: "update-branch",
            disabled: p.mergeStateStatus !== "BEHIND",
            reason: "Already up to date",
            run: updateBranch,
          });
          items.push({ sep: true });
          items.push(
            p.isDraft
              ? { label: "Mark ready for review", icon: "eye", run: markReady }
              : { label: "Convert to draft", icon: "pr-draft", run: toDraft },
          );
          items.push({
            label: "Close pull request",
            icon: "pr-closed",
            danger: true,
            run: closePR,
          });
        } else if (p.state === "closed") {
          items.push({ label: "Reopen pull request", icon: "pr-open", run: reopen });
        } else {
          items.push(
            p.branchDeleted
              ? { label: "Restore branch", icon: "branch", run: restoreBranch }
              : { label: "Delete branch", icon: "trash", danger: true, run: deleteBranch },
          );
        }
        return items;
      }
      function openMergeMenu(fromHash) {
        const p = cur();
        if (!p) return;
        const anchor =
          st.tab === "files"
            ? $('.c-head-tools [data-act="more"]', R.head)
            : $(".c-act-more", R.actblk);
        if (!anchor) return;
        L.menu.open(anchor, mergeMenuItems(p), {
          align: "end",
          minWidth: 300,
          onClose: () => {
            if (lab.getHashState().merge) setHash({ merge: null });
          },
        });
        if (!fromHash) setHash({ merge: true });
      }
      function openReviewPop(fromHash) {
        const anchor = $(".c-rbar-b", R.rbar);
        const p = cur();
        const d = curD();
        if (!anchor || !p) return;
        const n = pendingN(d);
        const own = mine(p);
        if (own && ui.reviewEvent !== "comment") ui.reviewEvent = "comment";
        const node = h("div", "c-rvp");
        node.innerHTML = String(html`<div class="c-rvp-h">
            <b>Finish your review</b
            ><span class="dim tnum"
              >${n ? plural(n, "pending comment") : "No line comments yet"}</span
            >
          </div>
          <textarea
            class="input c-rvp-t"
            rows="3"
            placeholder="Leave a summary (optional)"
            aria-label="Review summary"
          >
${ui.reviewBody}</textarea>
          <div class="c-rvp-o" role="radiogroup" aria-label="Review verdict">
            ${[
              ["comment", "Comment", "General feedback without a verdict"],
              ["approve", "Approve", "These changes are good to merge"],
              ["request", "Request changes", "Must be addressed before merging"],
            ].map(
              ([v, l, s]) =>
                html`<button
                  class="c-rvp-i ${ui.reviewEvent === v ? "on" : ""} v-${v}"
                  type="button"
                  role="radio"
                  data-v="${v}"
                  aria-checked="${String(ui.reviewEvent === v)}"
                  ${own && v !== "comment" ? raw(`aria-disabled="true" data-tip="Authors can't ${v === "approve" ? "approve" : "request changes on"} their own pull request"`) : ""}
                >
                  <i class="c-radio"></i><span class="c-rvp-tx"><b>${l}</b><span>${s}</span></span>
                </button>`,
            )}
          </div>
          <div class="c-rvp-f">
            <button class="btn sm ghost" type="button" data-r="discard" ${n ? "" : raw("disabled")}>
              Discard</button
            ><span class="sp"></span
            ><button class="btn pri" type="button" data-r="submit">
              Submit review<kbd>⌘↵</kbd>
            </button>
          </div>`);
        const ta = $(".c-rvp-t", node);
        ta.addEventListener("input", () => (ui.reviewBody = ta.value));
        node.addEventListener("click", (e) => {
          const opt = e.target.closest(".c-rvp-i");
          if (opt && !opt.getAttribute("aria-disabled")) {
            ui.reviewEvent = opt.dataset.v;
            for (const b of $$(".c-rvp-i", node)) {
              b.classList.toggle("on", b === opt);
              b.setAttribute("aria-checked", String(b === opt));
            }
          }
          const r = e.target.closest("[data-r]");
          if (r?.dataset.r === "submit") submitReview();
          else if (r?.dataset.r === "discard") discardReview();
        });
        ta.addEventListener("keydown", (e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submitReview();
          }
        });
        L.popover.open(anchor, node, {
          side: "top",
          align: "center",
          offset: 10,
          width: 360,
          cls: "c-pop",
          onClose: () => {
            if (lab.getHashState().review) setHash({ review: null });
          },
        });
        if (!fromHash) setHash({ review: true });
        setTimeout(() => ta.focus({ preventScroll: true }), 30);
      }
      function pickerOptions(kind, p, d) {
        if (kind === "labels")
          return Object.values(D.labels).map((l) => ({
            value: l.name,
            label: l.name,
            sub: l.description,
            on: p.labels.includes(l.name),
            lead: raw(`<i class="c-pick-dot" style="--lc:#${l.color}"></i>`),
            search: (l.name + " " + l.description).toLowerCase(),
          }));
        const users = Object.values(D.users).filter((u) => !u.bot);
        if (kind === "assignees")
          return users.map((u) => ({
            value: u.login,
            label: u.login === VIEWER ? `${u.login} (you)` : u.login,
            sub: u.name,
            on: (p.assignees || []).includes(u.login),
            lead: L.avatar(u.login, { size: 20, tip: false }),
            search: (u.login + " " + u.name).toLowerCase(),
          }));
        const revs = p.reviewers || [];
        const teams = Object.values(D.teams).map((t) => ({
          login: t.slug,
          name: `Team · ${t.members.length} members`,
          team: true,
        }));
        return [...users.filter((u) => u.login !== p.author), ...teams].map((u) => {
          const r = revs.find((x) => x.login === u.login);
          const reviewed = r && r.state !== "pending";
          return {
            value: u.login,
            label: u.team ? "@" + u.login : u.login === VIEWER ? `${u.login} (you)` : u.login,
            sub: reviewed
              ? `${{ approved: "Approved", changes_requested: "Requested changes", commented: "Commented" }[r.state] || "Reviewed"} · can't be withdrawn`
              : u.name,
            on: !!r,
            locked: reviewed,
            lead: L.avatar(u.login, { size: 20, tip: false }),
            trail: reviewed ? L.reviewGlyph(r.state, { size: 13, tip: false }) : "",
            search: (u.login + " " + (u.name || "")).toLowerCase(),
          };
        });
      }
      function pickerPop(anchor, kind) {
        const p = cur();
        const d = curD();
        if (!anchor || !p) return;
        const node = h("div", "c-pick");
        const PH = {
          reviewers: "Request a reviewer or team",
          labels: "Filter labels",
          assignees: "Assign someone",
        };
        node.innerHTML = String(
          html`<div class="c-pick-h">
              <label class="field"
                >${icon("search")}<input
                  type="text"
                  placeholder="${PH[kind]}"
                  aria-label="${PH[kind]}"
                  spellcheck="false"
              /></label>
            </div>
            <div class="c-pick-l" role="listbox" aria-multiselectable="true"></div>`,
        );
        const list = $(".c-pick-l", node);
        const inp = $("input", node);
        const draw = () => {
          const q = inp.value.trim().toLowerCase();
          const opts = pickerOptions(kind, p, d).filter((o) => !q || o.search.includes(q));
          set(
            list,
            html`${opts.map(
              (o) =>
                html`<button
                  class="c-pick-o ${o.on ? "on" : ""} ${o.locked ? "locked" : ""}"
                  type="button"
                  role="option"
                  aria-selected="${String(o.on)}"
                  data-v="${o.value}"
                  ${o.locked ? raw('aria-disabled="true"') : ""}
                >
                  <span class="c-pick-ck">${raw(BOX_CHECK)}</span>${o.lead}<span class="c-pick-tx"
                    ><span>${o.label}</span
                    >${o.sub ? html`<span class="sub">${o.sub}</span>` : ""}</span
                  >${o.trail || ""}
                </button>`,
            )}${opts.length ? "" : html`<div class="c-pick-empty">No matches</div>`}`,
          );
        };
        draw();
        inp.addEventListener("input", draw);
        inp.addEventListener("keydown", (e) => {
          if (e.key === "Enter") $(".c-pick-o:not([aria-disabled])", list)?.click();
        });
        list.addEventListener("click", (e) => {
          const b = e.target.closest(".c-pick-o");
          if (!b || b.getAttribute("aria-disabled")) return;
          togglePick(kind, b.dataset.v);
          draw();
        });
        L.popover.open(anchor, node, {
          side: narrow() ? "bottom" : "left",
          align: "start",
          offset: 12,
          width: 300,
          cls: "c-pop",
        });
        setTimeout(() => inp.focus({ preventScroll: true }), 30);
      }
      function togglePick(kind, v) {
        const p = cur();
        const d = curD();
        const before = new Set(
          kind === "labels"
            ? p.labels
            : kind === "assignees"
              ? p.assignees
              : (p.reviewers || []).map((r) => r.login),
        );
        if (kind === "labels") {
          const on = p.labels.includes(v);
          p.labels = on ? p.labels.filter((x) => x !== v) : [...p.labels, v];
          d.timeline.push({
            id: nid("lbl"),
            kind: on ? "unlabeled" : "labeled",
            actor: VIEWER,
            at: stamp(),
            label: v,
          });
        } else if (kind === "assignees") {
          const on = (p.assignees || []).includes(v);
          p.assignees = on ? p.assignees.filter((x) => x !== v) : [...(p.assignees || []), v];
          d.timeline.push({
            id: nid("asg"),
            kind: on ? "unassigned" : "assigned",
            actor: VIEWER,
            at: stamp(),
            assignee: v,
          });
        } else {
          const on = (p.reviewers || []).some((r) => r.login === v);
          if (on) {
            p.reviewers = p.reviewers.filter((r) => r.login !== v);
            if (d.reviewers) d.reviewers = d.reviewers.filter((r) => r.login !== v);
            d.timeline.push({
              id: nid("rr"),
              kind: "review_request_removed",
              actor: VIEWER,
              at: stamp(),
              reviewer: v,
            });
          } else {
            const team = !!D.teams[v];
            p.reviewers = [
              ...(p.reviewers || []),
              { login: v, state: "pending", submittedAt: null },
            ];
            if (d.reviewers && !d.synthetic)
              d.reviewers = [
                ...d.reviewers,
                { login: v, state: "pending", submittedAt: null, requested: true, team },
              ];
            d.timeline.push({
              id: nid("rr"),
              kind: "review_requested",
              actor: VIEWER,
              at: stamp(),
              reviewer: v,
            });
            if (!p.reviewDecision && !p.isDraft) p.reviewDecision = "review_required";
          }
        }
        refresh({ list: kind === "reviewers", sheet: false });
        // pop the chips/rows that just appeared
        const k = kind === "reviewers" ? "reviews" : kind;
        const fresh = $$(
          `.c-fact[data-k="${k}"] .lbl, .c-fact[data-k="${k}"] .c-rev-r, .c-fact[data-k="${k}"] .c-asg-i`,
          R.rail,
        );
        const after =
          kind === "labels"
            ? p.labels
            : kind === "assignees"
              ? p.assignees
              : p.reviewers.map((r) => r.login);
        fresh.forEach((el, i) => {
          if (!before.has(after[i])) el.classList.add("pop-in");
        });
      }
      function openConflicts(e) {
        const p = cur();
        const anchor = e?.currentTarget || R.actMain;
        const node = h("div", "c-cfl");
        node.innerHTML = String(html`<div class="c-cfl-h">
            ${icon("alert")}<b>Conflicts with <code>${p.baseRefName}</code></b>
          </div>
          <p>
            GitHub can't merge <code>${p.headRefName}</code> automatically. Resolve the conflicting
            hunks locally or in a worktree, then push.
          </p>
          <div class="c-cfl-a">
            <button class="chip agent" type="button" data-cfl="agent">
              ${icon("sparkle")}Resolve with agent</button
            ><span class="sp"></span
            ><button class="btn sm" type="button" data-cfl="worktree">
              ${icon("terminal")}Check out in a worktree
            </button>
          </div>`);
        node.addEventListener("click", (ev) => {
          const b = ev.target.closest("[data-cfl]");
          if (!b) return;
          L.popover.close();
          if (b.dataset.cfl === "agent") handoff("resolve-conflicts");
          else L.toast(`Checked out #${p.number} into a new worktree`, { tone: "ok" });
        });
        L.popover.open(anchor, node, {
          side: "left",
          align: "start",
          offset: 12,
          width: 320,
          cls: "c-pop",
        });
      }
      function moreMenu(anchor) {
        const p = cur();
        if (!p) return;
        const items = [
          { label: "Copy link", icon: "link", kbd: "", run: () => L.copy(p.url, "link") },
          {
            label: "Open on GitHub",
            icon: "external",
            run: () => window.open(p.url, "_blank", "noreferrer"),
          },
          {
            label: "Check out in a worktree",
            icon: "branch",
            run: () => L.toast(`Checked out ${p.headRefName} into a new worktree`, { tone: "ok" }),
          },
          {
            label: "Ask agent about this pull request",
            icon: "sparkle",
            run: () => handoff("ask-pr"),
          },
          { sep: true },
        ];
        if (st.tab === "files" && p.state === "open")
          items.push({
            label: "Merge options…",
            icon: "pr-merged",
            kbd: "M",
            run: () => openMergeMenu(),
          });
        if (mine(p) && p.state === "open")
          items.push({
            label: "Edit title",
            icon: "edit",
            run: () => {
              setTab("conversation");
              ui.editTitle = true;
              renderMast();
            },
          });
        if (p.state === "open")
          items.push(
            p.isDraft
              ? { label: "Mark ready for review", icon: "eye", run: markReady }
              : { label: "Convert to draft", icon: "pr-draft", run: toDraft },
          );
        if (p.state === "open")
          items.push({
            label: "Close pull request",
            icon: "pr-closed",
            danger: true,
            run: closePR,
          });
        if (p.state === "closed")
          items.push({ label: "Reopen pull request", icon: "pr-open", run: reopen });
        items.push(
          { sep: true },
          {
            label: "Keyboard shortcuts",
            icon: "keyboard",
            kbd: "?",
            run: () => shortcutsPop(anchor),
          },
        );
        L.menu.open(anchor, items, { align: "end", minWidth: 250 });
      }
      function shortcutsPop(anchor) {
        const rows = [
          ["J / K", "Next / previous pull request"],
          ["1 – 4", "Conversation, Files, Checks, Commits"],
          ["/", "Search or paste a link"],
          ["L", "Collapse or expand the list"],
          ["S", "Stack navigator"],
          ["[ / ]", "Layer below / above"],
          ["M", "Merge options"],
          ["N / ⇧N", "Next / previous unresolved thread"],
          ["R", "Finish your review"],
          ["Files: J / K", "Next / previous file"],
          ["Files: V", "Mark the current file viewed"],
          ["Files: U · F", "Split or unified · file tree"],
          ["Esc", "Leave Files, close layers"],
        ];
        const node = h("div", "c-keys");
        node.innerHTML = String(
          html`<div class="c-keys-h">Keyboard</div>
            ${rows.map(([k, l]) => html`<div class="c-keys-r"><span>${l}</span><kbd>${k}</kbd></div>`)}`,
        );
        L.popover.open(anchor || $('[data-act="more"]', R.head) || R.head, node, {
          side: "bottom",
          align: "end",
          width: 320,
          cls: "c-pop",
        });
      }

      /* ------------------------------------------------------ mutations */
      function recalcChecks(p, d) {
        const C = M.checks(d);
        if (!C.jobs.length && !C.statuses.length) return;
        const kinds = [
          ...C.jobs.map((j) => L.runKind(j)),
          ...C.statuses.map((s) => L.checkKind(s.state)),
        ];
        const cnt = (k) => kinds.filter((x) => x === k).length;
        const failed = cnt("fail");
        const running = cnt("run") + cnt("queued");
        const skipped = cnt("skip");
        p.checks = {
          state: failed ? "failing" : running ? "running" : "passing",
          total: kinds.length,
          passed: kinds.length - failed - running - skipped,
          failed,
          running,
          skipped,
        };
        for (const w of d.checks.workflows) {
          const ks = w.jobs.map((j) => L.runKind(j));
          const busy = ks.some((k) => k === "run" || k === "queued");
          w.status = busy ? "in_progress" : "completed";
          w.conclusion = busy ? null : ks.includes("fail") ? "failure" : "success";
        }
        const last = d.commits[d.commits.length - 1];
        if (last) last.checks = p.checks.state;
      }
      function rerunJobs(jobs, label) {
        const p = cur();
        const d = curD();
        const n = p.number;
        if (!jobs.length) return;
        for (const j of jobs) {
          j.status = "queued";
          j.conclusion = null;
          for (const s of j.steps) {
            s.status = "queued";
            s.conclusion = null;
          }
          ui.openSteps.delete(`${j.id}:${mainStepN(j)}`);
        }
        for (const w of d.checks.workflows)
          if (w.jobs.some((j) => jobs.includes(j))) w.attempt = (w.attempt || 1) + 1;
        recalcChecks(p, d);
        refresh({ mast: false });
        L.toast(label, { icon: "rerun" });
        later(() => {
          for (const j of jobs) {
            j.status = "in_progress";
            j.steps.forEach((s, i) => {
              s.status =
                i < j.steps.length - 2
                  ? "completed"
                  : i === j.steps.length - 2
                    ? "in_progress"
                    : "queued";
              s.conclusion = i < j.steps.length - 2 ? "success" : null;
            });
          }
          recalcChecks(p, d);
          if (st.pr === n) refresh({ mast: false });
        }, 900);
        later(() => {
          for (const j of jobs) {
            j.status = "completed";
            j.conclusion = "success";
            j.steps.forEach((s) => {
              s.status = "completed";
              s.conclusion = "success";
            });
            if (j.log?.some((l) => /FAIL|×/.test(l))) {
              const cmd = j.log[0];
              j.log = [
                cmd,
                " RUN  v3.2.4 /home/runner/work/ryco/ryco/apps/web",
                "",
                " ✓ src/components/pullRequests/stackLayers.logic.test.ts (5 tests) 14ms",
                " ✓ src/components/pullRequests/PullRequestMergeBox.logic.test.ts (14 tests) 21ms",
                "",
                " Test Files  212 passed (212)",
                "      Tests  1846 passed (1846)",
                "   Duration  55.12s",
              ];
            }
            ui.openJobs.delete(j.id);
          }
          recalcChecks(p, d);
          if (st.pr === n) refresh({ mast: false });
          else renderList({ flip: true });
          L.toast(jobs.length > 1 ? `${jobs.length} jobs passed` : `${jobs[0].name} passed`, {
            tone: "ok",
          });
        }, 4200);
      }
      async function doMerge(n, through) {
        const p = M.pr(n);
        const plan = M.mergePlan(n, through);
        if (!plan) return;
        if (plan.blockedBy)
          return L.toast(`#${plan.blockedBy.pr.number}: ${plan.blockedBy.reason}`, { tone: "err" });
        const method = ui.method || D.repo.defaultMergeMethod;
        const multi = plan.layers.length > 1;
        const above = p.stack
          ? M.stackOf(p).entries.filter(
              (e) => e.stack.position > plan.through && e.state === "open",
            )
          : [];
        const ok = await L.confirm({
          title: multi
            ? `Merge ${plan.layers.length} pull requests into ${plan.base}?`
            : `${METHOD[method]} #${n} into ${p.baseRefName}?`,
          body: raw(
            esc(
              multi
                ? `${METHOD_SHORT[method]}-merges ${plan.layers.map((l) => "#" + l.number).join(", ")} in order, bottom first.`
                : `Lands ${plural(p.commitsCount || 1, "commit")} from ${p.headRefName} as one ${method === "squash" ? "squashed commit" : method === "rebase" ? "rebased series" : "merge commit"}.`,
            ) +
              (above.length
                ? ` ${esc(above.map((a) => "#" + a.number).join(", "))} ${above.length > 1 ? "stay" : "stays"} open and GitHub retargets ${above.length > 1 ? "them" : "it"} onto <code>${esc(plan.base)}</code>.`
                : "") +
              (ui.delBranch ? " The head branch is deleted afterwards." : ""),
          ),
          confirmLabel: multi ? `Merge stack (${plan.layers.length})` : METHOD[method],
          tone: "pri",
        });
        if (!ok) return;
        if (st.pr !== n) openPR(n);
        ui.busy[n] = "merging";
        refresh({ list: false, body: false, mast: false, head: false });
        later(() => {
          delete ui.busy[n];
          const at = stamp();
          for (const l of plan.layers) {
            l.state = "merged";
            l.mergedAt = at;
            l.mergedBy = VIEWER;
            l.updatedAt = at;
            l.autoMerge = null;
            if (ui.delBranch) l.branchDeleted = true;
            const ld = M.detail(l.number);
            ld.timeline.push({
              id: nid("mg"),
              kind: "merged",
              actor: VIEWER,
              at,
              base: plan.base,
              commit: hex7(),
              layers: l.number === n && multi ? plan.layers.length : null,
            });
            if (ui.delBranch)
              ld.timeline.push({ id: nid("del"), kind: "head_ref_deleted", actor: VIEWER, at });
          }
          for (const a of above) {
            if (a.stack.position === plan.through + 1) {
              const from = a.baseRefName;
              a.baseRefName = plan.base;
              M.detail(a.number).timeline.push({
                id: nid("bc"),
                kind: "base_changed",
                actor: "github-actions[bot]",
                at,
                from,
                to: plan.base,
              });
            }
          }
          refresh();
          L.toast(
            multi
              ? `Merged ${plan.layers.length} pull requests into ${plan.base}`
              : `Merged #${n} into ${p.baseRefName}`,
            { tone: "ok" },
          );
        }, 1700);
      }
      function markReady() {
        const p = cur();
        p.isDraft = false;
        p.mergeStateStatus = "BLOCKED";
        if (!p.reviewDecision) p.reviewDecision = "review_required";
        curD().timeline.push({
          id: nid("rd"),
          kind: "ready_for_review",
          actor: VIEWER,
          at: stamp(),
        });
        refresh();
        L.toast(`#${p.number} is ready for review`, { tone: "ok" });
      }
      function toDraft() {
        const p = cur();
        p.isDraft = true;
        p.autoMerge = null;
        curD().timeline.push({
          id: nid("dr"),
          kind: "convert_to_draft",
          actor: VIEWER,
          at: stamp(),
        });
        refresh();
      }
      async function closePR() {
        const p = cur();
        const ok = await L.confirm({
          title: `Close #${p.number} without merging?`,
          body: `You can reopen it later. ${p.stack ? "Layers above it in the stack will be blocked." : ""}`,
          confirmLabel: "Close pull request",
          tone: "danger",
        });
        if (!ok) return;
        p.state = "closed";
        p.closedAt = stamp();
        p.autoMerge = null;
        curD().timeline.push({ id: nid("cl"), kind: "closed", actor: VIEWER, at: p.closedAt });
        refresh();
      }
      function reopen() {
        const p = cur();
        p.state = "open";
        p.closedAt = null;
        curD().timeline.push({ id: nid("ro"), kind: "reopened", actor: VIEWER, at: stamp() });
        refresh();
      }
      /* CI re-runs after a push to the head: every check goes back to running, then passes */
      function simulateCI(p, delay = 3200, label) {
        const n = p.number;
        const d = M.detail(n);
        const jobs = d.checks?.workflows?.flatMap((w) => w.jobs) || [];
        if (jobs.length) {
          for (const j of jobs) {
            j.status = "in_progress";
            j.conclusion = null;
          }
          recalcChecks(p, d);
        } else if (p.checks.total) {
          p.checks = {
            state: "running",
            total: p.checks.total,
            passed: 0,
            failed: 0,
            running: p.checks.total,
            skipped: 0,
          };
        }
        later(() => {
          if (jobs.length) {
            for (const j of jobs) {
              j.status = "completed";
              j.conclusion = "success";
              j.steps.forEach((s) => {
                s.status = "completed";
                s.conclusion = "success";
              });
            }
            recalcChecks(p, d);
          } else
            p.checks = {
              state: "passing",
              total: p.checks.total,
              passed: p.checks.total,
              failed: 0,
              running: 0,
              skipped: 0,
            };
          if (
            p.reviewDecision === "approved" &&
            p.mergeable === "mergeable" &&
            p.mergeStateStatus !== "BEHIND"
          )
            p.mergeStateStatus = "CLEAN";
          if (st.pr === n) refresh({ mast: false });
          else renderList({ flip: true });
          L.toast(label || `Checks passed on #${n}`, { tone: "ok" });
        }, delay);
      }
      function updateBranch() {
        const p = cur();
        const n = p.number;
        ui.busy[n] = "updating";
        refresh({ list: false, body: false, mast: false, head: false });
        later(() => {
          delete ui.busy[n];
          p.mergeStateStatus = "BLOCKED";
          p.behindBy = 0;
          M.detail(n).timeline.push({
            id: nid("ub"),
            kind: "update_branch",
            actor: VIEWER,
            at: stamp(),
          });
          simulateCI(p, 3400);
          if (st.pr === n) refresh();
          else renderList({ flip: true });
          L.toast(`Merged ${p.baseRefName} into ${p.headRefName} · CI restarted`, {
            icon: "update-branch",
          });
        }, 1300);
      }
      function autoMergeOn() {
        const p = cur();
        const method = ui.method || D.repo.defaultMergeMethod;
        p.autoMerge = { method, enabledBy: VIEWER, enabledAt: stamp() };
        curD().timeline.push({
          id: nid("am"),
          kind: "auto_merge_enabled",
          actor: VIEWER,
          at: stamp(),
          method,
        });
        refresh();
        L.toast(`Auto-merge on · ${METHOD_SHORT[method].toLowerCase()} when ready`, {
          icon: "clock",
        });
      }
      function autoMergeOff() {
        const p = cur();
        p.autoMerge = null;
        curD().timeline.push({
          id: nid("am"),
          kind: "auto_merge_disabled",
          actor: VIEWER,
          at: stamp(),
        });
        refresh();
      }
      function deleteBranch() {
        const p = cur();
        p.branchDeleted = true;
        curD().timeline.push({
          id: nid("del"),
          kind: "head_ref_deleted",
          actor: VIEWER,
          at: stamp(),
        });
        refresh();
      }
      function restoreBranch() {
        const p = cur();
        p.branchDeleted = false;
        curD().timeline.push({
          id: nid("rs"),
          kind: "head_ref_restored",
          actor: VIEWER,
          at: stamp(),
        });
        refresh();
      }
      function handoff(kind, extra) {
        const p = cur();
        const d = curD();
        const titles = {
          "fix-checks": () =>
            `Fix ${M.checks(d).failing[0]?.name || "the failing check"} on #${p.number}`,
          "fix-job": () => `Fix ${extra} on #${p.number}`,
          "resolve-conflicts": () => `Resolve conflicts on #${p.number}`,
          "address-review": () => `Address review threads on #${p.number}`,
          "ask-pr": () => `Questions about #${p.number}`,
          "ask-thread": () => `Discuss a review thread on #${p.number}`,
          "ask-selection": () => `Ask about ${extra}`,
        };
        const title = (titles[kind] || titles["ask-pr"])();
        const spawns = ["fix-checks", "fix-job", "resolve-conflicts", "address-review"].includes(
          kind,
        );
        if (spawns) {
          d.linkedThreads = d.linkedThreads || [];
          d.linkedThreads.push({
            id: nid("th"),
            title,
            state: "working",
            provider: "claude",
            model: "Opus 5.5",
            startedAt: stamp(),
          });
          refresh({ list: false, body: false, mast: false, head: false });
        }
        L.toast(spawns ? `Started “${title}”` : `Asked Claude · ${title}`, {
          icon: "sparkle",
          action: {
            label: "Open",
            run: () => L.toast("The thread opens in a side chat in the real app"),
          },
        });
      }
      function findComment(id) {
        const d = curD();
        for (const e of d.timeline) if (e.id === id) return e;
        for (const t of d.threads) for (const c of t.comments) if (c.id === id) return c;
        return null;
      }
      function toggleReaction(cid, emoji) {
        const c = findComment(cid);
        if (!c) return;
        c.reactions ||= [];
        let r = c.reactions.find((x) => x.emoji === emoji);
        if (!r) c.reactions.push((r = { emoji, count: 0, viewerReacted: false }));
        r.viewerReacted = !r.viewerReacted;
        r.count += r.viewerReacted ? 1 : -1;
        refresh({ list: false, mast: false, rail: false, head: false, sheet: true });
        const b = $(`.c-rx-b[data-c="${CSS.escape(cid)}"][data-e="${CSS.escape(emoji)}"]`, root);
        if (b && r.viewerReacted) b.classList.add("pop-in");
      }
      function resolveThread(id) {
        const p = cur();
        const d = curD();
        const t = d.threads.find((x) => x.id === id);
        if (!t) return;
        t.isResolved = !t.isResolved;
        t.resolvedBy = t.isResolved ? VIEWER : null;
        ui.openResolved.delete(id);
        p.unresolvedThreads = d.threads.filter((x) => !x.isResolved).length;
        const el = $(
          `.c-thr[data-thread="${CSS.escape(id)}"]`,
          st.tab === "files" ? R.sheet : R.doc,
        );
        const done = () => refresh({ mast: false, sheet: true });
        if (el && t.isResolved && !reduced()) {
          const hgt = el.offsetHeight;
          const a = L.animate(
            el,
            [
              { height: hgt + "px", opacity: 1 },
              { height: "36px", opacity: 0.6 },
            ],
            { duration: "stack", easing: "gentle", fill: "forwards" },
          );
          a ? a.finished.then(done).catch(done) : done();
        } else done();
        if (t.isResolved)
          L.toast("Conversation resolved", {
            tone: "ok",
            action: { label: "Undo", run: () => resolveThread(id) },
          });
      }
      function commitSuggestion(id) {
        const p = cur();
        const d = curD();
        const t = d.threads.find((x) => x.id === id);
        const short = hex7();
        const msg = `Apply suggestion from @${t.comments[0].author}`;
        d.commits.push({
          sha: short + hex7() + hex7(),
          short,
          message: msg,
          author: VIEWER,
          committedAt: stamp(),
          checks: "running",
        });
        d.timeline.push({
          id: nid("cm"),
          kind: "commits",
          actor: VIEWER,
          at: stamp(),
          commits: [{ short, message: msg }],
        });
        p.commitsCount = (p.commitsCount || d.commits.length - 1) + 1;
        t.isResolved = true;
        t.resolvedBy = VIEWER;
        p.unresolvedThreads = d.threads.filter((x) => !x.isResolved).length;
        refresh({ sheet: true });
        L.toast(`Committed ${short} · ${msg}`, { tone: "ok" });
      }
      function addComment(body) {
        const p = cur();
        const d = curD();
        d.timeline.push({
          id: nid("cmt"),
          kind: "comment",
          actor: VIEWER,
          at: stamp(),
          body,
          reactions: [],
        });
        p.comments = (p.comments || 0) + 1;
        p.updatedAt = stamp();
        refresh({ mast: false });
        later(() => {
          const last = $$(".c-cmt", R.docbody).pop();
          last?.scrollIntoView({ block: "nearest", behavior: reduced() ? "auto" : "smooth" });
        }, 30);
      }
      function addReply(id, body) {
        const d = curD();
        const t = d.threads.find((x) => x.id === id);
        if (!t) return;
        t.comments.push({ id: nid("rp"), author: VIEWER, createdAt: stamp(), body, reactions: [] });
        ui.reply = null;
        refresh({ mast: false, list: false, rail: false, sheet: true });
      }
      function rowOf(path, side, line) {
        const f = curD().files.find((x) => x.path === path);
        const rows = L.parsePatch(f?.patch || "");
        const i = rows.findIndex(
          (r) => r.kind !== "hunk" && (side === "LEFT" ? r.old : r.new) === line,
        );
        const row = rows[i];
        const ctx = rows.slice(Math.max(0, i - 3), i + 1).filter((r) => r.kind !== "hunk");
        const hunk =
          `@@ -${ctx[0]?.old ?? line},${ctx.length} +${ctx[0]?.new ?? line},${ctx.length} @@\n` +
          ctx
            .map((r) => (r.kind === "add" ? "+" : r.kind === "del" ? "-" : " ") + r.text)
            .join("\n");
        return { lineText: row?.text ?? "", diffHunk: hunk };
      }
      function addLineComment(mode, body) {
        const p = cur();
        const d = curD();
        const c = ui.composer;
        if (!c) return;
        const { lineText, diffHunk } = rowOf(c.path, c.side, c.line);
        const id = nid(`${p.number}-l`);
        if (mode === "single") {
          d.threads.push({
            id,
            path: c.path,
            side: c.side,
            line: c.line,
            originalLine: c.line,
            startLine: null,
            lineText,
            diffHunk,
            isResolved: false,
            isOutdated: false,
            comments: [{ id: id + "-c", author: VIEWER, createdAt: stamp(), body, reactions: [] }],
          });
          d.timeline.push({
            id: nid("rv"),
            kind: "review",
            actor: VIEWER,
            at: stamp(),
            state: "commented",
            body: "",
            threadIds: [id],
          });
          p.unresolvedThreads = d.threads.filter((x) => !x.isResolved).length;
        } else {
          d.pendingReview ||= { startedAt: stamp(), body: "", comments: [] };
          d.pendingReview.comments.push({
            id,
            path: c.path,
            side: c.side,
            line: c.line,
            originalLine: c.line,
            startLine: null,
            lineText,
            diffHunk,
            body,
          });
        }
        ui.composer = null;
        refresh({ mast: false, sheet: true, list: mode === "single" });
        if (mode !== "single") L.toast("Added to your pending review", { icon: "comment" });
      }
      function submitReview() {
        const p = cur();
        const d = curD();
        const pend = d.pendingReview;
        const event = mine(p) ? "comment" : ui.reviewEvent;
        const body = ui.reviewBody.trim();
        if (!pend?.comments?.length && !body && event === "comment")
          return L.toast("Add a summary or a line comment first", { tone: "err" });
        const created = (pend?.comments || []).map((c) => ({
          id: c.id,
          path: c.path,
          side: c.side,
          line: c.line,
          originalLine: c.line,
          startLine: null,
          lineText: c.lineText,
          diffHunk: c.diffHunk,
          isResolved: false,
          isOutdated: false,
          comments: [
            { id: c.id + "-c", author: VIEWER, createdAt: stamp(), body: c.body, reactions: [] },
          ],
        }));
        d.threads.push(...created);
        d.pendingReview = null;
        const state = { comment: "commented", approve: "approved", request: "changes_requested" }[
          event
        ];
        const at = stamp();
        d.timeline.push({
          id: nid("rv"),
          kind: "review",
          actor: VIEWER,
          at,
          state,
          body,
          threadIds: created.map((t) => t.id),
        });
        const upd = (list) => {
          if (!list) return list;
          const r = list.find((x) => x.login === VIEWER);
          if (r) Object.assign(r, { state, submittedAt: at, requested: false });
          else list.push({ login: VIEWER, state, submittedAt: at, requested: false });
          return list;
        };
        if (!mine(p)) {
          p.reviewers = upd(p.reviewers || []);
          if (!d.synthetic) d.reviewers = upd(d.reviewers || []);
          if (p.involvement === "review-requested") p.involvement = "reviewed";
        }
        const states = (p.reviewers || []).map((r) => r.state);
        p.reviewDecision = states.includes("changes_requested")
          ? "changes_requested"
          : states.filter((s) => s === "approved").length >= D.repo.protection.requiredApprovals
            ? "approved"
            : "review_required";
        if (
          p.reviewDecision === "approved" &&
          p.checks.state === "passing" &&
          p.mergeable === "mergeable" &&
          p.mergeStateStatus === "BLOCKED"
        )
          p.mergeStateStatus = "CLEAN";
        p.unresolvedThreads = d.threads.filter((x) => !x.isResolved).length;
        p.updatedAt = at;
        ui.reviewBody = "";
        L.popover.close();
        setHash({ review: null });
        refresh({ sheet: true });
        L.toast(
          {
            commented: "Review submitted",
            approved: `Approved #${p.number}`,
            changes_requested: `Requested changes on #${p.number}`,
          }[state],
          { tone: "ok" },
        );
      }
      async function discardReview() {
        const d = curD();
        const n = pendingN(d);
        L.popover.close();
        const ok = await L.confirm({
          title: "Discard your pending review?",
          body: `${plural(n, "pending comment")} will be deleted.`,
          confirmLabel: "Discard review",
          tone: "danger",
        });
        if (!ok) return;
        d.pendingReview = null;
        refresh({ mast: false, list: false, sheet: true });
      }
      function toggleViewed(path) {
        const d = curD();
        const f = d.files.find((x) => x.path === path);
        if (!f) return;
        const viewed = f.viewed !== "viewed";
        f.viewed = viewed ? "viewed" : "unviewed";
        ui.expandedViewed.delete(path);
        ui.collapsedFiles.delete(path);
        const art = $(`.c-file[data-path="${CSS.escape(path)}"]`, R.sheet);
        const diffs = $(".c-diffs", R.sheet);
        if (art) {
          art.classList.toggle("viewed", viewed);
          const btn = $(".c-viewed", art);
          btn.classList.toggle("on", viewed);
          btn.setAttribute("aria-checked", String(viewed));
          const disc = $(":scope > .disc", art);
          if (viewed) {
            const stuck = art.offsetTop < diffs.scrollTop;
            art.classList.add("collapsed");
            disc.classList.remove("open");
            if (stuck) diffs.scrollTop = art.offsetTop;
          } else if (!$(".diff", art)) {
            renderSheet({ keepScroll: true });
          } else {
            art.classList.remove("collapsed");
            disc.classList.add("open");
          }
        }
        const li = $(`.c-tn.file[data-path="${CSS.escape(path)}"]`, R.sheet);
        if (li) {
          li.classList.toggle("viewed", viewed);
          $(".c-vck", li)?.setAttribute("aria-checked", String(viewed));
        }
        const files = scopedFiles(d);
        const vn = files.filter((x) => x.viewed === "viewed").length;
        const num = $(".c-prog-n", R.sheet);
        if (num) num.textContent = String(vn);
        const bar = $(".c-prog-bar > i", R.sheet);
        if (bar) bar.style.transform = `scaleX(${files.length ? vn / files.length : 0})`;
        if (vn === files.length && viewed) L.toast("Every file viewed", { tone: "ok" });
      }
      function toggleTask(idx) {
        const p = cur();
        const d = curD();
        if (!mine(p)) return L.toast("Only the author can tick tasks");
        let i = -1;
        d.body = d.body.replace(/^(\s*[-*+]\s+)\[( |x|X)\]/gm, (m0, lead, mark) =>
          ++i === idx ? `${lead}[${mark === " " ? "x" : " "}]` : m0,
        );
        const el = $(`.c-desc .md-check[data-task="${idx}"]`, R.docbody);
        if (el) {
          const on = el.getAttribute("aria-checked") !== "true";
          el.setAttribute("aria-checked", String(on));
          el.closest("li")?.classList.toggle("done", on);
          if (on && !reduced())
            L.animate(el, [{ transform: "scale(.7)" }, { transform: "none" }], {
              duration: "pop",
              easing: "snappy",
            });
        }
      }

      /* ------------------------------------------------------ events */
      const ACT = {
        "list-toggle": () => {
          if (ui.listTemp) {
            ui.listTemp = false;
            ui.list = "open";
          } else ui.list = listMode() === "collapsed" ? "open" : "collapsed";
          ui.peek = false;
          applyListMode();
          later(() => syncSel(true), 380);
        },
        "list-filter": (e, b) => {
          const F = [
            ["open", "Open"],
            ["draft", "Drafts"],
            ["merged", "Merged"],
            ["closed", "Closed"],
            ["all", "Everything"],
          ];
          const G = [
            ["", "All groups"],
            ["review", "Needs your review"],
            ["mine", "Yours"],
            ["others", "Others"],
          ];
          L.menu.open(
            b,
            [
              { head: "State" },
              ...F.map(([v, l]) => ({
                label: l,
                checked: st.filter === v,
                run: () => setFilter({ filter: v }),
              })),
              { sep: true },
              { head: "Group" },
              ...G.map(([v, l]) => ({
                label: l,
                checked: st.group === v,
                run: () => setFilter({ group: v }),
              })),
            ],
            { align: "end", minWidth: 200 },
          );
        },
        "clear-search": () => {
          R.search.value = "";
          st.q = "";
          renderList();
          setHash({ q: null });
        },
        grp: (e, b) => {
          const g = b.dataset.g;
          const open = !ui.grpClosed.has(g);
          if (open) ui.grpClosed.add(g);
          else ui.grpClosed.delete(g);
          b.setAttribute("aria-expanded", String(!open));
          b.nextElementSibling.classList.toggle("open", !open);
          later(() => syncSel(false), reduced() ? 0 : 270);
          if (open)
            R.sel.style.opacity = $(".c-row.sel", b.nextElementSibling) ? "0" : R.sel.style.opacity;
        },
        "open-pr": (e, b) => {
          const n = Number(b.dataset.pr);
          if (n === st.pr && st.tab !== "conversation") return setTab("conversation");
          openPR(n);
        },
        tab: (e, b) => setTab(b.dataset.tab),
        next: () => {
          if (R.actRun) R.actRun({ currentTarget: R.actMain });
        },
        "merge-menu": () => openMergeMenu(),
        more: (e, b) => moreMenu(b),
        "copy-link": () => L.copy(cur().url, "link"),
        copy: (e, b) => L.copy(b.dataset.copy, b.dataset.label),
        "edit-title": () => {
          ui.editTitle = true;
          renderMast();
        },
        "title-cancel": () => {
          ui.editTitle = false;
          renderMast();
        },
        "edit-body": () => {
          ui.editBody = true;
          refresh({ list: false, rail: false, mast: false, head: false });
          $(".c-desc-edit textarea", R.docbody)?.focus();
        },
        "body-cancel": () => {
          ui.editBody = false;
          refresh({ list: false, rail: false, mast: false, head: false });
        },
        "goto-checks": () => setTab("checks"),
        "goto-job": (e, b) => {
          st.job = b.dataset.job;
          ui.openJobs.add(st.job);
          const j = M.checks(curD()).jobs.find((x) => x.id === st.job);
          const mn = j && mainStepN(j);
          if (mn) ui.openSteps.add(`${j.id}:${mn}`);
          setHash({ job: st.job });
          if (st.tab === "checks") {
            refresh({ list: false, mast: false, rail: false, head: false });
            focusJob(st.job);
          } else setTab("checks");
        },
        "goto-thread": () => gotoThread(1),
        "stack-open": () => openStackPop(),
        "stack-go": (e, b) => {
          const n = Number(b.dataset.pr);
          L.popover.close();
          const p = cur();
          const target = M.pr(n);
          if (n === st.pr) return;
          openPR(n, {
            anim:
              p?.stack && target?.stack
                ? target.stack.position > p.stack.position
                  ? "up"
                  : "down"
                : null,
            keepTab: true,
          });
        },
        "stack-merge": (e, b) => {
          if (b.getAttribute("aria-disabled")) return;
          L.popover.close();
          doMerge(Number(b.dataset.pr));
        },
        "edit-reviewers": (e, b) => pickerPop(b, "reviewers"),
        "edit-labels": (e, b) => pickerPop(b, "labels"),
        "edit-assignees": (e, b) => pickerPop(b, "assignees"),
        "toggle-del-branch": (e, b) => {
          ui.delBranch = !ui.delBranch;
          b.classList.toggle("on", ui.delBranch);
          b.setAttribute("aria-checked", String(ui.delBranch));
        },
        "auto-merge-on": autoMergeOn,
        "auto-merge-off": autoMergeOff,
        "delete-branch": deleteBranch,
        "restore-branch": restoreBranch,
        "open-agent": () =>
          L.toast("The agent's thread opens in a side chat in the real app", { icon: "sparkle" }),
        handoff: (e, b) => handoff(b.dataset.kind),
        "fix-job": (e, b) =>
          handoff("fix-job", M.checks(curD()).jobs.find((j) => j.id === b.dataset.job)?.name),
        "ask-thread": () => handoff("ask-thread"),
        "ask-selection": () => {
          const path = R.selchip.dataset.path;
          const lines = (R.selchip.dataset.text || "").split("\n").filter(Boolean).length || 1;
          R.selchip.hidden = true;
          getSelection()?.removeAllRanges();
          handoff("ask-selection", `${plural(lines, "line")} in ${splitPath(path)[1]}`);
        },
        push: (e, b) => {
          const id = b.dataset.id;
          const open = !ui.openPush.has(id);
          if (open) ui.openPush.add(id);
          else ui.openPush.delete(id);
          const li = b.closest(".c-push");
          li.classList.toggle("open", open);
          b.setAttribute("aria-expanded", String(open));
          $(".c-push-b", li).classList.toggle("open", open);
        },
        "commit-scope": (e, b) => {
          const sha = b.dataset.sha;
          const d = curD();
          if (!d.commits.some((c) => c.short === sha))
            return L.toast("That commit was rewritten by a later force-push");
          st.commit = sha;
          setHash({ commit: sha });
          if (st.tab === "files") {
            renderHeadTools();
            renderSheet();
          } else setTab("files");
        },
        "commit-menu": (e, b) => {
          const d = curD();
          L.menu.open(
            b,
            [
              {
                label: "All commits",
                sub: `${plural(d.files.length, "file")} changed`,
                checked: !st.commit,
                run: () => setCommit(null),
              },
              { sep: true },
              ...[...d.commits].reverse().map((c) => ({
                label: c.message,
                sub: `${c.short} · ${L.ago(c.committedAt)}`,
                checked: st.commit === c.short,
                run: () => setCommit(c.short),
              })),
            ],
            { align: "end", minWidth: 320 },
          );
        },
        "commit-clear": () => setCommit(null),
        view: (e, b) => setView(b.dataset.view),
        "tree-toggle": () => {
          ui.treeAuto = false;
          ui.tree = !ui.tree;
          R.sheet.classList.toggle("no-tree", !ui.tree);
          renderHeadTools();
        },
        "tree-file": (e, b) => {
          const path = b.dataset.path;
          const f = curD().files.find((x) => x.path === path);
          if (f?.viewed === "viewed" && !ui.expandedViewed.has(path)) {
            ui.expandedViewed.add(path);
            renderSheet({ keepScroll: true });
          }
          scrollToFile(path, { smooth: true });
          setHash({ file: path });
          if (R.sheet.classList.contains("tree-over")) R.sheet.classList.remove("tree-over");
        },
        viewed: (e, b) => {
          e.preventDefault();
          e.stopPropagation();
          toggleViewed(b.dataset.path);
        },
        "file-toggle": (e, b) => {
          const path = b.dataset.path;
          const f = curD().files.find((x) => x.path === path);
          const art = b.closest(".c-file");
          const collapsed = art.classList.contains("collapsed");
          if (f.viewed === "viewed") {
            if (collapsed) ui.expandedViewed.add(path);
            else ui.expandedViewed.delete(path);
          } else if (collapsed) ui.collapsedFiles.delete(path);
          else ui.collapsedFiles.add(path);
          if (collapsed && !$(".diff", art)) return renderSheet({ keepScroll: true });
          art.classList.toggle("collapsed", !collapsed);
          $(":scope > .disc", art).classList.toggle("open", collapsed);
          b.setAttribute("aria-expanded", String(collapsed));
        },
        "file-more": (e, b) => {
          const path = b.dataset.path;
          L.menu.open(
            b,
            [
              { label: "Copy path", icon: "copy", run: () => L.copy(path, "path") },
              {
                label: "Open in editor",
                icon: "terminal",
                run: () => L.toast(`Opening ${splitPath(path)[1]} in your editor`),
              },
              {
                label: "Ask agent about this file",
                icon: "sparkle",
                run: () => handoff("ask-selection", splitPath(path)[1]),
              },
            ],
            { align: "end" },
          );
        },
        "diff-comment": (e, b) => {
          const p = cur();
          if (p.state !== "open") return;
          ui.composer = {
            path: b.dataset.path,
            side: b.dataset.side,
            line: Number(b.dataset.line),
          };
          renderSheet({ keepScroll: true });
          const f = $(".c-cmp", R.sheet);
          if (f) {
            if (!reduced())
              L.animate(
                f,
                [
                  { opacity: 0, transform: "translateY(-4px)" },
                  { opacity: 1, transform: "none" },
                ],
                { duration: "stack", easing: "ease" },
              );
            $("textarea", f).focus({ preventScroll: true });
          }
        },
        "cmp-cancel": () => {
          ui.composer = null;
          renderSheet({ keepScroll: true });
        },
        "insert-suggestion": (e, b) => {
          const c = ui.composer;
          const ta = $("textarea", b.closest(".c-cmp"));
          const { lineText } = rowOf(c.path, c.side, c.line);
          ta.value += (ta.value ? "\n" : "") + "```suggestion\n" + lineText + "\n```";
          ta.focus();
          ta.setSelectionRange(ta.value.length - 4 - lineText.length, ta.value.length - 4);
        },
        reply: (e, b) => {
          ui.reply = b.dataset.thread;
          const inDoc = st.tab !== "files";
          if (inDoc) refresh({ list: false, mast: false, rail: false, head: false });
          else renderSheet({ keepScroll: true });
          const form = $(
            `.c-thr-reply[data-thread="${CSS.escape(ui.reply)}"]`,
            inDoc ? R.doc : R.sheet,
          );
          form?.querySelector("textarea")?.focus({ preventScroll: true });
        },
        "reply-cancel": () => {
          ui.reply = null;
          if (st.tab === "files") renderSheet({ keepScroll: true });
          else refresh({ list: false, mast: false, rail: false, head: false });
        },
        resolve: (e, b) => resolveThread(b.dataset.thread),
        "thr-expand": (e, b) => {
          ui.openResolved.add(b.dataset.thread);
          if (st.tab === "files") renderSheet({ keepScroll: true });
          else refresh({ list: false, mast: false, rail: false, head: false });
          const t = $(`.c-thr[data-thread="${CSS.escape(b.dataset.thread)}"]`, root);
          if (t && !reduced())
            L.animate(
              t,
              [
                { opacity: 0.4, transform: "translateY(-3px)" },
                { opacity: 1, transform: "none" },
              ],
              { duration: "stack" },
            );
        },
        "thr-open-file": (e, b) => {
          const d = curD();
          const t = M.threadsFor(d).find((x) => x.id === b.dataset.thread);
          if (!t) return;
          st.thread = t.id;
          const f = d.files.find((x) => x.path === t.path);
          if (f?.viewed === "viewed") ui.expandedViewed.add(f.path);
          setHash({ thread: t.id });
          setTab("files");
        },
        "commit-suggestion": (e, b) => commitSuggestion(b.dataset.thread),
        "pending-del": (e, b) => {
          const d = curD();
          if (!d.pendingReview) return;
          d.pendingReview.comments = d.pendingReview.comments.filter(
            (c) => c.id !== b.dataset.thread,
          );
          if (!d.pendingReview.comments.length) d.pendingReview = null;
          refresh({ mast: false, list: false, sheet: true });
        },
        react: (e, b) => toggleReaction(b.dataset.c, b.dataset.e),
        "react-add": (e, b) =>
          L.menu.open(
            b,
            ["👍", "🎉", "❤️", "👀", "🚀", "😄"].map((em) => ({
              label: em,
              run: () => toggleReaction(b.dataset.c, em),
            })),
            { minWidth: 120 },
          ),
        "review-open": () => openReviewPop(),
        "rerun-failed": (e, b) => {
          const w = curD().checks.workflows.find((x) => x.id === b.dataset.wf);
          const jobs = w.jobs.filter((j) => L.runKind(j) === "fail");
          rerunJobs(jobs, `Re-running ${plural(jobs.length, "failed job")} in ${w.name}`);
        },
        "rerun-all": (e, b) => {
          if (b.getAttribute("aria-disabled")) return;
          const w = curD().checks.workflows.find((x) => x.id === b.dataset.wf);
          rerunJobs(w.jobs, `Re-running every job in ${w.name}`);
        },
        "rerun-job": (e, b) => {
          if (b.getAttribute("aria-disabled")) return;
          const j = M.checks(curD()).jobs.find((x) => x.id === b.dataset.job);
          const real = curD()
            .checks.workflows.flatMap((w) => w.jobs)
            .find((x) => x.id === j.id);
          rerunJobs([real], `Re-running ${j.name}`);
        },
        job: (e, b) => {
          const id = b.dataset.job;
          const open = !ui.openJobs.has(id);
          if (open) ui.openJobs.add(id);
          else ui.openJobs.delete(id);
          const li = b.closest(".c-job");
          li.classList.toggle("open", open);
          b.setAttribute("aria-expanded", String(open));
          $(":scope > .disc", li).classList.toggle("open", open);
          if (open) {
            st.job = id;
            setHash({ job: id });
          } else if (st.job === id) {
            st.job = null;
            setHash({ job: null });
          }
        },
        step: (e, b) => {
          const key = b.dataset.key;
          const open = !ui.openSteps.has(key);
          if (open) ui.openSteps.add(key);
          else ui.openSteps.delete(key);
          const li = b.closest(".c-step");
          li.classList.toggle("open", open);
          b.setAttribute("aria-expanded", String(open));
          $(":scope > .disc", li)?.classList.toggle("open", open);
        },
        "log-link": (e, b) => {
          const d = curD();
          const tail = b.dataset.path.replace(/^(apps\/web\/)?/, "");
          const f = d.files.find((x) => x.path.endsWith(tail));
          if (!f) return L.toast("That file isn't part of this pull request");
          st.file = f.path;
          st.thread = null;
          if (f.viewed === "viewed") ui.expandedViewed.add(f.path);
          ui.composer = null;
          setHash({ file: f.path });
          setTab("files");
          later(() => {
            scrollToFile(f.path);
            const row = $(
              `.c-file[data-path="${CSS.escape(f.path)}"] tr[data-line="${b.dataset.line}"][data-side="RIGHT"]`,
              R.sheet,
            );
            if (row) {
              const diffs = $(".c-diffs", R.sheet);
              diffs.scrollTop +=
                row.getBoundingClientRect().top - diffs.getBoundingClientRect().top - 120;
              row.classList.add("sel", "flash-row");
            }
          }, 60);
        },
        "close-pr": () => closePR(),
      };
      function setFilter(patch) {
        Object.assign(st, patch);
        renderList({ flip: true });
        setHash({ filter: st.filter === "open" ? null : st.filter, group: st.group || null });
      }
      function setCommit(sha) {
        st.commit = sha;
        ui.composer = null;
        setHash({ commit: sha });
        renderHeadTools();
        if (st.tab === "files") renderSheet();
      }
      function setView(v) {
        if (st.view === v) return;
        st.view = v;
        setHash({ view: v === "unified" ? null : v });
        for (const b of $$('.c-seg [data-act="view"]', R.head))
          b.setAttribute("aria-checked", String(b.dataset.view === v));
        if (st.tab === "files") renderSheet({ keepScroll: true });
      }
      offs.push(
        on(root, "click", "[data-act]", (e, b) => {
          const fn = ACT[b.dataset.act];
          if (!fn) return;
          if (b.tagName === "A") return;
          if (b.getAttribute("aria-disabled") === "true" && b.dataset.act !== "next") return;
          fn(e, b);
        }),
      );
      /* layers live in <body>; route their data-act clicks too */
      const layerClick = (e) => {
        const b = e.target.closest?.(".c-pop [data-act], .c-stk [data-act]");
        if (!b || root.contains(b)) return;
        const fn = ACT[b.dataset.act];
        if (fn) fn(e, b);
      };
      document.addEventListener("click", layerClick);
      offs.push(() => document.removeEventListener("click", layerClick));

      /* description task checkboxes */
      offs.push(
        on(root, "click", ".c-desc .md-check", (e, b) => toggleTask(Number(b.dataset.task))),
      );
      /* forms */
      offs.push(
        on(root, "submit", "form[data-form]", (e, f) => {
          e.preventDefault();
          const kind = f.dataset.form;
          if (kind === "title") {
            const v = $(".c-title-in", f).value.trim();
            const p = cur();
            if (v && v !== p.title) {
              curD().timeline.push({
                id: nid("rn"),
                kind: "renamed",
                actor: VIEWER,
                at: stamp(),
                from: p.title,
                to: v,
              });
              p.title = v;
            }
            ui.editTitle = false;
            refresh();
            return;
          }
          if (kind === "body") {
            curD().body = $("textarea", f).value;
            ui.editBody = false;
            refresh({ list: false, rail: false, mast: false, head: false });
            return;
          }
          const ta = $("textarea", f);
          const v = ta.value.trim();
          if (!v) return ta.focus();
          if (kind === "comment") addComment(v);
          else if (kind === "reply") addReply(f.dataset.thread, v);
          else if (kind === "line") addLineComment(e.submitter?.dataset.mode || "review", v);
        }),
      );
      offs.push(
        on(root, "keydown", "textarea", (e, ta) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            const f = ta.closest("form");
            if (!f) return;
            const pri = $('button[type="submit"].pri', f) || $('button[type="submit"]', f);
            f.requestSubmit(pri || undefined);
          } else if (e.key === "Escape") {
            e.stopPropagation();
            const f = ta.closest("form");
            if (f?.dataset.form === "line") ACT["cmp-cancel"]();
            else if (f?.dataset.form === "reply") ACT["reply-cancel"]();
            else ta.blur();
          }
        }),
      );
      /* auto-grow the conversation composer */
      offs.push(
        on(root, "input", ".c-compose-t", (e, ta) => {
          ta.style.height = "auto";
          ta.style.height = Math.min(320, ta.scrollHeight) + "px";
        }),
      );
      offs.push(
        on(root, "focusin", ".c-compose-t", (e, ta) =>
          ta.closest(".c-compose").classList.add("on"),
        ),
        on(root, "focusout", ".c-compose-t", (e, ta) => {
          if (!ta.value.trim()) ta.closest(".c-compose").classList.remove("on");
        }),
      );

      /* keyboard */
      function onKey(e) {
        if (e.altKey || e.metaKey || e.ctrlKey) return;
        const t = e.target;
        if (t.closest?.("input, textarea, select, [contenteditable='true']")) return;
        if (document.querySelector(".scrim")) return;
        const layer = L.menu.isOpen() || L.popover.isOpen();
        const k = e.key;
        if (k === "Escape") {
          if (layer) return;
          if (st.tab === "files" && cur()) {
            setTab(ui.bodyTab || "conversation");
            e.preventDefault();
          } else if (ui.peek) {
            ui.peek = false;
            applyListMode();
          }
          return;
        }
        if (layer) return;
        const files = st.tab === "files";
        const handled = (() => {
          switch (k) {
            case "/":
              R.search.focus();
              return true;
            case "j":
            case "k": {
              if (files) {
                const arts = $$(".c-file", R.sheet);
                const i = arts.findIndex((a) => a.dataset.path === st.file);
                const n =
                  arts[
                    Math.max(0, Math.min(arts.length - 1, (i < 0 ? 0 : i) + (k === "j" ? 1 : -1)))
                  ];
                if (n) scrollToFile(n.dataset.path);
              } else moveList(k === "j" ? 1 : -1);
              return true;
            }
            case "1":
            case "2":
            case "3":
            case "4":
              if (cur()) setTab(TABS[Number(k) - 1]);
              return true;
            case "l":
              ACT["list-toggle"]();
              return true;
            case "s":
              if (cur()?.stack) openStackPop();
              return true;
            case "[":
              stackStep(-1);
              return true;
            case "]":
              stackStep(1);
              return true;
            case "m":
              if (cur()) openMergeMenu();
              return true;
            case "n":
              if (cur()) gotoThread(1);
              return true;
            case "N":
              if (cur()) gotoThread(-1);
              return true;
            case "r":
              if ($(".c-rbar.on", root)) openReviewPop();
              return true;
            case "u":
              if (files) setView(st.view === "split" ? "unified" : "split");
              return files;
            case "f":
              if (files) ACT["tree-toggle"]();
              return files;
            case "v":
              if (files && st.file) toggleViewed(st.file);
              return files;
            case "c":
              if (files) $('[data-act="commit-menu"]', R.head)?.click();
              return files;
            case "?":
              shortcutsPop();
              return true;
          }
          return false;
        })();
        if (handled) e.preventDefault();
      }
      document.addEventListener("keydown", onKey);
      offs.push(() => document.removeEventListener("keydown", onKey));

      /* list keyboard: arrows inside the list */
      offs.push(
        on(R.rows, "keydown", ".c-row", (e, b) => {
          if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
          e.preventDefault();
          e.stopPropagation();
          const rows = $$(".c-row", R.rows).filter((r) => !r.closest(".disc:not(.open)"));
          const i = rows.indexOf(b);
          rows[
            Math.max(0, Math.min(rows.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))
          ]?.focus();
        }),
      );

      /* sticky rail height follows the scroller */
      const ro = new ResizeObserver(() => {
        R.doc.style.setProperty("--sh", R.doc.clientHeight + "px");
        syncSel(true);
      });
      ro.observe(R.doc);
      offs.push(() => ro.disconnect());

      offs.push(
        lab.on("resize", () => {
          applyListMode();
        }),
      );

      /* ------------------------------------------------------ hash in */
      function syncLayers(hs) {
        if (!cur()) return;
        if (hs.stack && cur().stack) openStackPop(true);
        else if (hs.merge) openMergeMenu(true);
        else if (hs.review && $(".c-rbar.on", root)) openReviewPop(true);
      }
      offs.push(
        lab.onHashChange((s, { changed }) => {
          const hs = readHash();
          if (changed.has("q") || changed.has("group") || changed.has("filter")) {
            st.q = hs.q;
            st.group = hs.group;
            st.filter = hs.filter;
            R.search.value = st.q;
            renderList({ flip: true });
          }
          const subChanged = ["file", "thread", "commit", "view", "job"].some((k) =>
            changed.has(k),
          );
          st.view = hs.view;
          st.commit = hs.commit;
          if (changed.has("pr")) {
            st.tab = hs.tab;
            st.file = hs.file;
            st.thread = hs.thread;
            st.job = hs.job;
            selectPR(hs.pr);
            focusFromHash();
          } else if (changed.has("tab")) {
            st.file = hs.file;
            st.thread = hs.thread;
            st.job = hs.job;
            setTab(hs.tab, { fromHash: true });
          } else if (subChanged && cur()) {
            st.file = hs.file;
            st.thread = hs.thread;
            st.job = hs.job;
            renderHeadTools();
            if (st.tab === "files") renderSheet();
            focusFromHash();
          }
          if (["stack", "merge", "review"].some((k) => changed.has(k))) {
            if (!hs.stack && !hs.merge && !hs.review) L.closeLayers();
            else later(() => syncLayers(hs), 60);
          }
        }),
      );
      function focusFromHash() {
        if (!cur()) return;
        if (st.tab === "files") {
          later(() => {
            if (st.thread) scrollToThread(st.thread, "sheet");
            else if (st.file) scrollToFile(st.file);
          }, 40);
        } else if (st.tab === "checks" && st.job) {
          ui.openJobs.add(st.job);
          later(() => focusJob(st.job), 40);
        } else if (st.thread) later(() => scrollToThread(st.thread, "doc"), 40);
      }

      /* ------------------------------------------------------ boot */
      const hs0 = readHash();
      Object.assign(st, {
        q: hs0.q,
        group: hs0.group,
        filter: hs0.filter,
        view: hs0.view,
        commit: hs0.commit,
        file: hs0.file,
        thread: hs0.thread,
        job: hs0.job,
        tab: hs0.tab,
      });
      R.search.value = st.q;
      R.app.classList.add("c-boot");
      applyListMode();
      renderList();
      selectPR(hs0.pr, {
        afterInit: () => {
          const d0 = curD();
          if (hs0.thread) {
            const t0 = M.threadsFor(d0).find((t) => t.id === hs0.thread);
            const f0 = t0 && d0.files.find((f) => f.path === t0.path);
            if (f0?.viewed === "viewed") ui.expandedViewed.add(f0.path);
            if (t0?.isResolved) ui.openResolved.add(t0.id);
          }
          if (hs0.file) ui.expandedViewed.add(hs0.file);
          if (hs0.job) {
            ui.openJobs.add(hs0.job);
            const j = M.checks(d0).jobs.find((x) => x.id === hs0.job);
            const mn = j && mainStepN(j);
            if (mn) ui.openSteps.add(`${j.id}:${mn}`);
          }
        },
      });
      // expand any persisted path/thread state after the first paint
      requestAnimationFrame(() => {
        syncSel(true);
        requestAnimationFrame(() => R.app.classList.remove("c-boot"));
        focusFromHash();
        requestAnimationFrame(() => later(() => syncLayers(hs0), 120));
      });

      return () => {
        offs.forEach((f) => f?.());
        for (const t of timers) clearTimeout(t);
        clearTimeout(peekT);
        io.disconnect();
        titleIO.disconnect();
        toastMO?.disconnect();
        tabsOff?.();
        segOff?.();
        window.PR_LAB_DATA = ORIG;
        M._synth = {};
      };
    },
  });
})();
