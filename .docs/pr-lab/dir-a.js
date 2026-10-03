/* ============================================================
   Direction A · Triage + Reader

   [ ranked glyph list | reader ]. The list is a resizable column of
   two-line glyph rows grouped Needs your review / Yours / Others and
   ranked by readiness; one shared highlight slides between rows. The
   reader is a single-line bar (the title condenses into it once the
   hero scrolls away) over a tab strip with a sliding underline. Tabs
   stay mounted per PR. Conversation carries a facts column (merge box
   with the one next-action control, reviewers, assignees, labels,
   stack rail, linked work) that folds into rows under the title via a
   container query. Under 760px of page the list becomes an overlay.

   Mutations run on a structured clone of PR_LAB_DATA that is swapped
   into window.PR_LAB_DATA while mounted (so PR_LAB.model sees them)
   and restored on unmount, keeping B and C comparable.
   ============================================================ */
(function () {
  "use strict";
  const L = window.PR_LAB;
  const {
    html,
    raw,
    esc,
    h,
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
    animate,
    flip,
    push,
    syncIndicator,
    indicator,
    menu,
    popover,
    toast,
    confirm,
    closeLayers,
    model,
    plural,
    clamp,
    ms,
    runKind,
  } = L;

  const NARROW_AT = 760;
  const LIST_MIN = 264;
  const LIST_MAX = 500;
  const LIST_DEF = 340;
  const LS_LIST = "pr-lab:a:list-w";
  const TABS = [
    { key: "conversation", label: "Conversation" },
    { key: "files", label: "Files" },
    { key: "checks", label: "Checks" },
    { key: "commits", label: "Commits" },
  ];
  const METHODS = [
    { key: "squash", label: "Squash and merge", sub: "One commit on the base branch" },
    { key: "rebase", label: "Rebase and merge", sub: "Replay every commit onto the base" },
    { key: "merge", label: "Create a merge commit", sub: "Keep the commits plus a merge commit" },
  ];
  const CHECK_SVG = `<svg viewBox="0 0 12 12" aria-hidden="true"><path pathLength="1" d="M2.6 6.3l2.2 2.2 4.6-4.9" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const T = (tone) => `t-${tone || "neutral"}`;
  const S = (v) => String(v);

  /** 14px tone glyph: ok / err / warn / run / neutral (+ merged / closed). */
  function toneGlyph(tone, size = 14) {
    if (tone === "ok") return checkGlyph("pass", { size, tip: false });
    if (tone === "err") return checkGlyph("fail", { size, tip: false });
    if (tone === "run") return checkGlyph("run", { size, tip: false });
    if (tone === "merged") return stateGlyph("merged", { size, tip: false });
    if (tone === "closed") return stateGlyph("closed", { size, tip: false });
    if (tone === "warn")
      return raw(
        `<span class="cg a-cg-warn" style="--s:${size}px"><svg viewBox="0 0 14 14"><circle cx="7" cy="7" r="6.2" fill="var(--warn-fill)"/><path d="M7 3.8v3.7" stroke="var(--check-ink)" stroke-width="1.7" stroke-linecap="round"/><circle cx="7" cy="10.1" r="1" fill="var(--check-ink)"/></svg></span>`,
      );
    return checkGlyph("queued", { size, tip: false });
  }

  L.registerDirection({
    id: "a",
    name: "Triage + Reader",
    tagline: "Ranked glyph inbox beside a focused reader with a facts column",
    mount(root, origData, lab) {
      const saved = { data: window.PR_LAB_DATA, synth: model._synth };
      const data = structuredClone(origData);
      window.PR_LAB_DATA = data;
      model._synth = {};
      let app = null;
      try {
        app = createApp(root, data, lab);
      } catch (err) {
        window.PR_LAB_DATA = saved.data;
        model._synth = saved.synth;
        throw err;
      }
      return () => {
        app.destroy();
        window.PR_LAB_DATA = saved.data;
        model._synth = saved.synth;
      };
    },
  });

  function createApp(root, data, lab) {
    const viewer = data.viewer.login;
    const repo = data.repo;
    const nowMs = Date.parse(data.now);
    let tick = 0;
    const nowIso = () => new Date(nowMs + ++tick * 1000).toISOString();
    let seq = 0;
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
    const raf2 = (fn) => requestAnimationFrame(() => requestAnimationFrame(fn));

    for (const d of Object.values(data.details))
      for (const f of d.files || []) f.viewed = f.viewed === true || f.viewed === "viewed";
    for (const p of data.pullRequests)
      if (p.state === "merged" && p.branchDeleted == null)
        p.branchDeleted = !!repo.deleteBranchOnMerge;

    /* ------------------------------------------------------ state */
    const st = {
      pr: null,
      tab: "conversation",
      file: null,
      thread: null,
      commit: null,
      view: "unified",
      job: null,
      q: "",
      group: null,
      filter: "",
      stack: false,
      merge: false,
      review: false,
    };
    const ui = {
      listW: clamp(Number(localStorage.getItem(LS_LIST)) || LIST_DEF, LIST_MIN, LIST_MAX),
      listHidden: false,
      overlay: false,
      narrow: false,
      collapsed: new Set(),
      tree: null,
      treeClosed: new Set(),
      treeQ: "",
      composer: null,
      replies: new Map(),
      openResolved: new Set(),
      openJobs: new Set(),
      openSteps: new Set(),
      collapsedFiles: new Set(),
      forceOpen: new Set(),
      method: repo.defaultMergeMethod,
      panes: new Map(),
      order: [],
      spy: null,
      seenEv: new Set(),
      convDraft: "",
      paneTab: null,
    };

    const cur = () => (st.pr != null ? model.pr(st.pr) : null);
    const det = (pr) => model.detail(pr.number);
    const uname = (login) => model.user(login).name || login;
    const isMine = (pr) => pr.author === viewer;

    function readHash(s) {
      return {
        pr: s.pr ?? null,
        tab: TABS.some((t) => t.key === s.tab) ? s.tab : "conversation",
        file: s.file || null,
        thread: s.thread || null,
        commit: s.commit || null,
        view: s.view === "split" ? "split" : "unified",
        job: s.job || null,
        q: s.q || "",
        group: ["review", "mine", "others"].includes(s.group) ? s.group : null,
        filter: s.filter || "",
        stack: !!s.stack,
        merge: !!s.merge,
        review: !!s.review,
      };
    }
    function writeHash(pushIt = false) {
      lab.setHashState(
        {
          pr: st.pr,
          tab: st.pr != null ? st.tab : null,
          stack: st.stack,
          merge: st.merge,
          review: st.review,
          file: st.file,
          thread: st.thread,
          commit: st.commit,
          view: st.view === "split" ? "split" : null,
          job: st.job,
          q: st.q,
          group: st.group,
          filter: st.filter,
        },
        { push: pushIt },
      );
    }

    /* ------------------------------------------------------ data helpers */
    function recompute(pr) {
      const d = det(pr);
      if (!d.synthetic) pr.unresolvedThreads = d.threads.filter((t) => !t.isResolved).length;
      const people = pr.reviewers.filter((r) => !model.user(r.login).team);
      const approvals = people.filter((r) => r.state === "approved").length;
      if (!pr.isDraft) {
        pr.reviewDecision = people.some((r) => r.state === "changes_requested")
          ? "changes_requested"
          : approvals >= repo.protection.requiredApprovals
            ? "approved"
            : "review_required";
      }
      const wf = d.checks?.workflows || [];
      if (wf.length) {
        const jobs = wf.flatMap((w) => w.jobs);
        const failed = jobs.filter(
          (j) => j.status === "completed" && j.conclusion === "failure",
        ).length;
        const running = jobs.filter((j) => j.status !== "completed").length;
        const skipped = jobs.filter(
          (j) => j.status === "completed" && j.conclusion === "skipped",
        ).length;
        pr.checks = {
          state: failed ? "failing" : running ? "running" : "passing",
          total: jobs.length + (d.checks.statuses?.length || 0),
          passed: jobs.length - failed - running - skipped + (d.checks.statuses?.length || 0),
          failed,
          running,
          skipped,
        };
        for (const w of wf) {
          const ws = w.jobs.map((j) => runKind(j));
          w.status = ws.some((k) => k === "run" || k === "queued") ? "in_progress" : "completed";
          w.conclusion =
            w.status !== "completed" ? null : ws.includes("fail") ? "failure" : "success";
        }
      }
      if (pr.state === "open") {
        pr.mergeStateStatus = pr.isDraft
          ? "DRAFT"
          : pr.mergeable === "conflicting"
            ? "DIRTY"
            : pr.behindBy > 0
              ? "BEHIND"
              : model.blockers(pr).length
                ? "BLOCKED"
                : "CLEAN";
      }
    }
    function addEvent(pr, ev) {
      det(pr).timeline.push({ id: `${pr.number}-x${++seq}`, actor: viewer, at: nowIso(), ...ev });
      pr.updatedAt = data.now;
    }
    function scopedFiles(d) {
      const order = (f) =>
        /(^|\/)(bun\.lock|package\.json|.*\.lock)$/.test(f.path)
          ? 2
          : /\.(test|browser|spec)\.[tj]sx?$/.test(f.path)
            ? 1
            : 0;
      const list = d.files
        .map((f, i) => ({ f, i }))
        .sort((a, b) => order(a.f) - order(b.f) || a.i - b.i)
        .map((x) => x.f);
      return st.commit ? list.filter((f) => (f.commits || []).includes(st.commit)) : list;
    }
    const patchCache = new Map();
    function rowsOf(f) {
      let r = patchCache.get(f.patch);
      if (!r) patchCache.set(f.patch, (r = parsePatch(f.patch)));
      return r;
    }
    function splitPath(p) {
      const i = p.lastIndexOf("/");
      return i < 0 ? ["", p] : [p.slice(0, i + 1), p.slice(i + 1)];
    }
    function snippet(md) {
      return String(md || "")
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/[`*_>#]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 140);
    }
    function checksTip(pr) {
      const c = pr.checks;
      if (c.state === "failing")
        return `${plural(c.failed, "check")} failing · ${c.passed} of ${c.total} passed`;
      if (c.state === "running")
        return `${plural(c.running, "check")} running · ${c.passed} of ${c.total} done`;
      if (c.state === "passing") return `All ${c.total} checks passed`;
      return "No checks";
    }

    /* ------------------------------------------------------ filters */
    function filters() {
      const f = { state: "open", failing: false, sort: "ready", labels: [] };
      for (const t of (st.filter || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)) {
        if (["open", "draft", "merged", "closed", "all"].includes(t)) f.state = t;
        else if (t === "failing") f.failing = true;
        else if (t === "sort:updated") f.sort = "updated";
        else if (t.startsWith("label:")) f.labels.push(t.slice(6));
      }
      return f;
    }
    function setFilters(f) {
      const toks = [];
      if (f.state !== "open") toks.push(f.state);
      if (f.failing) toks.push("failing");
      if (f.sort === "updated") toks.push("sort:updated");
      for (const l of f.labels) toks.push("label:" + l);
      st.filter = toks.join(",");
    }
    const refQuery = (q) => /^#\d+$|\/pull\/\d+/.test(q.trim());
    function matches(pr, q) {
      const hay =
        `#${pr.number} ${pr.title} ${pr.author} ${uname(pr.author)} ${pr.headRefName} ${pr.labels.join(" ")}`.toLowerCase();
      return q.split(/\s+/).every((w) => hay.includes(w));
    }
    function listModel() {
      const f = filters();
      const q = st.q.trim().toLowerCase();
      let prs = data.pullRequests;
      if (q)
        prs = refQuery(q)
          ? prs.filter((p) => p.number === model.parseRef(q))
          : prs.filter((p) => matches(p, q));
      if (f.failing) prs = prs.filter((p) => p.checks.state === "failing");
      if (f.labels.length) prs = prs.filter((p) => f.labels.every((l) => p.labels.includes(l)));
      let groups = model.groups(prs, { state: f.state });
      if (f.sort === "updated")
        groups = groups.map((g) => ({
          ...g,
          prs: [...g.prs].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
        }));
      if (st.group) groups = groups.filter((g) => g.key === st.group);
      const shown = groups.reduce((n, g) => n + g.prs.length, 0);
      const elsewhere =
        q && f.state !== "all"
          ? model.groups(prs, { state: "all" }).reduce((n, g) => n + g.prs.length, 0) - shown
          : 0;
      const filtered = !!(q || f.failing || f.labels.length || f.state !== "open" || st.group);
      return { groups, f, shown, elsewhere, filtered };
    }

    /* ------------------------------------------------------ skeleton */
    root.innerHTML = String(html`<div class="a-shell">
      <aside class="a-list" aria-label="Pull requests">
        <div class="a-lhead">
          <label class="a-search"
            >${icon("search")}<input
              type="text"
              spellcheck="false"
              autocomplete="off"
              placeholder="Search or paste a link"
              aria-label="Search pull requests"
            /><kbd>/</kbd></label
          >
          <button class="ib a-fbtn" type="button" data-act="filter-menu" data-tip="Filter and sort">
            ${icon("filter")}<i class="a-fdot"></i>
          </button>
        </div>
        <div class="a-chips disc">
          <div><div class="a-chips-in"></div></div>
        </div>
        <div class="a-lscroll scroll" role="listbox" aria-label="Pull requests" tabindex="-1">
          <div class="a-lin">
            <i class="a-sel" aria-hidden="true"></i>
            <div class="a-groups"></div>
            <div class="a-lfoot"></div>
          </div>
        </div>
      </aside>
      <div
        class="a-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize list"
        tabindex="0"
        data-tip="Drag to resize · double-click to reset"
      ></div>
      <section class="a-reader" aria-label="Pull request">
        <header class="a-bar">
          <button
            class="ib a-listbtn"
            type="button"
            data-act="list-toggle"
            data-tip="Pull requests"
            data-kbd="\\"
          >
            ${icon("sidebar")}
          </button>
          <div class="a-id"></div>
          <div class="a-acts"></div>
        </header>
        <div class="a-tabrow">
          <div class="tabs a-tabs" role="tablist" aria-label="Pull request sections">
            ${TABS.map((t) => html`<button class="tab" type="button" role="tab" data-tab="${t.key}" aria-selected="false">${t.label}<span class="cnt tnum"></span></button>`)}<i
              class="tab-ind"
            ></i>
          </div>
          <div class="a-tools"></div>
        </div>
        <div class="a-panes"></div>
        <div class="a-empty">
          <div class="a-empty-in">
            <p>Select a pull request</p>
            <ul class="a-keys">
              <li><kbd>J</kbd><kbd>K</kbd><span>Move through the list</span></li>
              <li><kbd>/</kbd><span>Search, or paste a pull request link</span></li>
              <li><kbd>1</kbd><i>–</i><kbd>4</kbd><span>Switch section</span></li>
            </ul>
          </div>
        </div>
      </section>
      <div class="a-scrim" data-act="overlay-close"></div>
    </div>`);
    const shell = $(".a-shell", root);
    const search = $(".a-search input", root);
    const lscroll = $(".a-lscroll", root);
    const lin = $(".a-lin", root);
    const selEl = $(".a-sel", root);
    const reader = $(".a-reader", root);
    const panesEl = $(".a-panes", root);
    const tabsEl = $(".a-tabs", root);
    offs.push(indicator(tabsEl));

    /* ------------------------------------------------------ layout */
    function updateLayout() {
      const w = lab.pageWidth();
      const narrow = w < NARROW_AT;
      if (narrow !== ui.narrow) {
        ui.narrow = narrow;
        ui.overlay = false;
      }
      const maxW = Math.max(LIST_MIN, Math.min(LIST_MAX, w - 440));
      shell.style.setProperty("--list-w", Math.min(ui.listW, maxW) + "px");
      shell.classList.toggle("narrow", narrow);
      shell.classList.toggle("solo", narrow && st.pr == null);
      shell.classList.toggle("ovl", narrow && ui.overlay && st.pr != null);
      shell.classList.toggle("list-hidden", !narrow && ui.listHidden);
      const handle = $(".a-handle", root);
      handle.setAttribute("aria-valuenow", S(ui.listW));
      handle.setAttribute("aria-valuemin", S(LIST_MIN));
      handle.setAttribute("aria-valuemax", S(LIST_MAX));
    }
    function toggleList(force) {
      if (ui.narrow) {
        if (st.pr == null) return;
        ui.overlay = force ?? !ui.overlay;
        updateLayout();
        if (ui.overlay) requestAnimationFrame(() => placeSel(true));
      } else {
        ui.listHidden = force != null ? !force : !ui.listHidden;
        updateLayout();
        followSel(ms("pane") + 60);
      }
    }

    /* ------------------------------------------------------ list */
    const rowEls = new Map();
    const grpEls = new Map();
    function rowInner(pr, animateCheck) {
      const na = model.nextAction(pr);
      const sk = pr.stack;
      const sub =
        pr.state === "merged"
          ? html`<span class="a-rnext t-merged"
              >Merged by ${uname(pr.mergedBy || pr.author).split(" ")[0]}</span
            >`
          : pr.state === "closed"
            ? html`<span class="a-rnext t-closed">Closed</span>`
            : na.key === "review"
              ? html`<span class="a-rnext"
                  >${diffStat(pr.additions, pr.deletions)}<span class="dim"
                    >${plural(pr.changedFiles, "file")}</span
                  ></span
                >`
              : html`<span class="a-rnext ${T(na.tone)}">${na.label}</span>`;
      return String(html`<span class="a-rg">${stateGlyph(pr, { size: 15 })}</span>
        <span class="a-rt">${pr.title}</span>
        <span class="a-rtime tnum" data-tip="Updated ${agoLong(pr.updatedAt)}"
          >${ago(pr.updatedAt)}</span
        >
        <span class="a-rc ${animateCheck ? "a-glyph-in" : ""}"
          >${checkGlyph(pr.checks.state, { size: 12, tip: checksTip(pr), animate: animateCheck })}</span
        >
        <span class="a-rs"
          ><span class="a-rnum tnum">#${pr.number}</span
          >${sub}${sk ? html`<span class="a-rstk tnum" data-tip="Stack #${sk.number} · layer ${sk.position} of ${sk.size} · into ${sk.baseRefName}">${icon("stack")}${sk.position}/${sk.size}</span>` : ""}</span
        >
        <span class="a-rm">${isMine(pr) ? "" : avatar(pr.author, { size: 16 })}</span>`);
    }
    function ensureRow(pr, stk) {
      let row = rowEls.get(pr.number);
      const changedCk = row && row._ck !== pr.checks.state;
      const key = JSON.stringify([
        pr.title,
        pr.state,
        pr.isDraft,
        pr.checks,
        model.nextAction(pr).label,
        pr.updatedAt,
        pr.stack?.position,
        pr.additions,
      ]);
      if (!row) {
        row = h("div", {
          class: "a-row",
          role: "option",
          tabindex: "-1",
          dataset: { pr: S(pr.number) },
        });
        rowEls.set(pr.number, row);
      }
      if (row._key !== key) {
        row.innerHTML = rowInner(pr, !!changedCk);
        row._key = key;
      }
      row._ck = pr.checks.state;
      row.className = `a-row${pr.unread ? " unread" : ""}${stk ? ` stk stk-${stk}` : ""}`;
      row.setAttribute("aria-selected", S(pr.number === st.pr));
      return row;
    }
    function stackPositions(prs) {
      const out = prs.map(() => null);
      let i = 0;
      while (i < prs.length) {
        const id = prs[i].stack?.id;
        let j = i;
        while (id && j + 1 < prs.length && prs[j + 1].stack?.id === id) j++;
        if (j > i)
          for (let k = i; k <= j; k++) out[k] = k === i ? "first" : k === j ? "last" : "mid";
        i = j + 1;
      }
      return out;
    }
    function ensureGroup(g) {
      let gel = grpEls.get(g.key);
      if (!gel) {
        gel = el(
          `<div class="a-grp" data-g="${g.key}"><button class="a-gh" type="button" data-act="group" data-g="${g.key}">${icon("chevron", { cls: "chev" })}<span class="a-ght"></span><span class="a-gcnt tnum"></span></button><div class="disc open"><div><div class="a-gl" role="group"></div></div></div></div>`,
        );
        grpEls.set(g.key, gel);
      }
      const collapsed = ui.collapsed.has(g.key) && !st.q;
      $(".a-ght", gel).textContent = g.label;
      $(".a-gcnt", gel).textContent = g.prs.length ? S(g.prs.length) : "";
      $(".a-gh", gel).setAttribute("aria-expanded", S(!collapsed));
      $(".a-gh", gel).classList.toggle("open", !collapsed);
      $(".disc", gel).classList.toggle("open", !collapsed);
      $(".a-gl", gel).setAttribute("aria-label", g.label);
      return gel;
    }
    function renderList(opts = {}) {
      const m = listModel();
      const groupsEl = $(".a-groups", root);
      const mutate = () => {
        const kids = [];
        for (const g of m.groups) {
          if (!g.prs.length && m.filtered) continue;
          const gel = ensureGroup(g);
          const pos = stackPositions(g.prs);
          const rows = g.prs.map((p, i) => ensureRow(p, pos[i]));
          const gl = $(".a-gl", gel);
          if (rows.length) gl.replaceChildren(...rows);
          else gl.innerHTML = `<div class="a-gnone">Nothing here</div>`;
          kids.push(gel);
        }
        groupsEl.replaceChildren(...kids);
      };
      if (opts.flip) flip(() => $$(".a-row", groupsEl), mutate, { duration: "stack" });
      else mutate();
      const foot = $(".a-lfoot", root);
      const q = st.q.trim();
      if (!m.shown) {
        const n = refQuery(q) ? model.parseRef(q) : null;
        foot.innerHTML = String(html`<div class="a-lempty">
          <p>${n ? `No pull request #${n} in ${repo.nameWithOwner}` : "No pull requests match"}</p>
          ${m.elsewhere ? html`<button class="btn sm" type="button" data-act="show-all">Show ${plural(m.elsewhere, "match", "matches")} in other states</button>` : html`<button class="btn sm ghost" type="button" data-act="clear-filters">Clear filters</button>`}
        </div>`);
      } else if (m.elsewhere) {
        foot.innerHTML = String(
          html`<button class="a-lmore" type="button" data-act="show-all">
            ${plural(m.elsewhere, "more match", "more matches")} in merged and closed
          </button>`,
        );
      } else foot.innerHTML = "";
      paintChips(m.f);
      ui.order = m.groups
        .filter((g) => !(ui.collapsed.has(g.key) && !st.q))
        .flatMap((g) => g.prs.map((p) => p.number));
      placeSel(opts.instant);
    }
    function placeSel(instant) {
      const row = st.pr != null ? rowEls.get(st.pr) : null;
      for (const [n, r] of rowEls) r.setAttribute("aria-selected", S(n === st.pr));
      const rect = row && row.isConnected ? row.getBoundingClientRect() : null;
      if (!rect || rect.height < 4) {
        selEl.classList.remove("on");
        return;
      }
      const y = rect.top - lin.getBoundingClientRect().top;
      const wasOn = selEl.classList.contains("on");
      if (instant || !wasOn) selEl.style.transition = "none";
      selEl.style.transform = `translateY(${Math.round(y)}px)`;
      selEl.style.height = Math.round(rect.height) + "px";
      selEl.classList.add("on");
      if (instant || !wasOn) {
        void selEl.offsetWidth;
        selEl.style.transition = "";
      }
    }
    let followUntil = 0;
    function followSel(duration) {
      const start = !followUntil;
      followUntil = performance.now() + duration;
      if (!start) return;
      const step = () => {
        placeSel(true);
        placeTreeSel(true);
        if (performance.now() < followUntil) requestAnimationFrame(step);
        else followUntil = 0;
      };
      requestAnimationFrame(step);
    }
    function paintChips(f) {
      const chips = [];
      const chip = (label, act, extra = "") =>
        html`<button class="chip a-chip" type="button" data-act="${act}" ${raw(extra)}>
          ${label}${icon("x")}
        </button>`;
      if (f.state !== "open")
        chips.push(
          chip(
            { draft: "Drafts", merged: "Merged", closed: "Closed", all: "All states" }[f.state],
            "chip-state",
          ),
        );
      if (st.group)
        chips.push(
          chip(
            { review: "Needs your review", mine: "Yours", others: "Others" }[st.group],
            "chip-group",
          ),
        );
      if (f.failing) chips.push(chip("Failing checks", "chip-failing"));
      for (const l of f.labels)
        chips.push(chip(raw(labelChip(l)), "chip-label", `data-label="${esc(l)}"`));
      if (f.sort === "updated") chips.push(chip("Recently updated", "chip-sort"));
      const wrap = $(".a-chips", root);
      $(".a-chips-in", root).innerHTML = chips.length
        ? String(
            html`${chips}<button class="a-chipclear" type="button" data-act="clear-filters">
                Clear
              </button>`,
          )
        : "";
      wrap.classList.toggle("open", chips.length > 0);
      $(".a-fbtn", root).classList.toggle("on", chips.length > 0);
    }
    function afterFilter(pushIt = false) {
      renderList({ flip: true });
      writeHash(pushIt);
      followSel(ms("stack") + 60);
    }

    /* ------------------------------------------------------ selection */
    function selectPR(n, opts = {}) {
      n = n == null ? null : Number(n);
      if (n != null && !model.pr(n)) return;
      const prev = st.pr;
      const a = ui.order.indexOf(prev);
      const b = ui.order.indexOf(n);
      const dir = opts.dir ?? (a < 0 || b < 0 ? 1 : Math.sign(b - a) || 1);
      if (n !== prev) {
        Object.assign(st, {
          file: null,
          thread: null,
          commit: null,
          job: null,
          merge: false,
          review: false,
        });
        if (!opts.keepStack) st.stack = false;
        ui.composer = null;
        ui.openResolved.clear();
        ui.forceOpen.clear();
        ui.collapsedFiles.clear();
        ui.openJobs.clear();
        ui.openSteps.clear();
        ui.spy = null;
      }
      if (opts.tab) st.tab = opts.tab;
      st.pr = n;
      const pr = cur();
      if (pr && pr.unread) {
        pr.unread = false;
        ensureRow(pr, rowEls.get(pr.number)?.className.match(/stk-(\w+)/)?.[1]);
      }
      closeLayers();
      hideSelBar();
      if (ui.narrow) ui.overlay = false;
      updateLayout();
      if (n !== prev || opts.force) renderReader(prev == null || n == null ? 0 : dir);
      placeSel();
      if (opts.scroll !== false) scrollRowIntoView(n);
      if (opts.hash !== false) writeHash(opts.push ?? true);
    }
    function scrollRowIntoView(n) {
      const row = rowEls.get(n);
      if (!row || !row.isConnected) return;
      const r = row.getBoundingClientRect();
      const box = lscroll.getBoundingClientRect();
      const pad = 40;
      if (r.top < box.top + pad) lscroll.scrollTop -= box.top + pad - r.top;
      else if (r.bottom > box.bottom - 8) lscroll.scrollTop += r.bottom - box.bottom + 8;
    }
    function moveSel(delta) {
      if (!ui.order.length) return;
      const i = ui.order.indexOf(st.pr);
      const j =
        i < 0 ? (delta > 0 ? 0 : ui.order.length - 1) : clamp(i + delta, 0, ui.order.length - 1);
      if (ui.order[j] !== st.pr) selectPR(ui.order[j], { push: false });
    }

    /* ------------------------------------------------------ reader */
    function swapIn(node, dir) {
      if (!dir || !node) return;
      node.classList.remove("a-in-up", "a-in-down");
      void node.offsetWidth;
      node.classList.add(dir > 0 ? "a-in-up" : "a-in-down");
    }
    function renderReader(dir = 0) {
      const pr = cur();
      ui.panes.clear();
      panesEl.replaceChildren();
      reader.classList.toggle("is-empty", !pr);
      if (!pr) {
        $(".a-id", root).innerHTML = "";
        $(".a-acts", root).innerHTML = "";
        $(".a-tools", root).innerHTML = "";
        paintTabs();
        return;
      }
      paintIdentity(pr);
      paintActs(pr);
      showTab(st.tab, { instant: true, hash: false });
      swapIn($(".a-id", root), dir);
      swapIn(panesEl, dir);
    }
    function paintIdentity(pr) {
      const s = pr.stack;
      $(".a-id", root).innerHTML = String(html`${stateGlyph(pr, { size: 16 })}
        <button class="a-num tnum" type="button" data-act="copy-link" data-tip="Copy link">
          #${pr.number}
        </button>
        ${s ? html`<button class="a-stkchip tnum" type="button" data-act="stack" aria-expanded="${S(st.stack)}" data-tip="Stack #${s.number} · layer ${s.position} of ${s.size} · into ${s.baseRefName}" data-kbd="S">${icon("stack")}<span>${s.position}/${s.size}</span></button>` : ""}
        <button class="a-ctitle" type="button" data-act="to-top" tabindex="-1">
          <span class="trunc">${pr.title}</span>
        </button>`);
    }
    function paintActs(pr) {
      const d = det(pr);
      const pend = d.pendingReview?.comments?.length || 0;
      const prev = $(".a-badge", root)?.textContent;
      $(".a-acts", root).innerHTML =
        String(html`${pr.state === "open" ? html`<button class="btn sm a-revbtn" type="button" data-act="review" data-kbd="R" data-tip="${pend ? `Submit your review · ${plural(pend, "pending comment")}` : isMine(pr) ? "Comment on the changes" : "Submit a review"}">Review${pend ? html`<span class="a-badge tnum">${pend}</span>` : ""}</button>` : ""}
          <button
            class="chip agent a-askchip"
            type="button"
            data-act="ask"
            data-tip="Ask an agent about this pull request"
          >
            ${icon("agent")}<span>Ask</span>
          </button>
          <button class="ib" type="button" data-act="open-gh" data-tip="Open on GitHub">
            ${icon("external")}
          </button>
          <button class="ib" type="button" data-act="more" data-tip="More">
            ${icon("more")}
          </button>`);
      const badge = $(".a-badge", root);
      if (badge && prev !== badge.textContent) badge.classList.add("pop-in");
    }
    function paintTabs() {
      const pr = cur();
      const d = pr && det(pr);
      const counts = pr
        ? {
            conversation: pr.comments || "",
            files: d.files.length || pr.changedFiles || "",
            checks: pr.checks.total || "",
            commits: d.commits.length || pr.commitsCount || "",
          }
        : {};
      for (const b of $$(".tab", tabsEl)) {
        b.setAttribute("aria-selected", S(!!pr && b.dataset.tab === st.tab));
        $(".cnt", b).textContent = counts[b.dataset.tab] ?? "";
      }
      syncIndicator(tabsEl);
    }
    function paintTools() {
      const pr = cur();
      const tools = $(".a-tools", root);
      if (!pr) return void (tools.innerHTML = "");
      const d = det(pr);
      if (st.tab === "files" && d.files.length) {
        const files = scopedFiles(d);
        const viewed = files.filter((f) => f.viewed).length;
        const treeOn = treeShown();
        tools.innerHTML = String(html`<span class="a-vprog" data-tip="Files viewed" data-kbd="V"
            ><span class="a-vbar"
              ><i style="--p:${files.length ? viewed / files.length : 0}"></i></span
            ><span class="tnum">${viewed}/${files.length}</span></span
          >
          <button
            class="btn sm ghost a-scope ${st.commit ? "on" : ""}"
            type="button"
            data-act="scope"
            data-tip="${st.commit ? "Viewing one commit · commenting is off" : "Scope to a commit"}"
            data-kbd="C"
          >
            ${icon("commit")}<span class="a-scope-l">${st.commit || "All commits"}</span
            >${icon("chevron-down", { cls: "a-dd" })}
          </button>
          <div class="seg a-vseg" role="radiogroup" aria-label="Diff layout">
            <i class="seg-ind"></i
            ><button
              class="seg-opt"
              type="button"
              role="radio"
              data-act="view"
              data-v="unified"
              aria-checked="${S(st.view !== "split")}"
              data-tip="Unified"
              data-kbd="U"
            >
              ${icon("unified")}</button
            ><button
              class="seg-opt"
              type="button"
              role="radio"
              data-act="view"
              data-v="split"
              aria-checked="${S(st.view === "split")}"
              data-tip="Split"
              data-kbd="U"
            >
              ${icon("split")}
            </button>
          </div>
          <button
            class="ib a-treebtn ${treeOn ? "on" : ""}"
            type="button"
            data-act="tree"
            data-tip="${treeOn ? "Hide" : "Show"} file tree"
            data-kbd="F"
          >
            ${icon("sidebar")}
          </button>`);
        syncIndicator($(".a-vseg", tools), { instant: true });
      } else if (st.tab === "checks") {
        const C = model.checks(d);
        tools.innerHTML = C.failing.length
          ? String(
              html`<button class="btn sm" type="button" data-act="rerun-failed">
                ${icon("rerun")}Re-run failed
              </button>`,
            )
          : "";
      } else tools.innerHTML = "";
    }
    function paneEl(tab) {
      let p = ui.panes.get(tab);
      if (p) return p;
      const pr = cur();
      p = h("div", {
        class: `a-pane a-p-${tab}`,
        role: "tabpanel",
        "aria-label": tab,
        dataset: { tab },
      });
      ui.panes.set(tab, p);
      panesEl.append(p);
      buildPane(tab, pr);
      if (tab === "conversation") {
        p.addEventListener("scroll", updateCondensed, { passive: true });
        const ro = new ResizeObserver(fitFacts);
        ro.observe(p);
        const facts = $(".a-facts", p);
        if (facts) ro.observe(facts);
        offs.push(() => ro.disconnect());
      }
      return p;
    }
    function buildPane(tab, pr) {
      const p = ui.panes.get(tab);
      const d = det(pr);
      if (tab === "conversation") {
        p.classList.add("scroll");
        p.innerHTML = String(convHtml(pr, d));
        for (const e of d.timeline) ui.seenEv.add(e.id);
      } else if (tab === "files") {
        p.innerHTML = String(filesHtml(pr, d));
        const stream = $(".a-stream", p);
        if (stream) stream.addEventListener("scroll", onStreamScroll, { passive: true });
        raf2(() => spy(true));
      } else if (tab === "checks") {
        p.classList.add("scroll");
        p.innerHTML = String(checksHtml(pr, d));
        requestAnimationFrame(() => {
          for (const lg of $$(".a-step.k-fail .a-log", p)) lg.scrollTop = lg.scrollHeight;
        });
      } else {
        p.classList.add("scroll");
        p.innerHTML = String(commitsHtml(pr, d));
      }
    }
    function rebuildPane(tab) {
      const p = ui.panes.get(tab);
      const pr = cur();
      if (!p || !pr) return;
      const keep = [p, ...$$(".scroll", p)].map((n) => [n.className, n.scrollTop]);
      buildPane(tab, pr);
      const nodes = [p, ...$$(".scroll", p)];
      keep.forEach(([cls, top], i) => {
        if (nodes[i] && nodes[i].className === cls) nodes[i].scrollTop = top;
      });
    }
    function showTab(tab, opts = {}) {
      const prevTab = ui.paneTab;
      st.tab = tab;
      if (!cur()) return;
      const p = paneEl(tab);
      for (const [k, n] of ui.panes) {
        n.classList.toggle("on", k === tab);
        n.setAttribute("aria-hidden", S(k !== tab));
      }
      ui.paneTab = tab;
      paintTabs();
      paintTools();
      updateCondensed();
      if (!opts.instant && prevTab && prevTab !== tab) {
        const dx =
          TABS.findIndex((t) => t.key === tab) > TABS.findIndex((t) => t.key === prevTab) ? 1 : -1;
        p.classList.remove("a-tab-l", "a-tab-r");
        void p.offsetWidth;
        p.classList.add(dx > 0 ? "a-tab-r" : "a-tab-l");
      }
      if (tab !== "files") hideSelBar();
      if (opts.hash !== false) writeHash(false);
    }
    function updateCondensed() {
      let c = true;
      const p = ui.panes.get(st.tab);
      if (st.tab === "conversation" && p) {
        const h1 = $(".a-h1", p);
        if (h1) c = p.scrollTop > h1.offsetTop + h1.offsetHeight - 4;
      }
      reader.classList.toggle("condensed", c);
      reader.classList.toggle("scrolled", !!p && st.tab !== "files" && p.scrollTop > 1);
    }

    /* ------------------------------------------------------ conversation */
    function convHtml(pr, d) {
      const commits = d.commits.length || pr.commitsCount || 0;
      return html`<div class="a-conv">
        <header class="a-hero">
          <div class="a-h1row">
            <h1 class="a-h1">${pr.title}</h1>
            ${isMine(pr) && pr.state === "open" ? html`<button class="ib sm a-h1edit" type="button" data-act="edit-title" data-tip="Edit title">${icon("edit")}</button>` : ""}
          </div>
          <div class="a-meta">
            <button
              class="a-ref"
              type="button"
              data-act="copy-branch"
              data-v="${pr.headRefName}"
              data-tip="Copy branch name"
            >
              ${icon("branch")}<span>${pr.headRefName}</span>
            </button>
            <span class="a-into">into</span>
            <button
              class="a-ref"
              type="button"
              data-act="copy-branch"
              data-v="${pr.baseRefName}"
              data-tip="Copy branch name"
            >
              <span>${pr.baseRefName}</span>
            </button>
            ${commits ? html`<span class="sep">·</span><span class="tnum">${plural(commits, "commit")}</span>` : ""}
            <span class="sep">·</span>${diffStat(pr.additions, pr.deletions)}
          </div>
        </header>
        <div class="a-cols">
          <div class="a-main">
            <div class="a-tl">
              ${descHtml(pr, d)}${timelineHtml(pr, d)}${pr.state !== "merged" ? convComposerHtml() : ""}
            </div>
          </div>
          <aside class="a-facts" aria-label="Status">${factsHtml(pr, d)}</aside>
        </div>
      </div>`;
    }
    function descHtml(pr, d) {
      return html`<article class="a-ev big a-desc" data-ev="desc">
        <span class="a-rail">${avatar(pr.author, { size: 22 })}</span>
        <header class="a-evh">
          <b>${uname(pr.author)}</b
          ><span class="dim" data-tip="${fmtDate(pr.createdAt)}"
            >opened ${agoLong(pr.createdAt)}</span
          >
        </header>
        <div class="md" data-md="desc">${markdown(d.body)}</div>
        ${d.linkedIssues?.length ? html`<div class="a-closes">${d.linkedIssues.map((i) => html`<span class="a-issue">${icon("issue-open")}Closes <b>#${i.number}</b><span class="trunc">${i.title}</span></span>`)}</div>` : ""}
      </article>`;
    }
    function mergeEvents(list) {
      const out = [];
      for (const e of list) {
        if (e.kind === "opened") continue;
        const last = out[out.length - 1];
        const groupable = ["labeled", "review_requested", "assigned"].includes(e.kind);
        const val =
          e.kind === "labeled" ? e.label : e.kind === "review_requested" ? e.reviewer : e.assignee;
        if (
          groupable &&
          last &&
          last.kind === e.kind &&
          last.actor === e.actor &&
          Math.abs(Date.parse(e.at) - Date.parse(last.at)) < 15 * 60e3
        ) {
          last.items.push(val);
          continue;
        }
        out.push(groupable ? { ...e, items: [val] } : e);
      }
      return out;
    }
    const andList = (xs) =>
      xs.length < 2
        ? xs
        : [...xs.slice(0, -1).flatMap((x, i) => (i ? [", ", x] : [x])), " and ", xs[xs.length - 1]];
    function timelineHtml(pr, d) {
      return html`<div class="a-evs">${mergeEvents(d.timeline).map((e) => evHtml(pr, d, e))}</div>`;
    }
    function small(e, ic, body, cls = "") {
      const fresh = !ui.seenEv.has(e.id) ? " rise-in" : "";
      return html`<div class="a-ev small ${cls}${fresh}" data-ev="${e.id}">
        <span class="a-rail a-rail-ic">${icon(ic)}</span>
        <div class="a-evl">
          <b>${uname(e.actor)}</b> ${body}
          <span class="dim tnum" data-tip="${fmtDate(e.at)}">${ago(e.at)}</span>
        </div>
      </div>`;
    }
    function evHtml(pr, d, e) {
      const fresh = !ui.seenEv.has(e.id) ? " rise-in" : "";
      switch (e.kind) {
        case "comment":
          return html`<article class="a-ev big${fresh}" data-ev="${e.id}">
            <span class="a-rail">${avatar(e.actor, { size: 22 })}</span>
            <header class="a-evh">
              <b>${uname(e.actor)}</b
              ><span class="dim tnum" data-tip="${fmtDate(e.at)}">${agoLong(e.at)}</span
              >${e.editedAt ? html`<span class="dim">· edited</span>` : ""}<span class="a-evtools"
                >${reactAdd(`e:${e.id}`)}<button
                  class="ib sm"
                  type="button"
                  data-act="quote"
                  data-ev="${e.id}"
                  data-tip="Quote reply"
                >
                  ${icon("reply")}
                </button></span
              >
            </header>
            <div class="md">${markdown(e.body)}</div>
            ${reactsHtml(e.reactions, `e:${e.id}`)}
          </article>`;
        case "review": {
          const verb =
            {
              approved: "approved",
              changes_requested: "requested changes",
              commented: "reviewed",
              dismissed: "dismissed a review",
            }[e.state] || "reviewed";
          const threads = (e.threadIds || [])
            .map((id) => d.threads.find((t) => t.id === id))
            .filter(Boolean);
          return html`<article class="a-ev big a-review r-${e.state}${fresh}" data-ev="${e.id}">
            <span class="a-rail a-rail-rv">${reviewGlyph(e.state, { size: 13, tip: false })}</span>
            <header class="a-evh">
              <b>${uname(e.actor)}</b><span class="a-verb">${verb}</span
              ><span class="dim tnum" data-tip="${fmtDate(e.at)}">${agoLong(e.at)}</span>
            </header>
            ${e.body ? html`<div class="md">${markdown(e.body)}</div>` : ""}
            ${threads.length ? html`<div class="a-quotes">${threads.map((t) => quoteHtml(t))}</div>` : ""}
          </article>`;
        }
        case "commits": {
          const list = e.commits || [];
          return html`<div class="a-ev small a-pushed${fresh}" data-ev="${e.id}">
            <span class="a-rail a-rail-ic">${icon("commit")}</span>
            <div class="a-evl">
              <b>${uname(e.actor)}</b> pushed ${plural(list.length, "commit")}
              <span class="dim tnum" data-tip="${fmtDate(e.at)}">${ago(e.at)}</span>
            </div>
            <ul class="a-pcs">
              ${list.map((c) => {
                const live = d.commits.find((x) => x.short === c.short || x.message === c.message);
                return html`<li>
                  <button
                    class="a-pc"
                    type="button"
                    data-act="goto-commit"
                    data-sha="${live ? live.short : ""}"
                    ${live ? "" : raw('aria-disabled="true" data-tip="Rewritten by a force-push"')}
                  >
                    <code class="a-sha">${live ? live.short : c.short}</code
                    ><span class="trunc">${c.message}</span
                    >${live ? checkGlyph(live.checks, { size: 12 }) : ""}
                  </button>
                </li>`;
              })}
            </ul>
          </div>`;
        }
        case "force_pushed":
          return small(
            e,
            "branch",
            html`force-pushed <code class="a-sha">${e.before.slice(0, 7)}</code>→<code class="a-sha"
                >${e.after.slice(0, 7)}</code
              >${e.note ? html`<span class="dim"> · ${e.note}</span>` : ""}`,
          );
        case "labeled":
          return small(e, "tag", html`added ${e.items.map((l) => labelChip(l))}`, "a-labeled");
        case "review_requested":
          return small(
            e,
            "users",
            html`requested review from ${andList(e.items.map((x) => html`<b>${uname(x)}</b>`))}`,
          );
        case "assigned":
          return small(
            e,
            "user",
            html`assigned ${andList(e.items.map((x) => html`<b>${uname(x)}</b>`))}`,
          );
        case "renamed":
          return small(
            e,
            "edit",
            html`changed the title <del>${e.from}</del> to <span class="a-to">${e.to}</span>`,
          );
        case "ready_for_review":
          return small(e, "eye", html`marked this ready for review`);
        case "converted_to_draft":
          return small(e, "pr-draft", html`converted this to a draft`);
        case "base_changed":
          return small(
            e,
            "branch",
            html`changed the base from <code class="a-sha">${e.from}</code> to
              <code class="a-sha">${e.to}</code>`,
          );
        case "merged":
          return small(
            e,
            "pr-merged",
            html`merged into <code class="a-sha">${e.base || pr.baseRefName}</code>`,
            "a-merged",
          );
        case "closed":
          return small(e, "pr-closed", html`closed this`, "a-closed");
        case "reopened":
          return small(e, "pr-open", html`reopened this`);
        case "auto_merge":
          return small(
            e,
            "clock",
            html`${e.on ? `turned on auto-merge (${e.method})` : "turned off auto-merge"}`,
          );
        case "branch_updated":
          return small(
            e,
            "update-branch",
            html`updated the branch with <code class="a-sha">${pr.baseRefName}</code>`,
          );
        default:
          return "";
      }
    }
    function quoteHtml(t) {
      const c = t.comments[0];
      const [, name] = splitPath(t.path);
      return html`<button class="a-q" type="button" data-act="goto-thread" data-thread="${t.id}">
        <span class="a-qp"
          >${icon("file")}<span>${name}</span>${t.line ? html`<span class="dim tnum">:${t.line}</span>` : ""}</span
        >
        <span class="a-qs trunc">${snippet(c.body)}</span>
        <span class="a-qm ${t.isResolved ? "t-ok" : t.isOutdated ? "" : "t-warn"}"
          >${t.isOutdated ? "Outdated" : t.isResolved ? "Resolved" : plural(t.comments.length, "comment")}</span
        >
      </button>`;
    }
    function reactsHtml(list, key) {
      return html`<div class="a-reacts" data-key="${key}">
        ${(list || []).map((r) => html`<button class="a-react ${r.viewerReacted ? "on" : ""}" type="button" data-act="react" data-key="${key}" data-emoji="${r.emoji}" aria-pressed="${S(!!r.viewerReacted)}">${r.emoji}<span class="tnum">${r.count}</span></button>`)}
      </div>`;
    }
    function reactAdd(key) {
      return html`<button
        class="ib sm"
        type="button"
        data-act="react-add"
        data-key="${key}"
        data-tip="Add reaction"
      >
        ${icon("smile")}
      </button>`;
    }
    function convComposerHtml() {
      return html`<div class="a-ev big a-cbox ${ui.convDraft ? "has" : ""}">
        <span class="a-rail">${avatar(viewer, { size: 22 })}</span>
        <div class="a-cwrap">
          <textarea class="a-cta" rows="1" data-conv-ta placeholder="Leave a comment">
${ui.convDraft}</textarea>
          <div class="a-grow-row">
            <div>
              <div class="a-cacts">
                <span class="a-hint">Markdown is supported</span><span class="a-sp"></span
                ><button class="btn sm pri" type="button" data-act="conv-send">
                  Comment<kbd>⌘↵</kbd>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>`;
    }

    /* ------------------------------------------------------ facts column */
    function factsHtml(pr, d) {
      return html`${secMerge(pr, d)}${pr.stack ? secStack(pr, false) : ""}${secReviewers(pr)}${secAssignees(pr)}${secLabels(pr)}${secLinked(pr, d)}`;
    }
    function verdict(pr, na) {
      const owner = (o) =>
        o === "you"
          ? "on you"
          : o === "author"
            ? `on ${uname(pr.author).split(" ")[0]}`
            : o === "reviewers"
              ? "on reviewers"
              : o === "ci"
                ? "on CI"
                : "";
      switch (na.key) {
        case "merged":
          return {
            text: "Merged",
            tone: "merged",
            owner: `by ${uname(pr.mergedBy || viewer).split(" ")[0]} · ${ago(pr.mergedAt)}`,
          };
        case "closed":
          return { text: "Closed", tone: "closed", owner: pr.closedAt ? ago(pr.closedAt) : "" };
        case "merge":
        case "merge-stack":
          return { text: "Ready to merge", tone: "ok", owner: "" };
        case "auto-merge":
          return {
            text: "Auto-merge on",
            tone: "ok",
            owner: `${(pr.autoMerge?.method || ui.method).replace(/^\w/, (c) => c.toUpperCase())} · ${uname(pr.autoMerge?.enabledBy || viewer).split(" ")[0]}`,
          };
        case "review":
          return { text: "Waiting", tone: "warn", owner: "on your review" };
        case "wait-checks":
          return { text: "Waiting", tone: "run", owner: "on CI" };
        case "await-review":
          return { text: "Waiting", tone: "neutral", owner: "on reviewers" };
        case "blocked-by-stack":
          return {
            text: "Waiting",
            tone: "neutral",
            owner: `on ${na.label.replace("Waiting on ", "")}`,
          };
        case "mark-ready":
        case "draft":
          return {
            text: "Draft",
            tone: "neutral",
            owner: na.owner === "you" ? "" : `by ${uname(pr.author).split(" ")[0]}`,
          };
        case "update-branch":
          return { text: "Out of date", tone: "warn", owner: owner(na.owner) };
        default:
          return {
            text: "Blocked",
            tone: na.tone === "err" ? "err" : "warn",
            owner: owner(na.owner),
          };
      }
    }
    function statusLines(pr, d) {
      if (pr.state !== "open") return [];
      const out = [];
      const c = pr.checks;
      if (c.state === "failing") {
        const failing = model.checks(d).failing;
        out.push({
          key: "checks",
          tone: "err",
          text:
            failing.length === 1
              ? `${failing[0].name} failed`
              : `${plural(c.failed, "check")} failed`,
          sub: `${c.passed}/${c.total}`,
          go: "checks",
          agent: "Fix",
        });
      } else if (c.state === "running")
        out.push({
          key: "checks",
          tone: "run",
          text: `${plural(c.running, "check")} running`,
          sub: `${c.passed}/${c.total}`,
          go: "checks",
        });
      else if (c.state === "passing")
        out.push({
          key: "checks",
          tone: "ok",
          text: "Checks passed",
          sub: `${c.total}/${c.total}`,
          go: "checks",
        });
      else out.push({ key: "checks", tone: "neutral", text: "No checks yet", go: "checks" });
      if (!pr.isDraft) {
        if (pr.reviewDecision === "approved")
          out.push({ key: "reviews", tone: "ok", text: "Approved", go: "reviews" });
        else if (pr.reviewDecision === "changes_requested")
          out.push({ key: "reviews", tone: "err", text: "Changes requested", go: "reviews" });
        else
          out.push({
            key: "reviews",
            tone: "neutral",
            text: `${plural(repo.protection.requiredApprovals, "approval")} required`,
            go: "reviewers",
          });
      }
      const unresolved = d.synthetic
        ? pr.unresolvedThreads
        : d.threads.filter((t) => !t.isResolved).length;
      if (unresolved)
        out.push({
          key: "threads",
          tone: "warn",
          text: plural(unresolved, "unresolved thread"),
          go: "threads",
        });
      else if (d.threads?.length)
        out.push({ key: "threads", tone: "ok", text: "Threads resolved" });
      if (pr.mergeable === "conflicting")
        out.push({ key: "branch", tone: "err", text: "Conflicts with base", agent: "Resolve" });
      else if (pr.mergeStateStatus === "BEHIND" || pr.behindBy > 0)
        out.push({
          key: "branch",
          tone: "warn",
          text: `${plural(pr.behindBy || 1, "commit")} behind base`,
          go: "update",
        });
      else out.push({ key: "branch", tone: "ok", text: "Branch up to date" });
      return out;
    }
    function primaryAction(pr) {
      const na = model.nextAction(pr);
      const d = det(pr);
      const pend = d.pendingReview?.comments?.length || 0;
      const method = METHODS.find((m) => m.key === ui.method) || METHODS[0];
      switch (na.key) {
        case "review":
          return pend
            ? { label: "Finish review", style: "pri", icon: "review-approve" }
            : { label: "Start review", style: "pri", icon: "file-diff" };
        case "merge":
          return { label: method.label, style: "ok", icon: "merge" };
        case "merge-stack":
          return { label: na.label, style: "ok", icon: "stack" };
        case "update-branch":
          return { label: "Update branch", style: "pri", icon: "update-branch" };
        case "fix-checks":
          return { label: "View failing check", style: "pri", icon: "check-fail" };
        case "resolve-conflicts":
          return { label: "Resolve conflicts", style: "pri", icon: "conflict" };
        case "address-review":
          return { label: "Go to next thread", style: "pri", icon: "comment" };
        case "mark-ready":
          return { label: "Ready for review", style: "pri", icon: "eye" };
        case "auto-merge":
          return { label: "Cancel auto-merge", style: "", icon: "x" };
        case "wait-checks":
          return { label: "Merge when ready", style: "", icon: "clock" };
        case "blocked-by-stack":
          return {
            label: `Open ${na.label.replace("Waiting on ", "")}`,
            style: "",
            icon: "arrow-right",
          };
        case "await-review":
          return isMine(pr)
            ? { label: "Request reviewers", style: "", icon: "users" }
            : { label: "Merge when ready", style: "", icon: "clock" };
        case "draft":
          return { label: "View changes", style: "", icon: "file-diff" };
        case "merged":
          return pr.branchDeleted
            ? { label: "Revert", style: "", icon: "undo" }
            : { label: "Delete branch", style: "", icon: "trash" };
        case "closed":
          return { label: "Reopen", style: "", icon: "pr-open" };
        default:
          return { label: na.label, style: "", icon: null };
      }
    }
    function secMerge(pr, d) {
      const na = model.nextAction(pr);
      const v = verdict(pr, na);
      const lines = statusLines(pr, d);
      const act = primaryAction(pr);
      return html`<section
        class="a-fs a-mb"
        data-sec="merge"
        data-tone="${v.tone}"
        data-key="${na.key}"
      >
        <div class="a-mb-v">
          <span class="a-mb-vi">${toneGlyph(v.tone, 15)}</span
          ><span class="a-roll"
            ><span class="a-roll-in"
              ><b>${v.text}</b>${v.owner ? html`<span class="a-mb-vo">${v.owner}</span>` : ""}</span
            ></span
          >
        </div>
        ${
          lines.length
            ? html`<ul class="a-mb-ls">
                ${lines.map(
                  (l) => html`<li
                    class="a-mb-l ${l.go ? "go" : ""}"
                    data-line="${l.key}"
                    ${l.go ? raw(`data-act="mb-go" data-go="${l.go}" role="button" tabindex="0"`) : ""}
                  >
                    <span class="a-mb-li">${toneGlyph(l.tone, 13)}</span
                    ><span class="a-mb-lt">${l.text}</span
                    >${l.sub ? html`<span class="a-mb-ls-sub tnum">${l.sub}</span>` : ""}
                    ${l.agent ? html`<button class="a-agent" type="button" data-act="agent" data-what="${l.key === "checks" ? "fix-checks" : "resolve-conflicts"}" data-tip="${l.key === "checks" ? "Start an agent thread to fix the failing check" : "Start an agent thread to resolve the conflicts"}">${icon("agent")}<span>${l.agent}</span></button>` : ""}
                  </li>`,
                )}
              </ul>`
            : ""
        }
        <div class="btn-split a-next">
          <button class="btn ${act.style}" type="button" data-act="next">
            ${act.icon ? icon(act.icon) : ""}<span class="trunc">${act.label}</span>
          </button>
          <button
            class="btn ${act.style} a-next-more"
            type="button"
            data-act="merge-menu"
            data-tip="Merge options"
            data-kbd="M"
            aria-haspopup="menu"
            aria-label="Merge options"
          >
            ${icon("chevron-down")}
          </button>
        </div>
      </section>`;
    }
    function fhead(label, act, tip, extra = "") {
      return html`<header class="a-fh">
        <span class="a-fk">${label}</span
        >${extra}${act ? html`<button class="ib sm a-fedit" type="button" data-act="${act}" data-tip="${tip}">${icon("edit")}</button>` : ""}
      </header>`;
    }
    function secReviewers(pr) {
      const list = pr.reviewers || [];
      const canEdit = pr.state === "open";
      return html`<section class="a-fs" data-sec="reviewers">
        ${fhead("Reviewers", canEdit && "pick-reviewers", "Edit reviewers")}
        <div class="a-fv">
          ${
            list.length
              ? html`<ul class="a-ppl">
                  ${list.map((r) => html`<li class="a-p">${avatar(r.login, { size: 18 })}<span class="trunc">${model.user(r.login).team ? "@" + r.login : uname(r.login)}</span>${reviewGlyph(r.state, { size: 13, tip: r.state === "pending" ? "Review requested" : undefined })}${r.state !== "pending" && isMine(pr) && pr.state === "open" ? html`<button class="ib sm a-hov" type="button" data-act="rerequest" data-login="${r.login}" data-tip="Re-request review">${icon("rerun")}</button>` : ""}</li>`)}
                </ul>`
              : html`<span class="a-none">No reviewers</span>`
          }
        </div>
      </section>`;
    }
    function secAssignees(pr) {
      const list = pr.assignees || [];
      return html`<section class="a-fs" data-sec="assignees">
        ${fhead("Assignees", pr.state === "open" && "pick-assignees", "Edit assignees")}
        <div class="a-fv">
          ${
            list.length
              ? html`<ul class="a-ppl">
                  ${list.map((l) => html`<li class="a-p">${avatar(l, { size: 18 })}<span class="trunc">${uname(l)}</span></li>`)}
                </ul>`
              : html`<button class="a-none a-link" type="button" data-act="assign-me">
                  Assign yourself
                </button>`
          }
        </div>
      </section>`;
    }
    function secLabels(pr) {
      return html`<section class="a-fs" data-sec="labels">
        ${fhead("Labels", pr.state === "open" && "pick-labels", "Edit labels")}
        <div class="a-fv">
          ${pr.labels.length ? html`<div class="a-lbls">${pr.labels.map((l) => labelChip(l))}</div>` : html`<span class="a-none">None</span>`}
        </div>
      </section>`;
    }
    function stackTone(a) {
      return a.state === "ready"
        ? "ok"
        : a.state === "merged"
          ? "merged"
          : a.state === "pending"
            ? "run"
            : "err";
    }
    function secStack(pr, inPop) {
      const s = model.stackOf(pr);
      if (!s) return "";
      const expanded = st.stack || inPop;
      const a = s.assessment;
      const layers = [...s.entries].reverse();
      return html`<section
        class="a-fs a-stack ${expanded ? "x" : ""} ${inPop ? "in-pop" : ""}"
        data-sec="stack"
      >
        <header class="a-fh">
          <span class="a-fk">Stack <span class="tnum">#${s.number}</span></span>
          <span class="a-sa ${T(stackTone(a))}"
            >${a.state === "ready" ? "Ready to merge" : a.label}</span
          >
          ${inPop ? "" : html`<button class="ib sm a-sx" type="button" data-act="stack" aria-expanded="${S(expanded)}" data-tip="${expanded ? "Fewer details" : "Layer details"}" data-kbd="S">${icon("chevron", { cls: "chev" })}</button>`}
        </header>
        <div class="a-fv a-railwrap">
          <ol class="a-srail">
            ${layers.map((p) => layerHtml(p, s, expanded))}
            <li class="a-sbase">
              <span class="a-sdot"></span><span class="a-sbn">${s.baseRefName}</span>
            </li>
          </ol>
        </div>
      </section>`;
    }
    function layerHtml(p, s, expanded) {
      const isCur = p.number === st.pr;
      const na = model.nextAction(p);
      const plan = model.mergePlan(p.number);
      const short =
        {
          merge: "Ready",
          "merge-stack": "Ready",
          "fix-checks": "Failing",
          "wait-checks": "Running",
          "await-review": "In review",
          review: "In review",
          "address-review": "Changes",
          "resolve-conflicts": "Conflicts",
          "mark-ready": "Draft",
          draft: "Draft",
          merged: "Merged",
          closed: "Closed",
          "blocked-by-stack": "Waiting",
          "update-branch": "Behind",
          "auto-merge": "Auto-merge",
        }[na.key] || na.label;
      return html`<li class="a-layer ${isCur ? "cur" : ""} s-${L.prState(p)}">
        <button
          class="a-lh"
          type="button"
          data-act="goto-pr"
          data-pr="${p.number}"
          ${isCur ? raw('aria-current="page"') : ""}
        >
          <span class="a-sdot">${stateGlyph(p, { size: 13, tip: false })}</span>
          <span class="a-lnum tnum">#${p.number}</span>
          <span class="a-lt trunc">${p.title}</span>
          <span class="a-lr ${T(na.tone)}">${isCur ? "Here" : short}</span>
        </button>
        <div class="disc ${expanded ? "open" : ""}">
          <div>
            <div class="a-ld">
              <span class="a-ldm"
                >${avatar(p.author, { size: 14 })}${diffStat(p.additions, p.deletions)}</span
              >
              ${
                p.state !== "open"
                  ? html`<span class="dim"
                      >${p.state === "merged" ? `Merged ${ago(p.mergedAt)}` : "Closed"}</span
                    >`
                  : plan.blockedBy?.pr.number === p.number
                    ? html`<span class="a-lblock">Holds the layers above</span>`
                    : plan.blockedBy
                      ? ""
                      : html`<button
                          class="btn sm ok a-mthru"
                          type="button"
                          data-act="merge-through"
                          data-pr="${p.number}"
                        >
                          Merge through
                          #${p.number}${plan.layers.length > 1 ? ` (${plan.layers.length})` : ""}
                        </button>`
              }
            </div>
          </div>
        </div>
      </li>`;
    }
    function secLinked(pr, d) {
      const issues = [];
      const threads = d.linkedThreads || [];
      if (!threads.length && !issues.length) return "";
      return html`<section class="a-fs" data-sec="linked">
        ${fhead("Agent threads", null)}
        <div class="a-fv">
          <ul class="a-links">
            ${threads.map(
              (t) => html`<li
                class="a-lk ${t.fresh ? "rise-in" : ""}"
                data-act="open-thread"
                data-id="${t.id}"
                role="button"
                tabindex="0"
              >
                <span class="a-lkg"
                  >${t.state === "working" ? raw('<span class="g g-working"></span>') : checkGlyph("pass", { size: 13, tip: false, animate: !!t.justDone })}</span
                >
                <span class="trunc">${t.title}</span
                ><span class="a-lkm"
                  >${t.state === "working" ? "Working" : t.result || "Done"}</span
                >
              </li>`,
            )}
          </ul>
        </div>
      </section>`;
    }
    function refreshFacts(keys) {
      const p = ui.panes.get("conversation");
      const pr = cur();
      if (!p || !pr) return;
      const d = det(pr);
      const facts = $(".a-facts", p);
      const want = keys || ["merge", "stack", "reviewers", "assignees", "labels", "linked"];
      const make = {
        merge: () => secMerge(pr, d),
        reviewers: () => secReviewers(pr),
        assignees: () => secAssignees(pr),
        labels: () => secLabels(pr),
        stack: () => (pr.stack ? secStack(pr, false) : ""),
        linked: () => secLinked(pr, d),
      };
      for (const k of want) {
        const old = $(`[data-sec="${k}"]`, facts);
        const markup = String(make[k]());
        if (!markup.trim()) {
          old?.remove();
          continue;
        }
        const next = el(markup);
        if (k === "merge" && old && old.dataset.key !== next.dataset.key) {
          const roll = $(".a-roll", next);
          const inner = $(".a-roll-in", next);
          const oldInner = $(".a-roll-in", old);
          if (oldInner) roll.replaceChildren(oldInner);
          old.replaceWith(next);
          if (oldInner) push(roll, inner, { axis: "y", dir: 1, duration: "stack" });
          const g = $(".a-mb-vi", next);
          g.classList.add("a-glyph-in");
          continue;
        }
        if (old) old.replaceWith(next);
        else {
          const order = ["merge", "stack", "reviewers", "assignees", "labels", "linked"];
          const after = order
            .slice(0, order.indexOf(k))
            .reverse()
            .map((x) => $(`[data-sec="${x}"]`, facts))
            .find(Boolean);
          if (after) after.after(next);
          else facts.prepend(next);
        }
      }
    }
    /** Sticky facts: when taller than the pane, scroll it with the page first and stick at its bottom. */
    function fitFacts() {
      const p = ui.panes.get("conversation");
      const facts = p && $(".a-facts", p);
      if (!facts) return;
      const top = Math.min(18, p.clientHeight - facts.offsetHeight - 24);
      facts.style.setProperty("--facts-top", top + "px");
    }
    function refreshTimeline() {
      const p = ui.panes.get("conversation");
      const pr = cur();
      if (!p || !pr) return;
      const d = det(pr);
      const evs = $(".a-evs", p);
      if (evs) evs.outerHTML = String(timelineHtml(pr, d));
      for (const e of d.timeline) ui.seenEv.add(e.id);
    }
    /** Repaints everything a mutation can touch, keeping scroll positions. */
    function refreshAll(opts = {}) {
      const pr = cur();
      renderList({ flip: !!opts.flip });
      if (!pr) return;
      paintIdentity(pr);
      paintActs(pr);
      paintTabs();
      paintTools();
      refreshFacts();
      if (opts.timeline) refreshTimeline();
      for (const t of ["files", "checks", "commits"])
        if (opts[t] && ui.panes.has(t)) rebuildPane(t);
      updateCondensed();
    }

    /* ------------------------------------------------------ files */
    function treeShown() {
      return ui.tree ?? !ui.narrow;
    }
    function filesHtml(pr, d) {
      const files = scopedFiles(d);
      if (!d.files.length)
        return html`<div class="a-blank">
          ${icon("file-diff")}
          <p>
            ${d.synthetic ? "This pull request is only mocked at summary level." : "No file changes."}
          </p>
        </div>`;
      return html`<div class="a-files ${treeShown() ? "tree-on" : ""}">
        <aside class="a-tree">
          <div class="a-tfilter">
            ${icon("search")}<input
              type="text"
              placeholder="Filter files"
              spellcheck="false"
              data-tree-q
              value="${ui.treeQ}"
            />
          </div>
          <div class="a-tscroll scroll">
            <div class="a-tin"><i class="a-tsel"></i>${treeHtml(d, files)}</div>
          </div>
        </aside>
        <div class="a-stream scroll">
          ${files.map((f) => fileHtml(pr, d, f))}
          <div class="a-stream-end">
            ${st.commit ? html`Showing ${plural(files.length, "file")} touched by <code class="a-sha">${st.commit}</code> · <button class="a-link" type="button" data-act="scope-clear">Show all commits</button>` : html`${plural(files.length, "file")} · ${diffStat(pr.additions, pr.deletions)}`}
          </div>
        </div>
      </div>`;
    }
    function treeHtml(d, files) {
      const q = ui.treeQ.trim().toLowerCase();
      const list = q ? files.filter((f) => f.path.toLowerCase().includes(q)) : files;
      if (!list.length) return html`<div class="a-tnone">No files match</div>`;
      const threads = model.threadsFor(d);
      const walk = (nodes, depth) =>
        nodes.map((n) => {
          if (n.kind === "dir") {
            const open = !ui.treeClosed.has(n.path) || !!q;
            return html`<div class="a-tdir" data-dir="${n.path}">
              <div
                class="a-trow a-tdr ${open ? "open" : ""}"
                data-act="tdir"
                data-dir="${n.path}"
                style="--d:${depth}"
                role="button"
                tabindex="-1"
              >
                ${icon("chevron", { cls: "chev" })}<span class="trunc">${n.name}</span>
              </div>
              <div class="disc ${open ? "open" : ""}">
                <div>${walk(n.children, depth + 1)}</div>
              </div>
            </div>`;
          }
          const f = n.file;
          const nt = threads.filter((t) => t.path === f.path && !t.isResolved).length;
          const letter = { added: "A", modified: "M", removed: "D", renamed: "R" }[f.status] || "M";
          return html`<div
            class="a-trow a-tf ${f.viewed ? "viewed" : ""}"
            data-act="tfile"
            data-path="${f.path}"
            style="--d:${depth}"
            role="button"
            tabindex="-1"
            title="${f.path}"
          >
            <span class="a-tst st-${f.status}">${letter}</span
            ><span class="a-tname trunc">${n.name}</span
            >${nt ? html`<span class="a-tth tnum" data-tip="${plural(nt, "open conversation")}">${nt}</span>` : ""}<button
              class="a-tchk ${f.viewed ? "on" : ""}"
              type="button"
              data-act="viewed"
              data-path="${f.path}"
              aria-pressed="${S(f.viewed)}"
              aria-label="Viewed"
            >
              ${raw(CHECK_SVG)}
            </button>
          </div>`;
        });
      return walk(buildFileTree(list), 0);
    }
    function fileOpen(f) {
      return !ui.collapsedFiles.has(f.path) && (!f.viewed || ui.forceOpen.has(f.path));
    }
    function fileHtml(pr, d, f) {
      const threads = model.threadsFor(d, f.path);
      const open = fileOpen(f);
      const unresolved = threads.filter((t) => !t.isResolved && !t.pending).length;
      const [dir, name] = splitPath(f.path);
      return html`<section class="a-file ${f.viewed ? "viewed" : ""}" data-path="${f.path}">
        <header class="a-fhd">
          <button
            class="a-fchev ${open ? "open" : ""}"
            type="button"
            data-act="file-toggle"
            data-path="${f.path}"
            aria-expanded="${S(open)}"
            aria-label="Toggle ${name}"
          >
            ${icon("chevron", { cls: "chev" })}
          </button>
          <span class="a-fpath" data-act="copy-path" data-path="${f.path}" data-tip="Copy path"
            ><span class="a-fdir">${dir}</span><span class="a-fname">${name}</span></span
          >
          ${f.status === "added" ? html`<span class="a-fst">New</span>` : f.status === "removed" ? html`<span class="a-fst">Deleted</span>` : ""}
          ${threads.length ? html`<span class="a-fth ${unresolved ? "warn" : ""}" data-tip="${plural(threads.length, "conversation")}${unresolved ? ` · ${unresolved} unresolved` : ""}">${icon("comment")}<span class="tnum">${threads.length}</span></span>` : ""}
          <span class="a-sp"></span>
          ${diffStat(f.additions, f.deletions)}
          <button
            class="a-vchk ${f.viewed ? "on" : ""}"
            type="button"
            data-act="viewed"
            data-path="${f.path}"
            aria-pressed="${S(f.viewed)}"
            data-tip="${f.viewed ? "Mark as not viewed" : "Mark as viewed"}"
            data-kbd="V"
          >
            <span class="a-box">${raw(CHECK_SVG)}</span><span class="a-vl">Viewed</span>
          </button>
          <button
            class="ib sm"
            type="button"
            data-act="file-more"
            data-path="${f.path}"
            data-tip="More"
          >
            ${icon("more")}
          </button>
        </header>
        <div class="disc ${open ? "open" : ""}">
          <div><div class="a-fbody">${fileBody(pr, d, f, threads)}</div></div>
        </div>
      </section>`;
    }
    function fileBody(pr, d, f, threads) {
      const rows = rowsOf(f);
      const live = threads.filter((t) => t.line != null && !t.isOutdated);
      const outdated = threads.filter((t) => t.line == null || t.isOutdated);
      const map = new Map();
      for (const t of live) {
        const k = `${t.side}:${t.line}`;
        if (!map.has(k)) map.set(k, []);
        map.get(k).push(t);
      }
      const c = ui.composer && ui.composer.path === f.path ? ui.composer : null;
      const focusT = st.thread ? live.find((t) => t.id === st.thread) : null;
      const table = renderDiff(rows, {
        mode: st.view,
        path: f.path,
        wrap: true,
        commentable: pr.state === "open" && !st.commit,
        annotate: (ref) => {
          const k = `${ref.side}:${ref.line}`;
          let out = (map.get(k) || []).map((t) => threadHtml(pr, d, t)).join("");
          if (c && c.side === ref.side && c.line === ref.line) out += composerHtml(d);
          return out ? raw(out) : null;
        },
        lineClass: (ref) => {
          const k = `${ref.side}:${ref.line}`;
          const cls = [];
          if (map.has(k)) cls.push("has-thread");
          if (
            (c && c.side === ref.side && c.line === ref.line) ||
            (focusT && focusT.side === ref.side && focusT.line === ref.line)
          )
            cls.push("sel");
          return cls.join(" ");
        },
      });
      return html`${
        outdated.length
          ? html`<div class="a-outdated">
              <div class="a-od-h">
                ${icon("clock")}${plural(outdated.length, "outdated conversation")}
              </div>
              ${outdated.map((t) => html`<div class="a-od">${t.diffHunk ? renderDiff(parsePatch(t.diffHunk).slice(-3), { path: f.path, wrap: true }) : ""}${raw(threadHtml(pr, d, t))}</div>`)}
            </div>`
          : ""
      }${table}`;
    }
    function threadHtml(pr, d, t) {
      const open = !t.isResolved || ui.openResolved.has(t.id);
      const first = t.comments[0];
      const body = html`${t.comments.map((c) => commentHtml(pr, t, c))}${t.pending ? pendingFoot(t) : threadFoot(pr, t)}`;
      if (!t.isResolved)
        return String(
          html`<div class="a-th ${t.pending ? "pending" : ""}" data-thread="${t.id}">${body}</div>`,
        );
      return String(html`<div class="a-th resolved ${open ? "open" : ""}" data-thread="${t.id}">
        <button
          class="a-th-sum"
          type="button"
          data-act="th-expand"
          data-thread="${t.id}"
          aria-expanded="${S(open)}"
        >
          ${icon("resolve")}<span class="a-th-sl">Resolved</span
          ><span class="a-th-who">${uname(first.author).split(" ")[0]}</span
          ><span class="a-th-snip trunc">${snippet(first.body)}</span
          ><span class="a-th-n tnum">${t.comments.length}</span>${icon("chevron", { cls: "chev" })}
        </button>
        <div class="disc ${open ? "open" : ""}">
          <div><div class="a-th-body">${body}</div></div>
        </div>
      </div>`);
    }
    function commentHtml(pr, t, c) {
      const hasSug = /```suggestion/.test(c.body);
      return html`<div class="a-cmt">
        <span class="a-cmt-av">${avatar(c.author, { size: 20 })}</span>
        <div class="a-cmt-b">
          <div class="a-cmt-h">
            <b>${uname(c.author)}</b
            ><span class="dim tnum">${ago(c.createdAt)}</span
            >${c.pending ? html`<span class="a-pend">Pending</span>` : html`<span class="a-evtools">${reactAdd(`c:${t.id}:${c.id}`)}</span>`}
          </div>
          <div class="md">
            ${markdown(c.body, { suggestionBase: t.lineText, suggestionLine: t.line })}
          </div>
          ${hasSug && isMine(pr) && !t.isResolved && pr.state === "open" ? html`<div class="a-sugg"><button class="btn sm" type="button" data-act="commit-sugg" data-thread="${t.id}">${icon("commit")}Commit suggestion</button></div>` : ""}
          ${c.pending ? "" : reactsHtml(c.reactions, `c:${t.id}:${c.id}`)}
        </div>
      </div>`;
    }
    function threadFoot(pr, t) {
      const draft = ui.replies.get(t.id) || "";
      if (pr.state !== "open") return "";
      return html`<div class="a-th-foot ${draft ? "has" : ""}">
        <div class="a-th-row">
          <textarea class="a-reply-ta" rows="1" data-reply="${t.id}" placeholder="Reply">
${draft}</textarea>
          <button
            class="btn sm ghost a-resolve"
            type="button"
            data-act="resolve"
            data-thread="${t.id}"
          >
            ${icon(t.isResolved ? "undo" : "resolve")}${t.isResolved ? "Unresolve" : "Resolve"}
          </button>
          <button
            class="a-agent"
            type="button"
            data-act="agent"
            data-what="thread"
            data-thread="${t.id}"
            data-tip="Ask an agent to address this thread"
          >
            ${icon("agent")}<span>Ask agent</span>
          </button>
        </div>
        <div class="a-grow-row">
          <div>
            <div class="a-reply-acts">
              <span class="a-sp"></span
              ><button
                class="btn sm ghost"
                type="button"
                data-act="reply-cancel"
                data-thread="${t.id}"
              >
                Cancel</button
              ><button class="btn sm pri" type="button" data-act="reply-send" data-thread="${t.id}">
                Reply<kbd>⌘↵</kbd>
              </button>
            </div>
          </div>
        </div>
      </div>`;
    }
    function pendingFoot(t) {
      return html`<div class="a-th-foot">
        <div class="a-th-row">
          <span class="a-hint">Sent when you submit your review</span><span class="a-sp"></span
          ><button
            class="btn sm ghost danger"
            type="button"
            data-act="pending-del"
            data-thread="${t.id}"
          >
            ${icon("trash")}Remove
          </button>
        </div>
      </div>`;
    }
    function composerHtml(d) {
      const pend = d.pendingReview?.comments?.length || 0;
      const c = ui.composer;
      const fresh = c.fresh;
      c.fresh = false;
      return String(html`<div class="a-lc ${fresh ? "a-grow-in" : ""}">
        <div>
          <div class="a-lc-in">
            <textarea
              class="a-lc-ta"
              rows="3"
              data-composer-ta
              placeholder="Comment on line ${c.side === "LEFT" ? "L" : "R"}${c.line}"
            >
${c.text || ""}</textarea>
            <div class="a-lc-acts">
              <button
                class="btn sm ghost"
                type="button"
                data-act="lc-suggest"
                data-tip="Insert a suggestion"
              >
                ${icon("file-diff")}Suggest
              </button>
              <span class="a-sp"></span>
              <button class="btn sm ghost" type="button" data-act="lc-cancel">Cancel</button>
              <button class="btn sm" type="button" data-act="lc-single">Comment now</button>
              <button class="btn sm pri" type="button" data-act="lc-review">
                ${pend ? "Add to review" : "Start a review"}<kbd>⌘↵</kbd>
              </button>
            </div>
          </div>
        </div>
      </div>`);
    }
    function refreshFile(path) {
      const p = ui.panes.get("files");
      const pr = cur();
      if (!p || !pr) return;
      const d = det(pr);
      const f = d.files.find((x) => x.path === path);
      const sec = p.querySelector(`.a-file[data-path="${CSS.escape(path)}"]`);
      if (!f || !sec) return;
      $(".a-fbody", sec).innerHTML = String(fileBody(pr, d, f, model.threadsFor(d, f.path)));
      const next = el(String(fileHtml(pr, d, f)));
      $(".a-fhd", sec).replaceWith($(".a-fhd", next));
      sec.classList.toggle("viewed", f.viewed);
    }
    function refreshTree() {
      const p = ui.panes.get("files");
      const pr = cur();
      if (!p || !pr) return;
      const tin = $(".a-tin", p);
      if (!tin) return;
      tin.innerHTML = String(
        html`<i class="a-tsel"></i>${treeHtml(det(pr), scopedFiles(det(pr)))}`,
      );
      ui.spy = null;
      spy(true);
    }
    function setFileOpen(path, open) {
      const p = ui.panes.get("files");
      if (open) {
        ui.collapsedFiles.delete(path);
        ui.forceOpen.add(path);
      } else {
        ui.collapsedFiles.add(path);
        ui.forceOpen.delete(path);
      }
      const sec = p?.querySelector(`.a-file[data-path="${CSS.escape(path)}"]`);
      if (!sec) return;
      $(":scope > .disc", sec).classList.toggle("open", open);
      const chev = $(".a-fchev", sec);
      chev.classList.toggle("open", open);
      chev.setAttribute("aria-expanded", S(open));
    }
    function toggleViewed(path, opts = {}) {
      const pr = cur();
      const d = det(pr);
      const f = d.files.find((x) => x.path === path);
      if (!f) return;
      f.viewed = !f.viewed;
      ui.collapsedFiles.delete(path);
      ui.forceOpen.delete(path);
      const p = ui.panes.get("files");
      const sec = p?.querySelector(`.a-file[data-path="${CSS.escape(path)}"]`);
      if (sec) {
        sec.classList.toggle("viewed", f.viewed);
        const b = $(".a-vchk", sec);
        b.classList.toggle("on", f.viewed);
        b.setAttribute("aria-pressed", S(f.viewed));
        b.dataset.tip = f.viewed ? "Mark as not viewed" : "Mark as viewed";
        $(":scope > .disc", sec).classList.toggle("open", fileOpen(f));
        const chev = $(".a-fchev", sec);
        chev.classList.toggle("open", fileOpen(f));
        chev.setAttribute("aria-expanded", S(fileOpen(f)));
      }
      const row = p?.querySelector(`.a-tf[data-path="${CSS.escape(path)}"]`);
      if (row) {
        row.classList.toggle("viewed", f.viewed);
        $(".a-tchk", row).classList.toggle("on", f.viewed);
      }
      const files = scopedFiles(d);
      const n = files.filter((x) => x.viewed).length;
      const prog = $(".a-vprog", root);
      if (prog) {
        $(".a-vbar i", prog).style.setProperty("--p", files.length ? n / files.length : 0);
        $(".tnum", prog).textContent = `${n}/${files.length}`;
      }
      if (opts.advance && f.viewed) {
        const next =
          files.slice(files.indexOf(f) + 1).find((x) => !x.viewed) || files.find((x) => !x.viewed);
        if (next) later(() => scrollToFile(next.path), ms("stack"));
        else toast("Every file is viewed", { tone: "ok" });
      }
    }
    function scrollToFile(path, opts = {}) {
      const p = ui.panes.get("files");
      const stream = p && $(".a-stream", p);
      const sec = stream?.querySelector(`.a-file[data-path="${CSS.escape(path)}"]`);
      if (!sec) return;
      const top =
        sec.getBoundingClientRect().top - stream.getBoundingClientRect().top + stream.scrollTop;
      stream.scrollTo({
        top: Math.max(0, top - 1),
        behavior: opts.smooth === false || L.reducedMotion() ? "auto" : "smooth",
      });
    }
    function onStreamScroll() {
      spy();
      hideSelBar();
    }
    function spy(instant) {
      const p = ui.panes.get("files");
      const stream = p && $(".a-stream", p);
      if (!stream) return;
      const line = stream.getBoundingClientRect().top + 48;
      let curPath = null;
      for (const sec of $$(".a-file", stream)) {
        if (sec.getBoundingClientRect().top <= line) curPath = sec.dataset.path;
        else break;
      }
      curPath ||= $(".a-file", stream)?.dataset.path || null;
      if (curPath === ui.spy && !instant) return;
      ui.spy = curPath;
      for (const r of $$(".a-tf", p)) r.classList.toggle("cur", r.dataset.path === curPath);
      placeTreeSel(instant);
    }
    function placeTreeSel(instant) {
      const p = ui.panes.get("files");
      const tsel = p && $(".a-tsel", p);
      if (!tsel) return;
      const row = ui.spy && p.querySelector(`.a-tf[data-path="${CSS.escape(ui.spy)}"]`);
      const tin = $(".a-tin", p);
      const r = row?.getBoundingClientRect();
      if (!r || r.height < 4) return tsel.classList.remove("on");
      const wasOn = tsel.classList.contains("on");
      if (instant || !wasOn) tsel.style.transition = "none";
      tsel.style.transform = `translateY(${Math.round(r.top - tin.getBoundingClientRect().top)}px)`;
      tsel.style.height = Math.round(r.height) + "px";
      tsel.classList.add("on");
      if (instant || !wasOn) {
        void tsel.offsetWidth;
        tsel.style.transition = "";
      }
    }
    function focusThread(id, opts = {}) {
      const pr = cur();
      if (!pr) return;
      const d = det(pr);
      const t = model.threadsFor(d).find((x) => x.id === id);
      if (!t) return;
      st.thread = id;
      st.file = t.path;
      if (t.isResolved) ui.openResolved.add(id);
      const f = d.files.find((x) => x.path === t.path);
      if (st.commit && f && !(f.commits || []).includes(st.commit)) st.commit = null;
      ui.collapsedFiles.delete(t.path);
      if (f?.viewed) ui.forceOpen.add(t.path);
      if (ui.panes.has("files")) rebuildPane("files");
      if (st.tab !== "files") showTab("files", { hash: false });
      paintTools();
      writeHash(opts.push ?? false);
      const go = () => {
        const p = ui.panes.get("files");
        const stream = p && $(".a-stream", p);
        const card = stream?.querySelector(`.a-th[data-thread="${CSS.escape(id)}"]`);
        if (!card) return;
        const top =
          card.getBoundingClientRect().top - stream.getBoundingClientRect().top + stream.scrollTop;
        stream.scrollTo({
          top: Math.max(0, top - stream.clientHeight * 0.32),
          behavior: opts.instant || L.reducedMotion() ? "auto" : "smooth",
        });
        card.classList.remove("a-flash");
        void card.offsetWidth;
        card.classList.add("a-flash");
      };
      raf2(go);
    }
    function threadOrder() {
      const pr = cur();
      const d = det(pr);
      const files = scopedFiles(d).map((f) => f.path);
      return d.threads
        .filter((t) => !t.isResolved && t.line != null)
        .sort((a, b) => files.indexOf(a.path) - files.indexOf(b.path) || a.line - b.line);
    }
    function stepThread(delta) {
      const list = threadOrder();
      if (!list.length) return toast("No unresolved threads", { tone: "ok" });
      const i = list.findIndex((t) => t.id === st.thread);
      const next = list[(i + delta + list.length) % list.length] || list[0];
      focusThread(next.id);
    }
    function openComposer(path, side, line, text = "") {
      const prevPath = ui.composer?.path;
      ui.composer = { path, side, line: Number(line), text, fresh: true };
      if (prevPath && prevPath !== path) refreshFile(prevPath);
      refreshFile(path);
      requestAnimationFrame(() => {
        const ta = $("[data-composer-ta]", ui.panes.get("files"));
        if (ta) {
          ta.focus();
          ta.setSelectionRange(ta.value.length, ta.value.length);
        }
      });
    }
    function lineTextOf(path, side, line) {
      const f = det(cur()).files.find((x) => x.path === path);
      const r =
        f &&
        rowsOf(f).find(
          (x) => (side === "LEFT" ? x.old : x.new) === Number(line) && x.kind !== "hunk",
        );
      return r ? r.text : "";
    }

    /* ------------------------------------------------------ checks */
    function checksHtml(pr, d) {
      const C = model.checks(d);
      if (!C.workflows.length && !C.statuses.length)
        return html`<div class="a-blank">
          ${checkGlyph("none", { size: 18, tip: false })}
          <p>${C.note || "No checks reported."}</p>
        </div>`;
      return html`<div class="a-ck">
        ${C.workflows.map((w) => wfHtml(pr, w))}
        ${
          C.statuses.length
            ? html`<section class="a-wf">
                <header class="a-wfh"><span class="a-wfn">Statuses</span></header>
                <ul class="a-jobs">
                  ${C.statuses.map(
                    (s) =>
                      html`<li class="a-job">
                        <a class="a-jh a-status" href="${s.url}" target="_blank" rel="noreferrer"
                          >${checkGlyph(s.state, { size: 14 })}<span class="a-jn">${s.name}</span
                          ><span class="dim trunc">${s.description}</span><span class="a-sp"></span
                          ><span class="dim tnum">${ago(s.at)}</span
                          >${icon("external", { cls: "a-ext" })}</a
                        >
                      </li>`,
                  )}
                </ul>
              </section>`
            : ""
        }
      </div>`;
    }
    function wfHtml(pr, w) {
      const k = runKind(w);
      return html`<section class="a-wf" data-wf="${w.id}">
        <header class="a-wfh">
          ${checkGlyph(w, { size: 14 })}<span class="a-wfn">${w.name}</span
          ><span class="a-wfm tnum"
            >${w.file} · #${w.runNumber}${w.attempt > 1 ? ` · attempt ${w.attempt}` : ""} ·
            ${k === "run" ? "running" : dur(w.durationSec)}</span
          ><span class="a-sp"></span
          ><button
            class="ib sm"
            type="button"
            data-act="wf-menu"
            data-wf="${w.id}"
            data-tip="Workflow"
          >
            ${icon("more")}
          </button>
        </header>
        <ul class="a-jobs">
          ${w.jobs.map((j) => jobHtml(pr, w, j))}
        </ul>
      </section>`;
    }
    function jobHtml(pr, w, j) {
      const k = runKind(j);
      const open = ui.openJobs.has(j.id);
      return html`<li class="a-job k-${k} ${open ? "open" : ""}" data-job="${j.id}">
        <div
          class="a-jh"
          data-act="job"
          data-job="${j.id}"
          role="button"
          tabindex="0"
          aria-expanded="${S(open)}"
        >
          ${icon("chevron", { cls: "chev" })}<span class="a-jg ${j._fresh ? "a-glyph-in" : ""}"
            >${checkGlyph(j, { size: 14, animate: !!j._fresh })}</span
          ><span class="a-jn">${j.name}</span
          >${j.required ? html`<span class="a-req">Required</span>` : ""}
          <span class="a-sp"></span>
          ${k === "fail" && pr.state === "open" ? html`<button class="a-agent" type="button" data-act="agent" data-what="fix-job" data-job="${j.id}" data-tip="Start an agent thread with this log">${icon("agent")}<span>Fix with agent</span></button>` : ""}
          <span class="a-jd tnum"
            >${k === "run" ? "Running" : k === "queued" ? "Queued" : dur(j.durationSec)}</span
          >
          ${pr.state === "open" ? html`<button class="ib sm a-rerun" type="button" data-act="rerun-job" data-job="${j.id}" data-tip="Re-run job" ${k === "run" || k === "queued" ? raw('aria-disabled="true"') : ""}>${icon("rerun")}</button>` : ""}
        </div>
        <div class="disc ${open ? "open" : ""}">
          <div>
            <ol class="a-steps">
              ${j.steps.map((s) => stepHtml(j, s))}
            </ol>
          </div>
        </div>
      </li>`;
    }
    function stepHtml(j, s) {
      const k = runKind(s);
      const key = `${j.id}:${s.n}`;
      const logStep =
        j.log?.length &&
        j.steps.find((x) => j.log[0]?.startsWith("$ ") && x.name === j.log[0].slice(2));
      const hasLog = logStep && logStep.n === s.n;
      const open =
        hasLog && (ui.openSteps.has(key) || (k === "fail" && !ui.openSteps.has(key + ":closed")));
      return html`<li class="a-step k-${k} ${open ? "open" : ""}">
        <div
          class="a-sh ${hasLog ? "has-log" : ""}"
          ${hasLog ? raw(`data-act="step" data-key="${key}" role="button" tabindex="0" aria-expanded="${open}"`) : ""}
        >
          ${hasLog ? icon("chevron", { cls: "chev" }) : raw('<span class="a-chev-sp"></span>')}${checkGlyph(s, { size: 12 })}<span
            class="a-sn tnum"
            >${s.n}</span
          ><span class="trunc">${s.name}</span><span class="a-sp"></span
          ><span class="tnum a-sd"
            >${k === "run" ? "…" : k === "queued" ? "" : dur(s.durationSec)}</span
          >
        </div>
        ${hasLog ? html`<div class="disc ${open ? "open" : ""}"><div>${logHtml(j.log)}</div></div>` : ""}
      </li>`;
    }
    function logHtml(lines) {
      const cls = (l) =>
        /^\$ /.test(l)
          ? "cmd"
          : /(##\[error\]|\bFAIL\b|×|AssertionError|error:|failed\b|exited with code [1-9])/.test(l)
            ? "err"
            : /^\s*[✓]|passed|successful|No fixes/.test(l)
              ? "ok"
              : "";
      return html`<div class="log a-log">
        ${lines.map((l) => {
          const safe = esc(l).replace(
            /((?:src|apps|packages)\/[\w./-]+\.\w+):(\d+)(?::\d+)?/g,
            (m, file, line) =>
              `<button class="a-loglink" type="button" data-act="log-link" data-file="${file}" data-line="${line}">${m}</button>`,
          );
          return raw(`<span class="log-l ${cls(l)}">${safe || " "}</span>`);
        })}
      </div>`;
    }
    function rerun(jobIds) {
      const pr = cur();
      const d = det(pr);
      const jobs = model.checks(d).jobs.filter((j) => jobIds.includes(j.id));
      if (!jobs.length) return;
      for (const jw of jobs) {
        const j = jw.workflow.jobs.find((x) => x.id === jw.id);
        j.status = "in_progress";
        j.conclusion = null;
        j._fresh = false;
        j.steps.forEach((s, i) => {
          s.status = i < 3 ? "completed" : i === 3 ? "in_progress" : "queued";
          s.conclusion = i < 3 ? "success" : null;
        });
        jw.workflow.attempt = (jw.workflow.attempt || 1) + 1;
        ui.openJobs.add(j.id);
      }
      recompute(pr);
      refreshAll({ checks: true });
      toast(
        jobs.length > 1 ? `Re-running ${plural(jobs.length, "job")}` : `Re-running ${jobs[0].name}`,
        { icon: "rerun" },
      );
      const prNum = pr.number;
      later(() => {
        for (const jw of jobs) {
          const j = jw.workflow.jobs.find((x) => x.id === jw.id);
          j.status = "completed";
          j.conclusion = "success";
          j._fresh = true;
          j.steps.forEach((s) => {
            s.status = "completed";
            s.conclusion = "success";
          });
          if (j.log?.length)
            j.log = [
              j.log[0],
              "",
              " ✓ all tests passed on re-run",
              "",
              " Test Files  212 passed (212)",
              "      Tests  1846 passed (1846)",
            ];
          ui.openJobs.delete(j.id);
        }
        const p = model.pr(prNum);
        const last = det(p).commits.at(-1);
        if (last) last.checks = "passing";
        recompute(p);
        if (st.pr === prNum) refreshAll({ checks: true, commits: true });
        else renderList();
        for (const jw of jobs) jw.workflow.jobs.find((x) => x.id === jw.id)._fresh = false;
      }, 2600);
    }

    /* ------------------------------------------------------ commits */
    function commitsHtml(pr, d) {
      if (!d.commits.length)
        return html`<div class="a-blank">
          ${icon("commit")}
          <p>
            ${d.synthetic ? "This pull request is only mocked at summary level." : "No commits."}
          </p>
        </div>`;
      const items = [
        ...d.commits.map((c) => ({ at: c.committedAt, c })),
        ...d.timeline.filter((e) => e.kind === "force_pushed").map((e) => ({ at: e.at, fp: e })),
      ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || (a.fp ? -1 : 1));
      let day = "";
      const out = [];
      for (const it of items) {
        const dd = fmtDate(it.at, { time: false });
        if (dd !== day) {
          day = dd;
          out.push(html`<li class="a-cday">${dd}</li>`);
        }
        if (it.fp)
          out.push(
            html`<li class="a-cfp">
              ${icon("branch")}<span>Force-pushed${it.fp.note ? ` · ${it.fp.note}` : ""}</span
              ><code class="a-sha">${it.fp.before.slice(0, 7)}</code>→<code class="a-sha"
                >${it.fp.after.slice(0, 7)}</code
              ><span class="a-sp"></span><span class="dim tnum">${ago(it.at)}</span>
            </li>`,
          );
        else {
          const c = it.c;
          out.push(html`<li
            class="a-ci ${st.commit === c.short ? "on" : ""}"
            data-act="goto-commit"
            data-sha="${c.short}"
            role="button"
            tabindex="0"
          >
            <span class="a-cdot"></span>
            <span class="a-cmsg trunc">${c.message}</span>
            <span class="a-cmeta"
              >${checkGlyph(c.checks, { size: 12 })}<code class="a-sha">${c.short}</code
              >${avatar(c.author, { size: 16 })}<span class="dim tnum a-cago"
                >${ago(c.committedAt)}</span
              ><span class="a-cgo">${icon("arrow-right")}</span></span
            >
          </li>`);
        }
      }
      return html`<div class="a-cm">
        <ol class="a-crail">
          ${out}
        </ol>
      </div>`;
    }
    function setScope(sha) {
      st.commit = sha;
      ui.composer = null;
      if (st.tab !== "files") showTab("files", { hash: false });
      rebuildPane("files");
      paintTools();
      writeHash(false);
      const p = ui.panes.get("files");
      const s = p && $(".a-stream", p);
      if (s) s.scrollTop = 0;
      raf2(() => spy(true));
    }

    /* ------------------------------------------------------ mutations */
    async function doMerge(opts = {}) {
      const pr = cur();
      const method = METHODS.find((m) => m.key === ui.method);
      const ok = await confirm({
        title: opts.bypass
          ? `Bypass rules and merge #${pr.number}?`
          : `${method.label} #${pr.number}?`,
        body: raw(
          esc(`Lands ${pr.headRefName} on ${pr.baseRefName}`) +
            (opts.bypass
              ? `. <b>${esc(
                  model
                    .blockers(pr)
                    .map((b) => b.label)
                    .join(", "),
                )}</b> will be ignored.`
              : ". The branch is deleted afterwards."),
        ),
        confirmLabel: opts.bypass ? "Bypass and merge" : method.label,
        tone: opts.bypass ? "danger" : "ok",
      });
      if (!ok) return;
      landPRs([pr]);
      toast(`Merged #${pr.number} into ${pr.baseRefName}`, { tone: "ok" });
    }
    function landPRs(list) {
      const base = list[0].stack ? model.stackOf(list[0]).baseRefName : list[0].baseRefName;
      for (const p of list) {
        p.state = "merged";
        p.mergedAt = nowIso();
        p.mergedBy = viewer;
        p.branchDeleted = true;
        p.autoMerge = null;
        addEvent(p, { kind: "merged", base: p.stack ? base : p.baseRefName });
      }
      const s = list[0].stack && data.stacks.find((x) => x.id === list[0].stack.id);
      if (s) {
        const top = Math.max(...list.map((p) => p.stack.position));
        const above = s.entries.map((n) => model.pr(n)).find((p) => p.stack.position === top + 1);
        if (above && above.state === "open") {
          addEvent(above, { kind: "base_changed", from: above.baseRefName, to: base });
          above.baseRefName = base;
        }
      }
      refreshAll({ flip: true, timeline: true, checks: true });
    }
    async function mergeStack(n) {
      const pr = model.pr(n);
      const plan = model.mergePlan(n);
      if (plan.blockedBy)
        return toast(`#${plan.blockedBy.pr.number}: ${plan.blockedBy.reason}`, { tone: "err" });
      const s = model.stackOf(pr);
      const ok = await confirm({
        title: `Merge ${plural(plan.layers.length, "pull request")} into ${s.baseRefName}?`,
        body: raw(
          `${plan.layers.map((p) => `<b>#${p.number}</b>`).join(", ")} land together. Layers above #${n} stay open and GitHub retargets them onto <code>${esc(s.baseRefName)}</code>.`,
        ),
        confirmLabel: plan.label,
        tone: "ok",
      });
      if (!ok) return;
      landPRs(plan.layers);
      toast(`Merged ${plural(plan.layers.length, "layer")} into ${s.baseRefName}`, { tone: "ok" });
    }
    function setAutoMerge(on) {
      const pr = cur();
      pr.autoMerge = on ? { method: ui.method, enabledBy: viewer, enabledAt: nowIso() } : null;
      addEvent(pr, { kind: "auto_merge", on, method: ui.method });
      refreshAll({ timeline: true });
      toast(on ? "Auto-merge on · merges once requirements pass" : "Auto-merge off");
    }
    function updateBranch() {
      const pr = cur();
      const btn = $('.a-mb [data-act="next"]', root);
      if (btn) {
        btn.setAttribute("aria-disabled", "true");
        $("span", btn).textContent = "Updating…";
      }
      later(() => {
        pr.behindBy = 0;
        recompute(pr);
        addEvent(pr, { kind: "branch_updated" });
        if (st.pr === pr.number) refreshAll({ timeline: true });
        toast(`Updated ${pr.headRefName}`, { tone: "ok" });
      }, 900);
    }
    function setDraft(draft) {
      const pr = cur();
      pr.isDraft = draft;
      if (!draft && pr.reviewDecision == null) pr.reviewDecision = "review_required";
      addEvent(pr, { kind: draft ? "converted_to_draft" : "ready_for_review" });
      recompute(pr);
      refreshAll({ timeline: true, flip: true });
    }
    async function closePR() {
      const pr = cur();
      const ok = await confirm({
        title: `Close #${pr.number}?`,
        body: "It stays on GitHub and can be reopened.",
        confirmLabel: "Close pull request",
        tone: "danger",
      });
      if (!ok) return;
      pr.state = "closed";
      pr.closedAt = nowIso();
      addEvent(pr, { kind: "closed" });
      refreshAll({ timeline: true, flip: true });
    }
    function reopenPR() {
      const pr = cur();
      pr.state = "open";
      pr.closedAt = null;
      addEvent(pr, { kind: "reopened" });
      recompute(pr);
      refreshAll({ timeline: true, flip: true });
    }
    function runNext(btn) {
      const pr = cur();
      const na = model.nextAction(pr);
      const d = det(pr);
      switch (na.key) {
        case "review":
          if (d.pendingReview?.comments?.length)
            return openReview($('[data-act="review"]', root) || btn);
          showTab("files");
          return void raf2(() => {
            const first = scopedFiles(d).find((f) => !f.viewed);
            if (first) scrollToFile(first.path);
          });
        case "merge":
          return void doMerge();
        case "merge-stack":
          return void mergeStack(pr.number);
        case "update-branch":
          return updateBranch();
        case "fix-checks":
          return gotoChecks();
        case "resolve-conflicts":
          return menu.open(
            btn,
            [
              {
                label: "Resolve with an agent",
                sub: "Check out in a worktree and start a thread",
                icon: "agent",
                run: () => agent("resolve-conflicts"),
              },
              {
                label: "Resolve on GitHub",
                icon: "external",
                run: () => toast("Opens the web editor on GitHub"),
              },
              {
                label: "Copy checkout command",
                icon: "terminal",
                run: () => L.copy(`gh pr checkout ${pr.number}`, "checkout command"),
              },
            ],
            { align: "start", minWidth: 260 },
          );
        case "address-review": {
          const list = threadOrder();
          return list.length ? focusThread(list[0].id) : showTab("conversation");
        }
        case "mark-ready":
          return setDraft(false);
        case "auto-merge":
          return setAutoMerge(false);
        case "wait-checks":
          return setAutoMerge(true);
        case "blocked-by-stack":
          return selectPR(Number(na.label.replace(/\D+/g, "")), { keepStack: true });
        case "await-review":
          return isMine(pr)
            ? pickReviewers($('[data-act="pick-reviewers"]', root) || btn)
            : setAutoMerge(true);
        case "draft":
          return showTab("files");
        case "merged":
          if (pr.branchDeleted) return toast("Opens a revert pull request on GitHub");
          pr.branchDeleted = true;
          refreshFacts(["merge"]);
          return toast(`Deleted ${pr.headRefName}`, {
            action: {
              label: "Restore",
              run: () => ((pr.branchDeleted = false), refreshFacts(["merge"])),
            },
          });
        case "closed":
          return reopenPR();
      }
    }
    function gotoChecks() {
      const pr = cur();
      const C = model.checks(det(pr));
      const j = C.failing[0] || C.running[0];
      if (j) {
        ui.openJobs.add(j.id);
        st.job = j.id;
      }
      if (ui.panes.has("checks")) rebuildPane("checks");
      showTab("checks");
      if (j) raf2(() => scrollToJob(j.id));
    }
    function scrollToJob(id) {
      const p = ui.panes.get("checks");
      const job = p?.querySelector(`.a-job[data-job="${CSS.escape(id)}"]`);
      if (!job) return;
      const top = job.getBoundingClientRect().top - p.getBoundingClientRect().top + p.scrollTop;
      if (top >= p.scrollTop && top + 40 <= p.scrollTop + p.clientHeight * 0.45) return;
      const wf = job.closest(".a-wf");
      const wfTop = wf.getBoundingClientRect().top - p.getBoundingClientRect().top + p.scrollTop;
      const target =
        top + Math.min(job.offsetHeight, p.clientHeight * 0.7) - wfTop < p.clientHeight - 40
          ? wfTop - 8
          : top - 1;
      p.scrollTo({ top: Math.max(0, target), behavior: L.reducedMotion() ? "auto" : "smooth" });
    }
    function mergeMenuItems(pr) {
      if (pr.state === "merged")
        return [
          {
            label: "Revert",
            sub: "Open a pull request that undoes this one",
            icon: "undo",
            run: () => toast("Opens a revert pull request on GitHub"),
          },
          pr.branchDeleted
            ? {
                label: "Restore branch",
                icon: "branch",
                run: () => (
                  (pr.branchDeleted = false),
                  refreshFacts(["merge"]),
                  toast(`Restored ${pr.headRefName}`)
                ),
              }
            : {
                label: "Delete branch",
                icon: "trash",
                danger: true,
                run: () => ((pr.branchDeleted = true), refreshFacts(["merge"])),
              },
        ];
      if (pr.state === "closed")
        return [{ label: "Reopen pull request", icon: "pr-open", run: reopenPR }];
      const blockers = model.blockers(pr);
      const canMerge = !blockers.length;
      const method = METHODS.find((m) => m.key === ui.method);
      const plan = pr.stack && pr.stack.position > 1 ? model.mergePlan(pr.number) : null;
      const items = [{ head: "Merge method" }];
      for (const m of METHODS)
        items.push({
          label: m.label,
          sub: m.sub,
          checked: ui.method === m.key,
          disabled: !repo.mergeMethods[m.key],
          reason: `Not allowed in ${repo.nameWithOwner}`,
          run: () => {
            ui.method = m.key;
            refreshFacts(["merge"]);
          },
        });
      items.push({ sep: true });
      if (canMerge) items.push({ label: method.label, icon: "merge", run: () => doMerge() });
      else if (repo.viewerPermission === "admin")
        items.push({
          label: "Bypass rules and merge",
          sub: blockers[0].label,
          icon: "lock",
          danger: true,
          run: () => doMerge({ bypass: true }),
        });
      if (plan)
        items.push({
          label: `Merge stack through #${pr.number} (${plan.layers.length})`,
          sub: plan.blockedBy
            ? `#${plan.blockedBy.pr.number} · ${plan.blockedBy.reason}`
            : `Lands ${plan.layers.map((p) => "#" + p.number).join(", ")}`,
          icon: "stack",
          disabled: !!plan.blockedBy,
          reason: plan.blockedBy ? `Blocked by #${plan.blockedBy.pr.number}` : null,
          run: () => mergeStack(pr.number),
        });
      items.push(
        pr.autoMerge
          ? { label: "Cancel auto-merge", icon: "x", run: () => setAutoMerge(false) }
          : {
              label: "Merge when ready",
              sub: "Auto-merge once requirements pass",
              icon: "clock",
              disabled: canMerge || pr.isDraft || !repo.autoMergeAllowed,
              reason: canMerge ? "Already mergeable" : "Drafts can't auto-merge",
              run: () => setAutoMerge(true),
            },
        {
          label: "Update branch",
          sub: pr.behindBy ? `${plural(pr.behindBy, "commit")} behind ${pr.baseRefName}` : null,
          icon: "update-branch",
          disabled: !pr.behindBy,
          reason: `Up to date with ${pr.baseRefName}`,
          run: updateBranch,
        },
        { sep: true },
        pr.isDraft
          ? { label: "Ready for review", icon: "eye", run: () => setDraft(false) }
          : { label: "Convert to draft", icon: "pr-draft", run: () => setDraft(true) },
        { label: "Close pull request", icon: "pr-closed", danger: true, run: closePR },
      );
      return items;
    }
    function openMergeMenu(anchor) {
      const pr = cur();
      if (!pr || !anchor) return;
      if (menu.isOpen()) {
        menu.close();
        return;
      }
      st.merge = true;
      writeHash(false);
      menu.open(anchor, mergeMenuItems(pr), {
        align: "end",
        minWidth: 280,
        onClose: () => {
          st.merge = false;
          writeHash(false);
        },
      });
    }
    function submitReview(kind, body) {
      const pr = cur();
      const d = det(pr);
      const pend = d.pendingReview?.comments || [];
      const ids = [];
      for (const c of pend) {
        const id = `${pr.number}-t${++seq + 50}`;
        ids.push(id);
        d.threads.push({
          id,
          path: c.path,
          side: c.side,
          line: c.line,
          lineText: c.lineText,
          diffHunk: c.diffHunk,
          isResolved: false,
          isOutdated: false,
          comments: [
            { id: id + "-c", author: viewer, createdAt: nowIso(), body: c.body, reactions: [] },
          ],
        });
      }
      d.pendingReview = null;
      addEvent(pr, { kind: "review", state: kind, body, threadIds: ids });
      const r = pr.reviewers.find((x) => x.login === viewer);
      if (r) Object.assign(r, { state: kind, submittedAt: nowIso() });
      else if (!isMine(pr))
        pr.reviewers.push({ login: viewer, state: kind, submittedAt: nowIso() });
      if (pr.involvement === "review-requested") pr.involvement = "reviewed";
      recompute(pr);
      refreshAll({ flip: true, timeline: true, files: true });
      toast(
        {
          approved: "Approved",
          changes_requested: "Requested changes",
          commented: "Review submitted",
        }[kind] + ` on #${pr.number}`,
        { tone: "ok" },
      );
    }
    function agent(what, ctx = {}) {
      const pr = cur();
      const d = det(pr);
      const titles = {
        "fix-checks": () => `Fix ${model.checks(d).failing[0]?.name || "failing checks"}`,
        "fix-job": () =>
          `Fix ${model.checks(d).jobs.find((j) => j.id === ctx.job)?.name || "the failing job"}`,
        "resolve-conflicts": () => `Resolve conflicts with ${pr.baseRefName}`,
        thread: () => {
          const t = d.threads.find((x) => x.id === ctx.thread);
          return t
            ? `Address ${uname(t.comments[0].author).split(" ")[0]}'s note in ${splitPath(t.path)[1]}`
            : "Address a review thread";
        },
        ask: () => ctx.text || `Question about #${pr.number}`,
        selection: () =>
          `Explain ${ctx.text ? `“${ctx.text.slice(0, 28)}${ctx.text.length > 28 ? "…" : ""}”` : "the selection"}`,
      };
      const t = {
        id: `ag${++seq}`,
        title: (titles[what] || titles.ask)(),
        state: "working",
        provider: "claude",
        fresh: true,
      };
      (d.linkedThreads ||= []).unshift(t);
      if (st.tab === "conversation") refreshFacts(["linked"]);
      else if (ui.panes.has("conversation")) refreshFacts(["linked"]);
      toast(`Started “${t.title}”`, {
        icon: "agent",
        action:
          st.tab !== "conversation" ? { label: "View", run: () => showTab("conversation") } : null,
      });
      const prNum = pr.number;
      later(() => {
        t.fresh = false;
        t.state = "done";
        t.justDone = true;
        t.result = what === "ask" || what === "selection" ? "Answered" : "2 files changed";
        if (st.pr === prNum) refreshFacts(["linked"]);
        t.justDone = false;
      }, 5200);
      later(() => (t.fresh = false), 400);
    }

    /* ------------------------------------------------------ popovers */
    function wirePop(node) {
      node.addEventListener("click", (e) => {
        const a = e.target.closest("[data-act]");
        if (a && node.contains(a)) act(a.dataset.act, a, e);
      });
      return node;
    }
    function openReview(anchor) {
      const pr = cur();
      if (!pr || pr.state !== "open" || !anchor) return;
      const d = det(pr);
      const mine = isMine(pr);
      let kind = "commented";
      st.review = true;
      writeHash(false);
      const api = popover.open(
        anchor,
        () => {
          const pend = d.pendingReview?.comments?.length || 0;
          const opt = (k, label, sub, disabled) =>
            `<button class="a-rv-o" type="button" role="radio" data-k="${k}" aria-checked="${k === kind}" ${disabled ? `aria-disabled="true" data-tip="${esc(disabled)}"` : ""}><span class="a-radio"></span><span class="a-rv-t"><b>${esc(label)}</b><span>${esc(sub)}</span></span></button>`;
          const node = el(`<div class="a-rv">
            <div class="a-rv-h"><b>${mine ? "Comment on your changes" : "Finish your review"}</b>${pend ? `<span class="tnum">${esc(plural(pend, "pending comment"))}</span>` : ""}</div>
            <textarea class="input a-rv-ta" rows="3" placeholder="Summary (optional)"></textarea>
            <div class="a-rv-os" role="radiogroup" aria-label="Verdict">
              ${opt("commented", "Comment", "Feedback without a verdict")}
              ${opt("approved", "Approve", "Good to merge from your side", mine && "You can't approve your own pull request")}
              ${opt("changes_requested", "Request changes", "Must be addressed before merging", mine && "You can't request changes on your own pull request")}
            </div>
            <div class="a-rv-f">${pend ? `<button class="btn sm ghost danger" type="button" data-rv="discard">Discard</button>` : ""}<span class="a-sp"></span><button class="btn sm pri" type="button" data-rv="submit">Submit review<kbd>⌘↵</kbd></button></div>
          </div>`);
          const ta = $(".a-rv-ta", node);
          const submit = () => {
            if (kind === "commented" && !ta.value.trim() && !pend) {
              ta.focus();
              ta.classList.add("a-shake");
              setTimeout(() => ta.classList.remove("a-shake"), 400);
              return;
            }
            popover.close();
            submitReview(kind, ta.value.trim());
          };
          node.addEventListener("click", async (e) => {
            const o = e.target.closest(".a-rv-o");
            if (o && o.getAttribute("aria-disabled") !== "true") {
              kind = o.dataset.k;
              for (const b of $$(".a-rv-o", node)) b.setAttribute("aria-checked", S(b === o));
            }
            const b = e.target.closest("[data-rv]");
            if (b?.dataset.rv === "submit") submit();
            if (b?.dataset.rv === "discard") {
              popover.close();
              const ok = await confirm({
                title: "Discard your pending review?",
                body: `${plural(pend, "comment")} will be deleted.`,
                confirmLabel: "Discard",
                tone: "danger",
              });
              if (ok) {
                d.pendingReview = null;
                refreshAll({ files: true });
              }
            }
          });
          node.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit();
            }
          });
          return node;
        },
        {
          side: "bottom",
          align: "end",
          width: 340,
          cls: "a-pop",
          onClose: () => ((st.review = false), writeHash(false)),
        },
      );
      if (!api) return;
      requestAnimationFrame(() => $(".a-rv-ta", api.el)?.focus({ preventScroll: true }));
    }
    function railInView() {
      const p = ui.panes.get("conversation");
      if (st.tab !== "conversation" || !p) return false;
      const sec = $('[data-sec="stack"]', p);
      if (!sec) return false;
      const r = sec.getBoundingClientRect();
      const b = p.getBoundingClientRect();
      return r.bottom > b.top + 30 && r.top < b.bottom - 60;
    }
    function toggleStack(force, opts = {}) {
      const pr = cur();
      if (!pr?.stack) return;
      const next = force ?? !st.stack;
      st.stack = next;
      $(".a-stkchip", root)?.setAttribute("aria-expanded", S(next));
      const p = ui.panes.get("conversation");
      const sec = p && $('[data-sec="stack"]', p);
      if (sec) {
        sec.classList.toggle("x", next);
        for (const dsc of $$(".a-layer > .disc", sec)) dsc.classList.toggle("open", next);
        const b = $(".a-sx", sec);
        if (b) {
          b.setAttribute("aria-expanded", S(next));
          b.dataset.tip = next ? "Fewer details" : "Layer details";
        }
      }
      if (next && !(opts.inPlace ?? railInView())) openStackPop();
      else if (!next) popover.close();
      else if (sec && opts.reveal)
        sec.scrollIntoView({ block: "nearest", behavior: L.reducedMotion() ? "auto" : "smooth" });
      writeHash(false);
    }
    function openStackPop() {
      const anchor = $(".a-stkchip", root);
      if (!anchor) return;
      const api = popover.open(
        anchor,
        () => wirePop(el(`<div class="a-stackpop">${secStack(cur(), true)}</div>`)),
        {
          side: "bottom",
          align: "start",
          width: 380,
          cls: "a-pop",
          onClose: () => {
            if (st.stack && !railInView()) {
              st.stack = false;
              $(".a-stkchip", root)?.setAttribute("aria-expanded", "false");
              writeHash(false);
            }
          },
        },
      );
      return api;
    }
    function openAsk(anchor) {
      const pr = cur();
      const sugg = [
        "What's left before this can merge?",
        pr.checks.state === "failing"
          ? `Why is ${model.checks(det(pr)).failing[0]?.name || "CI"} failing?`
          : "Summarize the changes",
        "Summarize the review feedback",
      ];
      popover.open(
        anchor,
        () => {
          const node = el(`<div class="a-ask">
            <textarea class="a-ask-ta" rows="2" placeholder="Ask about #${pr.number}"></textarea>
            <div class="a-ask-s">${sugg.map((s) => `<button class="chip" type="button" data-s="${esc(s)}">${esc(s)}</button>`).join("")}</div>
            <div class="a-ask-f"><span class="a-hint">Starts a thread on ${esc(pr.headRefName)}</span><span class="a-sp"></span><button class="btn sm pri" type="button" data-go>Ask<kbd>⌘↵</kbd></button></div>
          </div>`);
          const ta = $("textarea", node);
          const go = (text) => {
            if (!text.trim()) return ta.focus();
            popover.close();
            agent("ask", { text: text.trim() });
          };
          node.addEventListener("click", (e) => {
            const s = e.target.closest("[data-s]");
            if (s) go(s.dataset.s);
            if (e.target.closest("[data-go]")) go(ta.value);
          });
          ta.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              go(ta.value);
            }
          });
          requestAnimationFrame(() => ta.focus());
          return node;
        },
        { side: "bottom", align: "end", width: 340, cls: "a-pop" },
      );
    }
    function openPicker(anchor, cfg) {
      let q = "";
      popover.open(
        anchor,
        (api) => {
          const node = el(
            `<div class="a-pick"><div class="a-pick-h">${esc(cfg.title)}</div><label class="a-pick-q">${icon("search")}<input type="text" placeholder="Filter" spellcheck="false" /></label><div class="a-pick-l scroll"></div></div>`,
          );
          const list = $(".a-pick-l", node);
          const paint = () => {
            const items = cfg
              .items()
              .filter(
                (it) => !q || `${it.key} ${it.label} ${it.sub || ""}`.toLowerCase().includes(q),
              );
            list.innerHTML = items.length
              ? items
                  .map(
                    (it) =>
                      `<button class="a-pick-i ${it.on ? "on" : ""}" type="button" data-k="${esc(it.key)}" role="menuitemcheckbox" aria-checked="${!!it.on}"><span class="a-pick-c">${CHECK_SVG}</span>${String(it.lead || "")}<span class="a-pick-t"><span>${esc(it.label)}</span>${it.sub ? `<span class="a-pick-s">${esc(it.sub)}</span>` : ""}</span></button>`,
                  )
                  .join("")
              : `<div class="a-pick-none">No matches</div>`;
          };
          paint();
          $("input", node).addEventListener("input", (e) => {
            q = e.target.value.trim().toLowerCase();
            paint();
          });
          list.addEventListener("click", (e) => {
            const b = e.target.closest(".a-pick-i");
            if (!b) return;
            cfg.toggle(b.dataset.k);
            paint();
            api.reposition();
          });
          requestAnimationFrame(() => $("input", node).focus());
          return node;
        },
        { side: "bottom", align: "end", width: 280, cls: "a-pop", onClose: cfg.onClose },
      );
    }
    function pickReviewers(anchor) {
      const pr = cur();
      const candidates = [
        ...Object.keys(data.users).filter((l) => !data.users[l].bot && l !== pr.author),
        ...Object.keys(data.teams),
      ];
      openPicker(anchor, {
        title: "Request reviews",
        items: () =>
          candidates.map((l) => {
            const u = model.user(l);
            const r = pr.reviewers.find((x) => x.login === l);
            return {
              key: l,
              label: u.team ? "@" + l : u.name || l,
              sub: u.team ? `${data.teams[l].members.length} members` : "@" + l,
              on: !!r,
              lead: avatar(l, { size: 18, tip: false }),
            };
          }),
        toggle: (l) => {
          const i = pr.reviewers.findIndex((x) => x.login === l);
          if (i >= 0) pr.reviewers.splice(i, 1);
          else {
            pr.reviewers.push({ login: l, state: "pending", submittedAt: null });
            addEvent(pr, { kind: "review_requested", reviewer: l });
          }
          recompute(pr);
          refreshFacts(["merge", "reviewers"]);
          renderList();
        },
        onClose: () => refreshTimeline(),
      });
    }
    function pickAssignees(anchor) {
      const pr = cur();
      openPicker(anchor, {
        title: "Assign",
        items: () =>
          Object.keys(data.users)
            .filter((l) => !data.users[l].bot)
            .map((l) => ({
              key: l,
              label: uname(l),
              sub: l === viewer ? "You" : "@" + l,
              on: pr.assignees.includes(l),
              lead: avatar(l, { size: 18, tip: false }),
            })),
        toggle: (l) => {
          const i = pr.assignees.indexOf(l);
          if (i >= 0) pr.assignees.splice(i, 1);
          else {
            pr.assignees.push(l);
            addEvent(pr, { kind: "assigned", assignee: l });
          }
          refreshFacts(["assignees"]);
        },
        onClose: () => refreshTimeline(),
      });
    }
    function pickLabels(anchor, opts = {}) {
      const pr = cur();
      const f = filters();
      openPicker(anchor, {
        title: opts.filter ? "Filter by label" : "Labels",
        items: () =>
          Object.values(data.labels).map((l) => ({
            key: l.name,
            label: l.name,
            sub: l.description,
            on: opts.filter ? f.labels.includes(l.name) : pr.labels.includes(l.name),
            lead: raw(`<span class="a-ldot" style="--lc:#${l.color}"></span>`),
          })),
        toggle: (name) => {
          if (opts.filter) {
            const i = f.labels.indexOf(name);
            if (i >= 0) f.labels.splice(i, 1);
            else f.labels.push(name);
            setFilters(f);
            afterFilter();
            return;
          }
          const i = pr.labels.indexOf(name);
          if (i >= 0) pr.labels.splice(i, 1);
          else {
            pr.labels.push(name);
            addEvent(pr, { kind: "labeled", label: name });
          }
          refreshFacts(["labels"]);
        },
        onClose: () => !opts.filter && refreshTimeline(),
      });
    }
    function openFilterMenu(anchor) {
      const f = filters();
      const set = (patch) => () => {
        Object.assign(f, patch);
        setFilters(f);
        afterFilter(true);
      };
      const states = [
        ["open", "Open"],
        ["draft", "Drafts"],
        ["merged", "Merged"],
        ["closed", "Closed"],
        ["all", "All"],
      ];
      menu.open(
        anchor,
        [
          { head: "State" },
          ...states.map(([k, label]) => ({
            label,
            checked: f.state === k,
            run: set({ state: k }),
          })),
          { sep: true },
          {
            label: "Needs your review only",
            checked: st.group === "review",
            run: () => ((st.group = st.group === "review" ? null : "review"), afterFilter(true)),
          },
          { label: "Failing checks", checked: f.failing, run: set({ failing: !f.failing }) },
          {
            label: "Labels…",
            icon: "tag",
            sub: f.labels.length ? f.labels.join(", ") : null,
            run: () => pickLabels(anchor, { filter: true }),
          },
          { sep: true },
          { head: "Sort" },
          {
            label: "Readiness",
            sub: "What can move next comes first",
            checked: f.sort === "ready",
            run: set({ sort: "ready" }),
          },
          {
            label: "Recently updated",
            checked: f.sort === "updated",
            run: set({ sort: "updated" }),
          },
        ],
        { align: "end", minWidth: 230 },
      );
    }
    function openMore(anchor) {
      const pr = cur();
      menu.open(
        anchor,
        [
          {
            label: "Copy link",
            icon: "link",
            kbd: "⇧⌘C",
            run: () => L.copy(pr.url || `${repo.url}/pull/${pr.number}`, "link"),
          },
          {
            label: "Copy branch name",
            icon: "branch",
            run: () => L.copy(pr.headRefName, "branch name"),
          },
          {
            label: "Check out in a worktree",
            icon: "terminal",
            run: () => toast(`Checking out ${pr.headRefName}…`, { icon: "terminal" }),
          },
          { sep: true },
          ...(isMine(pr) && pr.state === "open"
            ? [
                { label: "Edit title", icon: "edit", run: editTitle },
                pr.isDraft
                  ? { label: "Ready for review", icon: "eye", run: () => setDraft(false) }
                  : { label: "Convert to draft", icon: "pr-draft", run: () => setDraft(true) },
              ]
            : []),
          pr.state === "open"
            ? { label: "Close pull request", icon: "pr-closed", danger: true, run: closePR }
            : pr.state === "closed"
              ? { label: "Reopen", icon: "pr-open", run: reopenPR }
              : null,
          { sep: true },
          { label: "Keyboard shortcuts", icon: "keyboard", kbd: "?", run: () => openKeys(anchor) },
        ].filter(Boolean),
        { align: "end", minWidth: 230 },
      );
    }
    function openKeys(anchor) {
      const keys = [
        [["J", "K"], "Next / previous pull request"],
        [["/"], "Search, or paste a link"],
        [["1", "4"], "Conversation · Files · Checks · Commits"],
        [["M"], "Merge options"],
        [["R"], "Submit review"],
        [["S"], "Stack layers"],
        [["[", "]"], "Layer below / above"],
        [["N", "P"], "Next / previous open thread"],
        [["V"], "Mark file viewed, go to next"],
        [["F"], "Toggle file tree"],
        [["U"], "Unified / split"],
        [["C"], "Scope to a commit"],
        [["\\"], "Show / hide the list"],
      ];
      popover.open(
        anchor || $('[data-act="more"]', root),
        raw(
          `<div class="a-keys-pop"><div class="a-pick-h">Keyboard</div><ul>${keys.map(([k, l]) => `<li><span>${k.map((x) => `<kbd>${esc(x)}</kbd>`).join("")}</span><span>${esc(l)}</span></li>`).join("")}</ul></div>`,
        ),
        { side: "bottom", align: "end", width: 300, cls: "a-pop" },
      );
    }
    function editTitle() {
      const pr = cur();
      if (st.tab !== "conversation") showTab("conversation");
      const p = ui.panes.get("conversation");
      p.scrollTop = 0;
      const h1 = $(".a-h1", p);
      h1.contentEditable = "plaintext-only";
      h1.classList.add("editing");
      h1.focus();
      getSelection().selectAllChildren(h1);
      const done = (save) => {
        h1.contentEditable = "false";
        h1.classList.remove("editing");
        h1.removeEventListener("keydown", onKey);
        h1.removeEventListener("blur", onBlur);
        const v = h1.textContent.trim();
        if (save && v && v !== pr.title) {
          addEvent(pr, { kind: "renamed", from: pr.title, to: v });
          pr.title = v;
          refreshAll({ timeline: true });
        } else h1.textContent = pr.title;
      };
      const onKey = (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          done(true);
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          done(false);
        }
      };
      const onBlur = () => done(true);
      h1.addEventListener("keydown", onKey);
      h1.addEventListener("blur", onBlur);
    }

    /* ------------------------------------------------------ selection toolbar (diff) */
    const selBar = h("div", { class: "a-selbar" });
    document.body.append(selBar);
    let selCtx = null;
    function hideSelBar() {
      selBar.classList.remove("on");
      selCtx = null;
    }
    function maybeSelBar() {
      const s = getSelection();
      const p = ui.panes.get("files");
      if (!s || s.isCollapsed || !p || st.tab !== "files") return hideSelBar();
      const text = s.toString().trim();
      const node = s.focusNode?.nodeType === 1 ? s.focusNode : s.focusNode?.parentElement;
      const cell = node?.closest?.(".d-code");
      if (!text || !cell || !p.contains(cell)) return hideSelBar();
      const tr = cell.closest("tr");
      const side = cell.dataset.side || tr.dataset.side;
      const line = cell.dataset.line || tr.dataset.line;
      const path = cell.closest("table.diff")?.dataset.path;
      const r = s.getRangeAt(0).getBoundingClientRect();
      selCtx = { text, side, line, path };
      const pr = cur();
      selBar.innerHTML = String(
        html`${pr.state === "open" && !st.commit && line && line !== "null" ? html`<button type="button" data-sb="comment">${icon("comment")}Comment</button>` : ""}<button
            type="button"
            data-sb="ask"
          >
            ${icon("agent")}Ask agent
          </button>`,
      );
      selBar.style.left = Math.round(Math.min(innerWidth - 200, r.right - 40)) + "px";
      selBar.style.top = Math.round(r.top - 36) + "px";
      selBar.classList.add("on");
    }
    selBar.addEventListener("mousedown", (e) => e.preventDefault());
    selBar.addEventListener("click", (e) => {
      const b = e.target.closest("[data-sb]");
      if (!b || !selCtx) return;
      const ctx = selCtx;
      hideSelBar();
      getSelection().removeAllRanges();
      if (b.dataset.sb === "ask") agent("selection", { text: ctx.text });
      else
        openComposer(
          ctx.path,
          ctx.side,
          ctx.line,
          ctx.text
            .split("\n")
            .map((l) => "> " + l)
            .join("\n") + "\n\n",
        );
    });

    /* ------------------------------------------------------ actions */
    async function act(name, t, e) {
      const pr = cur();
      switch (name) {
        case "group": {
          const g = t.dataset.g;
          if (ui.collapsed.has(g)) ui.collapsed.delete(g);
          else ui.collapsed.add(g);
          renderList();
          return followSel(ms("stack") + 80);
        }
        case "filter-menu":
          return openFilterMenu(t);
        case "chip-state": {
          const f = filters();
          f.state = "open";
          setFilters(f);
          return afterFilter(true);
        }
        case "chip-group":
          st.group = null;
          return afterFilter(true);
        case "chip-failing": {
          const f = filters();
          f.failing = false;
          setFilters(f);
          return afterFilter(true);
        }
        case "chip-label": {
          const f = filters();
          f.labels = f.labels.filter((l) => l !== t.dataset.label);
          setFilters(f);
          return afterFilter(true);
        }
        case "chip-sort": {
          const f = filters();
          f.sort = "ready";
          setFilters(f);
          return afterFilter(true);
        }
        case "clear-filters":
          st.filter = "";
          st.group = null;
          st.q = "";
          search.value = "";
          return afterFilter(true);
        case "show-all": {
          const f = filters();
          f.state = "all";
          setFilters(f);
          return afterFilter(true);
        }
        case "list-toggle":
          return toggleList();
        case "to-top": {
          if (st.tab !== "conversation") return showTab("conversation");
          return ui.panes
            .get("conversation")
            ?.scrollTo({ top: 0, behavior: L.reducedMotion() ? "auto" : "smooth" });
        }
        case "overlay-close":
          return toggleList(false);
        case "copy-link":
          return L.copy(pr.url || `${repo.url}/pull/${pr.number}`, "link");
        case "copy-branch":
          return L.copy(t.dataset.v, "branch name");
        case "copy-path":
          return L.copy(t.dataset.path, "path");
        case "open-gh":
          return toast(`Opens ${repo.nameWithOwner}#${pr.number} on GitHub`, { icon: "external" });
        case "more":
          return openMore(t);
        case "ask":
          return openAsk(t);
        case "review":
          return openReview(t);
        case "stack":
          return toggleStack(undefined, { reveal: t.classList.contains("a-stkchip") });
        case "goto-pr":
          popover.close();
          return selectPR(Number(t.dataset.pr), { keepStack: st.stack });
        case "merge-through":
          return mergeStack(Number(t.dataset.pr));
        case "next":
          if (t.getAttribute("aria-disabled") === "true") return;
          return runNext(t);
        case "merge-menu":
          return openMergeMenu(t);
        case "mb-go": {
          const go = t.dataset.go;
          if (e.target.closest(".a-agent")) return;
          if (go === "checks") return gotoChecks();
          if (go === "threads") return stepThread(1);
          if (go === "update") return updateBranch();
          if (go === "reviewers") return pickReviewers($('[data-act="pick-reviewers"]', root) || t);
          if (go === "reviews") {
            const p = ui.panes.get("conversation");
            const last = $$(".a-review", p).at(-1);
            if (last) {
              last.scrollIntoView({
                block: "center",
                behavior: L.reducedMotion() ? "auto" : "smooth",
              });
              last.classList.remove("a-flash");
              void last.offsetWidth;
              last.classList.add("a-flash");
            }
          }
          return;
        }
        case "agent":
          e.stopPropagation();
          return agent(t.dataset.what, { job: t.dataset.job, thread: t.dataset.thread });
        case "pick-reviewers":
          return pickReviewers(t);
        case "pick-assignees":
          return pickAssignees(t);
        case "pick-labels":
          return pickLabels(t);
        case "assign-me":
          pr.assignees.push(viewer);
          addEvent(pr, { kind: "assigned", assignee: viewer });
          refreshFacts(["assignees"]);
          return refreshTimeline();
        case "rerequest": {
          const r = pr.reviewers.find((x) => x.login === t.dataset.login);
          if (r) Object.assign(r, { state: "pending" });
          addEvent(pr, { kind: "review_requested", reviewer: t.dataset.login });
          recompute(pr);
          refreshAll({ timeline: true });
          return toast(`Re-requested review from ${uname(t.dataset.login)}`);
        }
        case "open-thread":
          return toast("Opens the agent thread in a split pane", { icon: "agent" });
        case "edit-title":
          return editTitle();
        case "quote": {
          const ev = det(pr).timeline.find((x) => x.id === t.dataset.ev);
          const ta = $("[data-conv-ta]", ui.panes.get("conversation"));
          if (ev && ta) {
            ta.value =
              ev.body
                .split("\n")
                .map((l) => "> " + l)
                .join("\n") + "\n\n";
            ui.convDraft = ta.value;
            ta.closest(".a-cbox").classList.add("has");
            autoGrow(ta);
            ta.focus();
            ta.scrollIntoView({ block: "center", behavior: L.reducedMotion() ? "auto" : "smooth" });
          }
          return;
        }
        case "react":
        case "react-add":
          return react(t);
        case "conv-send": {
          const ta = $("[data-conv-ta]", ui.panes.get("conversation"));
          const body = ta?.value.trim();
          if (!body) return ta?.focus();
          addEvent(pr, { kind: "comment", body, reactions: [] });
          pr.comments = (pr.comments || 0) + 1;
          ui.convDraft = "";
          ta.value = "";
          ta.closest(".a-cbox").classList.remove("has");
          autoGrow(ta);
          refreshTimeline();
          paintTabs();
          return renderList();
        }
        case "goto-thread":
          return focusThread(t.dataset.thread, { push: true });
        case "goto-commit":
          if (!t.dataset.sha || t.getAttribute("aria-disabled") === "true") return;
          return setScope(t.dataset.sha);
        case "scope":
          return openScopeMenu(t);
        case "scope-clear":
          return setScope(null);
        case "view":
          return setView(t.dataset.v);
        case "tree":
          return toggleTree();
        case "tdir": {
          const path = t.dataset.dir;
          const open = ui.treeClosed.has(path);
          if (open) ui.treeClosed.delete(path);
          else ui.treeClosed.add(path);
          t.classList.toggle("open", open);
          t.nextElementSibling.classList.toggle("open", open);
          return followSel(ms("stack") + 60);
        }
        case "tfile":
          if (e.target.closest(".a-tchk")) return;
          st.file = t.dataset.path;
          setFileOpen(t.dataset.path, true);
          scrollToFile(t.dataset.path);
          if (ui.narrow) toggleTree(false);
          return writeHash(false);
        case "viewed":
          e.stopPropagation();
          return toggleViewed(t.dataset.path);
        case "file-toggle": {
          const f = det(pr).files.find((x) => x.path === t.dataset.path);
          return setFileOpen(t.dataset.path, !fileOpen(f));
        }
        case "file-more": {
          const path = t.dataset.path;
          return menu.open(
            t,
            [
              { label: "Copy path", icon: "copy", run: () => L.copy(path, "path") },
              {
                label: "Open in editor",
                icon: "external",
                run: () => toast(`Opens ${splitPath(path)[1]} in your editor`),
              },
              {
                label: "Ask agent about this file",
                icon: "agent",
                run: () => agent("ask", { text: `Explain the changes in ${splitPath(path)[1]}` }),
              },
            ],
            { align: "end" },
          );
        }
        case "diff-comment":
          return openComposer(t.dataset.path, t.dataset.side, t.dataset.line);
        case "lc-cancel": {
          const path = ui.composer?.path;
          ui.composer = null;
          return path && refreshFile(path);
        }
        case "lc-suggest": {
          const c = ui.composer;
          const ta = $("[data-composer-ta]", ui.panes.get("files"));
          if (!c || !ta) return;
          const line = lineTextOf(c.path, c.side, c.line);
          ta.value = `${ta.value ? ta.value.replace(/\s*$/, "\n\n") : ""}\`\`\`suggestion\n${line}\n\`\`\``;
          c.text = ta.value;
          ta.focus();
          return ta.setSelectionRange(ta.value.length - 4 - 0, ta.value.length - 4);
        }
        case "lc-single":
        case "lc-review":
          return submitLineComment(name === "lc-review");
        case "th-expand": {
          const id = t.dataset.thread;
          const open = !ui.openResolved.has(id);
          if (open) ui.openResolved.add(id);
          else ui.openResolved.delete(id);
          const card = t.closest(".a-th");
          card.classList.toggle("open", open);
          t.setAttribute("aria-expanded", S(open));
          $(":scope > .disc", card).classList.toggle("open", open);
          return;
        }
        case "resolve":
          return resolveThread(t.dataset.thread);
        case "reply-cancel": {
          ui.replies.delete(t.dataset.thread);
          const foot = t.closest(".a-th-foot");
          const ta = $(".a-reply-ta", foot);
          ta.value = "";
          autoGrow(ta);
          foot.classList.remove("has");
          return ta.blur();
        }
        case "reply-send":
          return sendReply(t.dataset.thread);
        case "pending-del": {
          const d = det(pr);
          if (d.pendingReview)
            d.pendingReview.comments = d.pendingReview.comments.filter(
              (c) => c.id !== t.dataset.thread,
            );
          if (d.pendingReview && !d.pendingReview.comments.length) d.pendingReview = null;
          paintActs(pr);
          return refreshFile(threadPath(t.dataset.thread, t));
        }
        case "commit-sugg": {
          const d = det(pr);
          const th = d.threads.find((x) => x.id === t.dataset.thread);
          if (!th) return;
          th.isResolved = true;
          th.resolvedBy = viewer;
          const short = Math.random().toString(16).slice(2, 9);
          d.commits.push({
            sha: short.padEnd(40, "0"),
            short,
            message: `Apply suggestion from ${uname(th.comments[0].author).split(" ")[0]}`,
            author: viewer,
            committedAt: nowIso(),
            checks: "running",
          });
          addEvent(pr, {
            kind: "commits",
            commits: [
              {
                short,
                message: `Apply suggestion from ${uname(th.comments[0].author).split(" ")[0]}`,
              },
            ],
          });
          recompute(pr);
          refreshAll({ timeline: true, files: true, commits: true });
          return toast(`Committed suggestion as ${short}`, { tone: "ok" });
        }
        case "job": {
          if (e.target.closest(".a-rerun, .a-agent")) return;
          const id = t.dataset.job;
          const open = !ui.openJobs.has(id);
          if (open) ui.openJobs.add(id);
          else ui.openJobs.delete(id);
          const li = t.closest(".a-job");
          li.classList.toggle("open", open);
          t.setAttribute("aria-expanded", S(open));
          $(":scope > .disc", li).classList.toggle("open", open);
          st.job = open ? id : st.job === id ? null : st.job;
          return writeHash(false);
        }
        case "step": {
          const key = t.dataset.key;
          const li = t.closest(".a-step");
          const open = !li.classList.contains("open");
          if (open) {
            ui.openSteps.add(key);
            ui.openSteps.delete(key + ":closed");
          } else {
            ui.openSteps.delete(key);
            ui.openSteps.add(key + ":closed");
          }
          li.classList.toggle("open", open);
          t.setAttribute("aria-expanded", S(open));
          $(":scope > .disc", li).classList.toggle("open", open);
          return;
        }
        case "rerun-job":
          e.stopPropagation();
          if (t.getAttribute("aria-disabled") === "true") return;
          return rerun([t.dataset.job]);
        case "rerun-failed":
          return rerun(model.checks(det(pr)).failing.map((j) => j.id));
        case "wf-menu": {
          const w = det(pr).checks.workflows.find((x) => x.id === t.dataset.wf);
          return menu.open(
            t,
            [
              {
                label: "Re-run all jobs",
                icon: "rerun",
                run: () => rerun(w.jobs.map((j) => j.id)),
              },
              {
                label: "Re-run failed jobs",
                icon: "rerun",
                disabled: !w.jobs.some((j) => j.conclusion === "failure"),
                reason: "Nothing failed",
                run: () => rerun(w.jobs.filter((j) => j.conclusion === "failure").map((j) => j.id)),
              },
              { sep: true },
              {
                label: "View workflow file",
                icon: "file",
                sub: w.file,
                run: () => toast(`Opens ${w.file}`),
              },
              {
                label: "Open run on GitHub",
                icon: "external",
                run: () => toast(`Opens run #${w.runNumber} on GitHub`),
              },
            ],
            { align: "end" },
          );
        }
        case "log-link":
          return openLogLink(t.dataset.file, Number(t.dataset.line));
      }
    }
    function threadPath(id, t) {
      return t.closest(".a-file")?.dataset.path || "";
    }
    function openScopeMenu(anchor) {
      const d = det(cur());
      menu.open(
        anchor,
        [
          {
            label: "All commits",
            sub: plural(d.commits.length, "commit"),
            checked: !st.commit,
            run: () => setScope(null),
          },
          { sep: true },
          ...[...d.commits].reverse().map((c) => ({
            label: c.message,
            sub: `${c.short} · ${ago(c.committedAt)}`,
            checked: st.commit === c.short,
            run: () => setScope(c.short),
          })),
        ],
        { align: "end", minWidth: 320 },
      );
    }
    function setView(v) {
      if (st.view === v) return;
      st.view = v;
      const seg = $(".a-vseg", root);
      if (seg) {
        for (const b of $$(".seg-opt", seg)) b.setAttribute("aria-checked", S(b.dataset.v === v));
        syncIndicator(seg);
      }
      rebuildPane("files");
      writeHash(false);
    }
    function toggleTree(force) {
      ui.tree = force ?? !treeShown();
      const p = ui.panes.get("files");
      $(".a-files", p)?.classList.toggle("tree-on", ui.tree);
      const b = $(".a-treebtn", root);
      if (b) {
        b.classList.toggle("on", ui.tree);
        b.dataset.tip = `${ui.tree ? "Hide" : "Show"} file tree`;
      }
      if (ui.tree) raf2(() => placeTreeSel(true));
    }
    function openLogLink(file, line) {
      const d = det(cur());
      const f = d.files.find((x) => x.path.endsWith(file));
      if (!f) return toast(`${file} isn't part of this diff`);
      st.commit = null;
      const t = d.threads.find((x) => x.path === f.path && x.line === line && !x.isResolved);
      ui.collapsedFiles.delete(f.path);
      if (f.viewed) ui.forceOpen.add(f.path);
      showTab("files", { hash: false });
      rebuildPane("files");
      paintTools();
      st.file = f.path;
      writeHash(true);
      raf2(() => {
        const p = ui.panes.get("files");
        const stream = $(".a-stream", p);
        const row =
          p.querySelector(
            `.a-file[data-path="${CSS.escape(f.path)}"] tr.d-row[data-side="RIGHT"][data-line="${line}"]`,
          ) ||
          p
            .querySelector(
              `.a-file[data-path="${CSS.escape(f.path)}"] td.d-code[data-side="RIGHT"][data-line="${line}"]`,
            )
            ?.closest("tr");
        if (!row) return scrollToFile(f.path);
        const top =
          row.getBoundingClientRect().top - stream.getBoundingClientRect().top + stream.scrollTop;
        stream.scrollTo({
          top: Math.max(0, top - stream.clientHeight * 0.35),
          behavior: L.reducedMotion() ? "auto" : "smooth",
        });
        row.classList.add("a-hit");
        later(() => row.classList.remove("a-hit"), 2400);
        if (t) toast(`Line ${line} has an open thread`, { icon: "comment" });
      });
    }
    function submitLineComment(toReview) {
      const pr = cur();
      const d = det(pr);
      const c = ui.composer;
      const ta = $("[data-composer-ta]", ui.panes.get("files"));
      const body = (ta?.value || "").trim();
      if (!c) return;
      if (!body) return ta?.focus();
      const lineText = lineTextOf(c.path, c.side, c.line);
      if (toReview) {
        d.pendingReview ||= { startedAt: nowIso(), body: "", comments: [] };
        d.pendingReview.comments.push({
          id: `${pr.number}-p${++seq}`,
          path: c.path,
          side: c.side,
          line: c.line,
          lineText,
          body,
        });
        paintActs(pr);
      } else {
        d.threads.push({
          id: `${pr.number}-t${++seq + 80}`,
          path: c.path,
          side: c.side,
          line: c.line,
          lineText,
          isResolved: false,
          isOutdated: false,
          comments: [
            {
              id: `${pr.number}-c${seq}`,
              author: viewer,
              createdAt: nowIso(),
              body,
              reactions: [],
            },
          ],
        });
        recompute(pr);
        refreshFacts(["merge"]);
        renderList();
      }
      ui.composer = null;
      refreshFile(c.path);
      refreshTree();
    }
    function resolveThread(id) {
      const pr = cur();
      const d = det(pr);
      const t = d.threads.find((x) => x.id === id);
      if (!t) return;
      t.isResolved = !t.isResolved;
      t.resolvedBy = t.isResolved ? viewer : null;
      if (t.isResolved) ui.openResolved.delete(id);
      else ui.openResolved.add(id);
      recompute(pr);
      refreshFile(t.path);
      refreshTree();
      refreshFacts(["merge"]);
      renderList();
      if (ui.panes.has("conversation")) refreshTimeline();
      if (t.isResolved) {
        const left = threadOrder().length;
        toast(left ? `Resolved · ${plural(left, "thread")} left` : "Every thread is resolved", {
          tone: "ok",
          action: left
            ? { label: "Next", run: () => stepThread(1) }
            : { label: "Undo", run: () => resolveThread(id) },
        });
      }
    }
    function sendReply(id) {
      const pr = cur();
      const d = det(pr);
      const t = d.threads.find((x) => x.id === id);
      const body = (ui.replies.get(id) || "").trim();
      if (!t || !body) return;
      t.comments.push({
        id: `${id}-r${++seq}`,
        author: viewer,
        createdAt: nowIso(),
        body,
        reactions: [],
      });
      ui.replies.delete(id);
      pr.comments = (pr.comments || 0) + 1;
      refreshFile(t.path);
      paintTabs();
      if (ui.panes.has("conversation")) refreshTimeline();
    }
    function react(t) {
      const pr = cur();
      const d = det(pr);
      const [kind, a, b] = t.dataset.key.split(":");
      const target =
        kind === "e"
          ? d.timeline.find((x) => x.id === a)
          : d.threads.find((x) => x.id === a)?.comments.find((c) => c.id === b);
      if (!target) return;
      const flipEmoji = (emoji) => {
        target.reactions ||= [];
        const r = target.reactions.find((x) => x.emoji === emoji);
        if (r) {
          r.viewerReacted = !r.viewerReacted;
          r.count += r.viewerReacted ? 1 : -1;
          if (!r.count) target.reactions.splice(target.reactions.indexOf(r), 1);
        } else target.reactions.push({ emoji, count: 1, viewerReacted: true });
        const wrap = root.querySelector(`.a-reacts[data-key="${CSS.escape(t.dataset.key)}"]`);
        if (!wrap) return;
        const next = el(String(reactsHtml(target.reactions, t.dataset.key)));
        wrap.replaceWith(next);
        const fresh = next.querySelector(`[data-emoji="${CSS.escape(emoji)}"]`);
        if (fresh) fresh.classList.add("pop-in");
      };
      if (t.dataset.act === "react") return flipEmoji(t.dataset.emoji);
      menu.open(
        t,
        ["👍", "🎉", "❤️", "🚀", "👀", "😕"].map((em) => ({ label: em, run: () => flipEmoji(em) })),
        { minWidth: 120 },
      );
    }
    function autoGrow(ta) {
      ta.style.height = "auto";
      ta.style.height = Math.min(ta.scrollHeight + 2, 320) + "px";
    }

    /* ------------------------------------------------------ wiring */
    offs.push(L.on(root, "click", "[data-act]", (e, t) => act(t.dataset.act, t, e)));
    offs.push(
      L.on(root, "click", ".a-row", (e, row) => {
        selectPR(Number(row.dataset.pr));
      }),
    );
    offs.push(
      L.on(root, "click", ".tab", (e, b) => {
        if (cur()) showTab(b.dataset.tab);
      }),
    );
    offs.push(
      L.on(root, "click", ".md-ref", (e, a) => {
        const n = Number(a.dataset.pr);
        if (model.pr(n)) selectPR(n);
        else toast(`#${n} is an issue · opens on GitHub`);
      }),
    );
    offs.push(
      L.on(root, "click", ".md-check", (e, c) => {
        const pr = cur();
        if (!pr || !isMine(pr)) return;
        const on = c.getAttribute("aria-checked") !== "true";
        c.setAttribute("aria-checked", S(on));
        c.closest("li")?.classList.toggle("done", on);
        let i = -1;
        const d = det(pr);
        d.body = d.body.replace(/^(\s*[-*+]\s+)\[( |x|X)\]/gm, (m, lead, x) =>
          ++i === Number(c.dataset.task) ? `${lead}[${on ? "x" : " "}]` : m,
        );
      }),
    );
    offs.push(
      L.on(root, "contextmenu", ".a-row", (e, row) => {
        e.preventDefault();
        const pr = model.pr(row.dataset.pr);
        menu.open({ x: e.clientX, y: e.clientY }, [
          { label: "Open", icon: "arrow-right", run: () => selectPR(pr.number) },
          {
            label: pr.unread ? "Mark as read" : "Mark as unread",
            icon: "dot",
            run: () => ((pr.unread = !pr.unread), renderList()),
          },
          {
            label: "Copy link",
            icon: "link",
            run: () => L.copy(pr.url || `${repo.url}/pull/${pr.number}`, "link"),
          },
          {
            label: "Open on GitHub",
            icon: "external",
            run: () => toast(`Opens #${pr.number} on GitHub`),
          },
        ]);
      }),
    );
    offs.push(
      L.on(root, "keydown", "[role=button][data-act]", (e, t) => {
        if (e.key === "Enter" || e.key === " ") {
          if (e.target !== t) return;
          e.preventDefault();
          act(t.dataset.act, t, e);
        }
      }),
    );
    offs.push(
      L.on(root, "input", "textarea", (e, ta) => {
        autoGrow(ta);
        if (ta.dataset.reply) {
          ui.replies.set(ta.dataset.reply, ta.value);
          ta.closest(".a-th-foot")?.classList.toggle("has", !!ta.value.trim());
        } else if ("composerTa" in ta.dataset && ui.composer) ui.composer.text = ta.value;
        else if ("convTa" in ta.dataset) {
          ui.convDraft = ta.value;
          ta.closest(".a-cbox")?.classList.toggle("has", !!ta.value.trim());
        }
      }),
    );
    offs.push(
      L.on(root, "focusin", ".a-cta", (e, ta) => ta.closest(".a-cbox")?.classList.add("focus")),
      L.on(root, "focusout", ".a-cta", (e, ta) => ta.closest(".a-cbox")?.classList.remove("focus")),
      L.on(root, "focusin", ".a-reply-ta", (e, ta) =>
        ta.closest(".a-th-foot")?.classList.add("focus"),
      ),
      L.on(root, "focusout", ".a-reply-ta", (e, ta) =>
        later(() => ta.closest(".a-th-foot")?.classList.remove("focus"), 120),
      ),
    );
    offs.push(
      L.on(root, "input", "[data-tree-q]", (e, inp) => {
        ui.treeQ = inp.value;
        refreshTree();
      }),
    );
    offs.push(
      L.on(root, "keydown", "textarea", (e, ta) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          if (ta.dataset.reply) sendReply(ta.dataset.reply);
          else if ("composerTa" in ta.dataset) submitLineComment(true);
          else if ("convTa" in ta.dataset) act("conv-send", ta, e);
        } else if (e.key === "Escape") {
          e.stopPropagation();
          if ("composerTa" in ta.dataset && !ta.value.trim()) act("lc-cancel", ta, e);
          else ta.blur();
        }
      }),
    );
    offs.push(L.on(root, "mouseup", ".a-stream", () => setTimeout(maybeSelBar, 0)));
    const onDocDown = (e) => {
      if (!selBar.contains(e.target)) hideSelBar();
    };
    document.addEventListener("mousedown", onDocDown, true);
    offs.push(() => document.removeEventListener("mousedown", onDocDown, true));

    /* search */
    let searchT = 0;
    search.addEventListener("input", () => {
      clearTimeout(searchT);
      st.q = search.value;
      searchT = setTimeout(() => afterFilter(), 60);
    });
    search.addEventListener("paste", () =>
      setTimeout(() => {
        const v = search.value.trim();
        if (!refQuery(v) && !/^\d+$/.test(v)) return;
        const n = model.parseRef(v);
        if (n && model.pr(n)) {
          search.value = "";
          st.q = "";
          const f = filters();
          const p = model.pr(n);
          if (
            f.state !== "all" &&
            L.prState(p) !== f.state &&
            !(f.state === "open" && p.state === "open")
          ) {
            f.state = "all";
            setFilters(f);
          }
          renderList({ flip: true });
          selectPR(n);
          search.blur();
          const row = rowEls.get(n);
          row?.classList.add("a-flash");
          later(() => row?.classList.remove("a-flash"), 1200);
        }
      }, 0),
    );
    search.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        if (search.value) {
          search.value = "";
          st.q = "";
          afterFilter();
        } else search.blur();
      } else if (e.key === "Enter") {
        const v = search.value.trim();
        const n = refQuery(v) ? model.parseRef(v) : ui.order[0];
        if (n && model.pr(n)) {
          selectPR(n);
          search.blur();
        }
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        search.blur();
        moveSel(1);
      }
    });

    /* resizer */
    const handle = $(".a-handle", root);
    handle.addEventListener("pointerdown", (e) => {
      if (ui.narrow) return;
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      const x0 = e.clientX;
      const w0 = ui.listW;
      shell.classList.add("dragging");
      L.tip.hide();
      const move = (ev) => {
        ui.listW = clamp(w0 + ev.clientX - x0, LIST_MIN, Math.min(LIST_MAX, lab.pageWidth() - 440));
        shell.style.setProperty("--list-w", ui.listW + "px");
        placeSel(true);
      };
      const up = () => {
        handle.removeEventListener("pointermove", move);
        shell.classList.remove("dragging");
        try {
          localStorage.setItem(LS_LIST, String(ui.listW));
        } catch {}
        updateLayout();
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up, { once: true });
      handle.addEventListener("pointercancel", up, { once: true });
    });
    handle.addEventListener("dblclick", () => {
      ui.listW = LIST_DEF;
      updateLayout();
      followSel(ms("pane") + 40);
      try {
        localStorage.setItem(LS_LIST, String(ui.listW));
      } catch {}
    });
    handle.addEventListener("keydown", (e) => {
      const d = e.key === "ArrowLeft" ? -16 : e.key === "ArrowRight" ? 16 : 0;
      if (!d && e.key !== "Home" && e.key !== "End") return;
      e.preventDefault();
      ui.listW =
        e.key === "Home"
          ? LIST_MIN
          : e.key === "End"
            ? LIST_MAX
            : clamp(ui.listW + d, LIST_MIN, LIST_MAX);
      updateLayout();
      placeSel(true);
    });

    /* keyboard */
    const editable = (n) =>
      n && (n.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(n.tagName));
    const onKey = (e) => {
      if (!root.isConnected) return;
      if (document.querySelector(".scrim")) return;
      if (e.altKey || e.metaKey || e.ctrlKey) return;
      if (editable(e.target)) return;
      if (menu.isOpen() && /^(Arrow|Escape|Enter)/.test(e.key)) return;
      const k = e.key;
      const pr = cur();
      const run = (fn) => {
        e.preventDefault();
        fn();
      };
      if (k === "j" || k === "ArrowDown") return run(() => moveSel(1));
      if (k === "k" || k === "ArrowUp") return run(() => moveSel(-1));
      if (k === "/")
        return run(() => {
          if (ui.narrow && st.pr != null) toggleList(true);
          search.focus();
          search.select();
        });
      if (k === "\\") return run(() => toggleList());
      if (k === "?") return run(() => openKeys($('[data-act="more"]', root)));
      if (k === "Escape") {
        if (ui.overlay) return run(() => toggleList(false));
        if (popover.isOpen()) return;
        if (ui.composer) return run(() => act("lc-cancel", null, e));
        return;
      }
      if (!pr) return;
      if (/^[1-4]$/.test(k)) return run(() => showTab(TABS[Number(k) - 1].key));
      if (k === "m")
        return run(() => {
          if (st.tab === "conversation") return openMergeMenu(mergeAnchor());
          showTab("conversation");
          raf2(() => openMergeMenu(mergeAnchor()));
        });
      if (k === "r") return run(() => openReview($('[data-act="review"]', root)));
      if (k === "s" && pr.stack) return run(() => toggleStack(undefined, { reveal: true }));
      if ((k === "[" || k === "]") && pr.stack) {
        const s = model.stackOf(pr);
        const pos = pr.stack.position + (k === "]" ? 1 : -1);
        const target = s.entries.find((p) => p.stack.position === pos);
        if (target)
          return run(() =>
            selectPR(target.number, { keepStack: st.stack, dir: k === "]" ? -1 : 1 }),
          );
        return;
      }
      if (k === "n") return run(() => stepThread(1));
      if (k === "p") return run(() => stepThread(-1));
      if (st.tab === "files") {
        if (k === "v" && ui.spy) return run(() => toggleViewed(ui.spy, { advance: true }));
        if (k === "f") return run(() => toggleTree());
        if (k === "u") return run(() => setView(st.view === "split" ? "unified" : "split"));
        if (k === "c") return run(() => openScopeMenu($(".a-scope", root)));
      }
      if (k === "Enter" && document.activeElement === lscroll)
        return run(() => tabsEl.querySelector('[aria-selected="true"]')?.focus());
    };
    document.addEventListener("keydown", onKey);
    offs.push(() => document.removeEventListener("keydown", onKey));

    /* lab events */
    offs.push(
      lab.on("resize", () => {
        const was = ui.narrow;
        updateLayout();
        placeSel(true);
        placeTreeSel(true);
        if (was !== ui.narrow && ui.panes.has("files") && ui.tree == null) {
          $(".a-files", ui.panes.get("files"))?.classList.toggle("tree-on", treeShown());
          paintTools();
        }
        updateCondensed();
      }),
    );
    offs.push(
      lab.onHashChange((s, { changed }) => {
        const next = readHash(s);
        const prev = { ...st };
        Object.assign(st, { q: next.q, filter: next.filter, group: next.group, view: next.view });
        if (changed.has("q")) search.value = st.q;
        if (["q", "filter", "group"].some((k) => changed.has(k))) renderList({ flip: true });
        if (next.pr !== prev.pr) {
          selectPR(next.pr, { hash: false, tab: next.tab, force: true });
          st.file = next.file;
          if (next.commit) setScope(next.commit);
          if (next.job) {
            st.job = next.job;
            ui.openJobs.add(next.job);
            rebuildPane("checks");
          }
        } else {
          if (changed.has("commit") || changed.has("view")) {
            st.commit = next.commit;
            rebuildPane("files");
            paintTools();
          }
          if (next.tab !== st.tab && cur()) showTab(next.tab, { hash: false });
          st.file = next.file;
          if (changed.has("job")) {
            st.job = next.job;
            if (next.job) {
              ui.openJobs.add(next.job);
              rebuildPane("checks");
              raf2(() => scrollToJob(next.job));
            }
          }
        }
        if (next.thread && next.thread !== prev.thread) focusThread(next.thread);
        else if (!next.thread) st.thread = null;
        if (changed.has("stack") && next.stack !== st.stack) toggleStack(next.stack);
        if (changed.has("merge")) next.merge ? openMergeMenu(mergeAnchor()) : menu.close();
        if (changed.has("review"))
          next.review ? openReview($('[data-act="review"]', root)) : popover.close();
        updateLayout();
      }),
    );
    function mergeAnchor() {
      return $(".a-next-more", ui.panes.get("conversation") || root);
    }

    /* ------------------------------------------------------ boot */
    Object.assign(st, readHash(lab.getHashState()));
    search.value = st.q;
    updateLayout();
    renderList({ instant: true });
    const deep = { ...st };
    if (deep.job) ui.openJobs.add(deep.job);
    renderReader(0);
    placeSel(true);
    scrollRowIntoView(st.pr);
    writeHash(false);
    const settle = () => {
      if (!root.isConnected) return;
      placeSel(true);
      updateCondensed();
      if (deep.tab === "files" && deep.thread) focusThread(deep.thread, { instant: true });
      else if (deep.tab === "files" && deep.file) scrollToFile(deep.file, { smooth: false });
      if (deep.tab === "checks" && deep.job) scrollToJob(deep.job);
      if (deep.stack && cur()?.stack) toggleStack(true, { inPlace: deep.tab === "conversation" });
      if (deep.review) openReview($('[data-act="review"]', root));
      if (deep.merge) {
        if (st.tab !== "conversation") showTab("conversation");
        raf2(() => openMergeMenu(mergeAnchor()));
      }
    };
    const wait = root.classList.contains("entering") ? ms("pane") + 40 : 0;
    (document.fonts?.ready || Promise.resolve()).then(() => later(() => raf2(settle), wait));

    return {
      destroy() {
        for (const off of offs) off?.();
        for (const id of timers) clearTimeout(id);
        clearTimeout(searchT);
        selBar.remove();
        closeLayers();
      },
    };
  }
})();
