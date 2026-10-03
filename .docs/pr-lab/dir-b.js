/* ============================================================
   Direction B · Stack Spine
   Stacks are the page's spatial structure.
   · List: stacks render as connected vertical runs on one spine
     (top layer first, the base branch as the spine's foot). The
     part of a stack that can land right now is tinted on the spine.
   · Detail: one header bar (tabs + next action) and, as its second
     row, the layer strip: base ── layer ── layer ── … left → right.
     The current layer is the expanded segment and carries the title.
   · Moving between layers pushes the whole detail sideways in
     lockstep (split-pane "push, not fade") while the strip segment
     unfolds and the list's selection plate glides along the spine.
   Scope: everything here lives under .dir-b / .b-* classes.
   ============================================================ */
(function () {
  "use strict";
  const L = window.PR_LAB;
  const {
    esc,
    el,
    $,
    $$,
    icon,
    stateGlyph,
    checkGlyph,
    reviewGlyph,
    labelChip,
    diffStat,
    avatar,
    ago,
    agoLong,
    fmtDate,
    dur,
    markdown,
    parsePatch,
    renderDiff,
    buildFileTree,
    plural,
    clamp,
    model,
    menu,
    popover,
    toast,
    confirm,
    checkKind,
    runKind,
  } = L;

  const TABS = [
    { key: "conversation", label: "Conversation", icon: "comment" },
    { key: "files", label: "Files", icon: "file-diff" },
    { key: "checks", label: "Checks", icon: "check-pass" },
    { key: "commits", label: "Commits", icon: "commit" },
  ];
  const METHODS = {
    squash: { label: "Squash and merge", short: "Squash" },
    rebase: { label: "Rebase and merge", short: "Rebase" },
    merge: { label: "Create a merge commit", short: "Merge" },
  };
  const FLAGS = new Set(["stack", "merge", "review"]);
  const EMOJIS = ["👍", "🎉", "❤️", "🚀", "👀", "😄"];
  const CHECK_SVG = `<svg viewBox="0 0 12 12" aria-hidden="true"><path pathLength="1" d="M2.6 6.3l2.2 2.2 4.6-4.9"/></svg>`;

  L.registerDirection({
    id: "b",
    name: "Stack Spine",
    tagline:
      "Stacks are the map: a spine in the list, a layer strip over the detail, push between layers",
    mount,
  });

  function mount(root, _data, lab) {
    /* Work on a private copy so mutations (merge, review, rerun…) never leak
       into the other directions. core.js's model reads window.PR_LAB_DATA. */
    const ORIG = window.PR_LAB_DATA;
    const W = structuredClone(ORIG);
    window.PR_LAB_DATA = W;
    model._synth = {};

    const D = () => window.PR_LAB_DATA;
    const P = (n) => model.pr(n);
    const det = (n) => model.detail(n);
    const me = () => D().viewer.login;
    const S = () => lab.getHashState();
    const tabOf = (s = S()) => (TABS.some((t) => t.key === s.tab) ? s.tab : "conversation");
    const reduced = () => L.reducedMotion();
    const EASE = L.easing("ease");
    const offs = [];
    const timers = new Set();
    const later = (fn, t) => {
      const id = setTimeout(() => {
        timers.delete(id);
        fn();
      }, t);
      timers.add(id);
      return id;
    };
    const short = (login) => String(login).replace(/\[bot\]$/, "");

    const ui = {
      pr: null,
      tab: "conversation",
      method: W.repo.defaultMergeMethod,
      deleteBranch: W.repo.deleteBranchOnMerge,
      through: {},
      collapsed: new Set(),
      fold: new Map(),
      closedDirs: new Set(),
      treeOpen: null,
      jobsOpen: new Set(),
      jobsClosed: new Set(),
      thrOpen: new Set(),
      scroll: new Map(),
      listOpen: false,
      listHidden: false,
      composer: null,
      replying: null,
      draft: new Map(),
      reviewVerdict: "commented",
      seq: 0,
      stripStack: null,
      inflight: [],
      flash: null,
      selChip: null,
    };

    /* ======================================================== model glue */
    function layerReason(p) {
      if (p.state === "merged") return { tone: "merged", text: "Merged" };
      if (p.state === "closed") return { tone: "closed", text: "Closed" };
      if (p.isDraft) return { tone: "neutral", text: "Draft" };
      if (p.mergeable === "conflicting") return { tone: "err", text: "Conflicts" };
      if (p.checks.state === "failing")
        return {
          tone: "err",
          text: p.checks.failed > 1 ? `${p.checks.failed} checks failing` : "Check failing",
        };
      if (p.reviewDecision === "changes_requested")
        return { tone: "warn", text: "Changes requested" };
      if (p.checks.state === "running") return { tone: "run", text: "Checks running" };
      if (p.reviewDecision === "review_required" || p.reviewDecision == null)
        return { tone: "neutral", text: "Needs review" };
      if (p.mergeStateStatus === "BEHIND") return { tone: "warn", text: "Behind base" };
      return { tone: "ok", text: "Ready" };
    }
    /** Highest stack position that could land now (merged layers count as landed). */
    function readyThrough(entries) {
      let ready = 0;
      for (const e of entries) {
        if (e.state === "merged" || layerReason(e).tone === "ok") ready = e.stack.position;
        else break;
      }
      return ready;
    }
    const linkTone = (e, ready) =>
      e.state === "merged" ? "merged" : e.stack && e.stack.position <= ready ? "ok" : "none";
    const soloTone = (p) =>
      p.state === "merged" ? "merged" : layerReason(p).tone === "ok" ? "ok" : "none";
    function rangeOf(layers) {
      if (!layers.length) return "";
      const a = layers[0].number;
      const b = layers[layers.length - 1].number;
      return a === b ? `#${a}` : `#${a}–#${b}`;
    }
    const checkKey = (p) => checkKind(p.checks?.state || "none");
    const listLabel = (a) =>
      ({
        review: "Your review",
        merge: "Ready to merge",
        merged: "Merged",
        closed: "Closed",
        "merge-stack": "Ready to merge",
      })[a.key] || a.label;
    const files = (d) => d?.files || [];
    function pendingCount(n) {
      return det(n)?.pendingReview?.comments?.length || 0;
    }

    /* ======================================================== skeleton */
    root.innerHTML = `
      <div class="b-shell">
        <aside class="b-list" aria-label="Pull requests">
          <div class="b-lhead">
            <label class="field b-search">${icon("search")}<input type="text" spellcheck="false" autocomplete="off" placeholder="Search or paste a PR link" aria-label="Search pull requests" /><kbd>/</kbd></label>
            <button class="ib b-filter" type="button" data-act="filter" data-tip="Filter" aria-haspopup="menu">${icon("filter")}<i class="b-fdot"></i></button>
          </div>
          <div class="b-lscroll scroll"><div class="b-lin"><i class="b-plate"></i><div class="b-rows"></div></div></div>
        </aside>
        <i class="b-scrim" data-act="close-list"></i>
        <section class="b-detail">
          <header class="b-head">
            <div class="b-bar">
              <button class="ib b-listbtn" type="button" data-act="toggle-list" data-tip="Pull requests" data-kbd="\\">${icon("sidebar")}</button>
              <nav class="b-tabs" role="tablist" aria-label="Pull request sections"><i class="seg-ind"></i>${TABS.map(
                (t, i) =>
                  `<button class="b-tab" type="button" role="tab" data-tab="${t.key}" data-tip="${t.label}" data-kbd="${i + 1}" aria-selected="false">${icon(t.icon)}<span class="b-tl-l">${t.label}</span><span class="b-tc tnum"></span></button>`,
              ).join("")}</nav>
              <button class="ib b-treebtn" type="button" data-act="toggle-tree" data-tip="File tree" data-kbd="T">${icon("folder")}<span class="b-tbc tnum"></span></button>
              <span class="b-gap"></span>
              <div class="b-acts">
                <button class="btn b-rev" type="button" data-act="review" data-tip="Finish your review" data-kbd="R">${icon("eye")}<span class="b-rev-l">Review</span><span class="b-rev-c tnum"></span></button>
                <div class="btn-split b-next">
                  <button class="btn b-nm" type="button" data-act="next"><span class="b-nclip"></span></button>
                  <button class="btn b-nmore" type="button" data-act="merge" data-tip="Merge options" data-kbd="M" aria-label="Merge options">${icon("chevron-down")}</button>
                </div>
                <button class="ib b-more" type="button" data-act="more" data-tip="More" aria-label="More actions">${icon("more")}</button>
              </div>
            </div>
            <div class="b-strip"></div>
          </header>
          <div class="b-body"></div>
          <div class="b-empty">
            <div class="b-empty-in">
              ${icon("stack", { size: 22 })}
              <p>Pick a pull request, or paste a link into search.</p>
              <dl><dt><kbd>J</kbd><kbd>K</kbd></dt><dd>Move through the list</dd><dt><kbd>[</kbd><kbd>]</kbd></dt><dd>Step down or up a stack</dd><dt><kbd>/</kbd></dt><dd>Search</dd></dl>
            </div>
          </div>
        </section>
      </div>`;
    const shell = $(".b-shell", root);
    const listEl = $(".b-list", root);
    const rowsEl = $(".b-rows", root);
    const linEl = $(".b-lin", root);
    const lscroll = $(".b-lscroll", root);
    const plate = $(".b-plate", root);
    const search = $(".b-search input", root);
    const detailEl = $(".b-detail", root);
    const tabsEl = $(".b-tabs", root);
    const stripEl = $(".b-strip", root);
    const bodyEl = $(".b-body", root);
    const revBtn = $(".b-rev", root);
    const nextWrap = $(".b-next", root);
    const nextBtn = $(".b-nm", root);
    const nextClip = $(".b-nclip", root);
    offs.push(L.indicator(tabsEl));

    /* ======================================================== list */
    function listGroups(s = S()) {
      const filter = s.filter || "open";
      const q = (s.q || "").trim().toLowerCase();
      let prs = D().pullRequests;
      if (q)
        prs = prs.filter((p) =>
          `#${p.number} ${p.number} ${p.title} ${p.author} ${p.headRefName} ${p.labels.join(" ")}`
            .toLowerCase()
            .includes(q),
        );
      let groups = model.groups(prs, { state: filter });
      if (s.group) groups = groups.filter((g) => g.key === s.group);
      return groups;
    }
    function rowHTML(p, spine) {
      const a = model.nextAction(p);
      const by = p.author !== me() ? `<span class="b-by">${esc(short(p.author))}</span>` : "";
      // The section already says "Needs your review", so those rows trade the
      // repeated label for what a reviewer weighs next: who, and how big.
      const line2 =
        a.key === "review"
          ? `<span class="b-a b-who2">${esc(short(p.author))}</span>${diffStat(p.additions, p.deletions)}${
              p.mergeable === "conflicting"
                ? `<span class="b-a t-err">· conflicts</span>`
                : p.checks.state === "failing"
                  ? `<span class="b-a t-err">· check failing</span>`
                  : ""
            }`
          : `<span class="b-a t-${a.tone}">${esc(listLabel(a))}</span>${by}`;
      return `<button class="b-row ${spine ? "in-run" : ""} ${p.unread ? "unread" : ""}" type="button" data-pr="${p.number}" ${
        p.number === ui.pr ? 'aria-current="true"' : ""
      } ${spine ? `data-up="${spine.up}" data-down="${spine.down}"` : ""}>
        <span class="b-node">${stateGlyph(p, { size: 15, tip: false })}</span>
        <span class="b-t">${esc(p.title)}</span>
        <span class="b-tm tnum">${ago(p.updatedAt)}</span>
        <span class="b-s">${line2}</span>
        <span class="b-num tnum">#${p.number}</span>
      </button>`;
    }
    function runHTML(run) {
      const st = model.stackOf(run[0]);
      const ready = readyThrough(st.entries);
      const tone = (pos) => {
        const e = st.entries[pos - 1];
        return e ? linkTone(e, ready) : "none";
      };
      const rows = run.map((p, k) =>
        rowHTML(p, {
          up: k === 0 ? "off" : tone(p.stack.position + 1),
          down: tone(p.stack.position),
        }),
      );
      const lowest = run[run.length - 1];
      const landable = st.entries.filter((e) => e.state === "open" && e.stack.position <= ready);
      const foot = landable.length
        ? `<span class="b-ft t-ok">${esc(rangeOf(landable))} can land</span>`
        : st.entries.every((e) => e.state === "merged")
          ? `<span class="b-ft t-merged">Stack merged</span>`
          : `<span class="b-ft">Stack ${st.number}</span>`;
      return `<div class="b-run" data-stack="${st.id}">${rows.join("")}<div class="b-foot" data-up="${tone(lowest.stack.position)}"><span class="b-node"><i class="b-ring"></i></span><span class="b-base">${esc(st.baseRefName)}</span>${foot}</div></div>`;
    }
    function groupRows(prs) {
      let out = "";
      let i = 0;
      while (i < prs.length) {
        const p = prs[i];
        if (p.stack) {
          const run = [];
          while (i < prs.length && prs[i].stack?.id === p.stack.id) run.push(prs[i++]);
          out += runHTML(run);
        } else {
          out += rowHTML(p, null);
          i++;
        }
      }
      return out;
    }
    function renderList(opts = {}) {
      const s = S();
      const q = (s.q || "").trim();
      const groups = listGroups(s);
      const before =
        opts.flip && !reduced()
          ? new Map($$(".b-row", rowsEl).map((r) => [r.dataset.pr, r.getBoundingClientRect().top]))
          : null;
      let out = "";
      let shown = 0;
      for (const g of groups) {
        if (!g.prs.length && (q || s.group)) continue;
        shown += g.prs.length;
        const collapsed = ui.collapsed.has(g.key) && !q;
        out += `<section class="b-grp" data-group="${g.key}">
          <button class="b-sec" type="button" data-act="group" data-group="${g.key}" aria-expanded="${!collapsed}"><span>${esc(g.label)}</span><span class="cnt tnum">${g.prs.length}</span>${icon("chevron", { cls: "chev" })}</button>
          <div class="disc ${collapsed ? "" : "open"}"><div>${g.prs.length ? groupRows(g.prs) : `<div class="b-none">Nothing here</div>`}</div></div>
        </section>`;
      }
      if (!shown && q)
        out = `<div class="b-none b-none-q">No pull requests match “${esc(q)}”.<br><span>Paste a link or #number to open one directly.</span></div>`;
      rowsEl.innerHTML = out;
      $(".b-fdot", root).hidden = !(s.filter || s.group);
      if (before) {
        for (const r of $$(".b-row", rowsEl)) {
          const t0 = before.get(r.dataset.pr);
          const t1 = r.getBoundingClientRect().top;
          if (t0 == null)
            L.animate(
              r,
              [
                { opacity: 0, transform: "translateY(6px)" },
                { opacity: 1, transform: "none" },
              ],
              { duration: "stack", easing: "ease" },
            );
          else if (Math.abs(t0 - t1) > 1)
            L.animate(r, [{ transform: `translateY(${t0 - t1}px)` }, { transform: "none" }], {
              duration: "stack",
              easing: "gentle",
            });
        }
      }
      placePlate({ instant: !opts.glide });
    }
    function placePlate(opts = {}) {
      const row = $(`.b-row[data-pr="${ui.pr}"]`, rowsEl);
      const visible = row && row.offsetParent && row.closest(".disc.open, .b-rows");
      if (!row || !visible || row.closest(".disc:not(.open)")) {
        plate.style.opacity = "0";
        return;
      }
      // Layout position (offsetTop), not the visual one: rows may be mid-FLIP.
      let top = row.offsetTop;
      for (let n = row.offsetParent; n && n !== linEl; n = n.offsetParent) top += n.offsetTop;
      const hgt = row.offsetHeight;
      plate.classList.toggle("pane", !!opts.pane);
      if (opts.instant || !plate.dataset.ready) {
        plate.style.transition = "none";
        plate.style.transform = `translateY(${top}px)`;
        plate.style.height = hgt + "px";
        plate.style.opacity = "1";
        void plate.offsetWidth;
        plate.style.transition = "";
        plate.dataset.ready = "1";
      } else {
        plate.style.transform = `translateY(${top}px)`;
        plate.style.height = hgt + "px";
        plate.style.opacity = "1";
      }
      for (const r of $$(".b-row[aria-current]", rowsEl))
        if (r !== row) r.removeAttribute("aria-current");
      row.setAttribute("aria-current", "true");
      const lr = lscroll.getBoundingClientRect();
      const rr = row.getBoundingClientRect();
      if (rr.top < lr.top + 30 || rr.bottom > lr.bottom)
        lscroll.scrollTo({
          top: lscroll.scrollTop + (rr.top - lr.top) - lr.height / 3,
          behavior: reduced() || opts.instant ? "auto" : "smooth",
        });
    }

    /* ======================================================== strip */
    function segHTML(p, current, i) {
      const r = layerReason(p);
      const tip = current ? "" : `data-tip="${esc(`#${p.number} · ${p.title} · ${r.text}`)}"`;
      return `<button class="b-seg" type="button" data-pr="${p.number}" style="--i:${i}" ${current ? 'aria-current="page"' : ""} ${tip}>
        ${stateGlyph(p, { size: 14, tip: false })}<span class="b-sn tnum">#${p.number}</span><span class="b-st"><span>${esc(p.title)}</span></span><i class="b-cd" data-k="${checkKey(p)}"></i></button>`;
    }
    function stripHTML(p) {
      const st = model.stackOf(p);
      if (!st) {
        return `<div class="b-lane"><span class="b-bnode" style="--i:0"><i class="b-ring"></i><span>${esc(p.baseRefName)}</span></span><i class="b-link" data-tone="${soloTone(p)}" style="--i:1"></i>${segHTML(p, true, 2)}</div>`;
      }
      const ready = readyThrough(st.entries);
      const segs = st.entries
        .map(
          (e, k) =>
            `<i class="b-link" data-tone="${linkTone(e, ready)}" style="--i:${k * 2 + 1}"></i>${segHTML(e, e.number === p.number, k * 2 + 2)}`,
        )
        .join("");
      return `<div class="b-lane"><span class="b-bnode" style="--i:0" data-tip="Stack #${st.number} lands on ${esc(st.baseRefName)}"><i class="b-ring"></i><span>${esc(st.baseRefName)}</span></span>${segs}</div>
        <button class="b-stackbtn" type="button" data-act="stack" data-tip="Stack map" data-kbd="S" aria-label="Stack map">${icon("stack")}${icon("chevrons-up-down", { cls: "b-sb-c" })}</button>`;
    }
    function measureStrip() {
      for (const seg of $$(".b-seg", stripEl)) {
        const s = $(".b-st > span", seg);
        if (s) seg.style.setProperty("--tw", Math.ceil(s.scrollWidth) + 1 + "px");
      }
    }
    /** Re-renders the strip. Same stack → in place (segments unfold via CSS); else rebuild + draw-in. */
    function renderStrip(p, opts = {}) {
      if (!p) {
        stripEl.innerHTML = "";
        ui.stripStack = null;
        return;
      }
      const key = p.stack ? p.stack.id : `solo-${p.number}`;
      if (opts.inPlace && key === ui.stripStack && p.stack) {
        const st = model.stackOf(p);
        const ready = readyThrough(st.entries);
        for (const seg of $$(".b-seg", stripEl)) {
          const e = P(+seg.dataset.pr);
          const cur = e.number === p.number;
          if (cur) {
            seg.setAttribute("aria-current", "page");
            seg.removeAttribute("data-tip");
          } else {
            seg.removeAttribute("aria-current");
            seg.dataset.tip = `#${e.number} · ${e.title} · ${layerReason(e).text}`;
          }
          $(".b-cd", seg).dataset.k = checkKey(e);
          const g = $(".sg", seg);
          const fresh = String(stateGlyph(e, { size: 14, tip: false }));
          if (!g.classList.contains(`sg-${L.prState(e)}`)) g.outerHTML = fresh;
        }
        $$(".b-link", stripEl).forEach(
          (lk, k) => (lk.dataset.tone = linkTone(st.entries[k], ready)),
        );
        return;
      }
      stripEl.innerHTML = stripHTML(p);
      stripEl.classList.remove("build");
      if (opts.build && !reduced()) {
        void stripEl.offsetWidth;
        stripEl.classList.add("build");
      }
      ui.stripStack = key;
      measureStrip();
    }

    /* ======================================================== header */
    function primaryFor(p) {
      const a = model.nextAction(p);
      const tone = a.tone;
      const go = (patch) => () => nav(patch, { push: true });
      switch (a.key) {
        case "review": {
          const pend = pendingCount(p.number);
          return {
            tone: "warn",
            glyph: `<i class="b-dot t-warn"></i>`,
            label: pend ? "Submit review" : "Review changes",
            count: pend,
            owns: "review",
            run: () => (popKey === "review" ? closePop() : openReview()),
          };
        }
        case "merge":
          return {
            tone: "ok",
            glyph: icon("pr-merged"),
            label: METHODS[ui.method].label,
            run: () => doMerge(p.number, p.stack?.position),
          };
        case "merge-stack": {
          const plan = model.mergePlan(p.number);
          return {
            tone: "ok",
            glyph: icon("pr-merged"),
            label: `Merge ${rangeOf(plan.layers)}`,
            run: () => doMerge(p.number, p.stack.position),
          };
        }
        case "update-branch":
          return {
            tone: "warn",
            glyph: icon("update-branch"),
            label: "Update branch",
            run: () => updateBranch(p.number),
          };
        case "fix-checks": {
          const job = model.checks(det(p.number)).failing[0];
          return {
            tone: "err",
            glyph: String(checkGlyph("fail", { tip: false })),
            label: a.label,
            run: go({ tab: "checks", job: job?.id || null }),
          };
        }
        case "resolve-conflicts":
          return {
            tone: "err",
            glyph: icon("alert"),
            label: "Resolve conflicts",
            run: () => openMerge(),
          };
        case "address-review": {
          const t = (det(p.number)?.threads || []).find((x) => !x.isResolved && x.line != null);
          return {
            tone: "warn",
            glyph: String(reviewGlyph("changes_requested", { tip: false })),
            label: a.label,
            run: t
              ? go({ tab: "files", thread: t.id, file: t.path, commit: null })
              : go({ tab: "conversation" }),
          };
        }
        case "mark-ready":
          return {
            tone: "neutral",
            glyph: icon("eye"),
            label: "Ready for review",
            run: () => setDraft(p.number, false),
          };
        case "draft":
          return {
            tone: "neutral",
            glyph: String(stateGlyph("draft", { size: 14, tip: false })),
            label: "Draft",
            run: () => openMerge(),
          };
        case "wait-checks":
          return {
            tone: "run",
            glyph: String(checkGlyph("run", { tip: false })),
            label: "Checks running",
            run: go({ tab: "checks" }),
          };
        case "await-review":
          return {
            tone: "neutral",
            glyph: String(reviewGlyph("pending", { tip: false })),
            label: "Awaiting review",
            run: () => openMerge(),
          };
        case "blocked-by-stack": {
          const plan = model.mergePlan(p.number);
          return {
            tone: "neutral",
            glyph: icon("stack"),
            label: a.label,
            run: () => selectPr(plan.blockedBy.pr.number),
          };
        }
        case "auto-merge":
          return {
            tone: "ok-quiet",
            glyph: icon("clock"),
            label: "Auto-merge on",
            run: () => openMerge(),
          };
        case "merged":
          return {
            tone: "merged",
            glyph: String(stateGlyph("merged", { size: 14, tip: false })),
            label: "Merged",
            run: () => openMerge(),
          };
        case "closed":
          return {
            tone: "closed",
            glyph: String(stateGlyph("closed", { size: 14, tip: false })),
            label: "Reopen",
            run: () => reopen(p.number),
          };
        default:
          return { tone, glyph: "", label: a.label, run: () => openMerge() };
      }
    }
    function roll(clip, markup, dir) {
      const old = clip.firstElementChild;
      const nu = el(`<span class="b-nl">${markup}</span>`);
      if (old && old.innerHTML === nu.innerHTML) return false;
      if (!old || reduced() || !dir) {
        clip.replaceChildren(nu);
        return true;
      }
      old.classList.add("b-nl-out");
      clip.append(nu);
      const o = { duration: L.ms("stack"), easing: EASE, fill: "both" };
      const a1 = old.animate(
        [{ transform: "none" }, { transform: `translateY(${-dir * 110}%)` }],
        o,
      );
      nu.animate(
        [{ transform: `translateY(${dir * 110}%)` }, { transform: "none" }],
        o,
      ).finished.then(
        (a) => a.cancel?.(),
        () => {},
      );
      a1.finished.then(
        () => old.remove(),
        () => old.remove(),
      );
      return true;
    }
    function morphWidth(node, mutate) {
      if (reduced()) return mutate();
      const w0 = node.getBoundingClientRect().width;
      const changed = mutate();
      if (changed === false) return;
      const w1 = node.getBoundingClientRect().width;
      if (Math.abs(w1 - w0) < 1) return;
      node.animate([{ width: w0 + "px" }, { width: w1 + "px" }], {
        duration: L.ms("stack"),
        easing: EASE,
      });
    }
    function renderHeader(p, opts = {}) {
      detailEl.dataset.tab = ui.tab;
      for (const b of $$(".b-tab", tabsEl))
        b.setAttribute("aria-selected", String(b.dataset.tab === ui.tab));
      if (!p) return;
      const d = det(p.number);
      const counts = {
        conversation: p.comments || "",
        files: files(d).length || p.changedFiles || "",
        checks: p.checks?.total || "",
        commits: d.commits?.length || p.commitsCount || "",
      };
      for (const b of $$(".b-tab", tabsEl)) $(".b-tc", b).textContent = counts[b.dataset.tab] || "";
      // Review button: only while the PR is open; the count is the pending review.
      const pend = pendingCount(p.number);
      const spec = primaryFor(p);
      // When reviewing *is* the next action, the primary button owns it (one control, not two).
      revBtn.hidden = p.state !== "open" || spec.owns === "review";
      const c = $(".b-rev-c", revBtn);
      const was = c.textContent;
      c.textContent = pend ? String(pend) : "";
      revBtn.classList.toggle("has-pend", !!pend);
      if (pend && was !== String(pend) && !reduced())
        c.animate(
          [
            { transform: "scale(.4)", opacity: 0 },
            { transform: "scale(1.12)" },
            { transform: "none", opacity: 1 },
          ],
          { duration: L.ms("pop") + 60, easing: L.easing("snappy") },
        );
      // Next action: label rolls vertically (push, not fade) and the button morphs width.
      nextWrap.dataset.tone = spec.tone;
      nextWrap.dataset.owns = spec.owns || "";
      const markup = `${spec.glyph || ""}<span class="b-nt">${esc(spec.label)}</span>${spec.count ? `<span class="b-rev-c tnum">${spec.count}</span>` : ""}`;
      morphWidth(nextBtn, () => roll(nextClip, markup, opts.roll ?? 0));
      nextBtn._run = spec.run;
    }

    /* ======================================================== panes */
    function buildPane(n, tab) {
      const p = P(n);
      if (!p)
        return el(
          `<div class="b-pane"><div class="b-none">Pull request #${esc(n)} is not in this mock.</div></div>`,
        );
      if (tab === "files") return filesPane(p);
      if (tab === "checks") return checksPane(p);
      if (tab === "commits") return commitsPane(p);
      return convPane(p);
    }
    const scrollKey = (n, tab) => `${n}:${tab}`;
    function saveScroll() {
      const pane = currentPane();
      if (!pane) return;
      const main = pane.matches(".b-files") ? $(".b-diffs", pane) : pane;
      ui.scroll.set(scrollKey(pane.dataset.pr, pane.dataset.tab), {
        main: main?.scrollTop || 0,
        tree: $(".b-tree", pane)?.scrollTop || 0,
      });
    }
    const currentPane = () => bodyEl.querySelector(":scope > .b-pane:not(.b-out)");
    /** mode: "swap" (instant) | "rise" (new pane rises in; old removed at once) | "push" (lockstep slide, dir ±1). */
    function mountPane(pane, mode, dir, sync) {
      for (const a of ui.inflight) a.finish?.();
      ui.inflight = [];
      $$(":scope > .b-out", bodyEl).forEach((n) => n.remove());
      const old = currentPane();
      if (!old || mode === "swap" || reduced() || mode === "rise") {
        old?.remove();
        bodyEl.append(pane);
        afterPane(pane);
        sync?.();
        if (mode === "rise" && !reduced())
          pane.animate(
            [
              { opacity: 0, transform: "translateY(6px)" },
              { opacity: 1, transform: "none" },
            ],
            { duration: L.ms("stack"), easing: EASE },
          );
        return;
      }
      // "Stage, then push": the incoming layer is laid out off-screen first, then
      // both panes travel by exactly the body width in one frame-aligned animation.
      const w = bodyEl.clientWidth;
      old.classList.add("b-out");
      pane.style.transform = `translateX(${dir * w}px)`;
      bodyEl.append(pane);
      afterPane(pane);
      requestAnimationFrame(() => {
        if (!pane.isConnected) return;
        pane.style.transform = "";
        const o = { duration: L.ms("pane"), easing: EASE, fill: "both" };
        const a1 = old.animate(
          [{ transform: "none" }, { transform: `translateX(${-dir * w}px)` }],
          o,
        );
        const a2 = pane.animate(
          [{ transform: `translateX(${dir * w}px)` }, { transform: "none" }],
          o,
        );
        ui.inflight = [a1, a2];
        sync?.();
        Promise.all([a1.finished, a2.finished])
          .catch(() => {})
          .finally(() => {
            old.remove();
            a2.cancel();
          });
      });
    }
    function afterPane(pane) {
      const s = S();
      const saved = ui.scroll.get(scrollKey(pane.dataset.pr, pane.dataset.tab));
      if (pane.matches(".b-files")) {
        syncTree(pane);
        const diffs = $(".b-diffs", pane);
        const tree = $(".b-tree", pane);
        if (saved) {
          diffs.scrollTop = saved.main;
          tree.scrollTop = saved.tree;
        }
        if (s.thread) requestAnimationFrame(() => focusThread(s.thread, { instant: true }));
        else if (ui.flash) requestAnimationFrame(() => flashLine(ui.flash));
        else if (s.file && !saved)
          requestAnimationFrame(() => scrollToFile(s.file, { instant: true }));
        diffs.addEventListener("scroll", () => spy(pane), { passive: true });
        diffs.addEventListener("mouseup", (e) => selectionChip(e, pane));
        requestAnimationFrame(() => spy(pane));
        for (const seg of $$(".b-vseg", pane)) L.syncIndicator(seg, { instant: true });
      } else if (saved) pane.scrollTop = saved.main;
      if (pane.matches(".b-checks"))
        requestAnimationFrame(() => {
          // Open logs start at the first error line, not at "Set up job".
          for (const log of $$(".b-log", pane)) {
            const err = $(".log-l.err", log);
            if (err) log.scrollTop = Math.max(0, err.offsetTop - log.offsetTop - 36);
          }
          const j = s.job && $(`.b-job[data-job="${CSS.escape(s.job)}"]`, pane);
          if (j && !saved && j.offsetTop + 120 > pane.clientHeight)
            pane.scrollTop = Math.max(0, j.offsetTop - 96);
        });
    }
    /** Re-renders the current pane in place (keeps scroll unless told otherwise). */
    function rebuildPane(opts = {}) {
      if (ui.pr == null) return;
      if (opts.keepScroll !== false) saveScroll();
      else ui.scroll.delete(scrollKey(ui.pr, ui.tab));
      mountPane(buildPane(ui.pr, ui.tab), "swap");
    }

    /* ---------------------------------------------- conversation */
    function convPane(p) {
      const d = det(p.number);
      return el(`<div class="b-pane b-conv scroll" data-pr="${p.number}" data-tab="conversation"><div class="b-cgrid">
        <article class="b-cmain">
          <div class="b-byline">${avatar(p.author, { size: 20 })}<span><b>${esc(short(p.author))}</b> opened this ${agoLong(p.createdAt)} from <code class="b-ref" data-tip="Head branch">${esc(p.headRefName)}</code></span></div>
          <div class="md b-desc">${markdown(d.body)}</div>
          ${timelineHTML(p, d)}
          ${p.state === "open" || p.state === "closed" ? newCommentHTML(p) : ""}
        </article>
        <aside class="b-facts">${factsHTML(p, d)}</aside>
      </div></div>`);
    }
    function factsHTML(p, d) {
      const revs = d.synthetic ? p.reviewers : d.reviewers || p.reviewers;
      const person = (login, trail = "") =>
        `<li class="b-person">${avatar(login, { size: 18 })}<span class="trunc">${esc(model.user(login).team ? "@" + login : short(login))}</span>${trail}</li>`;
      const revRows = revs.length
        ? revs
            .map((r) =>
              person(
                r.login,
                `${r.state === "changes_requested" && p.author === me() ? `<button class="ib sm b-rereq" data-act="rerequest" data-login="${esc(r.login)}" data-tip="Re-request review">${icon("rerun")}</button>` : ""}${reviewGlyph(r.state, { size: 13 })}`,
              ),
            )
            .join("")
        : `<li class="b-nil">No reviewers</li>`;
      const asg = p.assignees.length
        ? p.assignees.map((a) => person(a)).join("")
        : `<li class="b-nil">No one</li>`;
      const lbls = p.labels.length
        ? p.labels.map((l) => String(labelChip(l))).join("")
        : `<span class="b-nil">None</span>`;
      const linked = [
        ...(d.linkedIssues || []).map(
          (i) =>
            `<li class="b-link-row">${icon("issue-open")}<span class="trunc"><span class="tnum dim">#${i.number}</span> ${esc(i.title)}</span></li>`,
        ),
        ...(d.linkedThreads || []).map(
          (t) =>
            `<li class="b-link-row b-agentrow" data-tip="${esc(`${t.model || t.provider} · ${t.state}`)}"><span class="g g-${t.state === "working" ? "working" : "idle"}"></span><span class="trunc">${esc(t.title)}</span></li>`,
        ),
      ];
      const edit = (k, tip) =>
        `<button class="ib sm b-edit" data-act="edit-${k}" data-tip="${tip}">${icon("settings")}</button>`;
      return `
        <section class="b-fact"><h4>Reviewers ${edit("reviewers", "Request reviewers")}</h4><ul>${revRows}</ul></section>
        <section class="b-fact"><h4>Assignees ${edit("assignees", "Assign")}</h4><ul>${asg}</ul></section>
        <section class="b-fact"><h4>Labels ${edit("labels", "Edit labels")}</h4><div class="b-lbls">${lbls}</div></section>
        ${linked.length ? `<section class="b-fact"><h4>Linked</h4><ul>${linked.join("")}</ul></section>` : ""}`;
    }
    function coalesce(evs) {
      const out = [];
      for (const e of evs) {
        const prev = out[out.length - 1];
        const near =
          prev &&
          prev.actor === e.actor &&
          Math.abs(Date.parse(prev.at) - Date.parse(e.at)) < 120e3;
        if (near && e.kind === "labeled" && prev.kind === "labeled") prev.labels.push(e.label);
        else if (near && e.kind === "review_requested" && prev.kind === "review_requested")
          prev.reviewersList.push(e.reviewer);
        else if (e.kind === "labeled") out.push({ ...e, labels: [e.label] });
        else if (e.kind === "review_requested") out.push({ ...e, reviewersList: [e.reviewer] });
        else out.push(e);
      }
      return out;
    }
    function timelineHTML(p, d) {
      const evs = coalesce((d.timeline || []).filter((e) => e.kind !== "opened"));
      if (!evs.length) return "";
      return `<ol class="b-tl">${evs.map((e) => evHTML(e, p, d)).join("")}</ol>`;
    }
    const who = (login) => `<b class="b-who">${esc(short(login))}</b>`;
    const time = (at) => `<time data-tip="${esc(fmtDate(at))}">${ago(at)}</time>`;
    function small(ic, body, at, cls = "") {
      return `<li class="b-ev sm ${cls}"><span class="b-ev-n">${ic}</span><div class="b-ev-b">${body} ${time(at)}</div></li>`;
    }
    function evHTML(e, p, d) {
      switch (e.kind) {
        case "labeled":
          return small(
            icon("tag"),
            `${who(e.actor)} added ${e.labels.map((l) => String(labelChip(l))).join(" ")}`,
            e.at,
          );
        case "review_requested":
          return small(
            icon("users"),
            `${who(e.actor)} requested review from ${e.reviewersList.map((r) => who(r)).join(", ")}`,
            e.at,
          );
        case "assigned":
          return small(
            icon("user"),
            e.assignee === e.actor
              ? `${who(e.actor)} self-assigned this`
              : `${who(e.actor)} assigned ${who(e.assignee)}`,
            e.at,
          );
        case "renamed":
          return small(
            icon("edit"),
            `${who(e.actor)} renamed this from <del>${esc(e.from)}</del>`,
            e.at,
          );
        case "ready_for_review":
          return small(icon("eye"), `${who(e.actor)} marked this ready for review`, e.at);
        case "convert_to_draft":
          return small(icon("pr-draft"), `${who(e.actor)} converted this to a draft`, e.at);
        case "base_changed":
          return small(
            icon("branch"),
            `${who(e.actor)} changed the base from <code class="b-ref">${esc(e.from)}</code> to <code class="b-ref">${esc(e.to)}</code>`,
            e.at,
          );
        case "force_pushed":
          return small(
            icon("rerun"),
            `${who(e.actor)} force-pushed <code class="b-ref">${esc(String(e.before).slice(0, 7))}</code> → <code class="b-ref">${esc(String(e.after).slice(0, 7))}</code>${e.note ? ` <span class="dim">· ${esc(e.note)}</span>` : ""}`,
            e.at,
          );
        case "updated":
          return small(
            icon("update-branch"),
            `${who(e.actor)} updated the branch with <code class="b-ref">${esc(e.base)}</code>`,
            e.at,
          );
        case "merged":
          return small(
            `<span class="sg sg-merged" style="--s:13px">${icon("pr-merged")}</span>`,
            `${who(e.actor)} merged this into <code class="b-ref">${esc(e.base || p.baseRefName)}</code>`,
            e.at,
            "t-merged",
          );
        case "closed":
          return small(
            `<span class="sg sg-closed" style="--s:13px">${icon("pr-closed")}</span>`,
            `${who(e.actor)} closed this`,
            e.at,
          );
        case "reopened":
          return small(
            `<span class="sg sg-open" style="--s:13px">${icon("pr-open")}</span>`,
            `${who(e.actor)} reopened this`,
            e.at,
          );
        case "commits":
          return `<li class="b-ev sm"><span class="b-ev-n">${icon("commit")}</span><div class="b-ev-b">${who(e.actor)} pushed ${plural(e.commits.length, "commit")} ${time(e.at)}
            <ul class="b-evcm">${e.commits.map((c) => `<li><button class="b-sha" type="button" data-act="commit" data-sha="${esc(c.short)}">${esc(c.short)}</button><span class="trunc">${esc(c.message)}</span></li>`).join("")}</ul></div></li>`;
        case "comment":
          return `<li class="b-ev lg"><span class="b-ev-n">${avatar(e.actor, { size: 24 })}</span><div class="b-ev-b">
            <div class="b-ev-h">${who(e.actor)} <span class="dim">commented</span> ${time(e.at)}${e.editedAt ? `<span class="dim" data-tip="${esc(fmtDate(e.editedAt))}">· edited</span>` : ""}</div>
            <div class="md">${markdown(e.body)}</div>${rxHTML(e.id, e.reactions)}</div></li>`;
        case "review": {
          const verb =
            {
              approved: "approved",
              changes_requested: "requested changes",
              commented: "reviewed",
              dismissed: "had a review dismissed",
            }[e.state] || "reviewed";
          const thr = (e.threadIds || [])
            .map((id) => d.threads.find((t) => t.id === id))
            .filter(Boolean);
          return `<li class="b-ev lg"><span class="b-ev-n">${avatar(e.actor, { size: 24 })}</span><div class="b-ev-b">
            <div class="b-ev-h">${who(e.actor)} <span class="b-verdict v-${e.state}">${e.state !== "commented" ? reviewGlyph(e.state, { size: 13, tip: false }) : ""}${verb}</span> ${time(e.at)}</div>
            ${e.body ? `<div class="md">${markdown(e.body)}</div>` : ""}
            ${thr.map((t) => tlThreadHTML(t, d)).join("")}</div></li>`;
        }
        default:
          return small(
            icon("dot"),
            `${who(e.actor || p.author)} ${esc(e.kind.replace(/_/g, " "))}`,
            e.at,
          );
      }
    }
    function rxHTML(cid, list = []) {
      return `<div class="b-rx">${(list || [])
        .filter((r) => r.count > 0)
        .map(
          (r) =>
            `<button class="b-rxb ${r.viewerReacted ? "on" : ""}" type="button" data-act="react" data-cid="${esc(cid)}" data-emoji="${esc(r.emoji)}">${r.emoji}<span class="tnum">${r.count}</span></button>`,
        )
        .join(
          "",
        )}<button class="b-rxadd" type="button" data-act="react-add" data-cid="${esc(cid)}" data-tip="Add reaction">${icon("smile")}</button></div>`;
    }
    function snippetHTML(t) {
      const rows = parsePatch(t.diffHunk || "").filter((r) => r.kind !== "hunk");
      if (!rows.length) return "";
      const tail = rows.slice(-4);
      return `<div class="b-snip">${renderDiff(tail, {
        path: t.path,
        lineClass: (ref) =>
          ref.line === (t.line ?? t.originalLine) && ref.side === t.side ? "sel" : "",
      })}</div>`;
    }
    function tlThreadHTML(t, d) {
      const open = !t.isResolved || ui.thrOpen.has(t.id);
      const name = t.path.split("/").pop();
      return `<div class="b-tthr ${t.isResolved ? "resolved" : ""}" data-thread="${esc(t.id)}">
        <div class="b-tthr-h">
          <button class="b-tthr-p" type="button" data-act="goto-thread" data-thread="${esc(t.id)}" data-tip="${esc(t.path)}">${icon("file")}<span class="trunc">${esc(name)}</span><span class="dim tnum">${t.line != null ? `line ${t.line}` : `was line ${t.originalLine}`}</span></button>
          ${t.isOutdated ? `<span class="b-tag">Outdated</span>` : ""}
          ${t.isResolved ? `<button class="b-tag b-tag-btn" type="button" data-act="thr-toggle" data-thread="${esc(t.id)}">${icon("resolve")}Resolved${icon("chevron", { cls: `chev ${open ? "open" : ""}` })}</button>` : ""}
        </div>
        <div class="disc ${open ? "open" : ""}"><div>${snippetHTML(t)}${threadBodyHTML(t, d, { inTimeline: true })}</div></div>
      </div>`;
    }
    function commentHTML(c, t) {
      return `<div class="b-c ${c.pending ? "pending" : ""}">${avatar(c.author, { size: 20 })}<div class="b-c-b">
        <div class="b-c-h">${who(c.author)} ${time(c.createdAt || W.now)}${c.pending ? `<span class="b-tag b-tag-pend">Pending</span>` : ""}</div>
        <div class="md">${markdown(c.body, { suggestionBase: t.lineText, suggestionLine: t.line ?? t.originalLine })}</div>
        ${/```suggestion/.test(c.body) && !t.isResolved && !c.pending && P(ui.pr)?.state === "open" ? `<div class="b-sugg"><button class="btn sm" type="button" data-act="apply-sugg" data-thread="${esc(t.id)}">${icon("commit")}Commit suggestion</button></div>` : ""}
        ${c.pending ? "" : rxHTML(c.id, c.reactions)}</div></div>`;
    }
    function threadBodyHTML(t, d, opts = {}) {
      const replyKey = `r:${t.id}`;
      const replying = ui.replying === t.id;
      const foot = t.pending
        ? `<div class="b-thr-foot"><span class="dim">Part of your pending review</span><span class="b-gap"></span><button class="btn sm ghost danger" type="button" data-act="del-pending" data-thread="${esc(t.id)}">${icon("trash")}Delete</button></div>`
        : replying
          ? `<div class="b-thr-foot b-replying">${composerBox(replyKey, "Reply…", `<button class="btn sm ghost" type="button" data-act="reply-cancel">Cancel</button><button class="btn sm pri" type="button" data-act="reply-send" data-thread="${esc(t.id)}">Reply <kbd>⌘↵</kbd></button>`)}</div>`
          : `<div class="b-thr-foot">
              <button class="b-reply" type="button" data-act="reply" data-thread="${esc(t.id)}">Reply…</button>
              <button class="btn sm ghost" type="button" data-act="${t.isResolved ? "unresolve" : "resolve"}" data-thread="${esc(t.id)}">${icon(t.isResolved ? "undo" : "resolve")}${t.isResolved ? "Unresolve" : "Resolve"}</button>
              <button class="b-agentbtn" type="button" data-act="ask-thread" data-thread="${esc(t.id)}" data-tip="Ask an agent about this thread">${icon("agent")}Ask agent</button>
            </div>`;
      return `<div class="b-thr-cs">${t.comments.map((c) => commentHTML(c, t)).join("")}</div>${opts.noFoot ? "" : foot}`;
    }
    function composerBox(key, placeholder, actions) {
      return `<div class="b-cbox"><textarea class="b-ta" rows="2" data-draft="${esc(key)}" placeholder="${esc(placeholder)}">${esc(ui.draft.get(key) || "")}</textarea><div class="b-cbar">${actions}</div></div>`;
    }
    function newCommentHTML(p) {
      return `<div class="b-newc">${avatar(me(), { size: 24 })}${composerBox(
        `c:${p.number}`,
        "Add a comment…",
        `<span class="dim">Markdown</span><span class="b-gap"></span><button class="btn sm pri" type="button" data-act="post-comment">Comment <kbd>⌘↵</kbd></button>`,
      )}</div>`;
    }

    /* ---------------------------------------------- files */
    const foldKey = (n, path) => `${n}:${path}`;
    function isFolded(n, f) {
      const k = foldKey(n, f.path);
      return ui.fold.has(k) ? ui.fold.get(k) : f.viewed === "viewed";
    }
    function scopedFiles(p, s = S()) {
      const all = files(det(p.number));
      return s.commit ? all.filter((f) => (f.commits || []).includes(s.commit)) : all;
    }
    function treeOpen() {
      if (ui.treeOpen != null) return ui.treeOpen;
      return detailEl.clientWidth >= 720;
    }
    /** Tree visibility lives on the pane; the header toggle carries the viewed count only while the tree (which owns it) is hidden. */
    function syncTree(pane = currentPane()) {
      const open = treeOpen();
      pane?.classList.toggle("tree-off", !open);
      detailEl.classList.toggle("tree-off", !open);
      const all = files(det(ui.pr));
      $(".b-tbc", root).textContent = all.length
        ? `${all.filter((f) => f.viewed === "viewed").length}/${all.length}`
        : "";
    }
    function filesPane(p) {
      const s = S();
      const d = det(p.number);
      const list = scopedFiles(p, s);
      const all = files(d);
      if (!all.length)
        return el(
          `<div class="b-pane b-files-empty scroll" data-pr="${p.number}" data-tab="files"><div class="b-none">File diffs aren’t mocked for #${p.number}.</div></div>`,
        );
      const viewed = all.filter((f) => f.viewed === "viewed").length;
      const commit = s.commit ? d.commits.find((c) => c.short === s.commit) : null;
      const adds = list.reduce((a, f) => a + (f.additions || 0), 0);
      const dels = list.reduce((a, f) => a + (f.deletions || 0), 0);
      const view = s.view === "split" ? "split" : "unified";
      const pane =
        el(`<div class="b-pane b-files ${treeOpen() ? "" : "tree-off"}" data-pr="${p.number}" data-tab="files">
        <aside class="b-tree scroll">
          <div class="b-tree-h">
            <button class="b-scope ${commit ? "on" : ""}" type="button" data-act="scope" data-tip="${commit ? "Commenting is off while scoped to one commit" : "Scope to a commit"}" data-kbd="C">${icon("commit")}<span class="trunc">${commit ? `${esc(commit.short)} · ${esc(commit.message)}` : "All commits"}</span>${commit ? `<span class="b-scope-x" data-act="unscope" role="button" aria-label="Show all commits">${icon("x")}</span>` : icon("chevron-down", { cls: "b-scope-c" })}</button>
            <div class="b-tree-m">
              <span class="tnum"><b class="b-vc">${viewed}</b>/${all.length} viewed</span>
              ${diffStat(adds, dels)}
              <span class="b-gap"></span>
              <div class="seg b-vseg" role="radiogroup" aria-label="Diff layout"><i class="seg-ind"></i><button class="seg-opt" type="button" role="radio" data-act="view" data-view="unified" aria-checked="${view === "unified"}" data-tip="Unified" data-kbd="U">${icon("unified")}</button><button class="seg-opt" type="button" role="radio" data-act="view" data-view="split" aria-checked="${view === "split"}" data-tip="Split" data-kbd="U">${icon("split")}</button></div>
            </div>
            <i class="b-prog"><i style="transform:scaleX(${all.length ? viewed / all.length : 0})"></i></i>
          </div>
          <div class="b-tree-l">${treeHTML(buildFileTree(list), 0, p, d)}</div>
        </aside>
        <div class="b-diffs scroll">${list.map((f) => fileHTML(p, d, f, s)).join("")}<div class="b-diffs-end">${list.length === all.length ? `${plural(all.length, "file")} · end of changes` : `${list.length} of ${all.length} files touched by ${esc(s.commit)}`}</div></div>
      </div>`);
      return pane;
    }
    function treeHTML(nodes, depth, p, d) {
      return nodes
        .map((nd) => {
          if (nd.kind === "dir") {
            const open = !ui.closedDirs.has(nd.path);
            return `<div class="b-tdir"><button class="b-tn b-tn-d" type="button" data-act="tdir" data-dir="${esc(nd.path)}" style="--d:${depth}" aria-expanded="${open}">${icon("chevron", { cls: "chev" })}<span class="trunc">${esc(nd.name)}</span></button><div class="disc ${open ? "open" : ""}"><div>${treeHTML(nd.children, depth + 1, p, d)}</div></div></div>`;
          }
          const f = nd.file;
          const thr = model.threadsFor(d, f.path).filter((t) => !t.isResolved).length;
          return `<button class="b-tn b-tn-f ${f.viewed === "viewed" ? "viewed" : ""}" type="button" data-act="tfile" data-path="${esc(f.path)}" style="--d:${depth}" data-tip="${esc(f.path)}"><i class="b-fs fs-${esc(f.status)}"></i><span class="trunc">${esc(nd.name)}</span>${thr ? `<span class="b-tcnt tnum">${icon("comment")}${thr}</span>` : ""}<span class="b-tv">${icon("check")}</span></button>`;
        })
        .join("");
    }
    function fileHTML(p, d, f, s) {
      const n = p.number;
      const folded = isFolded(n, f);
      const thr = model.threadsFor(d, f.path);
      const live = thr.filter((t) => t.line != null);
      const outdated = thr.filter((t) => t.line == null);
      const byRef = new Map();
      for (const t of live) {
        const k = `${t.side}:${t.line}`;
        if (!byRef.has(k)) byRef.set(k, []);
        byRef.get(k).push(t);
      }
      const comp =
        ui.composer && ui.composer.n === n && ui.composer.path === f.path ? ui.composer : null;
      const rows = parsePatch(f.patch || "");
      const commentable = p.state === "open" && !s.commit;
      const diff = renderDiff(rows, {
        mode: s.view === "split" ? "split" : "unified",
        path: f.path,
        commentable,
        lineClass: (ref) => {
          const k = `${ref.side}:${ref.line}`;
          const c = [];
          if (byRef.has(k)) c.push("has-thread");
          if (comp && comp.side === ref.side && comp.line === ref.line) c.push("sel");
          return c.join(" ");
        },
        annotate: (ref) => {
          const k = `${ref.side}:${ref.line}`;
          let out = (byRef.get(k) || []).map((t) => inlineThreadHTML(t, d)).join("");
          if (comp && comp.side === ref.side && comp.line === ref.line)
            out += composerHTML(n, comp);
          return out || null;
        },
      });
      const unresolved = thr.filter((t) => !t.isResolved).length;
      const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/") + 1) : "";
      const name = f.path.slice(dir.length);
      return `<section class="b-file ${folded ? "folded" : ""}" data-path="${esc(f.path)}">
        <header class="b-fh">
          <button class="b-fold" type="button" data-act="fold" data-path="${esc(f.path)}" aria-expanded="${!folded}" aria-label="Toggle file">${icon("chevron", { cls: "chev" })}</button>
          <button class="b-fp" type="button" data-act="fold" data-path="${esc(f.path)}"><span class="b-fdir"><bdi>${esc(dir)}</bdi></span><span class="b-fname">${esc(name)}</span></button>
          ${f.status === "added" ? `<span class="b-tag">New</span>` : f.status === "removed" ? `<span class="b-tag">Deleted</span>` : ""}
          ${diffStat(f.additions, f.deletions)}
          ${unresolved ? `<span class="b-fthr tnum" data-tip="${plural(unresolved, "open conversation")}">${icon("comment")}${unresolved}</span>` : ""}
          <span class="b-gap"></span>
          <button class="b-viewed" type="button" role="checkbox" data-act="viewed" data-path="${esc(f.path)}" aria-checked="${f.viewed === "viewed"}" data-kbd="V" data-tip="Mark viewed and fold"><i class="b-box">${CHECK_SVG}</i>Viewed</button>
        </header>
        <div class="disc b-fbody ${folded ? "" : "open"}"><div><div class="b-dwrap">${diff}</div>${
          outdated.length
            ? `<div class="b-outd"><div class="b-outd-h">${icon("clock")}${plural(outdated.length, "outdated conversation")}</div>${outdated.map((t) => inlineThreadHTML(t, d, true)).join("")}</div>`
            : ""
        }</div></div>
      </section>`;
    }
    function inlineThreadHTML(t, d, outdated) {
      const open = !t.isResolved || ui.thrOpen.has(t.id);
      const last = t.comments[t.comments.length - 1];
      const focus = S().thread === t.id ? "focus" : "";
      if (!open)
        return `<div class="b-thr resolved ${focus}" data-thread="${esc(t.id)}"><button class="b-thr-sum" type="button" data-act="thr-toggle" data-thread="${esc(t.id)}">${icon("resolve")}<span>Resolved${t.resolvedBy ? ` by ${esc(short(t.resolvedBy))}` : ""}</span><span class="dim">· ${plural(t.comments.length, "comment")} · last by ${esc(short(last.author))}</span>${icon("chevron", { cls: "chev" })}</button></div>`;
      return `<div class="b-thr ${t.isResolved ? "resolved" : ""} ${t.pending ? "pending" : ""} ${focus}" data-thread="${esc(t.id)}">
        ${t.isResolved ? `<button class="b-thr-sum" type="button" data-act="thr-toggle" data-thread="${esc(t.id)}">${icon("resolve")}<span>Resolved${t.resolvedBy ? ` by ${esc(short(t.resolvedBy))}` : ""}</span>${icon("chevron", { cls: "chev open" })}</button>` : ""}
        ${outdated ? snippetHTML(t) : ""}
        ${threadBodyHTML(t, d)}
      </div>`;
    }
    function composerHTML(n, comp) {
      const key = `n:${n}:${comp.path}:${comp.side}:${comp.line}`;
      const pend = pendingCount(n);
      return `<div class="b-thr b-newthr">${composerBox(
        key,
        `Comment on line ${comp.side === "LEFT" ? "L" : "R"}${comp.line}…`,
        `<span class="dim b-hint">Suggest with <code>\`\`\`suggestion</code></span><span class="b-gap"></span><button class="btn sm ghost" type="button" data-act="comp-cancel">Cancel</button><button class="btn sm" type="button" data-act="comp-single">Add single comment</button><button class="btn sm pri" type="button" data-act="comp-review">${pend ? "Add to review" : "Start a review"} <kbd>⌘↵</kbd></button>`,
      )}</div>`;
    }
    function rerenderFile(path) {
      const pane = currentPane();
      if (!pane?.matches(".b-files")) return;
      const sec = $(`.b-file[data-path="${CSS.escape(path)}"]`, pane);
      const p = P(ui.pr);
      const f = files(det(ui.pr)).find((x) => x.path === path);
      if (!sec || !f) return;
      const nu = el(fileHTML(p, det(ui.pr), f, S()));
      sec.replaceWith(nu);
      refreshTree(pane);
      return nu;
    }
    function refreshTree(pane) {
      const p = P(ui.pr);
      const d = det(ui.pr);
      const tl = $(".b-tree-l", pane);
      if (tl) tl.innerHTML = treeHTML(buildFileTree(scopedFiles(p)), 0, p, d);
      const all = files(d);
      const v = all.filter((f) => f.viewed === "viewed").length;
      const vc = $(".b-vc", pane);
      if (vc) vc.textContent = v;
      const bar = $(".b-prog > i", pane);
      if (bar) bar.style.transform = `scaleX(${all.length ? v / all.length : 0})`;
      syncTree(pane);
      spy(pane);
    }
    function spy(pane) {
      const diffs = $(".b-diffs", pane);
      if (!diffs) return;
      const top = diffs.getBoundingClientRect().top + 44;
      let cur = null;
      for (const sec of $$(".b-file", diffs)) {
        if (sec.getBoundingClientRect().bottom > top) {
          cur = sec.dataset.path;
          break;
        }
      }
      for (const t of $$(".b-tn-f", pane)) t.classList.toggle("cur", t.dataset.path === cur);
      pane.dataset.cur = cur || "";
    }
    function scrollInto(scroller, node, opts = {}) {
      const top =
        scroller.scrollTop +
        node.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top -
        (opts.offset ?? 48);
      scroller.scrollTo({
        top: Math.max(0, top),
        behavior: opts.instant || reduced() ? "auto" : "smooth",
      });
    }
    function scrollToFile(path, opts = {}) {
      const pane = currentPane();
      const sec = pane && $(`.b-file[data-path="${CSS.escape(path)}"]`, pane);
      if (sec) scrollInto($(".b-diffs", pane), sec, { offset: 0, instant: opts.instant });
    }
    function flashNode(node) {
      if (!node) return;
      node.classList.remove("b-flash");
      void node.offsetWidth;
      node.classList.add("b-flash");
      later(() => node.classList.remove("b-flash"), 1400);
    }
    function focusThread(id, opts = {}) {
      const pane = currentPane();
      if (!pane?.matches(".b-files")) return;
      const node = $(`.b-thr[data-thread="${CSS.escape(id)}"]`, pane);
      if (!node) return;
      const sec = node.closest(".b-file");
      if (sec?.classList.contains("folded")) setFold(sec.dataset.path, false, { instant: true });
      scrollInto($(".b-diffs", pane), node, { offset: 140, instant: opts.instant });
      flashNode(node);
    }
    function flashLine(target) {
      ui.flash = null;
      const pane = currentPane();
      if (!pane?.matches(".b-files")) return;
      const sec = $(`.b-file[data-path="${CSS.escape(target.path)}"]`, pane);
      if (!sec) return;
      if (sec.classList.contains("folded")) setFold(target.path, false, { instant: true });
      const row =
        $(`tr.d-row[data-side="RIGHT"][data-line="${target.line}"]`, sec) ||
        $(`td.d-code[data-side="RIGHT"][data-line="${target.line}"]`, sec)?.closest("tr");
      if (!row) return scrollInto($(".b-diffs", pane), sec, { offset: 0, instant: true });
      scrollInto($(".b-diffs", pane), row, { offset: 160, instant: true });
      flashNode(row);
    }
    function setFold(path, folded, opts = {}) {
      const pane = currentPane();
      const sec = pane && $(`.b-file[data-path="${CSS.escape(path)}"]`, pane);
      ui.fold.set(foldKey(ui.pr, path), folded);
      if (!sec) return;
      const body = $(".b-fbody", sec);
      // Jumps (thread links, log links) need the final geometry right away to scroll to it.
      if (opts.instant) body.style.transition = "none";
      sec.classList.toggle("folded", folded);
      body.classList.toggle("open", !folded);
      for (const b of $$('[data-act="fold"]', sec))
        b.setAttribute("aria-expanded", String(!folded));
      if (opts.instant) {
        void body.offsetHeight;
        body.style.transition = "";
      }
    }
    function toggleViewed(path) {
      const f = files(det(ui.pr)).find((x) => x.path === path);
      if (!f) return;
      f.viewed = f.viewed === "viewed" ? "unviewed" : "viewed";
      const v = f.viewed === "viewed";
      const pane = currentPane();
      const sec = pane && $(`.b-file[data-path="${CSS.escape(path)}"]`, pane);
      if (sec) $(".b-viewed", sec).setAttribute("aria-checked", String(v));
      setFold(path, v);
      if (pane) refreshTree(pane);
      if (v && sec) {
        // Keep the reader anchored: if the folded file's header scrolled off, snap it back to the top.
        const diffs = $(".b-diffs", pane);
        if (sec.getBoundingClientRect().top < diffs.getBoundingClientRect().top)
          scrollInto(diffs, sec, { offset: 0 });
      }
    }

    /* ---------------------------------------------- checks */
    function logLineHTML(line, d) {
      const cls = /^\$ /.test(line)
        ? "cmd"
        : /(^|\s)(×|FAIL|Error|error:|##\[error\]|AssertionError)/.test(line)
          ? "err"
          : /^\s*✓/.test(line)
            ? "ok"
            : "";
      let text = esc(line);
      const m = line.match(/((?:[\w.@-]+\/)+[\w.-]+\.[a-z]{1,4}):(\d+)(?::\d+)?/);
      if (m) {
        const f = files(d).find((x) => x.path.endsWith(m[1]));
        if (f)
          text = text.replace(
            esc(m[0]),
            `<a class="b-loglink" data-act="goto-line" data-path="${esc(f.path)}" data-line="${m[2]}" data-tip="Open ${esc(f.path.split("/").pop())} at line ${m[2]}">${esc(m[0])}</a>`,
          );
      }
      return `<span class="log-l ${cls}">${text || " "}</span>`;
    }
    function jobOpen(j, s) {
      if (ui.jobsClosed.has(j.id)) return false;
      return ui.jobsOpen.has(j.id) || s.job === j.id;
    }
    function checksPane(p) {
      const s = S();
      const d = det(p.number);
      const c = model.checks(d);
      if (!c.workflows.length && !c.statuses.length)
        return el(
          `<div class="b-pane b-checks scroll" data-pr="${p.number}" data-tab="checks"><div class="b-chk"><div class="b-none">${esc(c.note || "No checks reported for this pull request.")}</div></div></div>`,
        );
      const sum = p.checks;
      const failing = c.failing.length;
      const summary = [
        failing ? `<b class="t-err">${failing} failing</b>` : "",
        sum.running ? `<b class="t-run">${sum.running} running</b>` : "",
        `<span>${sum.passed} passed</span>`,
        sum.skipped ? `<span>${sum.skipped} skipped</span>` : "",
      ]
        .filter(Boolean)
        .join('<span class="sep">·</span>');
      const required = D().repo.protection.requiredChecks;
      const wfHTML = c.workflows
        .map((w) => {
          const wk = runKind(w);
          const failed = w.jobs.filter((j) => j.conclusion === "failure");
          return `<section class="b-wf">
            <div class="b-wf-h">${checkGlyph(w, { size: 14 })}<b>${esc(w.name)}</b><span class="dim tnum">${esc(w.event)} · #${w.runNumber}${w.durationSec ? ` · ${dur(w.durationSec)}` : ""} · ${ago(w.startedAt)}</span><span class="b-gap"></span>
              ${failed.length ? `<button class="btn sm" type="button" data-act="rerun-failed" data-wf="${esc(w.id)}">${icon("rerun")}Rerun failed</button>` : ""}
              <button class="ib sm" type="button" data-act="ext" data-tip="Open run on GitHub">${icon("external")}</button></div>
            <div class="b-jobs">${w.jobs.map((j) => jobHTML(j, d, s, required)).join("")}</div>
          </section>`;
        })
        .join("");
      const st = c.statuses.length
        ? `<section class="b-wf"><div class="b-wf-h">${icon("rocket")}<b>Deployments</b></div><div class="b-jobs">${c.statuses
            .map(
              (x) =>
                `<div class="b-job"><div class="b-job-h static">${checkGlyph(x.state)}<span class="b-jn">${esc(x.name)}</span><span class="dim trunc">${esc(x.description || "")}</span><span class="b-gap"></span><button class="btn sm ghost" type="button" data-act="ext">${icon("external")}Preview</button></div></div>`,
            )
            .join("")}</div></section>`
        : "";
      return el(`<div class="b-pane b-checks scroll" data-pr="${p.number}" data-tab="checks"><div class="b-chk">
        <div class="b-chk-sum">${checkGlyph(sum.state, { size: 16 })}<span class="b-chk-t">${summary}</span><span class="b-gap"></span><span class="dim b-req" data-tip="${esc(required.join(", "))}">${required.length} required by ${esc(D().repo.protection.branch)}</span></div>
        ${wfHTML}${st}
      </div></div>`);
    }
    function jobHTML(j, d, s, required) {
      const k = runKind(j);
      const open = jobOpen(j, s);
      const failStep = j.steps.find((x) => x.conclusion === "failure");
      const runStep = j.steps.find((x) => x.status === "in_progress");
      const logAt = failStep || runStep || null;
      const req = required.includes(j.name);
      const steps = j.steps
        .map((st) => {
          const sk = runKind(st);
          const showLog = logAt === st;
          return `<li class="b-step k-${sk}"><span class="b-step-h">${checkGlyph(st, { size: 12, tip: false })}<span class="b-step-n tnum">${st.n}</span><span class="trunc">${esc(st.name)}</span><span class="b-gap"></span><span class="dim tnum">${st.durationSec != null ? dur(st.durationSec) : ""}</span></span>${
            showLog && j.log?.length
              ? `<div class="b-log log">${j.log.map((l) => logLineHTML(l, d)).join("")}</div>`
              : ""
          }</li>`;
        })
        .join("");
      return `<div class="b-job k-${k} ${open ? "open" : ""}" data-job="${esc(j.id)}">
        <div class="b-job-h" role="button" tabindex="0" data-act="job" data-job="${esc(j.id)}" aria-expanded="${open}">
          ${icon("chevron", { cls: "chev" })}${checkGlyph(j, { size: 14, animate: !!j._fresh })}<span class="b-jn">${esc(j.name)}</span>${req ? `<span class="b-tag">Required</span>` : ""}
          <span class="b-gap"></span>
          ${k === "fail" ? `<button class="b-agentbtn" type="button" data-act="fix-agent" data-job="${esc(j.id)}" data-tip="Hand this failure to an agent in a new thread">${icon("agent")}Fix with agent</button>` : ""}
          <span class="dim tnum b-jd">${j.durationSec ? dur(j.durationSec) : k === "run" ? "running…" : k === "queued" ? "queued" : ""}</span>
          <button class="ib sm b-jrr" type="button" data-act="rerun-job" data-job="${esc(j.id)}" data-tip="Rerun job" ${k === "run" || k === "queued" ? 'aria-disabled="true"' : ""}>${icon("rerun")}</button>
        </div>
        <div class="disc ${open ? "open" : ""}"><div><ol class="b-steps">${steps}</ol>${
          !logAt && j.log?.length
            ? `<div class="b-log log b-log-tail">${j.log
                .slice(-8)
                .map((l) => logLineHTML(l, d))
                .join("")}</div>`
            : ""
        }</div></div>
      </div>`;
    }

    /* ---------------------------------------------- commits */
    function commitsPane(p) {
      const d = det(p.number);
      const s = S();
      if (!d.commits?.length)
        return el(
          `<div class="b-pane b-commits scroll" data-pr="${p.number}" data-tab="commits"><div class="b-cms-in"><div class="b-none">Commits aren’t mocked for #${p.number}.</div></div></div>`,
        );
      const items = [
        ...d.commits.map((c) => ({ kind: "c", at: c.committedAt, c })),
        ...(d.timeline || [])
          .filter((e) => e.kind === "force_pushed")
          .map((e) => ({ kind: "f", at: e.at, e })),
      ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || (a.kind === "f" ? -1 : 1));
      let day = "";
      let out = "";
      for (const it of items) {
        const dd = fmtDate(it.at, { time: false });
        if (dd !== day) {
          if (day) out += "</ol>";
          out += `<h5 class="b-day">${dd}</h5><ol class="b-cms">`;
          day = dd;
        }
        if (it.kind === "f")
          out += `<li class="b-cm-f">${icon("rerun")}<span>${who(it.e.actor)} force-pushed${it.e.note ? ` · ${esc(it.e.note)}` : ""}</span>${time(it.at)}</li>`;
        else {
          const c = it.c;
          const [subject] = c.message.split("\n");
          out += `<li><button class="b-cm ${s.commit === c.short ? "on" : ""}" type="button" data-act="commit" data-sha="${esc(c.short)}"><i class="b-cm-dot"></i><span class="b-cm-m trunc">${esc(subject)}</span><span class="b-cm-v">View changes ${icon("arrow-right")}</span>${checkGlyph(c.checks || "none", { size: 13 })}<code class="b-cm-sha">${esc(c.short)}</code>${c.author !== p.author ? avatar(c.author, { size: 16 }) : ""}${time(c.committedAt)}</button></li>`;
        }
      }
      out += "</ol>";
      return el(
        `<div class="b-pane b-commits scroll" data-pr="${p.number}" data-tab="commits"><div class="b-cms-in">${out}</div></div>`,
      );
    }

    /* ======================================================== popovers */
    let popKey = null;
    let popApi = null;
    function openPop(key, anchor, build, opts = {}) {
      if (!anchor || !anchor.isConnected || !anchor.getClientRects().length) {
        if (FLAGS.has(key)) lab.setHashState({ [key]: null });
        return null;
      }
      const api = popover.open(anchor, (a) => build(a), {
        side: opts.side || "bottom",
        align: opts.align || "end",
        offset: 6,
        cls: `b-pop ${opts.cls || ""}`,
        width: opts.width,
        onClose: () => {
          if (popKey !== key) return;
          popKey = null;
          popApi = null;
          if (FLAGS.has(key)) lab.setHashState({ [key]: null });
        },
      });
      if (!api) return null;
      popKey = key;
      popApi = api;
      if (FLAGS.has(key)) lab.setHashState({ [key]: true });
      requestAnimationFrame(() => $("[autofocus]", api.el)?.focus());
      return api;
    }
    function closePop() {
      if (popKey) popover.close();
    }
    const bindPop = (node, handlers) => {
      node.addEventListener("click", (e) => {
        const t = e.target.closest("[data-pact]");
        if (t && !t.matches('[aria-disabled="true"]') && handlers[t.dataset.pact])
          handlers[t.dataset.pact](t, e);
      });
      return node;
    };

    /* ---------- stack map */
    function openStack() {
      const p = P(ui.pr);
      if (!p?.stack) return lab.setHashState({ stack: null });
      openPop("stack", $(".b-stackbtn", stripEl), () => stackContent(ui.pr), { width: 380 });
    }
    function stackContent(n) {
      const p = P(n);
      const st = model.stackOf(p);
      const ready = readyThrough(st.entries);
      const landable = st.entries.filter((e) => e.state === "open" && e.stack.position <= ready);
      const blocker = st.entries.find((e) => e.state === "open" && e.stack.position > ready);
      const br = blocker ? layerReason(blocker) : null;
      const head = landable.length
        ? `<span class="t-ok">${esc(rangeOf(landable))} can land now</span>${blocker ? `<span class="dim"> · then #${blocker.number}: ${esc(br.text.toLowerCase())}</span>` : ""}`
        : blocker
          ? `<span class="t-${br.tone}">#${blocker.number}: ${esc(br.text)}</span><span class="dim"> blocks the stack</span>`
          : `<span class="t-merged">Every layer has merged</span>`;
      const top = [...st.entries].reverse();
      const rows = top
        .map((e, k) => {
          const r = layerReason(e);
          const up = k === 0 ? "off" : linkTone(top[k - 1], ready);
          return `<li><button class="b-sp-r" type="button" data-pact="go" data-pr="${e.number}" data-up="${up}" data-down="${linkTone(e, ready)}" ${e.number === n ? 'aria-current="true"' : ""}>
            <span class="b-node">${stateGlyph(e, { size: 15, tip: false })}</span>
            <span class="b-sp-t"><span class="b-sp-tt"><span class="tnum b-sp-n">#${e.number}</span> ${esc(e.title)}</span><span class="b-sp-s"><span class="t-${r.tone}">${esc(r.text)}</span><span class="dim">${e.author !== p.author ? ` · ${esc(short(e.author))}` : ""} · ${ago(e.updatedAt)}</span></span></span>
            <span class="b-sp-k">${checkGlyph(e.checks.state, { size: 13 })}</span>
          </button></li>`;
        })
        .join("");
      const node = el(`<div class="b-sp">
        <div class="b-pop-h"><b>Stack ${st.number}</b><span class="b-pop-sub">${st.size} layers onto <code class="b-ref">${esc(st.baseRefName)}</code></span></div>
        <p class="b-sp-as">${head}</p>
        <ol class="b-sp-l">${rows}<li class="b-sp-base" data-up="${linkTone(st.entries[0], ready)}"><span class="b-node"><i class="b-ring"></i></span><span class="b-base">${esc(st.baseRefName)}</span></li></ol>
        <div class="b-pop-acts"><button class="btn sm ghost" type="button" data-pact="rebase">${icon("rerun")}Rebase stack</button><span class="b-gap"></span><button class="btn sm" type="button" data-pact="plan">Merge through…</button></div>
      </div>`);
      return bindPop(node, {
        go: (t) => {
          popover.close();
          selectPr(+t.dataset.pr);
        },
        plan: () => {
          popover.close();
          requestAnimationFrame(() => openMerge());
        },
        rebase: async () => {
          popover.close();
          const ok = await confirm({
            title: `Rebase stack ${st.number}?`,
            body: `Each open layer is rebased onto the one below it, starting from ${st.baseRefName}. Branches are force-pushed; reviews stay.`,
            confirmLabel: "Rebase stack",
          });
          if (ok)
            toast(
              `Rebased ${plural(st.entries.filter((e) => e.state === "open").length, "layer")} onto ${st.baseRefName}`,
              { tone: "ok" },
            );
        },
      });
    }

    /* ---------- merge box */
    function openMerge() {
      if (ui.pr == null) return;
      openPop("merge", $(".b-nmore", root), (api) => mergeContent(ui.pr, api), { width: 388 });
    }
    function blockerView(b, p) {
      const d = det(p.number);
      switch (b.key) {
        case "checks-failing":
        case "checks-running":
          return {
            label: "View",
            run: () =>
              nav({ tab: "checks", job: model.checks(d).failing[0]?.id || null }, { push: true }),
          };
        case "threads": {
          const t = (d.threads || []).find((x) => !x.isResolved && x.line != null);
          return t
            ? {
                label: "View",
                run: () =>
                  nav({ tab: "files", thread: t.id, file: t.path, commit: null }, { push: true }),
              }
            : null;
        }
        case "changes-requested":
          return { label: "View", run: () => nav({ tab: "conversation" }, { push: true }) };
        case "draft":
          return p.author === me()
            ? { label: "Ready for review", run: () => setDraft(p.number, false) }
            : null;
        case "behind":
          return { label: "Update", run: () => updateBranch(p.number) };
        case "review-required":
          return {
            label: "Request",
            run: () => {
              popover.close();
              nav({ tab: "conversation" }, { push: true });
              requestAnimationFrame(() => openPicker("reviewers"));
            },
          };
        case "conflicts":
          return {
            label: "Resolve",
            run: () => toast("Opens the conflict editor on GitHub", { icon: "external" }),
          };
        default:
          return null;
      }
    }
    const BLOCKER_ICON = {
      draft: () => stateGlyph("draft", { size: 14, tip: false }),
      conflicts: () => icon("alert", { cls: "t-err" }),
      "checks-failing": () => checkGlyph("fail", { tip: false }),
      "checks-running": () => checkGlyph("run", { tip: false }),
      "changes-requested": () => reviewGlyph("changes_requested", { tip: false }),
      "review-required": () => reviewGlyph("pending", { tip: false }),
      threads: () => icon("comment", { cls: "dim" }),
      behind: () => icon("update-branch", { cls: "t-warn" }),
    };
    function mergeContent(n, api) {
      const p = P(n);
      const d = det(n);
      if (p.state === "merged") {
        const node =
          el(`<div class="b-mp"><div class="b-pop-h">${stateGlyph("merged", { size: 15, tip: false })}<b>Merged into ${esc(p.baseRefName)}</b><span class="b-pop-sub">${esc(short(p.mergedBy || me()))} · ${agoLong(p.mergedAt || W.now)}</span></div>
          <p class="b-mp-note"><code class="b-ref">${esc(p.headRefName)}</code> ${ui.deleteBranch ? "was deleted." : "can be deleted now."}</p>
          <div class="b-pop-acts"><button class="btn sm ghost" type="button" data-pact="revert">${icon("undo")}Revert</button><span class="b-gap"></span>${ui.deleteBranch ? "" : `<button class="btn sm" type="button" data-pact="delbranch">${icon("trash")}Delete branch</button>`}</div></div>`);
        return bindPop(node, {
          revert: () => toast(`Opened a revert pull request for #${n}`, { tone: "ok" }),
          delbranch: () => {
            ui.deleteBranch = true;
            api.update(mergeContent(n, api));
            toast(`Deleted ${p.headRefName}`, { tone: "ok" });
          },
        });
      }
      if (p.state === "closed") {
        const node =
          el(`<div class="b-mp"><div class="b-pop-h">${stateGlyph("closed", { size: 15, tip: false })}<b>Closed without merging</b><span class="b-pop-sub">${agoLong(p.closedAt || p.updatedAt)}</span></div>
          <div class="b-pop-acts"><span class="b-gap"></span><button class="btn sm pri" type="button" data-pact="reopen">Reopen pull request</button></div></div>`);
        return bindPop(node, {
          reopen: () => {
            popover.close();
            reopen(n);
          },
        });
      }
      const st = model.stackOf(p);
      const through = st ? clamp(ui.through[n] ?? p.stack.position, 1, st.size) : null;
      const plan = model.mergePlan(n, through ?? undefined);
      const base = plan.base;
      const blockedBy = plan.blockedBy;
      const multi = plan.layers.length > 1;
      const title = st ? `Merge ${rangeOf(plan.layers) || "—"} into ${base}` : `Merge into ${base}`;
      const methods = D().repo.mergeMethods;
      let middle = "";
      if (st) {
        const ready = readyThrough(st.entries);
        const top = [...st.entries].reverse();
        middle = `<ol class="b-mp-l" role="radiogroup" aria-label="Merge through layer">${top
          .map((e, k) => {
            const r = layerReason(e);
            const inPlan = plan.layers.includes(e);
            const merged = e.state === "merged";
            const up =
              k === 0
                ? "off"
                : top[k - 1].stack.position <= through && top[k - 1].state !== "merged"
                  ? plan.blockedBy
                    ? "plan-b"
                    : "plan"
                  : linkTone(top[k - 1], ready);
            const down = merged
              ? "merged"
              : e.stack.position <= through
                ? plan.blockedBy
                  ? "plan-b"
                  : "plan"
                : linkTone(e, ready);
            return `<li><button class="b-mp-r ${inPlan ? "in" : ""} ${merged ? "merged" : ""} ${e.number === n ? "cur" : ""}" type="button" role="radio" aria-checked="${e.stack.position === through}" data-pact="through" data-pos="${e.stack.position}" ${merged ? 'aria-disabled="true"' : ""} data-up="${up}" data-down="${down}">
              <span class="b-node">${stateGlyph(e, { size: 14, tip: false })}</span><span class="b-mp-n tnum">#${e.number}</span><span class="b-mp-t trunc">${esc(e.title)}</span><span class="b-mp-s t-${r.tone}">${esc(r.text)}</span><i class="b-mp-rad"></i></button></li>`;
          })
          .join(
            "",
          )}<li class="b-mp-base" data-up="${plan.layers.includes(st.entries.find((e) => e.state !== "merged")) ? (plan.blockedBy ? "plan-b" : "plan") : linkTone(st.entries[0], ready)}"><span class="b-node"><i class="b-ring"></i></span><span class="b-base">${esc(base)}</span></li></ol>`;
        if (blockedBy) {
          const lowerReady = st.entries.filter(
            (e) =>
              e.state === "open" &&
              e.stack.position < blockedBy.pr.stack.position &&
              layerReason(e).tone === "ok",
          );
          middle += `<div class="b-mp-blk"><span class="b-mp-bt">Blocked by ${
            blockedBy.pr.number !== n
              ? `<button class="b-inl" type="button" data-pact="goto" data-pr="${blockedBy.pr.number}" data-tip="Open #${blockedBy.pr.number}">#${blockedBy.pr.number}</button>`
              : `<b>#${blockedBy.pr.number}</b>`
          } · ${esc(blockedBy.reason.toLowerCase())}</span>${lowerReady.length ? `<button class="btn sm" type="button" data-pact="through" data-pos="${lowerReady[lowerReady.length - 1].stack.position}">Merge ${esc(rangeOf(lowerReady))} only</button>` : ""}</div>`;
        }
      }
      // This layer's own blockers (the merge plan above only names the first one per layer).
      const own = model.blockers(p);
      if (own.length && (!st || plan.layers.includes(p)))
        middle += `<ul class="b-mp-bl">${own
          .map((b) => {
            const v = blockerView(b, p);
            return `<li>${(BLOCKER_ICON[b.key] || (() => icon("dot")))()}<span class="trunc">${esc(b.label)}</span>${v ? `<button class="b-mp-v" type="button" data-pact="blocker" data-key="${b.key}">${esc(v.label)}</button>` : ""}</li>`;
          })
          .join("")}</ul>`;
      const canAuto = D().repo.autoMergeAllowed && blockedBy?.pending && !p.autoMerge;
      const auto = p.autoMerge
        ? `<div class="b-mp-auto">${icon("clock")}<span>Auto-merge on · ${esc(METHODS[p.autoMerge.method]?.short || p.autoMerge.method)} · by ${esc(short(p.autoMerge.enabledBy))}</span><span class="b-gap"></span><button class="btn sm ghost" type="button" data-pact="auto-off">Turn off</button></div>`
        : "";
      const disabled = !!blockedBy || !plan.layers.length;
      const primaryLabel = multi
        ? `Merge ${plan.layers.length} pull requests`
        : METHODS[ui.method].label;
      const node = el(`<div class="b-mp">
        <div class="b-pop-h"><b>${esc(title)}</b>${st ? `<span class="b-pop-sub">pick the layer to merge through</span>` : ""}</div>
        ${middle}
        ${auto}
        <div class="b-mp-opts">
          <div class="seg b-mseg" role="radiogroup" aria-label="Merge method"><i class="seg-ind"></i>${Object.entries(
            METHODS,
          )
            .map(
              ([k, m]) =>
                `<button class="seg-opt" type="button" role="radio" data-pact="method" data-m="${k}" aria-checked="${ui.method === k}" ${methods[k] ? "" : 'aria-disabled="true" data-tip="Disabled in repository settings"'}>${esc(m.short)}</button>`,
            )
            .join("")}</div>
          <label class="b-chk-opt"><input type="checkbox" data-pact="delete" ${ui.deleteBranch ? "checked" : ""}><span class="b-box">${CHECK_SVG}</span>Delete ${multi ? "branches" : "branch"}</label>
        </div>
        <div class="b-mp-go">
          ${canAuto ? `<button class="btn sm" type="button" data-pact="auto-on">${icon("clock")}Merge when ready</button>` : ""}
          <span class="b-gap"></span>
          <button class="btn ok b-mp-btn" type="button" data-pact="merge" ${disabled ? 'aria-disabled="true"' : ""} ${blockedBy ? `data-tip="${esc(`Blocked: #${blockedBy.pr.number} ${blockedBy.reason.toLowerCase()}`)}"` : ""}>${icon("pr-merged")}${esc(primaryLabel)}</button>
        </div>
        <div class="b-pop-foot">
          ${p.author === me() || D().repo.viewerPermission === "admin" ? (p.isDraft ? `<button class="b-lnk" type="button" data-pact="ready">Ready for review</button>` : `<button class="b-lnk" type="button" data-pact="draft">Convert to draft</button>`) : ""}
          ${p.mergeStateStatus === "BEHIND" ? `<button class="b-lnk" type="button" data-pact="update">Update branch</button>` : ""}
          <span class="b-gap"></span>
          <button class="b-lnk danger" type="button" data-pact="close">Close pull request</button>
        </div>
      </div>`);
      requestAnimationFrame(() => {
        const seg = $(".b-mseg", node);
        if (seg) L.syncIndicator(seg, { instant: true });
      });
      const rerender = () => api.update(mergeContent(n, api));
      return bindPop(node, {
        through: (t) => {
          ui.through[n] = +t.dataset.pos;
          rerender();
        },
        goto: (t) => {
          popover.close();
          selectPr(+t.dataset.pr);
        },
        method: (t) => {
          ui.method = t.dataset.m;
          for (const b of $$(".b-mseg .seg-opt", node))
            b.setAttribute("aria-checked", String(b === t));
          L.syncIndicator($(".b-mseg", node));
          const btn = $(".b-mp-btn", node);
          if (!multi) btn.lastChild.textContent = METHODS[ui.method].label;
          renderHeader(P(n), { roll: 0 });
        },
        delete: (t) => {
          ui.deleteBranch = t.checked;
        },
        blocker: (t) => {
          const b = own.find((x) => x.key === t.dataset.key);
          const v = b && blockerView(b, p);
          if (v) {
            popover.close();
            v.run();
          }
        },
        "auto-on": () => {
          p.autoMerge = { method: ui.method, enabledBy: me(), enabledAt: W.now };
          refresh();
          rerender();
          toast(
            `Auto-merge on: ${rangeOf(plan.layers)} merges when ${blockedBy.reason.toLowerCase().replace("checks running", "checks pass").replace("needs review", "it’s approved")}`,
            { tone: "ok" },
          );
        },
        "auto-off": () => {
          p.autoMerge = null;
          refresh();
          rerender();
          toast("Auto-merge off");
        },
        merge: () => doMerge(n, through ?? undefined),
        ready: () => {
          popover.close();
          setDraft(n, false);
        },
        draft: () => {
          popover.close();
          setDraft(n, true);
        },
        update: () => {
          popover.close();
          updateBranch(n);
        },
        close: () => {
          popover.close();
          closePr(n);
        },
      });
    }

    /* ---------- review */
    function openReview() {
      const p = P(ui.pr);
      if (!p || p.state !== "open") return lab.setHashState({ review: null });
      const anchor = revBtn.hidden ? nextBtn : revBtn;
      openPop("review", anchor, () => reviewContent(ui.pr), { width: 380 });
    }
    function reviewContent(n) {
      const p = P(n);
      const own = p.author === me();
      if (own && ui.reviewVerdict !== "commented") ui.reviewVerdict = "commented";
      const pend = pendingCount(n);
      const opt = (v, label, sub, dis) =>
        `<label class="b-radio ${dis ? "dis" : ""}"><input type="radio" name="b-verdict" value="${v}" ${ui.reviewVerdict === v ? "checked" : ""} ${dis ? "disabled" : ""}><i class="b-rdot"></i><span><b>${label}</b><small>${sub}</small></span></label>`;
      const node = el(`<div class="b-rv">
        <div class="b-pop-h"><b>Finish your review</b><span class="b-pop-sub">${pend ? plural(pend, "pending comment") : "no line comments yet"}</span></div>
        <textarea class="input b-rv-ta" rows="4" placeholder="Leave a summary (optional)" data-draft="rv:${n}" autofocus>${esc(ui.draft.get(`rv:${n}`) || "")}</textarea>
        <div class="b-rv-o" role="radiogroup">
          ${opt("commented", "Comment", "Feedback without an explicit verdict", false)}
          ${opt("approved", "Approve", own ? "You can’t approve your own pull request" : "Ready to merge from your side", own)}
          ${opt("changes_requested", "Request changes", own ? "Not available on your own pull request" : "Must be addressed before merging", own)}
        </div>
        <div class="b-pop-acts">${pend ? `<button class="btn sm ghost danger" type="button" data-pact="discard">Discard</button>` : ""}<span class="b-gap"></span><button class="btn sm pri" type="button" data-pact="submit">Submit review <kbd>⌘↵</kbd></button></div>
      </div>`);
      node.addEventListener("change", (e) => {
        if (e.target.name === "b-verdict") ui.reviewVerdict = e.target.value;
      });
      node.addEventListener("input", (e) => {
        if (e.target.dataset.draft) ui.draft.set(e.target.dataset.draft, e.target.value);
      });
      node.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          submitReview(n);
        }
      });
      return bindPop(node, {
        submit: () => submitReview(n),
        discard: async () => {
          const ok = await confirm({
            title: "Discard pending review?",
            body: `${plural(pend, "comment")} will be deleted.`,
            confirmLabel: "Discard",
            tone: "danger",
          });
          if (!ok) return;
          det(n).pendingReview = null;
          popover.close();
          refresh();
          toast("Pending review discarded");
        },
      });
    }

    /* ---------- reviewers / assignees / labels */
    function openPicker(kind) {
      const p = P(ui.pr);
      const pane = currentPane();
      const anchor = pane && $(`[data-act="edit-${kind}"]`, pane);
      if (!p || !anchor) return;
      openPop(kind, anchor, (api) => pickerContent(kind, p, api), { width: 280, align: "end" });
    }
    function pickerContent(kind, p, api, q = "") {
      const d = det(p.number);
      let items;
      if (kind === "labels")
        items = Object.values(D().labels).map((l) => ({
          key: l.name,
          on: p.labels.includes(l.name),
          html: `${labelChip(l)}`,
          sub: l.description || "",
        }));
      else {
        const people = Object.values(D().users).filter(
          (u) => !u.bot && (kind === "assignees" || u.login !== p.author),
        );
        const list =
          kind === "reviewers"
            ? [...people.map((u) => u.login), ...Object.keys(D().teams)]
            : people.map((u) => u.login);
        const cur = kind === "reviewers" ? p.reviewers.map((r) => r.login) : p.assignees;
        items = list.map((login) => {
          const u = model.user(login);
          return {
            key: login,
            on: cur.includes(login),
            html: `${avatar(login, { size: 18, tip: false })}<span class="trunc">${esc(u.team ? "@" + login : u.name || login)}</span>`,
            sub: u.team ? "team" : login,
          };
        });
      }
      const ql = q.toLowerCase();
      const shown = items.filter((i) => !ql || `${i.key} ${i.sub}`.toLowerCase().includes(ql));
      const node = el(`<div class="b-pk">
        <label class="field b-pk-s">${icon("search")}<input type="text" placeholder="${kind === "labels" ? "Filter labels" : "Filter people"}" value="${esc(q)}" autofocus></label>
        <div class="b-pk-l">${
          shown
            .map(
              (i) =>
                `<button class="b-pk-i" type="button" data-pact="toggle" data-key="${esc(i.key)}" aria-pressed="${i.on}"><span class="b-pk-c">${icon("check")}</span><span class="b-pk-m">${i.html}</span><span class="b-pk-sub trunc">${esc(i.sub)}</span></button>`,
            )
            .join("") || `<div class="b-none">No matches</div>`
        }</div>
      </div>`);
      const input = $("input", node);
      input.addEventListener("input", () => {
        const pos = input.selectionStart;
        api.update(pickerContent(kind, p, api, input.value));
        const ni = $("input", api.el);
        ni.focus();
        ni.setSelectionRange(pos, pos);
      });
      return bindPop(node, {
        toggle: (t) => {
          const key = t.dataset.key;
          const on = t.getAttribute("aria-pressed") !== "true";
          t.setAttribute("aria-pressed", String(on));
          if (kind === "labels")
            p.labels = on ? [...p.labels, key] : p.labels.filter((x) => x !== key);
          else if (kind === "assignees")
            p.assignees = on ? [...p.assignees, key] : p.assignees.filter((x) => x !== key);
          else {
            const add = (list) =>
              list.push({
                login: key,
                state: "pending",
                submittedAt: null,
                requested: true,
                team: !!D().teams[key],
              });
            if (on) {
              add(p.reviewers);
              if (!d.synthetic && d.reviewers) add(d.reviewers);
              d.timeline?.push({
                id: `${p.number}-x${++ui.seq}`,
                kind: "review_requested",
                actor: me(),
                at: W.now,
                reviewer: key,
              });
              if (p.reviewDecision == null) p.reviewDecision = "review_required";
            } else {
              p.reviewers = p.reviewers.filter((r) => r.login !== key);
              if (!d.synthetic && d.reviewers)
                d.reviewers = d.reviewers.filter((r) => r.login !== key);
            }
          }
          if (kind === "labels" && on)
            d.timeline?.push({
              id: `${p.number}-x${++ui.seq}`,
              kind: "labeled",
              actor: me(),
              at: W.now,
              label: key,
            });
          refreshFacts();
          renderList();
        },
      });
    }
    function refreshFacts() {
      const pane = currentPane();
      if (!pane?.matches(".b-conv")) return;
      const p = P(ui.pr);
      $(".b-facts", pane).innerHTML = factsHTML(p, det(ui.pr));
    }

    /* ---------- menus */
    function openFilter(anchor) {
      const s = S();
      const f = s.filter || "open";
      const g = s.group || "";
      const set = (patch) => {
        lab.setHashState(patch);
        renderList({ flip: true });
      };
      menu.open(
        anchor,
        [
          { head: "State" },
          ...[
            ["open", "Open"],
            ["draft", "Drafts"],
            ["merged", "Merged"],
            ["closed", "Closed"],
            ["all", "Everything"],
          ].map(([k, label]) => ({
            label,
            checked: f === k,
            run: () => set({ filter: k === "open" ? null : k }),
          })),
          { sep: true },
          { head: "Group" },
          ...[
            ["", "All groups"],
            ["review", "Needs your review"],
            ["mine", "Yours"],
            ["others", "Others"],
          ].map(([k, label]) => ({
            label,
            checked: g === k,
            run: () => set({ group: k || null }),
          })),
        ],
        { align: "end", minWidth: 200 },
      );
    }
    function openMore(anchor) {
      const p = P(ui.pr);
      if (!p) return;
      const own = p.author === me();
      menu.open(
        anchor,
        [
          {
            label: "Copy link",
            icon: "link",
            kbd: "⇧C",
            run: () => L.copy(p.url || `${D().repo.url}/pull/${p.number}`, "link"),
          },
          {
            label: "Open on GitHub",
            icon: "external",
            run: () =>
              toast(`Opens ${D().repo.nameWithOwner}#${p.number} on GitHub`, { icon: "external" }),
          },
          {
            label: "Check out in a new thread",
            icon: "branch",
            sub: p.headRefName,
            run: () => agentToast(`Checked out ${p.headRefName} in a new worktree thread`),
          },
          {
            label: "Keyboard shortcuts",
            icon: "keyboard",
            kbd: "?",
            run: () => requestAnimationFrame(openKeys),
          },
          { sep: true },
          ...(p.state === "open"
            ? [
                own || D().repo.viewerPermission === "admin"
                  ? p.isDraft
                    ? {
                        label: "Ready for review",
                        icon: "eye",
                        run: () => setDraft(p.number, false),
                      }
                    : {
                        label: "Convert to draft",
                        icon: "pr-draft",
                        run: () => setDraft(p.number, true),
                      }
                  : null,
                {
                  label: "Close pull request",
                  icon: "pr-closed",
                  danger: true,
                  run: () => closePr(p.number),
                },
              ].filter(Boolean)
            : p.state === "closed"
              ? [{ label: "Reopen pull request", icon: "pr-open", run: () => reopen(p.number) }]
              : [
                  {
                    label: "Revert",
                    icon: "undo",
                    run: () =>
                      toast(`Opened a revert pull request for #${p.number}`, { tone: "ok" }),
                  },
                ]),
        ],
        { align: "end", minWidth: 230 },
      );
    }
    function openScope(anchor) {
      const d = det(ui.pr);
      const s = S();
      menu.open(
        anchor,
        [
          {
            label: "All commits",
            sub: `${plural(d.commits.length, "commit")} · comments on`,
            checked: !s.commit,
            run: () => nav({ commit: null }),
          },
          { sep: true },
          ...[...d.commits].reverse().map((c) => ({
            label: c.message.split("\n")[0],
            sub: `${c.short} · ${ago(c.committedAt)}`,
            checked: s.commit === c.short,
            run: () => nav({ commit: c.short }),
          })),
        ],
        { minWidth: 300 },
      );
    }
    const KEYS = [
      ["J", "K", "Next / previous pull request"],
      ["[", "]", "Step down / up the stack (push)"],
      ["1–4", null, "Switch tab"],
      ["S", null, "Stack map"],
      ["M", null, "Merge box"],
      ["R", null, "Finish your review"],
      ["N", "P", "Next / previous open conversation"],
      ["V", null, "Mark file viewed (and fold it)"],
      ["U", null, "Unified / split diff"],
      ["C", null, "Scope files to a commit"],
      ["T", null, "File tree"],
      ["/", null, "Search or paste a link"],
      ["\\", null, "Show / hide the list"],
      ["⌘↵", null, "Send the open composer"],
    ];
    function openKeys() {
      openPop(
        "keys",
        $(".b-more", root),
        () =>
          el(
            `<div class="b-keys"><div class="b-pop-h"><b>Keyboard</b></div><dl>${KEYS.map(
              ([a, b, label]) =>
                `<dt><kbd>${esc(a)}</kbd>${b ? `<kbd>${esc(b)}</kbd>` : ""}</dt><dd>${esc(label)}</dd>`,
            ).join("")}</dl></div>`,
          ),
        { width: 320 },
      );
    }
    function openEmoji(anchor) {
      menu.open(
        anchor,
        EMOJIS.map((em) => ({ label: em, run: () => react(anchor.dataset.cid, em) })),
        { minWidth: 120 },
      );
    }

    /* ======================================================== mutations */
    function findComment(cid) {
      const d = det(ui.pr);
      const ev = (d.timeline || []).find((e) => e.id === cid);
      if (ev) return ev;
      for (const t of d.threads || []) {
        const c = t.comments.find((x) => x.id === cid);
        if (c) return c;
      }
      return null;
    }
    function react(cid, emoji) {
      const c = findComment(cid);
      if (!c) return;
      c.reactions = c.reactions || [];
      let r = c.reactions.find((x) => x.emoji === emoji);
      if (!r) c.reactions.push((r = { emoji, count: 0, viewerReacted: false }));
      r.viewerReacted = !r.viewerReacted;
      r.count += r.viewerReacted ? 1 : -1;
      rebuildPane();
    }
    function threadById(id) {
      return model.threadsFor(det(ui.pr)).find((t) => t.id === id);
    }
    function setResolved(id, resolved, opts = {}) {
      const d = det(ui.pr);
      const t = (d.threads || []).find((x) => x.id === id);
      if (!t) return;
      t.isResolved = resolved;
      t.resolvedBy = resolved ? me() : null;
      ui.thrOpen.delete(id);
      const p = P(ui.pr);
      p.unresolvedThreads = Math.max(0, (p.unresolvedThreads || 0) + (resolved ? -1 : 1));
      refresh({ list: true });
      if (ui.tab === "files") {
        const nu = rerenderFile(t.path);
        if (nu && resolved) {
          const sum = $(`.b-thr[data-thread="${CSS.escape(id)}"]`, nu);
          if (sum && !reduced())
            sum.animate(
              [
                { opacity: 0.4, transform: "translateY(-2px)" },
                { opacity: 1, transform: "none" },
              ],
              { duration: L.ms("stack"), easing: EASE },
            );
        }
      } else rebuildPane();
      if (!opts.quiet)
        toast(resolved ? "Conversation resolved" : "Conversation reopened", {
          tone: resolved ? "ok" : undefined,
          action: { label: "Undo", run: () => setResolved(id, !resolved) },
        });
    }
    function rowsFor(path) {
      const f = files(det(ui.pr)).find((x) => x.path === path);
      return f ? parsePatch(f.patch || "") : [];
    }
    function hunkFor(path, side, line) {
      const rows = rowsFor(path);
      const idx = rows.findIndex((r) =>
        side === "LEFT" ? r.old === line && r.kind !== "add" : r.new === line && r.kind !== "del",
      );
      if (idx < 0) return { lineText: "", diffHunk: "" };
      const r = rows[idx];
      let start = idx;
      while (start > 0 && idx - start < 3 && rows[start - 1].kind !== "hunk") start--;
      const take = rows.slice(start, idx + 1);
      const o = take.find((x) => x.old != null)?.old ?? 0;
      const nn = take.find((x) => x.new != null)?.new ?? 0;
      const sign = { add: "+", del: "-", ctx: " " };
      const header = `@@ -${o},${take.filter((x) => x.kind !== "add").length} +${nn},${take.filter((x) => x.kind !== "del").length} @@`;
      return {
        lineText: r.text,
        diffHunk: [header, ...take.map((x) => sign[x.kind] + x.text)].join("\n"),
      };
    }
    function submitComposer(asReview) {
      const comp = ui.composer;
      if (!comp) return;
      const key = `n:${comp.n}:${comp.path}:${comp.side}:${comp.line}`;
      const body = (ui.draft.get(key) || "").trim();
      if (!body) {
        toast("Write a comment first");
        return;
      }
      const n = comp.n;
      const d = det(n);
      const p = P(n);
      const { lineText, diffHunk } = hunkFor(comp.path, comp.side, comp.line);
      if (asReview) {
        d.pendingReview = d.pendingReview || { startedAt: W.now, body: "", comments: [] };
        d.pendingReview.comments.push({
          id: `${n}-p${++ui.seq}`,
          path: comp.path,
          side: comp.side,
          line: comp.line,
          originalLine: comp.line,
          lineText,
          diffHunk,
          body,
        });
      } else {
        const id = `${n}-t${++ui.seq}n`;
        d.threads.push({
          id,
          path: comp.path,
          side: comp.side,
          line: comp.line,
          originalLine: comp.line,
          lineText,
          diffHunk,
          isResolved: false,
          isOutdated: false,
          comments: [{ id: id + "-c", author: me(), createdAt: W.now, body, reactions: [] }],
        });
        d.timeline.push({
          id: `${n}-x${++ui.seq}`,
          kind: "review",
          actor: me(),
          at: W.now,
          state: "commented",
          body: "",
          threadIds: [id],
        });
        p.unresolvedThreads = (p.unresolvedThreads || 0) + 1;
        p.comments = (p.comments || 0) + 1;
      }
      ui.draft.delete(key);
      ui.composer = null;
      rerenderFile(comp.path);
      refresh({ list: !asReview });
      if (!asReview) toast("Comment posted", { tone: "ok" });
    }
    function submitReview(n) {
      const p = P(n);
      const d = det(n);
      const v = me();
      const verdict = p.author === v ? "commented" : ui.reviewVerdict;
      const body = (ui.draft.get(`rv:${n}`) || "").trim();
      const pend = d.pendingReview?.comments || [];
      if (!body && !pend.length && verdict === "commented") {
        toast("Add a comment or pick a verdict");
        return;
      }
      const ids = [];
      for (const c of pend) {
        const id = `${n}-t${++ui.seq}r`;
        d.threads.push({
          id,
          path: c.path,
          side: c.side,
          line: c.line,
          originalLine: c.line,
          lineText: c.lineText,
          diffHunk: c.diffHunk || "",
          isResolved: false,
          isOutdated: false,
          comments: [{ id: id + "-c", author: v, createdAt: W.now, body: c.body, reactions: [] }],
        });
        ids.push(id);
      }
      d.pendingReview = null;
      d.timeline = d.timeline || [];
      d.timeline.push({
        id: `${n}-x${++ui.seq}`,
        kind: "review",
        actor: v,
        at: W.now,
        state: verdict,
        body,
        threadIds: ids,
      });
      const upd = (list) => {
        const r = list.find((x) => x.login === v);
        if (r) Object.assign(r, { state: verdict, submittedAt: W.now, requested: false });
        else list.push({ login: v, state: verdict, submittedAt: W.now });
      };
      upd(p.reviewers);
      if (!d.synthetic && d.reviewers) upd(d.reviewers);
      if (verdict === "approved" && p.reviewDecision !== "changes_requested")
        p.reviewDecision = "approved";
      if (verdict === "changes_requested") p.reviewDecision = "changes_requested";
      const movedGroup = p.involvement === "review-requested";
      if (movedGroup) p.involvement = "reviewed";
      p.unresolvedThreads = (p.unresolvedThreads || 0) + ids.length;
      p.comments = (p.comments || 0) + 1;
      ui.draft.delete(`rv:${n}`);
      ui.reviewVerdict = "commented";
      popover.close();
      refresh({ list: "flip" });
      rebuildPane();
      const word = {
        approved: "Approved",
        changes_requested: "Requested changes on",
        commented: "Reviewed",
      }[verdict];
      toast(
        `${word} #${n}${ids.length ? ` · ${plural(ids.length, "comment")}` : ""}${movedGroup ? " · moved out of Needs your review" : ""}`,
        { tone: "ok" },
      );
    }
    function postComment() {
      const n = ui.pr;
      const key = `c:${n}`;
      const body = (ui.draft.get(key) || "").trim();
      if (!body) return toast("Write a comment first");
      const d = det(n);
      d.timeline = d.timeline || [];
      d.timeline.push({
        id: `${n}-x${++ui.seq}`,
        kind: "comment",
        actor: me(),
        at: W.now,
        body,
        reactions: [],
      });
      P(n).comments = (P(n).comments || 0) + 1;
      ui.draft.delete(key);
      saveScroll();
      const pane = buildPane(n, "conversation");
      mountPane(pane, "swap");
      pane.scrollTop = pane.scrollHeight;
      const last = $$(".b-tl > .b-ev", pane).pop();
      if (last && !reduced())
        last.animate(
          [
            { opacity: 0, transform: "translateY(8px)" },
            { opacity: 1, transform: "none" },
          ],
          { duration: L.ms("stack"), easing: EASE },
        );
      renderHeader(P(n));
    }
    function setDraft(n, draft) {
      const p = P(n);
      p.isDraft = draft;
      p.mergeStateStatus = draft
        ? "DRAFT"
        : p.reviewDecision === "approved" && p.checks.state === "passing"
          ? "CLEAN"
          : "BLOCKED";
      if (!draft && p.reviewDecision == null) p.reviewDecision = "review_required";
      det(n).timeline?.push({
        id: `${n}-x${++ui.seq}`,
        kind: draft ? "convert_to_draft" : "ready_for_review",
        actor: me(),
        at: W.now,
      });
      refresh({ list: "flip", body: true, roll: 1 });
      toast(draft ? `#${n} is a draft again` : `#${n} is ready for review`, {
        tone: "ok",
        action: { label: "Undo", run: () => setDraft(n, !draft) },
      });
    }
    function updateBranch(n) {
      const p = P(n);
      p.mergeStateStatus = "BLOCKED";
      toast(`Updating ${p.headRefName}…`, { icon: "update-branch" });
      later(() => {
        p.behindBy = 0;
        det(n).behindBy = 0;
        p.mergeStateStatus =
          p.reviewDecision === "approved" && p.checks.state === "passing" ? "CLEAN" : "BLOCKED";
        det(n).timeline?.push({
          id: `${n}-x${++ui.seq}`,
          kind: "updated",
          actor: me(),
          at: W.now,
          base: p.baseRefName,
        });
        refresh({ list: true, body: true, roll: 1 });
        toast(`${p.headRefName} is up to date with ${p.baseRefName}`, { tone: "ok" });
      }, 900);
    }
    async function closePr(n) {
      const p = P(n);
      const ok = await confirm({
        title: `Close #${n} without merging?`,
        body: p.stack
          ? `Layers above it stay open; GitHub keeps them stacked on ${p.headRefName}.`
          : "You can reopen it later.",
        confirmLabel: "Close pull request",
        tone: "danger",
      });
      if (!ok) return;
      p.state = "closed";
      p.closedAt = W.now;
      det(n).timeline?.push({ id: `${n}-x${++ui.seq}`, kind: "closed", actor: me(), at: W.now });
      refresh({ list: "flip", body: true, roll: 1 });
      toast(`Closed #${n}`, { action: { label: "Undo", run: () => reopen(n) } });
    }
    function reopen(n) {
      const p = P(n);
      p.state = "open";
      det(n).timeline?.push({ id: `${n}-x${++ui.seq}`, kind: "reopened", actor: me(), at: W.now });
      refresh({ list: "flip", body: true, roll: -1 });
      toast(`Reopened #${n}`, { tone: "ok" });
    }
    async function doMerge(n, through) {
      const plan = model.mergePlan(n, through);
      if (!plan || plan.blockedBy || !plan.layers.length) {
        if (plan?.blockedBy)
          toast(`Blocked: #${plan.blockedBy.pr.number} ${plan.blockedBy.reason.toLowerCase()}`, {
            tone: "err",
          });
        return;
      }
      const multi = plan.layers.length > 1;
      const p = P(n);
      const above = p.stack
        ? model
            .stackOf(p)
            .entries.filter((e) => e.state === "open" && e.stack.position > plan.through)
        : [];
      const ok = await confirm({
        title: multi
          ? `Merge ${plan.layers.length} pull requests into ${plan.base}?`
          : `${METHODS[ui.method].label} #${plan.layers[0].number}?`,
        body: L.raw(
          `${multi ? `${esc(rangeOf(plan.layers))} land on <b>${esc(plan.base)}</b> bottom-up, ${esc(METHODS[ui.method].short.toLowerCase())}ed one by one.` : `#${plan.layers[0].number} lands on <b>${esc(plan.base)}</b>.`}${
            above.length
              ? ` ${esc(rangeOf(above))} stay${above.length === 1 ? "s" : ""} open and GitHub retargets ${above.length === 1 ? "it" : "them"} onto ${esc(plan.base)}.`
              : ""
          }${ui.deleteBranch ? ` ${multi ? "Head branches are" : "The head branch is"} deleted.` : ""}`,
        ),
        confirmLabel: multi ? `Merge ${plan.layers.length}` : "Merge",
        tone: "ok",
      });
      if (!ok) return;
      closePop();
      const step = reduced() ? 0 : 280;
      plan.layers.forEach((layer, i) =>
        later(() => {
          layer.state = "merged";
          layer.mergedAt = W.now;
          layer.mergedBy = me();
          layer.autoMerge = null;
          det(layer.number).timeline?.push({
            id: `${layer.number}-x${++ui.seq}`,
            kind: "merged",
            actor: me(),
            at: W.now,
            base: plan.base,
          });
          const next = layer.stack
            ? model
                .stackOf(layer)
                .entries.find((e) => e.stack.position === layer.stack.position + 1)
            : null;
          if (next && next.state === "open") next.baseRefName = plan.base;
          landSeg(layer.number);
          if (i === plan.layers.length - 1) {
            later(() => {
              refresh({ list: "flip", body: true, roll: 1 });
              toast(
                multi
                  ? `Merged ${rangeOf(plan.layers)} into ${plan.base}`
                  : `Merged #${layer.number} into ${plan.base}`,
                { tone: "ok", icon: "pr-merged" },
              );
            }, step);
          }
        }, i * step),
      );
    }
    /** Merge choreography: the landed layer's glyph pops to "merged" and its link to the base turns violet. */
    function landSeg(n) {
      const seg = $(`.b-seg[data-pr="${n}"]`, stripEl);
      const p = P(n);
      if (!seg) return;
      const g = $(".sg", seg);
      g.outerHTML = String(stateGlyph(p, { size: 14, tip: false }));
      seg.classList.add("landing");
      const lk = seg.previousElementSibling;
      if (lk?.classList.contains("b-link")) lk.dataset.tone = "merged";
      later(() => seg.classList.remove("landing"), 600);
      const row = $(`.b-row[data-pr="${n}"] .b-node`, rowsEl);
      if (row) {
        row.innerHTML = String(stateGlyph(p, { size: 15, tip: false }));
        if (!reduced())
          row.animate(
            [{ transform: "scale(.5)" }, { transform: "scale(1.15)" }, { transform: "none" }],
            { duration: L.ms("pane"), easing: L.easing("snappy") },
          );
      }
    }
    function recomputeChecks(n) {
      const p = P(n);
      const d = det(n);
      const jobs = d.checks.workflows.flatMap((w) => w.jobs);
      const kinds = [
        ...jobs.map((j) => runKind(j)),
        ...(d.checks.statuses || []).map((x) => checkKind(x.state)),
      ];
      const failed = kinds.filter((k) => k === "fail").length;
      const running = kinds.filter((k) => k === "run" || k === "queued").length;
      const skipped = kinds.filter((k) => k === "skip").length;
      p.checks = {
        state: failed ? "failing" : running ? "running" : kinds.length ? "passing" : "none",
        total: kinds.length,
        passed: kinds.length - failed - running - skipped,
        failed,
        running,
        skipped,
      };
      for (const w of d.checks.workflows) {
        const ks = w.jobs.map((j) => runKind(j));
        w.status = ks.some((k) => k === "run" || k === "queued") ? "in_progress" : "completed";
        w.conclusion =
          w.status !== "completed" ? null : ks.includes("fail") ? "failure" : "success";
      }
      const c = d.commits?.[d.commits.length - 1];
      if (c) c.checks = p.checks.state;
    }
    function rerunJobs(jobIds) {
      const n = ui.pr;
      const d = det(n);
      const jobs = d.checks.workflows.flatMap((w) => w.jobs).filter((j) => jobIds.includes(j.id));
      if (!jobs.length) return;
      for (const j of jobs) {
        j.status = "queued";
        j.conclusion = null;
        j.durationSec = null;
        j._log = j._log || j.log;
        j.log = [];
        for (const st of j.steps)
          Object.assign(st, { status: "queued", conclusion: null, durationSec: null });
        ui.jobsOpen.add(j.id);
      }
      recomputeChecks(n);
      refresh({ list: true, body: ui.tab === "checks", roll: 1 });
      toast(`Re-running ${jobs.length === 1 ? jobs[0].name : plural(jobs.length, "job")}`, {
        icon: "rerun",
      });
      later(() => {
        for (const j of jobs) {
          j.status = "in_progress";
          j.steps.forEach((st, i) =>
            i < j.steps.length - 3
              ? Object.assign(st, { status: "completed", conclusion: "success", durationSec: 6 })
              : i === j.steps.length - 3
                ? Object.assign(st, { status: "in_progress" })
                : 0,
          );
          j.log = [(j._log || [])[0] || "$ run"];
        }
        recomputeChecks(n);
        if (ui.pr === n) refresh({ list: true, body: ui.tab === "checks" });
      }, 700);
      later(() => {
        for (const j of jobs) {
          j.status = "completed";
          j.conclusion = "success";
          j.durationSec = 171;
          j._fresh = true;
          for (const st of j.steps)
            Object.assign(st, {
              status: "completed",
              conclusion: "success",
              durationSec: st.durationSec || 9,
            });
          j.log = [
            (j._log || [])[0] || "$ run",
            " Test Files  212 passed (212)",
            "      Tests  1846 passed (1846)",
            "   Duration  58.41s",
          ];
        }
        recomputeChecks(n);
        if (ui.pr === n) refresh({ list: true, body: ui.tab === "checks", roll: 1 });
        else renderList();
        toast(`${jobs.length === 1 ? jobs[0].name : plural(jobs.length, "job")} passed on rerun`, {
          tone: "ok",
        });
        later(() => jobs.forEach((j) => delete j._fresh), 600);
      }, 3200);
    }
    function agentToast(msg, thread) {
      if (thread) {
        const d = det(ui.pr);
        d.linkedThreads = d.linkedThreads || [];
        d.linkedThreads.push({
          id: `th${++ui.seq}`,
          title: thread,
          state: "working",
          provider: "claude",
          model: "Opus 5.5",
          startedAt: W.now,
        });
      }
      toast(msg, {
        icon: "agent",
        action: {
          label: "Open",
          run: () => toast("Opens the thread in a split pane next to this page"),
        },
      });
    }

    /* ======================================================== selection + navigation */
    /** Patch the hash and apply it to this direction (setHashState never calls our own listener). */
    function nav(patch, opts = {}) {
      const prev = S();
      lab.setHashState(patch, opts);
      applyState(prev, S());
    }
    function selectPr(n, opts = {}) {
      if (n == null || !P(n)) return;
      if (n === ui.pr) {
        if (ui.listOpen) setListOpen(false);
        return;
      }
      closePop();
      ui.composer = null;
      ui.replying = null;
      nav(
        {
          pr: n,
          file: null,
          thread: null,
          commit: null,
          job: null,
          stack: null,
          merge: null,
          review: null,
          tab: opts.tab ?? (ui.tab === "conversation" ? null : ui.tab),
        },
        { push: true },
      );
      if (ui.listOpen) setListOpen(false);
    }
    function applyPr(prevN, n) {
      const prevP = prevN != null ? P(prevN) : null;
      const p = n != null ? P(n) : null;
      saveScroll();
      ui.pr = p ? n : null;
      shell.classList.toggle("no-pr", !p);
      if (!p) {
        bodyEl.replaceChildren();
        renderStrip(null);
        placePlate();
        renderHeader(null);
        return;
      }
      const sameStack = prevP && prevP.stack && p.stack && prevP.stack.id === p.stack.id;
      const dir = sameStack ? Math.sign(p.stack.position - prevP.stack.position) : 1;
      const pane = buildPane(n, ui.tab);
      if (sameStack) {
        mountPane(pane, "push", dir, () => {
          renderStrip(p, { inPlace: true });
          placePlate({ pane: true });
          renderHeader(p, { roll: dir });
        });
      } else {
        mountPane(pane, prevP ? "rise" : "swap");
        renderStrip(p, { build: true });
        placePlate({ instant: !prevP });
        renderHeader(p, { roll: prevP ? 1 : 0 });
      }
    }
    function applyState(prev, s) {
      const tab = tabOf(s);
      if (prev.pr !== s.pr || (s.pr != null && ui.pr !== s.pr)) {
        if (tab !== ui.tab) ui.tab = tab;
        applyPr(ui.pr, s.pr);
        syncFlags(s);
        return;
      }
      if (tab !== ui.tab) {
        saveScroll();
        ui.tab = tab;
        renderHeader(P(ui.pr));
        if (ui.pr != null) mountPane(buildPane(ui.pr, tab), "swap");
      } else if (
        ["file", "thread", "commit", "view", "job"].some(
          (k) => (prev.params?.[k] ?? prev[k]) !== (s.params?.[k] ?? s[k]),
        )
      ) {
        const jump = s.thread !== prev.thread || s.file !== prev.file || s.job !== prev.job;
        if (s.commit !== prev.commit) ui.composer = null;
        if (
          jump &&
          ui.tab === "files" &&
          currentPane()?.matches(".b-files") &&
          s.commit === prev.commit &&
          s.view === prev.view
        ) {
          if (s.thread) focusThread(s.thread);
          else if (s.file) scrollToFile(s.file);
        } else rebuildPane({ keepScroll: !jump });
      }
      if (["q", "group", "filter"].some((k) => prev[k] !== s[k])) {
        if (search.value !== (s.q || "") && document.activeElement !== search)
          search.value = s.q || "";
        renderList({ flip: true });
      }
      syncFlags(s);
    }
    function syncFlags(s) {
      const want = s.merge ? "merge" : s.review ? "review" : s.stack ? "stack" : null;
      if (want === popKey) return;
      if (!want) {
        if (FLAGS.has(popKey)) closePop();
        return;
      }
      if (want === "merge") openMerge();
      else if (want === "review") openReview();
      else openStack();
    }
    /** Re-sync every surface with the (mutated) data. */
    function refresh(opts = {}) {
      const p = P(ui.pr);
      if (opts.list !== false) renderList({ flip: opts.list === "flip", glide: true });
      if (p) {
        renderStrip(p, { inPlace: true });
        renderHeader(p, { roll: opts.roll ?? 1 });
        if (opts.body) rebuildPane();
      }
      if (popApi && popKey === "merge") popApi.update(mergeContent(ui.pr, popApi));
    }
    function stepLayer(delta) {
      const p = P(ui.pr);
      if (!p?.stack) return;
      const st = model.stackOf(p);
      const next = st.entries.find((e) => e.stack.position === p.stack.position + delta);
      if (next) selectPr(next.number);
      else if (!reduced()) {
        const seg = $(`.b-seg[aria-current]`, stripEl);
        seg?.animate(
          [
            { transform: "none" },
            { transform: `translateX(${delta * 4}px)` },
            { transform: "none" },
          ],
          { duration: L.ms("pop"), easing: L.easing("snappy") },
        );
      }
    }
    function stepList(delta) {
      const rows = $$(".b-row", rowsEl).filter((r) => !r.closest(".disc:not(.open)"));
      if (!rows.length) return;
      const i = rows.findIndex((r) => +r.dataset.pr === ui.pr);
      const next = rows[clamp(i < 0 ? 0 : i + delta, 0, rows.length - 1)];
      if (next) selectPr(+next.dataset.pr);
    }
    function setListOpen(open) {
      ui.listOpen = open;
      shell.classList.toggle("list-open", open);
      if (open) requestAnimationFrame(() => placePlate({ instant: true }));
    }
    const narrow = () => root.clientWidth < 760;
    function nextThread(delta) {
      const pane = currentPane();
      if (!pane?.matches(".b-files")) return;
      const diffs = $(".b-diffs", pane);
      const nodes = $$(".b-thr:not(.resolved):not(.b-newthr)", diffs);
      if (!nodes.length) return toast("No open conversations in this diff");
      const y = diffs.getBoundingClientRect().top + 150;
      const idx =
        delta > 0
          ? nodes.findIndex((nd) => nd.getBoundingClientRect().top > y + 4)
          : nodes.map((nd) => nd.getBoundingClientRect().top < y - 4).lastIndexOf(true);
      const target = nodes[idx < 0 ? (delta > 0 ? 0 : nodes.length - 1) : idx];
      lab.setHashState({ thread: target.dataset.thread });
      focusThread(target.dataset.thread);
    }
    function selectionChip(e, pane) {
      ui.selChip?.remove();
      ui.selChip = null;
      if (e.target.closest("textarea, button")) return;
      const sel = getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return;
      const r = sel.getRangeAt(0);
      if (!$(".b-diffs", pane).contains(r.commonAncestorContainer)) return;
      const text = sel.toString().trim();
      if (!text) return;
      const rect = r.getBoundingClientRect();
      const file = r.startContainer.parentElement?.closest(".b-file")?.dataset.path || "";
      const lines = text.split("\n").length;
      const chip = el(
        `<button class="b-selchip" type="button">${icon("agent")}Ask about ${plural(lines, "line")}</button>`,
      );
      chip.style.left = Math.round(Math.min(innerWidth - 180, rect.right + 6)) + "px";
      chip.style.top = Math.round(rect.bottom + 6) + "px";
      chip.addEventListener("mousedown", (ev) => ev.preventDefault());
      chip.addEventListener("click", () => {
        chip.remove();
        ui.selChip = null;
        agentToast(`Asked an agent about ${plural(lines, "line")} in ${file.split("/").pop()}`);
      });
      document.body.append(chip);
      ui.selChip = chip;
    }

    /* ======================================================== events */
    function act(e) {
      const t = e.target.closest("[data-act]");
      if (!t || !root.contains(t) || t.matches('[aria-disabled="true"]')) return;
      const a = t.dataset.act;
      const s = S();
      switch (a) {
        case "filter":
          return openFilter(t);
        case "group": {
          const g = t.dataset.group;
          const open = ui.collapsed.has(g);
          if (open) ui.collapsed.delete(g);
          else ui.collapsed.add(g);
          t.setAttribute("aria-expanded", String(open));
          t.nextElementSibling.classList.toggle("open", open);
          later(() => placePlate({ instant: true }), L.ms("stack") + 20);
          return;
        }
        case "toggle-list":
          if (narrow()) return setListOpen(!ui.listOpen);
          // Clip, don't reflow: the list keeps its open width while the column folds.
          if (!ui.listHidden) shell.style.setProperty("--lpx", listEl.offsetWidth + "px");
          ui.listHidden = !ui.listHidden;
          shell.classList.add("list-moving");
          shell.classList.toggle("list-hidden", ui.listHidden);
          later(
            () => {
              shell.classList.remove("list-moving");
              placePlate({ instant: true });
            },
            L.ms("pane") + 40,
          );
          return;
        case "close-list":
          return setListOpen(false);
        case "toggle-tree":
          ui.treeOpen = !treeOpen();
          return syncTree();
        case "next":
          return nextBtn._run?.();
        case "merge":
          return popKey === "merge" ? closePop() : openMerge();
        case "review":
          return popKey === "review" ? closePop() : openReview();
        case "stack":
          return popKey === "stack" ? closePop() : openStack();
        case "more":
          return openMore(t);
        case "edit-reviewers":
          return openPicker("reviewers");
        case "edit-assignees":
          return openPicker("assignees");
        case "edit-labels":
          return openPicker("labels");
        case "rerequest": {
          const p = P(ui.pr);
          const login = t.dataset.login;
          for (const list of [p.reviewers, det(ui.pr).reviewers || []]) {
            const r = list.find((x) => x.login === login);
            if (r) Object.assign(r, { state: "pending", requested: true });
          }
          refreshFacts();
          return toast(`Re-requested review from ${login}`, { tone: "ok" });
        }
        case "commit": {
          const sha = t.dataset.sha;
          const d = det(ui.pr);
          if (!d.commits?.some((c) => c.short === sha))
            return toast(`${sha} was rewritten by a force-push and isn’t on the branch anymore`);
          return nav({ tab: "files", commit: sha, file: null, thread: null }, { push: true });
        }
        case "goto-thread": {
          const th = threadById(t.dataset.thread);
          if (th) nav({ tab: "files", thread: th.id, file: th.path, commit: null }, { push: true });
          return;
        }
        case "goto-line":
          ui.flash = { path: t.dataset.path, line: +t.dataset.line };
          if (ui.tab === "files" && !s.commit) {
            lab.setHashState({ file: t.dataset.path });
            return flashLine(ui.flash);
          }
          return nav(
            { tab: "files", file: t.dataset.path, thread: null, commit: null },
            { push: true },
          );
        case "thr-toggle": {
          const id = t.dataset.thread;
          if (ui.thrOpen.has(id)) ui.thrOpen.delete(id);
          else ui.thrOpen.add(id);
          if (ui.tab === "files") return rerenderFile(threadById(id)?.path);
          const box = t.closest(".b-tthr");
          const disc = box && $(":scope > .disc", box);
          if (disc) {
            disc.classList.toggle("open", ui.thrOpen.has(id));
            $(".chev", t)?.classList.toggle("open", ui.thrOpen.has(id));
          }
          return;
        }
        case "resolve":
          return setResolved(t.dataset.thread, true);
        case "unresolve":
          return setResolved(t.dataset.thread, false);
        case "reply": {
          ui.replying = t.dataset.thread;
          if (ui.tab === "files") rerenderFile(threadById(ui.replying)?.path);
          else rebuildPane();
          const ta = $(`[data-draft="r:${CSS.escape(ui.replying)}"]`, root);
          ta?.focus();
          return;
        }
        case "reply-cancel": {
          const id = ui.replying;
          ui.replying = null;
          if (ui.tab === "files") rerenderFile(threadById(id)?.path);
          else rebuildPane();
          return;
        }
        case "reply-send":
          return sendReply(t.dataset.thread);
        case "apply-sugg": {
          const th = threadById(t.dataset.thread);
          if (th) setResolved(th.id, true, { quiet: true });
          return toast(
            `Committed the suggestion to ${P(ui.pr).headRefName} and resolved the thread`,
            { tone: "ok", icon: "commit" },
          );
        }
        case "ask-thread": {
          const th = threadById(t.dataset.thread);
          return agentToast(
            `Asked an agent about the thread on ${th?.path.split("/").pop()}:${th?.line ?? th?.originalLine}`,
          );
        }
        case "del-pending": {
          const d = det(ui.pr);
          const id = t.dataset.thread;
          const c = d.pendingReview?.comments.find((x) => x.id === id);
          d.pendingReview.comments = d.pendingReview.comments.filter((x) => x.id !== id);
          if (!d.pendingReview.comments.length) d.pendingReview = null;
          if (c) rerenderFile(c.path);
          renderHeader(P(ui.pr));
          return;
        }
        case "react":
          return react(t.dataset.cid, t.dataset.emoji);
        case "react-add":
          return openEmoji(t);
        case "post-comment":
          return postComment();
        case "close-pr":
          return closePr(ui.pr);
        case "fold": {
          const path = t.dataset.path;
          const sec = t.closest(".b-file");
          return setFold(path, !sec.classList.contains("folded"));
        }
        case "viewed":
          return toggleViewed(t.dataset.path);
        case "tfile": {
          const path = t.dataset.path;
          lab.setHashState({ file: path, thread: null });
          const sec = $(`.b-file[data-path="${CSS.escape(path)}"]`, currentPane());
          if (sec?.classList.contains("folded")) setFold(path, false, { instant: true });
          scrollToFile(path);
          if (narrow() || detailEl.clientWidth < 720) {
            ui.treeOpen = false;
            syncTree();
          }
          return;
        }
        case "tdir": {
          const dir = t.dataset.dir;
          const open = ui.closedDirs.has(dir);
          if (open) ui.closedDirs.delete(dir);
          else ui.closedDirs.add(dir);
          t.setAttribute("aria-expanded", String(open));
          t.nextElementSibling.classList.toggle("open", open);
          return;
        }
        case "scope":
          if (e.target.closest('[data-act="unscope"]')) return nav({ commit: null });
          return openScope(t);
        case "unscope":
          return nav({ commit: null });
        case "view": {
          const v = t.dataset.view;
          for (const b of $$(".b-vseg .seg-opt", root))
            b.setAttribute("aria-checked", String(b.dataset.view === v));
          L.syncIndicator(t.parentElement);
          return later(() => nav({ view: v === "unified" ? null : v }), L.ms("chip"));
        }
        case "diff-comment": {
          const p = P(ui.pr);
          if (p.state !== "open") return;
          const prevPath = ui.composer?.path;
          ui.composer = {
            n: ui.pr,
            path: t.dataset.path,
            side: t.dataset.side,
            line: +t.dataset.line,
          };
          if (prevPath && prevPath !== ui.composer.path) rerenderFile(prevPath);
          const nu = rerenderFile(ui.composer.path);
          const ta = nu && $(".b-newthr textarea", nu);
          if (ta) {
            ta.focus();
            if (!reduced())
              ta.closest(".b-newthr").animate(
                [
                  { opacity: 0, transform: "translateY(-4px)" },
                  { opacity: 1, transform: "none" },
                ],
                { duration: L.ms("pop"), easing: EASE },
              );
          }
          return;
        }
        case "comp-cancel": {
          const path = ui.composer?.path;
          ui.composer = null;
          return path && rerenderFile(path);
        }
        case "comp-single":
          return submitComposer(false);
        case "comp-review":
          return submitComposer(true);
        case "job": {
          if (e.target.closest("button")) return;
          const id = t.dataset.job;
          const box = t.closest(".b-job");
          const open = !box.classList.contains("open");
          box.classList.toggle("open", open);
          t.setAttribute("aria-expanded", String(open));
          $(":scope > .disc", box).classList.toggle("open", open);
          if (open) {
            ui.jobsOpen.add(id);
            ui.jobsClosed.delete(id);
          } else {
            ui.jobsOpen.delete(id);
            ui.jobsClosed.add(id);
          }
          lab.setHashState({ job: open ? id : s.job === id ? null : s.job });
          return;
        }
        case "rerun-job":
          return rerunJobs([t.dataset.job]);
        case "rerun-failed": {
          const w = det(ui.pr).checks.workflows.find((x) => x.id === t.dataset.wf);
          return rerunJobs(w.jobs.filter((j) => j.conclusion === "failure").map((j) => j.id));
        }
        case "fix-agent": {
          const j = det(ui.pr)
            .checks.workflows.flatMap((w) => w.jobs)
            .find((x) => x.id === t.dataset.job);
          return agentToast(
            `Started a thread to fix “${j?.name}” on ${P(ui.pr).headRefName}`,
            `Fix ${j?.name} on #${ui.pr}`,
          );
        }
        case "ext":
          return toast("Opens on GitHub", { icon: "external" });
      }
    }
    function sendReply(id) {
      const key = `r:${id}`;
      const body = (ui.draft.get(key) || "").trim();
      if (!body) return toast("Write a reply first");
      const t = (det(ui.pr).threads || []).find((x) => x.id === id);
      if (!t) return;
      t.comments.push({
        id: `${id}-c${++ui.seq}`,
        author: me(),
        createdAt: W.now,
        body,
        reactions: [],
      });
      ui.draft.delete(key);
      ui.replying = null;
      P(ui.pr).comments = (P(ui.pr).comments || 0) + 1;
      if (ui.tab === "files") rerenderFile(t.path);
      else rebuildPane();
      renderHeader(P(ui.pr));
    }
    root.addEventListener("click", (e) => {
      const row = e.target.closest(".b-row");
      if (row && root.contains(row)) return selectPr(+row.dataset.pr);
      const seg = e.target.closest(".b-seg");
      if (seg && !seg.hasAttribute("aria-current")) return selectPr(+seg.dataset.pr);
      const tab = e.target.closest(".b-tab");
      if (tab)
        return nav(
          {
            tab: tab.dataset.tab === "conversation" ? null : tab.dataset.tab,
            thread: null,
            job: null,
          },
          { push: true },
        );
      const task = e.target.closest(".b-desc .md-check");
      if (task) return toggleTask(+task.dataset.task, task);
      const ref = e.target.closest(".md-ref[data-pr]");
      if (ref) {
        if (P(+ref.dataset.pr)) return selectPr(+ref.dataset.pr);
        return toast(`#${ref.dataset.pr} is an issue`, { icon: "issue-open" });
      }
      act(e);
    });
    root.addEventListener("keydown", (e) => {
      const jh = e.target.closest?.(".b-job-h");
      if (jh && (e.key === "Enter" || e.key === " ") && e.target === jh) {
        e.preventDefault();
        jh.click();
      }
      const ta = e.target.closest?.("textarea");
      if (ta && e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        if (ta.closest(".b-newthr")) submitComposer(true);
        else if (ta.closest(".b-replying")) sendReply(ui.replying);
        else if (ta.closest(".b-newc")) postComment();
      }
      if (ta && e.key === "Escape") {
        if (ta.closest(".b-newthr")) {
          const path = ui.composer?.path;
          ui.composer = null;
          if (path) rerenderFile(path);
        } else ta.blur();
      }
    });
    root.addEventListener("input", (e) => {
      const ta = e.target.closest?.("[data-draft]");
      if (ta) {
        ui.draft.set(ta.dataset.draft, ta.value);
        if (ta.tagName === "TEXTAREA") {
          ta.style.height = "auto";
          ta.style.height = Math.min(320, ta.scrollHeight + 2) + "px";
        }
      }
    });
    function toggleTask(idx, node) {
      const d = det(ui.pr);
      let k = -1;
      d.body = d.body.replace(/^(\s*[-*+]\s+)\[( |x|X)\]/gm, (m0, lead, mark) =>
        ++k === idx ? `${lead}[${mark === " " ? "x" : " "}]` : m0,
      );
      const on = node.getAttribute("aria-checked") !== "true";
      node.setAttribute("aria-checked", String(on));
      node.closest("li")?.classList.toggle("done", on);
    }

    /* search */
    let qTimer = 0;
    search.value = S().q || "";
    search.addEventListener("input", () => {
      clearTimeout(qTimer);
      const v = search.value;
      const looksRef = /\/pull\/\d+/.test(v) || /^\s*#\d{2,6}\s*$/.test(v);
      if (looksRef) {
        const n = model.parseRef(v);
        if (n && P(n)) {
          search.value = "";
          lab.setHashState({ q: null });
          renderList();
          selectPr(n);
          toast(`Opened #${n}`, { icon: "link" });
          return;
        }
      }
      qTimer = setTimeout(() => {
        lab.setHashState({ q: v.trim() || null });
        renderList({ flip: true });
      }, 70);
    });
    search.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const first = $(".b-row", rowsEl);
        if (first) selectPr(+first.dataset.pr);
      } else if (e.key === "Escape") {
        search.value = "";
        lab.setHashState({ q: null });
        renderList({ flip: true });
        search.blur();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        stepList(1);
      }
    });

    /* keyboard */
    function onKey(e) {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (!root.isConnected) return;
      if (e.target.closest?.("input, textarea, select, [contenteditable]")) return;
      if (document.querySelector(".scrim") || menu.isOpen()) return;
      const k = e.key;
      const s = S();
      const tabKeys = { 1: "conversation", 2: "files", 3: "checks", 4: "commits" };
      if (tabKeys[k] && ui.pr != null)
        nav({ tab: k === "1" ? null : tabKeys[k], thread: null, job: null }, { push: true });
      else if (k === "j") stepList(1);
      else if (k === "k") stepList(-1);
      else if (k === "]") stepLayer(1);
      else if (k === "[") stepLayer(-1);
      else if (k === "s" && ui.pr != null) popKey === "stack" ? closePop() : openStack();
      else if (k === "m" && ui.pr != null) popKey === "merge" ? closePop() : openMerge();
      else if (k === "r" && ui.pr != null) popKey === "review" ? closePop() : openReview();
      else if (k === "/") {
        if (narrow() && !ui.listOpen && ui.pr != null) setListOpen(true);
        search.focus();
        search.select();
      } else if (k === "\\") act({ target: $(".b-listbtn", root) });
      else if (k === "?") popKey === "keys" ? closePop() : openKeys();
      else if (k === "Escape" && ui.listOpen) setListOpen(false);
      else if (ui.tab === "files" && k === "n") nextThread(1);
      else if (ui.tab === "files" && k === "p") nextThread(-1);
      else if (ui.tab === "files" && k === "t") act({ target: $(".b-treebtn", root) });
      else if (ui.tab === "files" && k === "c") {
        const b = $(".b-scope", currentPane() || root);
        if (b) openScope(b);
      } else if (ui.tab === "files" && k === "u") {
        const v = s.view === "split" ? "unified" : "split";
        nav({ view: v === "unified" ? null : v });
      } else if (ui.tab === "files" && k === "v") {
        const cur = currentPane()?.dataset.cur;
        if (cur) toggleViewed(cur);
      } else return;
      e.preventDefault();
    }
    document.addEventListener("keydown", onKey);
    offs.push(() => document.removeEventListener("keydown", onKey));
    const killChip = (e) => {
      if (ui.selChip && !ui.selChip.contains(e.target)) {
        ui.selChip.remove();
        ui.selChip = null;
      }
    };
    document.addEventListener("pointerdown", killChip, true);
    document.addEventListener("scroll", killChip, true);
    offs.push(() => {
      document.removeEventListener("pointerdown", killChip, true);
      document.removeEventListener("scroll", killChip, true);
      ui.selChip?.remove();
    });

    /* lab events */
    offs.push(
      lab.onHashChange((s, { prev }) => applyState(prev, s)),
      lab.on("resize", () => {
        measureStrip();
        placePlate({ instant: true });
        if (!narrow() && ui.listOpen) setListOpen(false);
        if (currentPane()?.matches(".b-files") && ui.treeOpen == null) syncTree();
        popApi?.reposition();
      }),
    );

    /* ======================================================== boot */
    const s0 = S();
    ui.tab = tabOf(s0);
    renderList();
    applyPr(null, s0.pr != null && P(s0.pr) ? s0.pr : null);
    const boot = () => {
      if (!root.isConnected) return;
      measureStrip();
      placePlate({ instant: true });
      syncFlags(S());
    };
    (document.fonts?.ready || Promise.resolve()).then(() =>
      requestAnimationFrame(() => requestAnimationFrame(boot)),
    );

    return () => {
      for (const f of offs) {
        try {
          f();
        } catch {}
      }
      for (const id of timers) clearTimeout(id);
      for (const a of ui.inflight) a.cancel?.();
      window.PR_LAB_DATA = ORIG;
      model._synth = {};
    };
  }
})();
