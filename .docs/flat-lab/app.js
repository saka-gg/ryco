/* Flat surfaces lab — app shell, composer, pickers and the three dialog flows. */
(() => {
  const C = window.Core;
  const { icon, brand, el, esc, anim, EASE, SPR, Lab } = C;

  /* Wall-clock waits stretch with slow-mo but never collapse to zero. */
  const wait = (ms) => ms * Math.max(1, Lab.reduced ? 1 : Lab.speed);

  const ICON = {
    play: "play",
    test: "flask",
    lint: "list-checks",
    configure: "wrench",
    build: "hammer",
    debug: "bug",
  };
  const ICON_LIST = [
    ["play", "Play"],
    ["test", "Test"],
    ["lint", "Lint"],
    ["configure", "Configure"],
    ["build", "Build"],
    ["debug", "Debug"],
  ];

  /* What Ryco's own package.json exposes — C suggests these. */
  const SUGG = [
    { name: "Test", icon: "test", command: "bun run test" },
    { name: "Lint", icon: "lint", command: "bun lint" },
    { name: "Typecheck", icon: "debug", command: "bun typecheck" },
    { name: "Format", icon: "configure", command: "bun fmt" },
    { name: "Build", icon: "build", command: "bun run build" },
    { name: "Dev server", icon: "play", command: "bun run dev" },
  ];

  const MODELS = [
    {
      group: "Codex",
      brand: "OpenAI",
      items: [
        ["GPT-6.1-Sol", "⌘1"],
        ["GPT-6-Astra", "⌘2"],
        ["GPT-6-Sol", "⌘3"],
        ["GPT-5.6-Terra", "⌘4"],
      ],
    },
    {
      group: "Claude",
      brand: "ClaudeAI",
      items: [
        ["Claude Opus 5.5", "⌘5"],
        ["Claude Sonnet 5.5", "⌘6"],
        ["Claude Haiku 4.5", "⌘7"],
      ],
    },
  ];
  const EFFORTS = ["Low", "Medium", "High", "Max"];

  const SEED = [
    { role: "user", html: "Run the transport tests and tell me what fails." },
    {
      role: "ai",
      worklog: ["Ran 1 command", "38s"],
      html: "<p>Everything passes except <code>reconnects after heartbeat timeout</code>, which failed twice in 40 runs with <code>expected 1 reconnect, got 2</code>. The same seed passes when the test runs alone, so the failure depends on timing, not on test order.</p>",
    },
    {
      role: "user",
      html: "The reconnect test in <code>wsTransport.test.ts</code> flakes about 1 in 20 runs. Can you find out why?",
    },
    {
      role: "ai",
      worklog: ["Explored 6 files", "Ran 3 commands", "1m 12s"],
      html: `<p>The heartbeat timer races the reconnect backoff. When the socket closes inside the 250&nbsp;ms heartbeat window, <code>scheduleReconnect</code> runs twice and the second attempt reuses a stale generation.</p>
<pre class="codeblock"><span class="del">-  if (this.timer) clearTimeout(this.timer);</span>
<span class="add">+  if (generation !== this.generation) return;</span>
<span class="add">+  this.timer = undefined;</span></pre>
<p>I made the timer check the generation and added a regression test that forces the race with fake timers. 40 of 40 runs pass now.</p>`,
    },
    { role: "user", html: "Nice. Does the hosted reconnect path have the same problem?" },
    {
      role: "ai",
      worklog: ["Explored 3 files", "24s"],
      html: "<p>No. <code>hostedLifecycle.ts</code> already drops stale generations before it publishes readiness, so a late heartbeat can't reopen the relay. I left it unchanged.</p><p>There is one related gap: the saved-environment reconnect helper doesn't check the generation either. Hosted sessions can't reach it today, but I can add the same guard there if you want.</p>",
    },
  ];

  const REPLY =
    "On it. I'll add the same generation guard to savedEnvironmentReconnect.ts, cover it with the fake-timer test, and run the transport suite 40 times to confirm the flake is gone.";

  const state = {
    dir: "a",
    actions: [
      { id: "dev", name: "Dev", icon: "play", command: "bun run dev", combo: null, autorun: false },
      {
        id: "test",
        name: "Test",
        icon: "test",
        command: "bun run test",
        combo: { meta: true, shift: true, key: "T" },
        autorun: false,
      },
    ],
    model: { name: "GPT-5.6-Terra", brand: "OpenAI" },
    effort: "Medium",
    machine: "MacBook Pro M5",
    messages: SEED.slice(),
  };

  const POP_ENTER = { a: "scale", b: "morph", c: "slide" };

  /* ═══════════════════════ Markup ═══════════════════════ */

  function chipHTML(a) {
    const tip = `${a.command}${a.combo ? ` · ${C.comboText(a.combo)}` : ""}`;
    return `<div class="action-chip" data-id="${a.id}">
      <button class="run" type="button" title="${esc(tip)}">
        <span class="ico"><span class="base">${icon(ICON[a.icon], "sm")}</span><span class="spin"><span class="spin-ring"></span></span><span class="done">${icon("check", "sm")}</span></span>${esc(a.name)}
      </button>
      <button class="edit" type="button" aria-label="Edit ${esc(a.name)}">${icon("sliders", "xs")}</button>
    </div>`;
  }

  function messageHTML(m) {
    if (m.role === "user") {
      const att = m.att?.length
        ? `<div class="att">${m.att.map((f) => `<span class="att-chip"><span class="thumb">${icon(f.ic, "xs")}</span>${esc(f.name)}</span>`).join("")}</div>`
        : "";
      return `<div class="msg-user">${att}${m.html}</div>`;
    }
    if (m.role === "note") return `<div class="stopped-note">${m.html}</div>`;
    const log = m.worklog
      ? `<div class="worklog">${m.worklog.map(esc).join('<span class="dot"></span>')}</div>`
      : "";
    return `<div class="msg-ai">${log}${m.html}</div>`;
  }

  function composerHTML(dir) {
    const sep = dir === "c" ? '<span class="tb-sep"></span>' : "";
    const hints =
      dir === "c"
        ? '<span class="keyhints"><span><kbd>↵</kbd> send</span><span><kbd>⇧↵</kbd> newline</span><span><kbd>esc</kbd> stop</span></span>'
        : "";
    return `<div class="composer">
      <div class="attachments-wrap"><div class="attachments"></div></div>
      <textarea rows="1" placeholder="Ask for follow-up changes or attach images" aria-label="Message"></textarea>
      <div class="toolbar">
        <button class="tb icon" data-act="attach" type="button" aria-label="Attach file" title="Attach file">${icon("paperclip")}</button>
        <button class="tb chip" data-act="model" type="button" aria-haspopup="dialog" aria-expanded="false">
          <span class="brand-holder" data-brand="${state.model.brand}" style="display:inline-grid">${brand(state.model.brand)}</span>
          <span class="roll model-roll"><span>${esc(state.model.name)}</span></span>
          <span class="roll effort"><span>${state.effort}</span></span>${icon("chevron-down", "xs chev")}
        </button>${sep}
        <button class="tb chip" data-act="machine" type="button" aria-haspopup="menu" aria-expanded="false">${icon("laptop", "sm")}<span class="roll machine-roll"><span>${esc(state.machine)}</span></span>${icon("chevron-down", "xs chev")}</button>${sep}
        <button class="tb icon access" data-act="access" data-full="true" type="button" aria-label="Full access" title="Full access">${icon("lock-open", "sm")}</button>
        <span class="spacer"></span>${hints}
        <span class="ctx" title="Context used"><svg width="18" height="18" viewBox="0 0 18 18"><circle class="track" cx="9" cy="9" r="7"/><circle class="val" cx="9" cy="9" r="7" stroke-dasharray="43.98" stroke-dashoffset="38.7" transform="rotate(-90 9 9)"/></svg></span>
        <button class="send" data-act="send" type="button" aria-label="Send">
          ${icon("arrow-up", "sm i-up")}
          <svg class="i sm i-stop" viewBox="0 0 24 24" aria-hidden="true"><rect x="6.5" y="6.5" width="11" height="11" rx="2.5" fill="currentColor" stroke="none"/></svg>
          <span class="stop-label">Stop 0:00</span>
        </button>
      </div>
    </div>
    <div class="below-composer"><span>${icon("git-branch", "xs")}ryco/flat-surfaces</span><span>${icon("terminal", "xs")}Open terminal</span></div>`;
  }

  function appHTML(dir) {
    const rows = [
      { t: "Fix flaky reconnect test", m: "server · ryco/flat-surfaces", time: "now", cur: true },
      { t: "Overview rail polish", m: "server · ryco/overview-icon-rail", time: "2h" },
      { t: "Settings page redesign", m: "server · #659 merged", time: "1d" },
      { t: "Inbox rows lab", m: "server · Local workspace", time: "1d" },
      { t: "Pairing token rotation", m: "pairing · Local workspace", time: "3d" },
    ];
    return `<div class="app" data-dir="${dir}">
      <aside class="sidebar" aria-label="Threads">
        <div class="sb-top"><span class="sb-logo">${brand("Ryco", "sb-logo")}</span><span class="spacer"></span>${icon("chart", "sm")}${icon("sliders", "sm")}${icon("panel-left", "sm")}</div>
        <div class="sb-item">${icon("square-pen", "sm")}New thread<span class="kbd">⇧⌘N</span></div>
        <div class="sb-item">${icon("search", "sm")}Search<span class="kbd">⌘K</span></div>
        <div class="sb-label">RECENT</div>
        ${rows
          .map(
            (r) =>
              `<div class="sb-row"${r.cur ? ' aria-current="true"' : ""}><span class="glyph"${r.cur ? ' data-cur="true"' : ""}></span><span class="title">${r.t}</span><span class="time">${r.time}</span><span></span><span class="meta">${r.m}</span></div>`,
          )
          .join("")}
      </aside>
      <div class="main">
        <header class="hdr">
          <div class="crumb"><span class="proj">server</span>${icon("chevron-right", "xs")}<span class="title">Fix flaky reconnect test</span></div>
          <span class="spacer"></span>
          <div class="hdr-actions" role="group" aria-label="Project actions">${state.actions.map(chipHTML).join("")}</div>
          <button class="hdr-btn add-action" type="button">${icon("plus", "sm")}Add action</button>
          <span class="hdr-sep"></span>
          <button class="hdr-btn" type="button">${icon("box", "sm")}Open${icon("chevron-down", "xs")}</button>
        </header>
        <div class="thread">
          <div class="transcript"><div class="transcript-inner">${state.messages.map(messageHTML).join("")}</div></div>
          <div class="composer-dock">${composerHTML(dir)}</div>
        </div>
      </div>
      <div class="toasts" aria-live="polite"></div>
      <div class="layer"></div>
    </div>`;
  }

  /* ═══════════════════════ Mount ═══════════════════════ */

  function mountApp(app, dir) {
    const cleanups = [];
    const thread = app.querySelector(".thread");
    const transcript = app.querySelector(".transcript");
    const inner = app.querySelector(".transcript-inner");
    const dock = app.querySelector(".composer-dock");

    let nearBottom = true;
    transcript.addEventListener("scroll", () => {
      nearBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 48;
    });
    const pin = () => {
      if (nearBottom) transcript.scrollTop = transcript.scrollHeight;
    };

    const ro = new ResizeObserver(() => {
      if (dir !== "c") {
        const h = dock.offsetHeight;
        thread.style.setProperty("--composer-h", `${h}px`);
        thread.style.setProperty("--clearance", `${h + 28}px`);
      }
      pin();
    });
    ro.observe(dock);
    cleanups.push(() => ro.disconnect());
    requestAnimationFrame(() => (transcript.scrollTop = transcript.scrollHeight));

    const composer = mountComposer(app, dir, { inner, transcript, pin, dock });
    cleanups.push(composer.dispose);

    /* Header actions. */
    const actions = app.querySelector(".hdr-actions");
    actions.addEventListener("click", (e) => {
      const chip = e.target.closest(".action-chip");
      const a = chip && state.actions.find((x) => x.id === chip.dataset.id);
      if (!a) return;
      if (e.target.closest(".edit")) {
        openActionDialog(app, dir, {
          mode: "edit",
          action: a,
          trigger: e.target.closest(".edit"),
          origin: chip,
        });
      } else if (e.target.closest(".run")) runAction(chip);
    });
    const add = app.querySelector(".add-action");
    add.addEventListener("click", () =>
      openActionDialog(app, dir, { mode: "add", trigger: add, origin: add }),
    );

    /* Saved shortcuts run their action. */
    const onKey = (e) => {
      if (C.stack.length) return;
      const a = state.actions.find((x) => C.matchCombo(e, x.combo));
      if (!a) return;
      e.preventDefault();
      const chip = app.querySelector(`.action-chip[data-id="${a.id}"]`);
      if (chip) runAction(chip);
    };
    document.addEventListener("keydown", onKey);
    cleanups.push(() => document.removeEventListener("keydown", onKey));

    return () => cleanups.forEach((f) => f());
  }

  function runAction(chip) {
    if (chip.dataset.run) return;
    chip.dataset.run = "running";
    setTimeout(() => {
      chip.dataset.run = "done";
      setTimeout(() => delete chip.dataset.run, wait(900));
    }, wait(1100));
  }

  /* ═══════════════════════ Composer ═══════════════════════ */

  const FILES = [
    { name: "reconnect-trace.log", ic: "file" },
    { name: "heartbeat.png", ic: "image" },
    { name: "flake-run-17.txt", ic: "file" },
  ];

  function mountComposer(app, dir, { inner, transcript, pin, dock }) {
    const composer = app.querySelector(".composer");
    const ta = composer.querySelector("textarea");
    const send = composer.querySelector(".send");
    const attWrap = composer.querySelector(".attachments-wrap");
    const att = composer.querySelector(".attachments");
    const toolbar = composer.querySelector(".toolbar");
    const glyph = app.querySelector('.sb-row[aria-current="true"] .glyph');
    const mirror = el('<div class="ta-mirror" aria-hidden="true"></div>');
    composer.appendChild(mirror);
    const MIN = ta.offsetHeight;
    let attachments = [];
    let ready = false;

    if (dir === "a") C.glide(toolbar, ".tb");

    function fit() {
      mirror.style.width = `${ta.clientWidth}px`;
      mirror.textContent = `${ta.value}​`;
      ta.style.height = `${Math.max(MIN, Math.min(240, mirror.offsetHeight))}px`;
      updateReady();
    }

    function updateReady() {
      const r = ta.value.trim().length > 0 || attachments.length > 0;
      if (r === ready) return;
      ready = r;
      send.toggleAttribute("data-ready", r);
      if (r && dir === "b")
        anim(send, [{ transform: "scale(.8)" }, { transform: "none" }], {
          duration: SPR.pop.duration,
          easing: SPR.pop.easing,
        });
    }

    ta.addEventListener("input", fit);
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        submit();
      }
      if (e.key === "Escape" && running) {
        e.preventDefault();
        stop();
      }
    });

    /* Attachments. */
    function addAttachment(fromBtn) {
      const f = FILES[attachments.length % FILES.length];
      const item = { ...f };
      attachments.push(item);
      const chip = el(
        `<span class="att-chip"><span class="thumb">${icon(f.ic, "xs")}</span>${esc(f.name)}<button class="x" type="button" aria-label="Remove ${esc(f.name)}">${icon("x", "xs")}</button></span>`,
      );
      chip.querySelector(".x").addEventListener("click", () => removeAttachment(item, chip));
      C.heightTween(attWrap, () => att.appendChild(chip), {
        duration: dir === "c" ? 140 : dir === "b" ? SPR.soft.duration : 220,
        easing: dir === "b" ? SPR.soft.easing : EASE.out,
      });
      if (dir === "a") {
        anim(
          chip,
          [
            { opacity: 0, transform: "scale(.94)" },
            { opacity: 1, transform: "none" },
          ],
          { duration: 180 },
        );
      } else if (dir === "b") {
        const p = fromBtn.getBoundingClientRect();
        const c = chip.getBoundingClientRect();
        chip.style.transformOrigin = "0 0";
        anim(
          chip,
          [
            {
              opacity: 0,
              transform: `translate(${p.left - c.left}px, ${p.top - c.top}px) scale(.35)`,
            },
            { opacity: 1, transform: "none" },
          ],
          { duration: SPR.soft.duration, easing: SPR.soft.easing },
        );
      } else {
        anim(
          chip,
          [
            { opacity: 0, transform: "translateX(-6px)" },
            { opacity: 1, transform: "none" },
          ],
          {
            duration: 120,
          },
        );
      }
      updateReady();
    }

    function removeAttachment(item, chip) {
      attachments = attachments.filter((x) => x !== item);
      updateReady();
      anim(
        chip,
        [
          { opacity: 1, transform: "none" },
          { opacity: 0, transform: "scale(.9)" },
        ],
        {
          duration: 120,
          keep: true,
        },
      ).finished.then(() => {
        const others = [...att.children].filter((c) => c !== chip);
        C.heightTween(attWrap, () => C.flip(others, () => chip.remove(), { duration: 200 }), {
          duration: 200,
        });
        ta.focus({ preventScroll: true });
      });
    }

    composer.addEventListener("dragover", (e) => {
      e.preventDefault();
      composer.toggleAttribute("data-drag", true);
    });
    composer.addEventListener("dragleave", () => composer.removeAttribute("data-drag"));
    composer.addEventListener("drop", (e) => {
      e.preventDefault();
      composer.removeAttribute("data-drag");
      addAttachment(composer.querySelector('[data-act="attach"]'));
    });

    /* Running a turn. */
    let running = false;
    let timers = [];
    let tick = null;
    let startAt = 0;
    let workingEl = null;
    let streamEl = null;

    function setRunning(on) {
      running = on;
      composer.toggleAttribute("data-running", on);
      dock.toggleAttribute("data-running", on);
      send.setAttribute("aria-label", on ? "Stop" : "Send");
      if (glyph) glyph.dataset.state = on ? "working" : "";
      app.querySelector('.sb-row[aria-current="true"] .time').textContent = on ? "now" : "now";
    }

    function appendMessage(m) {
      state.messages.push(m);
      const node = el(messageHTML(m));
      inner.appendChild(node);
      return node;
    }

    function submit() {
      if (running) {
        stop();
        return;
      }
      const text = ta.value.trim();
      if (!text && !attachments.length) {
        C.shake(send);
        ta.focus();
        return;
      }
      const from = ta.getBoundingClientRect();
      const node = appendMessage({ role: "user", html: esc(text), att: attachments.slice() });
      nearBottomForce();
      ta.value = "";
      if (attachments.length) {
        attachments = [];
        C.heightTween(attWrap, () => att.replaceChildren(), { duration: 180 });
      }
      fit();
      enterUser(node, from);
      startRun();
    }

    function nearBottomForce() {
      transcript.scrollTop = transcript.scrollHeight;
    }

    function enterUser(node, from) {
      if (dir === "b") {
        const r = node.getBoundingClientRect();
        node.style.transformOrigin = "100% 0";
        anim(
          node,
          [
            {
              transform: `translate(${from.left + 18 - r.left}px, ${from.top + 14 - r.top}px)`,
              backgroundColor: "transparent",
              opacity: 0.6,
            },
            { transform: "none", opacity: 1 },
          ],
          { duration: SPR.morph.duration, easing: SPR.morph.easing },
        );
      } else if (dir === "c") {
        anim(
          node,
          [
            { opacity: 0, transform: "translateY(6px)" },
            { opacity: 1, transform: "none" },
          ],
          {
            duration: 140,
          },
        );
      } else {
        anim(
          node,
          [
            { opacity: 0, transform: "translateY(10px)" },
            { opacity: 1, transform: "none" },
          ],
          {
            duration: 240,
          },
        );
      }
    }

    function startRun() {
      setRunning(true);
      startAt = performance.now();
      workingEl = el(
        '<div class="working"><span class="shimmer">Working</span><span class="elapsed">0s</span></div>',
      );
      inner.appendChild(workingEl);
      anim(workingEl, [{ opacity: 0 }, { opacity: 1 }], { duration: 200, delay: 120 });
      pin();
      tick = setInterval(updateElapsed, 250);
      updateElapsed();
      timers.push(setTimeout(streamReply, wait(2400)));
    }

    function updateElapsed() {
      const s = Math.floor((performance.now() - startAt) / 1000);
      send.querySelector(".stop-label").textContent = `Stop 0:${String(s).padStart(2, "0")}`;
      workingEl?.querySelector(".elapsed") &&
        (workingEl.querySelector(".elapsed").textContent = `${s}s`);
    }

    function streamReply() {
      const m = { role: "ai", worklog: ["Explored 2 files", "Edited 1 file"], html: "<p></p>" };
      state.messages.push(m);
      streamEl = el(messageHTML(m));
      workingEl.replaceWith(streamEl);
      workingEl = null;
      const p = streamEl.querySelector("p");
      const words = REPLY.split(" ");
      let i = 0;
      const step = () => {
        p.textContent = words.slice(0, ++i).join(" ");
        m.html = `<p>${esc(p.textContent)}</p>`;
        pin();
        if (i < words.length) timers.push(setTimeout(step, 34));
        else finish();
      };
      step();
    }

    function finish() {
      clearInterval(tick);
      timers.forEach(clearTimeout);
      timers = [];
      streamEl = null;
      setRunning(false);
      const val = composer.querySelector(".ctx .val");
      val.style.strokeDashoffset = String(
        Math.max(8, parseFloat(val.getAttribute("stroke-dashoffset")) - 6),
      );
      val.setAttribute("stroke-dashoffset", val.style.strokeDashoffset);
    }

    function stop() {
      if (!running) return;
      if (workingEl) {
        const note = { role: "note", html: "Stopped before the agent replied." };
        state.messages.push(note);
        const n = el(messageHTML(note));
        workingEl.replaceWith(n);
        workingEl = null;
        anim(n, [{ opacity: 0 }, { opacity: 1 }], { duration: 160 });
      } else if (streamEl) {
        const n = el('<span class="stopped-note"> — stopped</span>');
        streamEl.querySelector("p").appendChild(n);
        state.messages.at(-1).html += '<p class="stopped-note">Stopped.</p>';
      }
      finish();
      ta.focus({ preventScroll: true });
    }

    /* Toolbar. */
    toolbar.addEventListener("click", (e) => {
      const b = e.target.closest("[data-act]");
      if (!b) return;
      const act = b.dataset.act;
      if (act === "attach") addAttachment(b);
      if (act === "send") submit();
      if (act === "model") openModelPicker(app, b, dir);
      if (act === "machine") openMachineMenu(app, b, dir);
      if (act === "access") toggleAccess(b, dir);
    });

    fit();
    return {
      dispose() {
        clearInterval(tick);
        timers.forEach(clearTimeout);
        if (running && workingEl)
          state.messages.push({ role: "note", html: "Stopped before the agent replied." });
      },
    };
  }

  function toggleAccess(b, dir) {
    const full = b.dataset.full === "true";
    b.dataset.full = String(!full);
    b.classList.toggle("access", !full);
    b.title = full ? "Ask before edits" : "Full access";
    b.setAttribute("aria-label", b.title);
    C.swapIcon(b, icon(full ? "lock" : "lock-open", "sm"), {
      easing: dir === "c" ? EASE.out : SPR.pop.easing,
      duration: dir === "c" ? 140 : SPR.pop.duration,
    });
    const app = b.closest(".app");
    C.toast(app, {
      variant: dir,
      iconName: full ? "lock" : "lock-open",
      title: full ? "Asks before edits" : "Full access",
      sub: full
        ? "The agent pauses before it changes files."
        : "The agent edits and runs commands without asking.",
      timeout: 2600,
    });
  }

  /* ═══════════════════════ Pickers ═══════════════════════ */

  function openModelPicker(app, trigger, dir) {
    const open = C.isOpenFor(trigger);
    if (open) return open.close("toggle");
    const content = el(`<div class="mp">
      <div class="mp-search">${icon("search", "sm")}<input type="text" placeholder="Search models…" aria-label="Search models" autocomplete="off" spellcheck="false"></div>
      <div class="mp-list" role="listbox" aria-label="Models"></div>
      <div class="mp-effort"><span>Effort</span><div class="seg" role="group" aria-label="Effort"><span class="seg-thumb"></span>${EFFORTS.map((e) => `<button type="button" aria-pressed="${e === state.effort}">${e}</button>`).join("")}</div></div>
    </div>`);
    const list = content.querySelector(".mp-list");
    const input = content.querySelector("input");
    const g = C.glide(list, ".mp-item");
    let items = [];
    let hl = -1;

    function renderList(q = "") {
      list.querySelectorAll(".mp-group, .mp-item, .hint").forEach((n) => n.remove());
      items = [];
      for (const grp of MODELS) {
        const hits = grp.items.filter(([n]) => n.toLowerCase().includes(q.toLowerCase()));
        if (!hits.length) continue;
        list.appendChild(el(`<div class="mp-group">${grp.group}</div>`));
        for (const [name, k] of hits) {
          const b = el(
            `<button class="mp-item" type="button" role="option" aria-selected="${name === state.model.name}">${brand(grp.brand)}<span class="name">${name}</span><kbd>${k}</kbd>${icon("check", "sm check")}</button>`,
          );
          b.addEventListener("click", () => pick(name, grp.brand));
          list.appendChild(b);
          items.push(b);
        }
      }
      if (!items.length)
        list.appendChild(el('<div class="hint" style="padding:10px">No models match.</div>'));
      setHl(q ? 0 : -1);
    }

    function setHl(i) {
      items.forEach((n) => n.removeAttribute("data-hl"));
      hl = i;
      const it = items[i];
      if (!it) return g.moveTo(null);
      it.dataset.hl = "";
      it.scrollIntoView({ block: "nearest" });
      g.moveTo(it);
    }

    renderList();
    const h = C.popover({
      trigger,
      content,
      side: "top",
      align: "start",
      enter: POP_ENTER[dir],
      label: "Model",
    });

    input.addEventListener("input", () => renderList(input.value));
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHl(Math.min(items.length - 1, hl + 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setHl(Math.max(0, hl - 1));
      } else if (e.key === "Enter") {
        e.preventDefault();
        (items[hl] ?? items[0])?.click();
      }
    });

    const seg = content.querySelector(".seg");
    const thumb = seg.querySelector(".seg-thumb");
    const segBtns = [...seg.querySelectorAll("button")];
    const place = (b, instant) => {
      if (instant) thumb.style.transition = "none";
      thumb.style.width = `${b.offsetWidth}px`;
      thumb.style.transform = `translateX(${b.offsetLeft}px)`;
      if (instant) {
        void thumb.offsetWidth;
        thumb.style.transition = "";
      }
    };
    place(
      segBtns.find((b) => b.textContent === state.effort),
      true,
    );
    segBtns.forEach((b) =>
      b.addEventListener("click", () => {
        segBtns.forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
        place(b);
        state.effort = b.textContent;
        C.rollText(trigger.querySelector(".effort"), state.effort);
      }),
    );

    function pick(name, brandName) {
      const changed = name !== state.model.name;
      state.model = { name, brand: brandName };
      h.close("pick");
      if (!changed) return;
      C.rollText(trigger.querySelector(".model-roll"), name);
      const holder = trigger.querySelector(".brand-holder");
      if (holder.dataset.brand !== brandName) {
        holder.dataset.brand = brandName;
        C.swapIcon(holder, brand(brandName));
      }
    }

    requestAnimationFrame(() => input.focus({ preventScroll: true }));
  }

  function openMenu(app, trigger, dir, { label, items, onPick }) {
    const open = C.isOpenFor(trigger);
    if (open) return open.close("toggle");
    const content = el(
      `<div class="menu" role="menu">${label ? `<div class="menu-label">${label}</div>` : ""}</div>`,
    );
    const g = C.glide(content, ".menu-item");
    const btns = items.map((it) => {
      const b = el(
        `<button class="menu-item${it.sub ? " two" : ""}" role="menuitemradio" aria-checked="${!!it.selected}" aria-selected="${!!it.selected}" type="button">${icon(it.icon, "sm")}<span class="name">${esc(it.label)}${it.sub ? `<div class="sub">${esc(it.sub)}</div>` : ""}</span>${icon("check", "sm check")}</button>`,
      );
      b.addEventListener("click", () => {
        h.close("pick");
        onPick(it);
      });
      content.appendChild(b);
      return b;
    });
    content.addEventListener("focusin", (e) => {
      const b = e.target.closest(".menu-item");
      if (b) g.moveTo(b);
    });
    content.addEventListener("keydown", (e) => {
      const i = btns.indexOf(document.activeElement);
      if (e.key === "ArrowDown") {
        e.preventDefault();
        btns[(i + 1) % btns.length].focus();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        btns[(i - 1 + btns.length) % btns.length].focus();
      }
    });
    const h = C.popover({
      trigger,
      content,
      side: "top",
      align: "start",
      enter: POP_ENTER[dir],
      label,
    });
    requestAnimationFrame(() => h.el.focus({ preventScroll: true }));
    h.el.addEventListener("keydown", (e) => {
      if (
        (e.key === "ArrowDown" || e.key === "ArrowUp") &&
        !btns.includes(document.activeElement)
      ) {
        e.preventDefault();
        btns[0].focus();
      }
    });
    return h;
  }

  function openMachineMenu(app, trigger, dir) {
    const machines = [
      { label: "MacBook Pro M5", sub: "This machine", icon: "laptop" },
      { label: "build-box", sub: "Remote · Tailscale", icon: "server" },
    ];
    openMenu(app, trigger, dir, {
      label: "Run on",
      items: machines.map((m) => ({ ...m, selected: m.label === state.machine })),
      onPick(m) {
        if (m.label === state.machine) return;
        state.machine = m.label;
        C.rollText(trigger.querySelector(".machine-roll"), m.label);
      },
    });
  }

  function openIconPopover(app, trigger, dir, current, onPick) {
    const open = C.isOpenFor(trigger);
    if (open) return open.close("toggle");
    const content = el(
      `<div class="icon-grid" role="radiogroup" aria-label="Icon">${ICON_LIST.map(([id, label]) => `<button type="button" class="icon-opt" role="radio" data-icon="${id}" aria-checked="${id === current}">${icon(ICON[id])}<span>${label}</span></button>`).join("")}</div>`,
    );
    const g = C.glide(content, ".icon-opt");
    const opts = [...content.querySelectorAll(".icon-opt")];
    const h = C.popover({
      trigger,
      content,
      side: "bottom",
      align: "start",
      enter: POP_ENTER[dir],
      label: "Choose icon",
    });
    content.addEventListener("click", (e) => {
      const o = e.target.closest(".icon-opt");
      if (!o) return;
      onPick(o.dataset.icon);
      h.close("pick");
    });
    let i = Math.max(
      0,
      opts.findIndex((o) => o.dataset.icon === current),
    );
    content.addEventListener("keydown", (e) => {
      const m = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 3, ArrowUp: -3 }[e.key];
      if (!m) return;
      e.preventDefault();
      i = (i + m + opts.length) % opts.length;
      opts[i].focus();
    });
    content.addEventListener("focusin", (e) => {
      const o = e.target.closest(".icon-opt");
      if (o) g.moveTo(o);
    });
    requestAnimationFrame(() => opts[i].focus({ preventScroll: true }));
  }

  /* ═══════════════════════ Actions: chips, save, delete ═══════════════════════ */

  const chipsOf = (app) => app.querySelector(".hdr-actions");

  function flashChip(app, chip) {
    const tone = getComputedStyle(app).getPropertyValue("--info-foreground").trim() || "#3b82f6";
    anim(
      chip,
      [
        { backgroundColor: `color-mix(in srgb, ${tone} 24%, transparent)` },
        { backgroundColor: "transparent" },
      ],
      {
        duration: 900,
      },
    );
  }

  function insertChip(app, dir, a, { index, hidden = false } = {}) {
    const wrap = chipsOf(app);
    const chip = el(chipHTML(a));
    const others = [...wrap.children];
    C.flip(
      others,
      () => {
        const ref = index != null ? wrap.children[index] : null;
        wrap.insertBefore(chip, ref ?? null);
      },
      { duration: dir === "c" ? 160 : 280, easing: dir === "b" ? SPR.soft.easing : EASE.out },
    );
    if (hidden) {
      chip.style.opacity = "0";
      return chip;
    }
    if (dir === "a")
      anim(
        chip,
        [
          { opacity: 0, transform: "scale(.9)" },
          { opacity: 1, transform: "none" },
        ],
        { duration: 220 },
      );
    if (dir === "b")
      anim(
        chip,
        [
          { opacity: 0, transform: "scale(.6)" },
          { opacity: 1, transform: "none" },
        ],
        {
          duration: SPR.pop.duration,
          easing: SPR.pop.easing,
        },
      );
    if (dir === "c") {
      anim(
        chip,
        [
          { opacity: 0, transform: "translateX(10px)" },
          { opacity: 1, transform: "none" },
        ],
        {
          duration: 150,
        },
      );
      flashChip(app, chip);
    }
    return chip;
  }

  function updateChip(app, dir, a, { hidden = false } = {}) {
    const wrap = chipsOf(app);
    const old = wrap.querySelector(`[data-id="${a.id}"]`);
    const fresh = el(chipHTML(a));
    if (!old) return insertChip(app, dir, a, { hidden });
    const others = [...wrap.children].filter((c) => c !== old);
    C.flip(others, () => old.replaceWith(fresh), { duration: 240 });
    if (hidden) fresh.style.opacity = "0";
    else if (dir === "c") flashChip(app, fresh);
    else
      anim(
        fresh,
        [
          { opacity: 0.4, transform: "scale(.96)" },
          { opacity: 1, transform: "none" },
        ],
        { duration: 220 },
      );
    return fresh;
  }

  function removeChip(app, dir, id) {
    const wrap = chipsOf(app);
    const chip = wrap.querySelector(`[data-id="${id}"]`);
    if (!chip) return;
    anim(
      chip,
      [
        { opacity: 1, transform: "none" },
        { opacity: 0, transform: dir === "c" ? "translateX(8px)" : "scale(.88)" },
      ],
      {
        duration: dir === "c" ? 100 : 150,
        keep: true,
      },
    ).finished.then(() => {
      const others = [...wrap.children].filter((c) => c !== chip);
      C.flip(others, () => chip.remove(), {
        duration: 240,
        easing: dir === "b" ? SPR.soft.easing : EASE.out,
      });
    });
  }

  function formFrom(a) {
    return a
      ? { name: a.name, icon: a.icon, command: a.command, combo: a.combo, autorun: a.autorun }
      : { name: "", icon: "play", command: "", combo: null, autorun: false };
  }

  function validate(form, self) {
    const e = {};
    if (!form.name.trim()) e.name = "Give the action a name.";
    if (!form.command.trim()) e.command = "Add the command it runs.";
    if (form.combo) {
      const other = state.actions.find(
        (x) => x !== self && x.combo && C.comboText(x.combo) === C.comboText(form.combo),
      );
      if (other) e.combo = `${C.comboText(form.combo)} already runs “${other.name}”.`;
    }
    return Object.keys(e).length ? e : null;
  }

  function commit(form, { mode, action }) {
    const clean = { ...form, name: form.name.trim(), command: form.command.trim() };
    if (mode === "add") {
      const a = { id: `a${Date.now().toString(36)}`, ...clean };
      state.actions.push(a);
      return { a, isNew: true };
    }
    Object.assign(action, clean);
    return { a: action, isNew: false };
  }

  function toastSaved(app, dir, a, isNew) {
    C.toast(app, {
      variant: dir,
      title: isNew ? `Added “${esc(a.name)}”` : `Saved “${esc(a.name)}”`,
      sub: `<code style="font-family:var(--font-mono);font-size:11.5px">${esc(a.command)}</code>${a.combo ? ` · <kbd>${C.comboText(a.combo)}</kbd>` : ""}`,
      action: isNew
        ? {
            label: "Undo",
            onClick() {
              state.actions = state.actions.filter((x) => x !== a);
              removeChip(app, dir, a.id);
            },
          }
        : null,
    });
  }

  function deleteAction(app, dir, a) {
    const index = state.actions.indexOf(a);
    state.actions.splice(index, 1);
    removeChip(app, dir, a.id);
    C.toast(app, {
      variant: dir,
      iconName: "trash",
      title: `Deleted “${esc(a.name)}”`,
      sub: a.combo ? `<kbd>${C.comboText(a.combo)}</kbd> is free again.` : "",
      action: {
        label: "Undo",
        onClick() {
          state.actions.splice(index, 0, a);
          insertChip(app, dir, a, { index });
        },
      },
    });
  }

  /* Shared error display for A and B. */
  function showErrors(panel, errs) {
    panel.querySelectorAll(".reveal[data-err]").forEach((r) => {
      const k = r.dataset.err;
      r.toggleAttribute("data-show", !!errs?.[k]);
      if (errs?.[k]) r.querySelector(".err").textContent = errs[k];
    });
    panel
      .querySelectorAll("[data-field]")
      .forEach((f) => f.toggleAttribute("data-invalid", !!errs?.[f.dataset.field]));
    const first = ["name", "command", "combo"].find((k) => errs?.[k]);
    if (!first) return false;
    const target = panel.querySelector(`[data-field="${first}"]`);
    C.shake(target.closest("[data-shake]") ?? target);
    (target.matches("input,textarea,[tabindex]")
      ? target
      : target.querySelector("input,textarea")
    )?.focus({
      preventScroll: true,
    });
    return true;
  }

  function clearErr(panel, k) {
    panel.querySelector(`.reveal[data-err="${k}"]`)?.removeAttribute("data-show");
    panel.querySelector(`[data-field="${k}"]`)?.removeAttribute("data-invalid");
  }

  function errRow(k, pad = "") {
    return `<div class="reveal" data-err="${k}"><div><div class="err"${pad ? ` style="${pad}"` : ""}></div></div></div>`;
  }

  function openActionDialog(app, dir, opts) {
    ({ a: dialogA, b: dialogB, c: dialogC })[dir](app, opts);
  }

  /* ═══════════════════════ A · Hairline dialog ═══════════════════════ */

  const enterA = (panel) =>
    anim(
      panel,
      [
        { opacity: 0, transform: "translateY(6px) scale(.985)" },
        { opacity: 1, transform: "none" },
      ],
      {
        duration: 200,
      },
    ).finished;
  const exitA = (panel) =>
    anim(
      panel,
      [
        { opacity: 1, transform: "none" },
        { opacity: 0, transform: "scale(.985)" },
      ],
      {
        duration: 130,
        keep: true,
      },
    ).finished;

  function fieldsAB(form, dir) {
    return {
      command: `<div class="field" data-stagger><label for="f-cmd">Command</label>
        <div class="input cmd" data-field="command"><span class="prompt">$</span><textarea id="f-cmd" rows="${dir === "a" ? 2 : 1}" spellcheck="false" placeholder="bun lint">${esc(form.command)}</textarea></div>
        ${errRow("command")}</div>`,
      shortcut: `<div class="field" data-stagger><span class="field-label" id="f-key-l">Shortcut</span>
        <div class="input kbd-capture" data-field="combo" tabindex="0" role="textbox" aria-labelledby="f-key-l"></div>
        ${errRow("combo")}
        <div class="hint">Focus the field and press keys, e.g. ⌘⇧L. Backspace clears.</div></div>`,
      toggle: `<label class="toggle-row" data-stagger><span class="tr-text"><b>Run on new worktrees</b><small>Runs once, right after a worktree is created.</small></span><button type="button" role="switch" class="switch" aria-checked="${form.autorun}" aria-label="Run on new worktrees"></button></label>`,
    };
  }

  function wireForm(panel, form, dir, save) {
    const nameInput = panel.querySelector("#f-name");
    const cmd = panel.querySelector("#f-cmd");
    const sw = panel.querySelector(".switch");
    C.keyCapture(panel.querySelector(".kbd-capture"), {
      value: form.combo,
      variant: dir,
      onChange: (c) => {
        form.combo = c;
        clearErr(panel, "combo");
      },
    });
    nameInput.addEventListener("input", () => {
      form.name = nameInput.value;
      clearErr(panel, "name");
    });
    nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        cmd.focus();
      }
    });
    cmd.addEventListener("input", () => {
      form.command = cmd.value;
      clearErr(panel, "command");
    });
    sw.addEventListener("click", () => {
      form.autorun = !form.autorun;
      sw.setAttribute("aria-checked", String(form.autorun));
    });
    panel.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        save();
      }
    });
    return { nameInput, cmd };
  }

  function confirmDelete(app, dir, action, origin, onConfirm) {
    const panel =
      el(`<div class="modal ${dir} confirm" role="alertdialog" aria-modal="true" aria-labelledby="cf-t" tabindex="-1">
      <h2 id="cf-t" data-stagger>Delete “${esc(action.name)}”?</h2>
      <p data-stagger>It leaves the top bar${action.combo ? ` and <b>${C.comboText(action.combo)}</b> stops working` : ""}. You can undo this for a few seconds.</p>
      <div class="row" data-stagger><button class="btn ghost" type="button" data-close>Cancel</button><button class="btn danger-solid" type="button" data-ok>Delete</button></div>
    </div>`);
    const h = C.modal({
      app,
      panel,
      trigger: origin,
      enter: dir === "b" ? morphEnter(origin, { hideOrigin: false }) : enterA,
      exit: dir === "b" ? morphExitTo(() => origin) : exitA,
      initialFocus: () => panel.querySelector("[data-ok]"),
    });
    panel.querySelector("[data-close]").addEventListener("click", () => h.close("cancel"));
    panel.querySelector("[data-ok]").addEventListener("click", () => {
      h.close("deleted", { exit: exitA });
      onConfirm();
    });
  }

  function dialogA(app, { mode, action, trigger }) {
    const isEdit = mode === "edit";
    const form = formFrom(action);
    const f = fieldsAB(form, "a");
    const panel =
      el(`<div class="modal a" role="dialog" aria-modal="true" aria-labelledby="dlg-t" tabindex="-1">
      <div class="dlg-h"><div><h2 id="dlg-t">${isEdit ? "Edit action" : "New action"}</h2><p>Runs from the top bar or its shortcut, in this project only.</p></div>
        <button class="icon-btn" type="button" data-close aria-label="Close">${icon("x", "sm")}</button></div>
      <div class="dlg-b">
        <div class="field"><label for="f-name">Name</label>
          <div class="name-row"><button type="button" class="icon-pick" aria-label="Choose icon" aria-haspopup="dialog">${icon(ICON[form.icon])}</button><input id="f-name" data-field="name" class="input" autocomplete="off" placeholder="Lint" value="${esc(form.name)}"></div>
          ${errRow("name")}</div>
        ${f.command}${f.shortcut}${f.toggle}
      </div>
      <div class="dlg-f">${isEdit ? `<button class="btn danger" type="button" data-delete>${icon("trash", "sm")}Delete</button>` : ""}<span class="spacer"></span>
        <button class="btn ghost" type="button" data-close>Cancel</button>
        <button class="btn primary" type="button" data-save><span class="btn-face">${isEdit ? "Save changes" : "Save action"}<kbd>⌘↵</kbd></span></button></div>
    </div>`);
    const h = C.modal({
      app,
      panel,
      trigger,
      enter: enterA,
      exit: exitA,
      initialFocus: () => panel.querySelector("#f-name"),
    });
    const { nameInput } = wireForm(panel, form, "a", save);
    const pick = panel.querySelector(".icon-pick");
    pick.addEventListener("click", () =>
      openIconPopover(app, pick, "a", form.icon, (id) => {
        if (id === form.icon) return;
        form.icon = id;
        C.swapIcon(pick, icon(ICON[id]));
      }),
    );
    panel
      .querySelectorAll("[data-close]")
      .forEach((b) => b.addEventListener("click", () => h.close("cancel")));
    panel.querySelector("[data-delete]")?.addEventListener("click", (e) =>
      confirmDelete(app, "a", action, e.currentTarget, () => {
        h.close("deleted");
        deleteAction(app, "a", action);
      }),
    );

    let saving = false;
    function save() {
      if (saving) return;
      form.name = nameInput.value;
      if (showErrors(panel, validate(form, action))) return;
      saving = true;
      const face = panel.querySelector("[data-save] .btn-face");
      face.innerHTML = `${icon("check", "sm")}Saved`;
      anim(
        face,
        [
          { opacity: 0, transform: "translateY(4px)" },
          { opacity: 1, transform: "none" },
        ],
        { duration: 140 },
      );
      setTimeout(() => {
        h.close("saved");
        const { a, isNew } = commit(form, { mode, action });
        if (isNew) insertChip(app, "a", a);
        else updateChip(app, "a", a);
        toastSaved(app, "a", a, isNew);
      }, wait(220));
    }
    panel.querySelector("[data-save]").addEventListener("click", save);
  }

  /* ═══════════════════════ B · Morph dialog ═══════════════════════ */

  /* The dialog unfolds out of the element that opened it. */
  function morphEnter(origin, { hideOrigin = true } = {}) {
    return (panel, h) => {
      const from = C.relRect(origin, h.app);
      const to = C.relRect(panel, h.app);
      const m = C.morph({
        layer: h.layer,
        ghostClass: "dialog-b",
        from,
        to,
        fromRadius: C.radiusOf(origin),
        toRadius: C.radiusOf(panel, 20),
        before: h.wrap,
      });
      if (hideOrigin) {
        h.origin = origin;
        origin.animate([{ opacity: 1 }, { opacity: 0 }], { duration: C.dur(90), fill: "forwards" });
      }
      const t0 = SPR.morph.duration;
      anim(panel, [{ opacity: 0 }, { opacity: 1 }], { duration: 120, delay: t0 * 0.48 });
      panel.querySelectorAll("[data-stagger]").forEach((n, i) =>
        anim(
          n,
          [
            { opacity: 0, transform: "translateY(6px)" },
            { opacity: 1, transform: "none" },
          ],
          {
            duration: 260,
            delay: t0 * 0.42 + i * 38,
          },
        ),
      );
      return m.done.then((g) => g.remove());
    };
  }

  /* …and folds back into wherever its result now lives. */
  function morphExitTo(getTarget) {
    return (panel, h) => {
      const target = getTarget();
      const from = C.relRect(panel, h.app);
      anim(panel, [{ opacity: 1 }, { opacity: 0 }], { duration: 90, keep: true });
      const sp = { duration: 340, easing: EASE.house };
      const m = C.morph({
        layer: h.layer,
        ghostClass: "dialog-b",
        from,
        to: C.relRect(target, h.app),
        fromRadius: C.radiusOf(panel, 20),
        toRadius: C.radiusOf(target),
        sp,
        before: h.wrap,
      });
      anim(m.ghost, [{ opacity: 1 }, { opacity: 1, offset: 0.62 }, { opacity: 0 }], {
        duration: sp.duration,
        easing: "linear",
        keep: true,
      });
      if (h.origin) {
        h.origin.getAnimations().forEach((a) => a.cancel());
        anim(h.origin, [{ opacity: 0 }, { opacity: 1 }], {
          duration: 140,
          delay: sp.duration * 0.62,
        });
      }
      return m.done.then((g) => g.remove());
    };
  }

  function dialogB(app, { mode, action, trigger, origin }) {
    const isEdit = mode === "edit";
    const form = formFrom(action);
    const f = fieldsAB(form, "b");
    const panel =
      el(`<div class="modal b" role="dialog" aria-modal="true" aria-label="${isEdit ? "Edit action" : "New action"}" tabindex="-1">
      <div class="id-head" data-stagger>
        <button type="button" class="id-tile" aria-label="Choose icon" aria-expanded="false">${icon(ICON[form.icon])}</button>
        <div class="id-name" data-shake><input id="f-name" data-field="name" autocomplete="off" placeholder="Name this action" value="${esc(form.name)}" aria-label="Name"><small>${isEdit ? "Edit action" : "New action"} · runs from the top bar or its shortcut</small></div>
        <button class="icon-btn" type="button" data-close aria-label="Close">${icon("x", "sm")}</button>
      </div>
      <div class="reveal icon-row-wrap"><div><div class="icon-row" role="radiogroup" aria-label="Icon"><span class="sel" aria-hidden="true"></span>${ICON_LIST.map(([id, label]) => `<button type="button" class="icon-opt" role="radio" data-icon="${id}" aria-checked="${id === form.icon}">${icon(ICON[id])}<span>${label}</span></button>`).join("")}</div></div></div>
      ${errRow("name", "padding: 4px 18px 0 74px")}
      <div class="dlg-b">${f.command}${f.shortcut}${f.toggle}</div>
      <div class="dlg-f" data-stagger>${isEdit ? `<button class="btn danger" type="button" data-delete>${icon("trash", "sm")}Delete</button>` : ""}<span class="spacer"></span>
        <button class="btn ghost" type="button" data-close>Cancel</button>
        <button class="btn primary" type="button" data-save>${isEdit ? "Save changes" : "Save action"}<kbd>⌘↵</kbd></button></div>
    </div>`);
    const h = C.modal({
      app,
      panel,
      trigger,
      enter: morphEnter(origin),
      exit: morphExitTo(() => origin),
      initialFocus: () => panel.querySelector("#f-name"),
    });
    const { nameInput } = wireForm(panel, form, "b", save);

    /* Inline icon row: expands under the name, selection pill slides. */
    const tile = panel.querySelector(".id-tile");
    const rowWrap = panel.querySelector(".icon-row-wrap");
    const row = panel.querySelector(".icon-row");
    const sel = row.querySelector(".sel");
    rowWrap.style.transitionTimingFunction = "var(--spring-soft)";
    rowWrap.style.transitionDuration = "var(--t-slow)";
    function placeSel(instant) {
      const cur = row.querySelector('[aria-checked="true"]');
      if (instant) sel.style.transition = "none";
      sel.style.width = `${cur.offsetWidth}px`;
      sel.style.height = `${cur.offsetHeight}px`;
      sel.style.transform = `translate(${cur.offsetLeft}px, ${cur.offsetTop}px)`;
      if (instant) {
        void sel.offsetWidth;
        sel.style.transition = "";
      }
    }
    function toggleRow(force) {
      const open = force ?? !rowWrap.hasAttribute("data-show");
      rowWrap.toggleAttribute("data-show", open);
      tile.toggleAttribute("data-open", open);
      tile.setAttribute("aria-expanded", String(open));
      if (!open) return;
      placeSel(true);
      row.querySelectorAll(".icon-opt").forEach((o, i) =>
        anim(
          o,
          [
            { opacity: 0, transform: "translateY(-8px) scale(.85)" },
            { opacity: 1, transform: "none" },
          ],
          {
            duration: SPR.soft.duration,
            easing: SPR.soft.easing,
            delay: 40 + i * 30,
          },
        ),
      );
    }
    tile.addEventListener("click", () => toggleRow());
    row.addEventListener("click", (e) => {
      const o = e.target.closest(".icon-opt");
      if (!o) return;
      row
        .querySelectorAll(".icon-opt")
        .forEach((x) => x.setAttribute("aria-checked", String(x === o)));
      placeSel(false);
      if (o.dataset.icon !== form.icon) {
        form.icon = o.dataset.icon;
        C.swapIcon(tile, icon(ICON[form.icon]), {
          easing: SPR.pop.easing,
          duration: SPR.pop.duration,
        });
      }
      setTimeout(() => toggleRow(false), wait(320));
    });

    panel
      .querySelectorAll("[data-close]")
      .forEach((b) => b.addEventListener("click", () => h.close("cancel")));
    panel.querySelector("[data-delete]")?.addEventListener("click", (e) =>
      confirmDelete(app, "b", action, e.currentTarget, () => {
        h.close("deleted", { exit: exitA });
        deleteAction(app, "b", action);
      }),
    );

    function save() {
      form.name = nameInput.value;
      if (showErrors(panel, validate(form, action))) return;
      const { a, isNew } = commit(form, { mode, action });
      const chip = isNew
        ? insertChip(app, "b", a, { hidden: true })
        : updateChip(app, "b", a, { hidden: true });
      const d = 340;
      chip.style.opacity = "";
      anim(chip, [{ opacity: 0 }, { opacity: 1 }], { duration: d * 0.4, delay: d * 0.6 });
      h.close("saved", { exit: morphExitTo(() => chip) }).then(() => {
        anim(chip, [{ transform: "scale(1.08)" }, { transform: "none" }], {
          duration: SPR.pop.duration,
          easing: SPR.pop.easing,
        });
        toastSaved(app, "b", a, isNew);
      });
    }
    panel.querySelector("[data-save]").addEventListener("click", save);
  }

  /* ═══════════════════════ C · Command panel ═══════════════════════ */

  const enterC = (panel) =>
    anim(
      panel,
      [
        { opacity: 0, transform: "translateY(-8px)" },
        { opacity: 1, transform: "none" },
      ],
      {
        duration: 150,
      },
    ).finished;
  const exitC = (panel) =>
    anim(
      panel,
      [
        { opacity: 1, transform: "none" },
        { opacity: 0, transform: "translateY(-6px)" },
      ],
      {
        duration: 100,
        keep: true,
      },
    ).finished;

  function typeInto(input, text) {
    if (!Lab.mult) {
      input.value = text;
      return;
    }
    let i = 0;
    const chunk = Math.max(1, Math.ceil(text.length / 12));
    const step = () => {
      i = Math.min(text.length, i + chunk);
      input.value = text.slice(0, i);
      if (i < text.length) setTimeout(step, 14 * Lab.speed);
    };
    step();
  }

  function dialogC(app, { mode, action, trigger }) {
    const isEdit = mode === "edit";
    const form = formFrom(action);
    let nameTouched = isEdit;
    const panel =
      el(`<div class="modal c" role="dialog" aria-modal="true" aria-label="${isEdit ? "Edit action" : "New action"}" tabindex="-1">
      <div class="cp-top"><span>server</span>${icon("chevron-right", "xs")}<b>${isEdit ? `Edit “${esc(action.name)}”` : "New action"}</b><span class="spacer"></span><kbd>esc</kbd></div>
      <div class="cp-cmd" data-field="command"><span class="prompt">$</span><input id="f-cmd" type="text" spellcheck="false" autocomplete="off" placeholder="Command to run, or pick a script" value="${esc(form.command)}" aria-label="Command"></div>
      <div class="cp-sugg-wrap" style="overflow:hidden"><div class="cp-sugg" role="listbox" aria-label="Scripts"></div></div>
      <div class="cp-fields">
        <button type="button" class="icon-pick" aria-label="Choose icon">${icon(ICON[form.icon])}</button>
        <input class="input" id="f-name" data-field="name" placeholder="Name" autocomplete="off" value="${esc(form.name)}" aria-label="Name">
        <div class="input kbd-capture" data-field="combo" tabindex="0" role="textbox" aria-label="Shortcut"></div>
        <label class="cp-auto"><button type="button" role="switch" class="switch" aria-checked="${form.autorun}" aria-label="Run on new worktrees"></button>Run once on every new worktree</label>
      </div>
      <div class="reveal cp-err"><div><div class="err" style="padding: 0 16px 10px"></div></div></div>
      <div class="cp-foot"><span><kbd>↑↓</kbd> pick</span><span><kbd>↵</kbd> use</span><span><kbd>⌘↵</kbd> save</span><span class="spacer"></span>
        ${isEdit ? `<button class="btn danger hold" type="button" data-hold><span class="fill"></span><span class="btn-face">${icon("trash", "sm")}Hold to delete</span></button>` : ""}
        <button class="btn primary" type="button" data-save>Save</button></div>
    </div>`);
    const h = C.modal({
      app,
      panel,
      trigger,
      wrapClass: "top",
      enter: enterC,
      exit: exitC,
      initialFocus: () => panel.querySelector("#f-cmd"),
    });

    const cmd = panel.querySelector("#f-cmd");
    const nameInput = panel.querySelector("#f-name");
    const pick = panel.querySelector(".icon-pick");
    const cap = panel.querySelector(".kbd-capture");
    const sw = panel.querySelector(".switch");
    const wrap = panel.querySelector(".cp-sugg-wrap");
    const list = panel.querySelector(".cp-sugg");
    const errBox = panel.querySelector(".cp-err");
    const g = C.glide(list, ".cp-item");
    let items = [];
    let hl = 0;
    let shown = false;

    C.keyCapture(cap, {
      value: form.combo,
      variant: "c",
      onChange: (c) => {
        form.combo = c;
        hideErr();
      },
    });

    function setHl(i) {
      items.forEach((n) => n.removeAttribute("data-hl"));
      hl = i;
      if (!items[i]) return g.moveTo(null);
      items[i].dataset.hl = "";
      g.moveTo(items[i]);
    }

    function renderSugg() {
      const q = cmd.value.trim().toLowerCase();
      const hits = SUGG.filter(
        (s) => !q || s.command.includes(q) || s.name.toLowerCase().includes(q),
      );
      const exact = hits.length === 1 && hits[0].command === cmd.value.trim();
      const show = document.activeElement === cmd && hits.length > 0 && !exact;
      const wasShown = shown;
      shown = show;
      C.heightTween(
        wrap,
        () => {
          list.querySelectorAll(".cp-group,.cp-item").forEach((n) => n.remove());
          list.style.display = show ? "" : "none";
          if (!show) return;
          list.appendChild(el('<div class="cp-group">From package.json</div>'));
          hits.forEach((s) => {
            const b = el(
              `<button type="button" class="cp-item" role="option" tabindex="-1">${icon(ICON[s.icon], "sm")}<span>${s.name}</span><span class="cmdtext">${s.command}</span><span class="enter kbd">↵</span></button>`,
            );
            b.addEventListener("mousedown", (e) => e.preventDefault());
            b.addEventListener("click", () => apply(s));
            b.addEventListener("pointerenter", () => setHl(items.indexOf(b)));
            list.appendChild(b);
          });
        },
        { duration: 140 },
      );
      items = [...list.querySelectorAll(".cp-item")];
      if (show && !wasShown)
        items.forEach((n, i) =>
          anim(
            n,
            [
              { opacity: 0, transform: "translateY(4px)" },
              { opacity: 1, transform: "none" },
            ],
            {
              duration: 120,
              delay: i * 16,
            },
          ),
        );
      requestAnimationFrame(() => setHl(show ? 0 : -1));
    }

    function apply(s) {
      form.command = s.command;
      form.icon = s.icon;
      typeInto(cmd, s.command);
      if (!nameTouched || !nameInput.value.trim()) {
        form.name = s.name;
        nameInput.value = s.name;
        anim(
          nameInput,
          [
            { opacity: 0.2, transform: "translateY(3px)" },
            { opacity: 1, transform: "none" },
          ],
          {
            duration: 150,
            delay: 40,
          },
        );
      }
      C.swapIcon(pick, icon(ICON[s.icon]), { easing: EASE.out, duration: 160 });
      hideErr();
      cap.focus({ preventScroll: true });
      renderSugg();
    }

    cmd.addEventListener("focus", renderSugg);
    cmd.addEventListener("blur", () => setTimeout(renderSugg, 0));
    cmd.addEventListener("input", () => {
      form.command = cmd.value;
      hideErr();
      renderSugg();
    });
    cmd.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" && items.length) {
        e.preventDefault();
        setHl(Math.min(items.length - 1, hl + 1));
      } else if (e.key === "ArrowUp" && items.length) {
        e.preventDefault();
        setHl(Math.max(0, hl - 1));
      } else if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        if (items[hl]) items[hl].click();
        else nameInput.focus();
      }
    });
    nameInput.addEventListener("input", () => {
      nameTouched = true;
      form.name = nameInput.value;
      hideErr();
    });
    nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        cap.focus();
      }
    });
    sw.addEventListener("click", () => {
      form.autorun = !form.autorun;
      sw.setAttribute("aria-checked", String(form.autorun));
    });
    pick.addEventListener("click", () =>
      openIconPopover(app, pick, "c", form.icon, (id) => {
        if (id === form.icon) return;
        form.icon = id;
        C.swapIcon(pick, icon(ICON[id]), { easing: EASE.out, duration: 160 });
      }),
    );

    function hideErr() {
      errBox.removeAttribute("data-show");
      panel.querySelectorAll("[data-invalid]").forEach((n) => n.removeAttribute("data-invalid"));
    }

    function save() {
      form.name = nameInput.value;
      form.command = cmd.value;
      const errs = validate(form, action);
      if (errs) {
        const k = ["command", "name", "combo"].find((x) => errs[x]);
        errBox.querySelector(".err").textContent = errs[k];
        errBox.toggleAttribute("data-show", true);
        const target = panel.querySelector(`[data-field="${k}"]`);
        if (k !== "command") target.toggleAttribute("data-invalid", true);
        C.shake(target);
        (k === "command" ? cmd : target).focus({ preventScroll: true });
        return;
      }
      const { a, isNew } = commit(form, { mode, action });
      h.close("saved");
      if (isNew) insertChip(app, "c", a);
      else updateChip(app, "c", a);
      toastSaved(app, "c", a, isNew);
    }
    panel.querySelector("[data-save]").addEventListener("click", save);
    panel.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        save();
      }
    });

    /* Hold to delete: no second dialog. */
    const hold = panel.querySelector("[data-hold]");
    if (hold) {
      const fill = hold.querySelector(".fill");
      let run = null;
      const start = (e) => {
        if (e.type === "keydown" && e.key !== " " && e.key !== "Enter") return;
        if (e.repeat) return;
        e.preventDefault();
        run?.cancel();
        run = fill.animate([{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], {
          duration: 700 * (Lab.reduced ? 1 : Lab.speed),
          easing: "linear",
          fill: "forwards",
        });
        run.finished
          .then(() => {
            h.close("deleted");
            deleteAction(app, "c", action);
          })
          .catch(() => {});
      };
      const cancel = () => {
        if (!run || run.playState === "finished") return;
        const now = getComputedStyle(fill).transform;
        run.cancel();
        run = null;
        fill.animate([{ transform: now }, { transform: "scaleX(0)" }], {
          duration: C.dur(180),
          easing: EASE.out,
        });
      };
      hold.addEventListener("pointerdown", start);
      hold.addEventListener("keydown", start);
      ["pointerup", "pointerleave", "pointercancel", "keyup", "blur"].forEach((t) =>
        hold.addEventListener(t, cancel),
      );
    }
  }

  /* ═══════════════════════ Notes ═══════════════════════ */

  const tok = (k, v) => `<li class="tok"><span>${k}</span><span>${v}</span></li>`;

  const NOTES = {
    today: `<h2>Today</h2>
      <p class="lede">What main paints right now, captured from a dev instance (430fda4c7). Four overlay materials, and liquid glass on the surface you look at most.</p>
      <h3>Where the glass is</h3><ul>
        <li><b>Composer.</b> <code>ComposerLiquidGlass</code>: a 52% / 40% plate with <code>blur(24px) saturate(185%)</code>, SVG refraction in Chromium, a sheen, and two gradient rims that follow the pointer. This is on at every transparency step. Even Solid keeps a 93% + <code>blur(10px)</code> floor.</li>
        <li><b>Dialogs.</b> A white 48% scrim plus <code>backdrop-blur-[2px]</code> over the whole app, an inset top highlight, a muted footer band, and the toggle boxed inside the card.</li>
        <li><b>Popovers.</b> <code>.selection-glass-surface</code> with inset highlights and a double shadow. Above Solid, the enhancer in <code>main.tsx</code> also attaches refraction, a sheen, and rims.</li>
        <li><b>Toasts.</b> The composer's rims over a 52% plate.</li></ul>
      <h3>What it costs</h3><ul>
        <li>The rim reads as a second border that moves when the pointer moves anywhere on screen.</li>
        <li>No single rule for elevation: composer, dialog, popover and toast all use different materials.</li>
        <li>The biggest persistent surface carries the most expensive paint, and it repaints on every frame the transcript scrolls under it.</li>
        <li>Motion is one 200&nbsp;ms fade/scale for everything, so nothing shows where a surface came from or where its result went.</li></ul>
      <h3>Kept in every direction</h3><ul>
        <li>Popovers stay translucent: one material for every popover (86% plate, <code>blur(16px)</code>, one hairline, one shadow). No rim, sheen or refraction.</li>
        <li>Solid composer, solid dialogs, and no backdrop blur behind dialogs.</li>
        <li>Every duration runs on <code>--speed</code>, so reduced motion zeroes it.</li></ul>`,
    a: `<h2>A · Hairline</h2>
      <p class="lede">One solid plane and one 1&nbsp;px line. The transcript fades out above the composer instead of blurring underneath it. Motion is quick and quiet: things respond at once and never travel far.</p>
      <h3>Surfaces</h3><ul>
        ${tok("Composer", "<code>--card</code>, 1px <code>--border</code>, r16, no blur. Focus: border to fg 22% plus a 3px ring")}
        ${tok("Under it", "The transcript masks out over 40px above the composer. No plate behind the content")}
        ${tok("Dialog", "Solid <code>--popover</code>, 1px border, r16. Flat 20% / 50% scrim, no blur, no footer band")}
        ${tok("Fields", "Outlined inputs. The toggle sits on a hairline, not in a box")}
        ${tok("Overlays", "The shared 86% material for menus, the picker and toasts")}</ul>
      <h3>Motion</h3><ul>
        ${tok("Press", "110ms, scale .97")}
        ${tok("Hover", "One highlight glides between toolbar items, list rows and icon tiles")}
        ${tok("Popover", "170ms ease-out, scaled from the trigger's edge. Exit 110ms")}
        ${tok("Dialog", "200ms: rises 6px from .985. Exit 130ms")}
        ${tok("Running", "A hairline sweeps along the composer's top edge. Send turns into stop")}
        ${tok("Labels", "The model, effort and machine names roll instead of jumping")}
        ${tok("Errors", "Height reveal plus a 280ms shake")}</ul>
      <h3>Try</h3><ul class="try">
        <li>Type a few lines; the height eases. Attach twice, then remove one.</li>
        <li>Send, then stop. Open the model picker and use ↑ ↓ ↵. Change the effort.</li>
        <li>Add action, then Save with the name empty.</li>
        <li>Pick an icon, record ⌘⇧L, save, then press ⌘⇧L anywhere.</li>
        <li>Hover the new chip, then click the slider icon and Delete.</li></ul>
      <h3>Port</h3><ul>
        <li>Delete <code>ComposerLiquidGlass</code> and the enhancer import in <code>main.tsx</code>. The composer class becomes <code>bg-card border</code>. Set <code>--app-composer-filter: none</code>.</li>
        <li><code>DialogViewport</code>: drop <code>backdrop-blur-[2px]</code> and use a flat scrim. Make <code>DialogFooter</code> default to <code>bare</code>.</li>
        <li>Fold <code>.selection-glass-surface</code> and <code>.app-toast-surface</code> into one overlay class. Remove the toast rings.</li></ul>`,
    b: `<h2>B · Morph</h2>
      <p class="lede">No borders at all; surfaces separate by tone. Things grow out of what you clicked and fold back into where the result lives. The dialog unfolds from Add action, and the saved action lands in the top bar.</p>
      <h3>Surfaces</h3><ul>
        ${tok("Composer", "Tone 1 (fg 4% / white 6%), r22, no border. Focus moves it one tone up")}
        ${tok("Under it", "Same fade as A; still no blur")}
        ${tok("Chips", "Pills, tone 3 on hover")}
        ${tok("Dialog", "Solid, borderless, one soft shadow, r20. Filled fields instead of outlined ones")}
        ${tok("Overlays", "The shared material. It grows out of the chip that opened it")}</ul>
      <h3>Motion</h3><ul>
        ${tok("Curves", "Real springs (CSS <code>linear()</code>, ζ≈0.8) for anything that changes size")}
        ${tok("Container", "Popovers and dialogs morph from the trigger's rect. Content fades in at about 45%")}
        ${tok("Save", "The dialog collapses into the new chip; neighbours slide over (FLIP)")}
        ${tok("Cancel", "The dialog folds back into Add action, which is hidden while it's open")}
        ${tok("Composer", "Attachments fly out of the paperclip and sent text flies up into the thread. Stop grows into a timed pill")}
        ${tok("Icon", "The picker expands inline and a selection pill slides between icons")}
        ${tok("Shortcut", "Keycaps drop in one after another")}</ul>
      <h3>Try</h3><ul class="try">
        <li>Add action, then Cancel, and watch the button.</li>
        <li>Add again: click the icon tile, pick an icon, name it, and save.</li>
        <li>Edit a chip, then Delete. The confirm grows out of the button.</li>
        <li>Attach three times. Send, then watch the stop pill.</li>
        <li>Switch on ¼× slow-mo to see the hand-offs.</li></ul>
      <h3>Port</h3><ul>
        <li>A shared <code>useContainerTransform(originRef)</code> in <code>components/ui/</code>. A childless ghost animates its rect. One layout box, no backdrop filter, and the dialog content stays unscaled.</li>
        <li><code>DialogPopup</code> takes <code>morphFrom</code>. base-ui popovers already expose the anchor rect.</li>
        <li>Spring tokens go next to <code>--app-motion-spring-*</code> as generated <code>linear()</code> curves.</li></ul>`,
    c: `<h2>C · Dock</h2>
      <p class="lede">The flattest option. The composer is a tray docked under one rule instead of a floating card, so nothing ever scrolls beneath it and it needs no material at all. Dialogs become a keyboard-first command panel.</p>
      <h3>Surfaces</h3><ul>
        ${tok("Composer", "Page background, a 1px top rule, zero radius, zero shadow")}
        ${tok("Running", "A segment travels along the rule")}
        ${tok("Panel", "Anchored at the top like ⌘K. Solid, 1px border, r12, flat scrim")}
        ${tok("Overlays", "The shared material. Slides 6px out of the dock")}</ul>
      <h3>Motion</h3><ul>
        ${tok("Tempo", "90–150ms, at most 8px of travel, no springs on layout")}
        ${tok("Keyboard", "↑ ↓ moves a gliding highlight, ↵ applies, ⌘↵ saves, esc closes")}
        ${tok("Autofill", "Picking a script types the command and fills the name and icon in one beat. The list collapses and focus jumps to the shortcut")}
        ${tok("Delete", "Hold to confirm. A fill sweeps across the button, with no second dialog")}
        ${tok("Hints", "Key hints fade in only while the composer has focus")}</ul>
      <h3>Try</h3><ul class="try">
        <li>Add action, type <code>lint</code>, press ↵, record a shortcut, then ⌘↵.</li>
        <li>Edit a chip, then hold Delete and let go halfway.</li>
        <li>Send, watch the rule, then press esc to stop.</li></ul>
      <h3>Port</h3><ul>
        <li>The panel reuses <code>CommandDialog</code> positioning from <code>command.tsx</code> with a solid surface.</li>
        <li>Script suggestions need the server to read package.json scripts (a new RPC). Everything else is front-end only.</li>
        <li>The docked composer changes ChatView's bottom layout. The phone tier stays untouched.</li></ul>`,
  };

  /* ═══════════════════════ Today gallery ═══════════════════════ */

  function todayView() {
    const fig = (src, b, text) =>
      `<figure><img src="screens/${src}" alt="${esc(b)}" loading="lazy"><figcaption><b>${b}</b> ${text}</figcaption></figure>`;
    return el(`<div class="today">
      ${fig("today-thread-dark.png", "Composer, dark.", "A liquid plate with a gradient rim that tracks the pointer and a sheen across the top.")}
      ${fig("today-picker-dark.png", "Model picker.", "A glass popover over the glass composer: two materials touching.")}
      ${fig("today-add-action.png", "Add Action.", "A blurred white scrim over the whole app, outlined fields, a muted footer band, and the toggle boxed inside the card.")}
      ${fig("today-icon-picker.png", "Icon picker.", "A glass popover on a solid dialog on a blurred app: three materials stacked.")}
      ${fig("today-chat.png", "Composer, light.", "The rim almost vanishes on white, so the composer's edge depends on a shadow.")}
    </div>`);
  }

  /* ═══════════════════════ Lab chrome ═══════════════════════ */

  const stage = document.getElementById("stage");
  const notes = document.getElementById("notes");
  const main = document.getElementById("lab-main");
  const tabs = [...document.querySelectorAll(".lab-tabs button")];
  const thumb = document.querySelector(".lab-tabs-thumb");
  let teardown = null;

  function placeTabThumb(instant) {
    const t = tabs.find((b) => b.dataset.dir === state.dir);
    if (instant) thumb.style.transition = "none";
    thumb.style.width = `${t.offsetWidth}px`;
    thumb.style.transform = `translateX(${t.offsetLeft}px)`;
    if (instant) {
      void thumb.offsetWidth;
      thumb.style.transition = "";
    }
  }

  function render() {
    teardown?.();
    teardown = null;
    C.stack.splice(0);
    tabs.forEach((b) => b.setAttribute("aria-selected", String(b.dataset.dir === state.dir)));
    placeTabThumb(false);
    notes.innerHTML = NOTES[state.dir];
    notes.scrollTop = 0;
    stage.innerHTML = "";
    if (state.dir === "today") {
      stage.appendChild(todayView());
      return;
    }
    const app = el(appHTML(state.dir));
    stage.appendChild(app);
    teardown = mountApp(app, state.dir);
    anim(app, [{ opacity: 0 }, { opacity: 1 }], { duration: 160 });
  }

  tabs.forEach((b) =>
    b.addEventListener("click", () => {
      if (state.dir === b.dataset.dir) return;
      state.dir = b.dataset.dir;
      history.replaceState(null, "", `#${state.dir}`);
      localStorage.setItem("flat-lab:dir", state.dir);
      render();
    }),
  );

  const themeBtn = document.getElementById("theme-btn");
  const speedBtn = document.getElementById("speed-btn");
  const reduceBtn = document.getElementById("reduce-btn");
  const notesBtn = document.getElementById("notes-btn");

  function applyMotion() {
    document.documentElement.style.setProperty("--speed", String(Lab.mult));
    speedBtn.setAttribute("aria-pressed", String(Lab.speed !== 1));
    reduceBtn.setAttribute("aria-pressed", String(Lab.reduced));
  }

  function applyTheme(dark) {
    document.documentElement.classList.toggle("dark", dark);
    themeBtn.innerHTML = `${icon(dark ? "moon" : "sun", "sm")}${dark ? "Dark" : "Light"}`;
    localStorage.setItem("flat-lab:theme", dark ? "dark" : "light");
  }

  themeBtn.addEventListener("click", () =>
    applyTheme(!document.documentElement.classList.contains("dark")),
  );
  speedBtn.addEventListener("click", () => {
    Lab.speed = Lab.speed === 1 ? 4 : 1;
    applyMotion();
  });
  reduceBtn.addEventListener("click", () => {
    Lab.reduced = !Lab.reduced;
    applyMotion();
  });
  notesBtn.addEventListener("click", () => {
    const on = main.dataset.notes !== "off";
    main.dataset.notes = on ? "off" : "on";
    notesBtn.setAttribute("aria-pressed", String(!on));
  });

  const fromHash = location.hash.slice(1);
  state.dir = ["today", "a", "b", "c"].includes(fromHash)
    ? fromHash
    : localStorage.getItem("flat-lab:dir") || "a";
  Lab.reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  applyTheme((localStorage.getItem("flat-lab:theme") ?? "dark") === "dark");
  applyMotion();
  render();
  requestAnimationFrame(() => placeTabThumb(true));
  document.fonts?.ready.then(() => placeTabThumb(true));
})();
