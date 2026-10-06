/* ============================================================
   D · Pickers — the date component chosen apart from the surface.
   Three start-time pickers bound to one value (a discrete pick in one
   shows up in the others with a quiet highlight), then the interval,
   end and run preview composed exactly as a surface would ship them:
   every fact once — the preview owns the count, the last run and the
   clock change; the end picker shows only its choice.
   ============================================================ */
(() => {
  const reg = typeof DIRS !== "undefined" ? DIRS : (window.DIRS = window.DIRS || {});
  const DAY = 864e5;
  const HORIZON = 90 * DAY;
  const escD = (s) =>
    String(s ?? "").replace(
      /[&<>"]/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
    );
  const simNow = () => {
    try {
      if (typeof S !== "undefined" && S && Number.isFinite(S.now)) return S.now;
    } catch {}
    return Date.now();
  };
  const minute = (ms) => Math.floor(ms / 6e4);

  /* Phrases to try in the Type picker (one is deliberately in the past). */
  const TRY = ["in 2h", "fri 17:30", "tonight", "12.10. 14:00", "yesterday 9"];

  const k = (s) => `<kbd>${s}</kbd>`;
  const pair = (keys, label) => `<span class="pkd-k">${keys} ${label}</span>`;
  const COLS = [
    {
      v: "calendar",
      name: "Calendar",
      idea: "Point and pick. A trigger that grows into a month grid, a 15-minute time column and the four times people actually choose.",
      keys: [
        pair(k("↓"), "open"),
        pair(`${k("←")}${k("→")}${k("↑")}${k("↓")}`, "move"),
        pair(k("↵"), "pick"),
        pair(k("esc"), "close"),
      ],
    },
    {
      v: "type",
      name: "Type",
      idea: "Say it. Plain phrases parse as you type; a chip shows what it understood, and a bad time explains itself with a one-click fix.",
      keys: [
        pair("", "type"),
        pair(`${k("↑")}${k("↓")}`, "suggestions"),
        pair(k("↵"), "or leaving sets it"),
        pair(k("esc"), "reverts"),
      ],
    },
    {
      v: "segments",
      name: "Segments",
      idea: "Edit in place. Every part of the date is a spinner: step it, type over it, never open anything. The calendar is there when you want the month.",
      keys: [
        pair(`${k("↑")}${k("↓")}`, "step"),
        pair("0–9", "type"),
        pair(`${k("←")}${k("→")}`, "move"),
        pair(k("⌫"), "clear"),
      ],
    },
  ];

  reg.D = {
    title: "Pickers",
    thesis:
      "The date component, chosen apart from the surface: three ways to set one start time, plus the interval, the end and a live preview of the runs they imply.",
    notes: [
      [
        "Calendar",
        [
          "The trigger reads the value in words (<b>Wed, Oct 7 · 14:00</b> · in 3h) and grows into its popover. Days outside the 90-day window are ghosted; the last bookable day has an end cap. The footer names the limit once (<b>90-day limit · Jan 5</b>).",
          "Picking a day whose time has passed (today, 09:00) doesn't move the value: the footer says <b>09:00 has passed</b> and offers <b>Use 11:00</b>; the time column lists that day's remaining times.",
          "Keys: ↓ opens · arrows move by day/week · PgUp/PgDn month · ⇧PgUp/PgDn year · Home/End week edge · ↵ picks · Tab to the time column · esc closes.",
        ],
      ],
      [
        "Type",
        [
          "Understands <b>in 2h</b>, <b>tomorrow 9</b>, <b>fri 17:30</b>, <b>oct 12 14:00</b>, <b>12.10.</b>, <b>tonight</b>, <b>next monday 9am</b>, <b>now+30m</b>.",
          "<b>Enter</b> or leaving the field sets a valid reading; <b>Esc</b> reverts. Past or out-of-window times say why and the nearest valid time leads the suggestions.",
          "Inside a popover or dialog (C) the suggestions and the calendar render in that surface — no second card — and one Esc reverts before the next closes the host.",
        ],
      ],
      [
        "Segments",
        [
          "react-aria DateField model: role=spinbutton parts with value text; digits auto-advance (<b>2</b> waits for <b>23</b>, <b>7</b> jumps on). A half-typed value is never judged.",
          "Month and day edits land in the allowed window's year (Jan in an Oct → Jan window is next January) until you touch the year.",
          "Keys: ↑/↓ step (minutes by 5, ⇧ by 15) · PgUp/PgDn big steps · digits fill and advance · ←/→ move · ⌫ clear · Jan–Dec by letter. Fits where space is tight, e.g. B's sheet.",
        ],
      ],
      [
        "Schedule parts",
        [
          "Interval presets start at the 15-minute floor; Custom says when a typed amount is under it, offers <b>Use 15 min</b>, and converts on a unit switch (1 day → 24 hours).",
          "The end is always set and never past 90 days. A preset that no longer fits ends at the limit and selects nothing. <b>summary</b>: hidden next to a preview, full in a popover.",
          "The preview owns the count, the last run and the dated clock change, and says the approval load when runs come more than 8 a day.",
        ],
      ],
      [
        "Motion",
        [
          "Popovers grow out of their trigger and fold back into it (320 / 240 ms, ease .16,1,.3,1), kept inside the dialog or window they opened in; a month change slides 22 px.",
          "Plates slide under segments; preview rows settle (FLIP) and ticks glide when the rule changes. Sim ticks, typing and held keys move nothing.",
          "Reduced motion keeps the same states with ≤ 100 ms fades only.",
        ],
      ],
    ],

    mount(host) {
      const P = window.Pickers;
      if (!P) {
        host.innerHTML = '<p style="padding:24px">pickers.js did not load.</p>';
        return { update() {}, destroy() {} };
      }
      let now = simNow();
      let lastMinute = minute(now);
      const range = () => [now, now + HORIZON];

      /* Start tomorrow 09:00; daily for 30 days (the preset's own end). */
      const t = new Date(now);
      t.setDate(t.getDate() + 1);
      t.setHours(9, 0, 0, 0);
      let value = t.getTime();
      let iv = DAY;
      let end = P.endFor ? P.endFor(value, 30 * DAY) : value + 30 * DAY;
      let kind = "fixed-interval";

      const root = document.createElement("div");
      root.className = "pkd";
      root.dataset.dir = "D";
      root.innerHTML = `
        <header class="pkd-bar">
          <h2 class="pkd-title">Pickers</h2>
          <span class="pkd-sub">The parts of a schedule, one component each</span>
        </header>
        <div class="pkd-scroll">
          <section class="pkd-trio" aria-label="Start time, three ways">
            ${COLS.map(
              (c, i) => `
              <article class="pkd-col" data-v="${c.v}">
                <div class="pkd-col-head"><span class="pkd-num">${i + 1}</span><h3>${c.name}</h3></div>
                <p class="pkd-idea">${c.idea}</p>
                <div class="pkd-slot"></div>
                <div class="pkd-extra">${
                  c.v === "type"
                    ? `<span class="pkd-try-l">Try</span>${TRY.map((p) => `<button type="button" class="pkd-try" data-phrase="${escD(p)}">${escD(p)}</button>`).join('<span class="pkd-dot" aria-hidden="true">·</span>')}`
                    : ""
                }</div>
                <p class="pkd-keys">${c.keys.join('<span class="pkd-dot" aria-hidden="true">·</span>')}</p>
              </article>`,
            ).join("")}
          </section>
          <section class="pkd-draft" aria-label="Draft schedule">
            <div class="pkd-ctl">
              <div class="pkd-ctl-head">
                <h3>Draft schedule</h3>
                <span class="pkd-kind"></span>
              </div>
              <div class="pkd-rep" data-open>
                <div class="pkd-rep-in">
                  <div class="pkd-field pkd-iv"><span class="pkd-label">Repeat</span><div class="pkd-iv-slot"></div></div>
                  <div class="pkd-field pkd-until"><span class="pkd-label">Ends</span><div class="pkd-until-slot"></div></div>
                </div>
              </div>
              <p class="pkd-once" hidden>Runs once at the start time above. It waits for your approval when it's due.</p>
            </div>
            <div class="pkd-pv"></div>
          </section>
        </div>`;
      host.append(root);
      const $r = (sel) => root.querySelector(sel);

      /* --- three pickers, one value */
      const pick = {};
      const slotOf = (v) => root.querySelector(`.pkd-col[data-v="${v}"] .pkd-slot`);
      /* The highlight marks a discrete pick arriving from another column — not
         every step of a held arrow key in Segments — at most once per 600 ms. */
      let lastFlash = 0;
      function flash(from, via) {
        if (via === "segments") return;
        const t0 = performance.now();
        if (t0 - lastFlash < 600) return;
        lastFlash = t0;
        for (const v of Object.keys(pick)) {
          if (v === from) continue;
          const el = slotOf(v);
          el.classList.remove("is-synced");
          void el.offsetWidth;
          el.classList.add("is-synced");
        }
      }
      for (const c of COLS) {
        const [lo, hi] = range();
        pick[c.v] = P.dateTime(slotOf(c.v), {
          variant: c.v,
          value,
          min: lo,
          max: hi,
          label: "First run",
          now: () => now,
          onChange: (ms, info) => setShared(ms, c.v, info?.via),
        });
      }
      function setShared(ms, from, via) {
        value = ms;
        for (const v of Object.keys(pick)) if (v !== from) pick[v].set(ms);
        flash(from, via);
        untilP.update({ startMs: value });
        pv.update(schedule());
      }
      root.addEventListener("click", (e) => {
        const b = e.target.closest(".pkd-try");
        if (b) pick.type.setText(b.dataset.phrase);
      });

      /* --- draft schedule: interval + until + preview, de-duplicated */
      const schedule = () =>
        kind === "once"
          ? { kind: "once", runAt: value }
          : { kind: "fixed-interval", startsAt: value, intervalMs: iv, endsAt: end };
      const kindSeg = P.segmented($r(".pkd-kind"), {
        label: "Schedule kind",
        value: kind,
        options: [
          { value: "once", label: "Once" },
          { value: "fixed-interval", label: "Repeats" },
        ],
        onChange: (v) => {
          kind = v;
          paintKind(true);
          for (const p of Object.values(pick))
            p.setLabel?.(kind === "once" ? "Runs at" : "First run");
          pv.update(schedule());
        },
      });
      const ivP = P.interval($r(".pkd-iv-slot"), {
        valueMs: iv,
        onChange: (ms) => {
          iv = ms;
          untilP.update({ intervalMs: iv });
          pv.update(schedule());
        },
      });
      const untilP = P.until($r(".pkd-until-slot"), {
        startMs: value,
        valueMs: end,
        nowMs: now,
        intervalMs: iv,
        summary: false,
        onChange: (ms) => {
          end = ms;
          pv.update(schedule());
        },
      });
      const pv = P.preview($r(".pkd-pv"), { schedule: schedule(), nowMs: now });
      const rep = $r(".pkd-rep");
      function paintKind(animate) {
        const once = kind === "once";
        rep.toggleAttribute("data-open", !once);
        rep.inert = once;
        if (!animate || (typeof motionOn === "function" && !motionOn())) {
          rep.style.transition = "none";
          void rep.offsetHeight;
          rep.style.transition = "";
        }
        $r(".pkd-once").hidden = !once;
      }
      paintKind(false);

      return {
        update(state) {
          const n = state && Number.isFinite(state.now) ? state.now : simNow();
          if (n === now) return;
          now = n;
          const m = minute(now);
          if (m === lastMinute) return;
          lastMinute = m;
          const [lo, hi] = range();
          for (const p of Object.values(pick)) p.setRange(lo, hi);
          untilP.update({ nowMs: now });
          pv.update(schedule(), now);
        },
        destroy() {
          for (const p of Object.values(pick)) p.destroy();
          kindSeg.destroy();
          ivP.destroy();
          untilP.destroy();
          pv.destroy();
          root.remove();
        },
      };
    },
  };
})();
