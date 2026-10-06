/* ============================================================
   Pickers — the date/time, interval, end and run-preview parts of a
   schedule, for every direction of the automations lab.

   window.Pickers = {
     dateTime(host, { variant: "calendar" | "type" | "segments", value, min, max, label,
                      onChange(ms, { via }), onCommit?(ms, { changed, via }),
                      onInvalid?(reason | null), now?: ms | () => ms, tz?, inline? })
       → { set(ms), setRange(min, max), refresh(), focus(), open(), value(), destroy(), el,
           setLabel(text), setText(text) — type variant only }
       onCommit fires on every user accept (Enter, suggestion, grid/time/quick pick, fix)
       even when the value is unchanged: close host popovers on it, not on onChange.
       inline (type): suggestions + calendar in flow; auto when inside a popover/dialog.
       tz: name the timezone in the calendar footer (off: the host's bar says it).
     calendarPopover(anchorEl, { value, min, max, label, onChange(ms), onCommit?, now?, compact?, tz? })
       → { open(originEl?), close(), toggle(), set(ms), setRange(min, max), setLabel(text), destroy() }
     interval(host, { valueMs, onChange(ms), onInvalid?(reason | null), label?, dstHint? })
       → { set(ms), value(), destroy(), el }
     until(host, { startMs, valueMs, nowMs, intervalMs?, onChange(ms), label?,
                   summary?: "auto" | "full" | "bound" | false })
       → { set(ms), update({ startMs?, intervalMs?, nowMs? }), value(), destroy(), el }
     endFor(startMs, presetMs) → the end a duration preset means (wall-clock for days)
     preview(host, { schedule, nowMs, title?, approvals?: "auto" | true | false })
       → { update(schedule, nowMs?), destroy(), el }
     segmented(host, { options: [{ value, label }], value, label, onChange(v) })
       → { set(v), destroy(), el }
     parseWhen(text, nowMs, { defaultTime? }) → { ms, label, rel } | { error }
     parseTime(text) → minutes | null
     explain(ms, { now, min, max }) → plain-words reason | null  (a start must be after now)
     suggest(text, nowMs, { min, max }) → [{ phrase, ms, label, rel, nearest? }]
     intervalLabel(ms), occurrences(schedule, fromMs, toMs, limit), countRuns(schedule, fromMs)
     fmt: { full, day, time, date, dateTime, rel, duration }, selfTest()
   }

   Self-contained: uses core.js `motionOn()` when it exists, otherwise the
   lab's data-motion flag and prefers-reduced-motion. Popovers are top-layer
   elements (Popover API) that stay DOM descendants of their picker, so they
   escape overflow clipping and still work inside modal dialogs, sheets and
   other popovers (focus traps, inert). Escape is consumed (preventDefault +
   stopPropagation) so only the topmost layer closes.
   ============================================================ */
(() => {
  "use strict";

  /* ------------------------------------------------ constants */
  const MIN = 6e4;
  const HOUR = 36e5;
  const DAY = 864e5;
  const WEEK = 7 * DAY;
  const HORIZON = 90 * DAY;
  const MIN_INTERVAL = 15 * MIN;
  const EASE_PK = "cubic-bezier(.16,1,.3,1)";
  const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const WD_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const MO_LONG = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];

  /* ------------------------------------------------ tiny DOM kit (core.js may not be loaded yet) */
  const mk = (tag, cls, html) => {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (html != null) el.innerHTML = html;
    return el;
  };
  const escx = (s) =>
    String(s ?? "").replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
    );
  const clampN = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const pad2 = (n) => String(n).padStart(2, "0");
  let seq = 0;
  const nid = (p) => `pk-${p}-${++seq}`;
  const setAttr = (el, name, on, value = "") =>
    on ? el.setAttribute(name, value) : el.removeAttribute(name);

  /* Motion: the lab's toggle (core motionOn) or reduced-motion. */
  function motionOK() {
    try {
      if (typeof motionOn === "function") return !!motionOn();
    } catch {}
    if (document.documentElement.dataset.motion === "off") return false;
    return !matchMedia("(prefers-reduced-motion: reduce)").matches;
  }
  /* Opacity-only fades survive reduced motion (≤ 120 ms); anything that moves does not. */
  const fade = (el, from, to, ms = 100) =>
    el.animate([{ opacity: from }, { opacity: to }], { duration: ms, fill: "forwards" });

  function resolveNow(src) {
    if (typeof src === "function") {
      const v = src();
      if (Number.isFinite(v)) return v;
    }
    if (Number.isFinite(src)) return src;
    try {
      if (typeof S !== "undefined" && S && Number.isFinite(S.now)) return S.now;
    } catch {}
    return Date.now();
  }
  function tzName() {
    try {
      if (typeof S !== "undefined" && S && S.tz) return S.tz;
    } catch {}
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "Local time";
    } catch {
      return "Local time";
    }
  }

  /* Register with core's layer stack when present: its capture-phase Escape
     handler closes the topmost layer only, so a picker popover inside a
     dialog must be on that stack or Escape would close the dialog first. */
  function labLayer(spec) {
    try {
      if (typeof Lab !== "undefined" && Lab && Lab.layers && typeof Lab.layers.push === "function")
        return Lab.layers.push(spec);
    } catch {}
    return () => {};
  }

  /* ------------------------------------------------ icons (own set; icons.js has no calendar) */
  const PATHS = {
    cal: '<rect width="18" height="18" x="3" y="4" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/>',
    chevL: '<path d="m15 18-6-6 6-6"/>',
    chevR: '<path d="m9 18 6-6-6-6"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    minus: '<path d="M5 12h14"/>',
    plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
    alert: '<circle cx="12" cy="12" r="9"/><path d="M12 8v4.5"/><path d="M12 16h.01"/>',
    arrow: '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>',
  };
  const icon = (name, cls = "") =>
    `<svg class="pk-ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name]}</svg>`;

  /* ------------------------------------------------ local calendar math */
  const dayStart = (ms) => {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const mkDate = (y, m, d) => new Date(y, m, d).getTime();
  const daysInMonth = (y, m) => new Date(y, m + 1, 0).getDate();
  const addDays = (ms, n) => {
    const d = new Date(ms);
    d.setDate(d.getDate() + n);
    return d.getTime();
  };
  const addMonths = (ms, n) => {
    const d = new Date(ms);
    const day = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + n);
    d.setDate(Math.min(day, daysInMonth(d.getFullYear(), d.getMonth())));
    return d.getTime();
  };
  const monthStart = (ms) => {
    const d = new Date(ms);
    return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  };
  const monthLastDay = (ms) => {
    const d = new Date(ms);
    return new Date(d.getFullYear(), d.getMonth() + 1, 0).getTime();
  };
  const sameDay = (a, b) => dayStart(a) === dayStart(b);
  const minutesOf = (ms) => {
    const d = new Date(ms);
    return d.getHours() * 60 + d.getMinutes();
  };
  /* Wall-clock minutes on a local day (1440 rolls into the next day). */
  const withMinutes = (dayMs, mins) => {
    const d = new Date(dayMs);
    d.setHours(Math.floor(mins / 60), mins % 60, 0, 0);
    return d.getTime();
  };
  /* Calendar-day distance (DST-safe: 23 h and 25 h days round to 1). */
  const calDiff = (a, b) => Math.round((dayStart(b) - dayStart(a)) / DAY);
  const roundMin = (ms) => Math.round(ms / MIN) * MIN;
  const floorMin = (ms) => Math.floor(ms / MIN) * MIN;
  const ceilQuarter = (ms) => {
    const d = new Date(ms);
    const extra = d.getSeconds() || d.getMilliseconds() ? 1 : 0;
    return withMinutes(dayStart(ms), Math.ceil((minutesOf(ms) + extra) / 15) * 15);
  };
  const floorQuarter = (ms) => withMinutes(dayStart(ms), Math.floor(minutesOf(ms) / 15) * 15);
  const fmtMin = (m) => `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;

  /* ------------------------------------------------ formatting */
  const yearOf = (ms) => new Date(ms).getFullYear();
  function fTime(ms) {
    return fmtMin(minutesOf(ms));
  }
  function fDay(ms, now) {
    const d = new Date(ms);
    const y = now != null && d.getFullYear() !== yearOf(now) ? `, ${d.getFullYear()}` : "";
    return `${WD[d.getDay()]}, ${MO[d.getMonth()]} ${d.getDate()}${y}`;
  }
  function fFull(ms, now) {
    return `${fDay(ms, now)} · ${fTime(ms)}`;
  }
  function fDate(ms, now) {
    const d = new Date(ms);
    const y = now != null && d.getFullYear() !== yearOf(now) ? `, ${d.getFullYear()}` : "";
    return `${MO[d.getMonth()]} ${d.getDate()}${y}`;
  }
  function fDateTime(ms, now) {
    return `${fDate(ms, now)}, ${fTime(ms)}`;
  }
  /* The page's relative format (core sched.relative): "in 7m" · "in 3h 20m" under
     12 h, then "in 22h" · "tomorrow" · "in 4 days" (sched.relative switches to a
     date there, which would repeat the date columns these sit next to). */
  function fRel(ms, now) {
    const diff = ms - now;
    const a = Math.abs(diff);
    const fut = diff > 0;
    const w = (s) => (fut ? `in ${s}` : `${s} ago`);
    if (a < 45e3) return "now";
    if (a < 12 * HOUR) {
      try {
        if (
          typeof sched !== "undefined" &&
          sched &&
          typeof sched.relative === "function" &&
          a >= MIN
        )
          return sched.relative(ms, now);
      } catch {}
      const hh = Math.floor(a / HOUR);
      const mm = Math.max(hh ? 0 : 1, Math.floor((a % HOUR) / MIN));
      return w(hh ? (mm ? `${hh}h ${mm}m` : `${hh}h`) : `${mm}m`);
    }
    const cd = Math.abs(calDiff(now, ms));
    if (cd === 0 || a < 36 * HOUR) return w(`${Math.round(a / HOUR)}h`);
    if (cd === 1) return fut ? "tomorrow" : "yesterday";
    return w(`${cd} days`);
  }
  /* "today 10:45" · "tomorrow 09:00" · "Jan 5, 10:30" — for one-click fixes (no
     year: every fix sits inside the 90-day window, so it can't be ambiguous). */
  function fNear(ms, now) {
    if (sameDay(ms, now)) return `today ${fTime(ms)}`;
    if (calDiff(now, ms) === 1) return `tomorrow ${fTime(ms)}`;
    return fDateTime(ms);
  }
  function fDuration(ms) {
    if (ms >= DAY - MIN) {
      const n = Math.round(ms / DAY);
      return `${n} ${n === 1 ? "day" : "days"}`;
    }
    if (ms >= HOUR) {
      const n = Math.round(ms / HOUR);
      return `${n} h`;
    }
    return `${Math.round(ms / MIN)} min`;
  }

  /* ============================================================
     Parser — plain phrases into a local time.
     ============================================================ */
  const MONTHS = {
    jan: 0,
    january: 0,
    feb: 1,
    february: 1,
    mar: 2,
    march: 2,
    apr: 3,
    april: 3,
    may: 4,
    jun: 5,
    june: 5,
    jul: 6,
    july: 6,
    aug: 7,
    august: 7,
    sep: 8,
    sept: 8,
    september: 8,
    oct: 9,
    october: 9,
    nov: 10,
    november: 10,
    dec: 11,
    december: 11,
  };
  const WEEKDAYS = {
    sun: 0,
    sunday: 0,
    mon: 1,
    monday: 1,
    tue: 2,
    tues: 2,
    tuesday: 2,
    wed: 3,
    weds: 3,
    wednesday: 3,
    thu: 4,
    thur: 4,
    thurs: 4,
    thursday: 4,
    fri: 5,
    friday: 5,
    sat: 6,
    saturday: 6,
  };
  const PARTS = {
    morning: 540,
    noon: 720,
    midday: 720,
    afternoon: 840,
    evening: 1080,
    tonight: 1260,
    night: 1260,
    midnight: 0,
  };
  const PM_PARTS = new Set(["afternoon", "evening", "tonight", "night"]);
  const UNITS = {
    m: MIN,
    min: MIN,
    mins: MIN,
    minute: MIN,
    minutes: MIN,
    h: HOUR,
    hr: HOUR,
    hrs: HOUR,
    hour: HOUR,
    hours: HOUR,
    d: DAY,
    day: DAY,
    days: DAY,
    w: WEEK,
    wk: WEEK,
    wks: WEEK,
    week: WEEK,
    weeks: WEEK,
  };
  const has = (obj, k) => k != null && Object.prototype.hasOwnProperty.call(obj, k);
  const own = (obj, k) => (has(obj, k) ? obj[k] : undefined);

  function normalize(text) {
    return String(text ?? "")
      .toLowerCase()
      .replace(/\ba\.m\.?/g, "am")
      .replace(/\bp\.m\.?/g, "pm")
      .replace(/[·,@]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function parseDuration(src) {
    const s = src
      .replace(/\band\b/g, " ")
      .replace(/\bhalf an? hour\b/g, "30 min")
      .replace(/\ban? (?=[a-z])/g, "1 ")
      .replace(/\s+/g, " ")
      .trim();
    if (!s) return { error: "Add an amount, like “in 2h”" };
    const re = /(\d+(?:[.,]\d+)?)\s*([a-z]*)\s*/y;
    let total = 0;
    let prev = null;
    let idx = 0;
    while (idx < s.length) {
      re.lastIndex = idx;
      const m = re.exec(s);
      if (!m || !m[0])
        return { error: `Didn't catch “${src.trim()}” — try “in 2h” or “in 45 min”` };
      idx = re.lastIndex;
      const n = parseFloat(m[1].replace(",", "."));
      let unit = m[2];
      if (!unit) {
        if (prev === HOUR) unit = "min";
        else if (prev === DAY) unit = "h";
        else return { error: `Add a unit — “${m[1]} min”, “${m[1]} h” or “${m[1]} days”?` };
      }
      const u = own(UNITS, unit);
      if (!u) return { error: `Didn't catch “${unit}” — use min, h, days or weeks` };
      total += n * u;
      prev = u;
    }
    if (total < MIN) return { error: "That's less than a minute away" };
    return { ms: total };
  }

  function toMinutes(h, m, ap) {
    if (m > 59) return { error: `“${pad2(m)}” isn't a minute` };
    if (ap) {
      if (h < 1 || h > 12) return { error: `“${h}${ap}” isn't a time — use 1–12 with am/pm` };
      h = (h % 12) + (ap[0] === "p" ? 12 : 0);
    } else if (h > 23) return { error: `“${h}:${pad2(m)}” isn't a time` };
    return { min: h * 60 + m };
  }

  /* Time of day only: "9", "9:30", "21:05", "9pm", "930", "noon". → minutes | null */
  function parseTime(text) {
    const s = normalize(text).replace(/\s+/g, "");
    if (!s) return null;
    if (s === "noon" || s === "midday") return 720;
    if (s === "midnight") return 0;
    let m = s.match(/^(\d{1,2})(?:[:.h](\d{2}))?(am|pm|a|p)?h?$/);
    if (m) {
      const r = toMinutes(+m[1], m[2] != null ? +m[2] : 0, m[3]);
      return r.error ? null : r.min;
    }
    m = s.match(/^(\d{3,4})(am|pm|a|p)?$/);
    if (m) {
      const v = +m[1];
      const r = toMinutes(Math.floor(v / 100), v % 100, m[2]);
      return r.error ? null : r.min;
    }
    return null;
  }

  const DURATION_HEAD =
    /^\d+(?:[.,]\d+)?\s*(?:m|mins?|minutes?|h|hrs?|hours?|d|days?|w|wks?|weeks?)(?:\s|$|\d)/;

  /* parseWhen(text, nowMs, { defaultTime }) → { ms, label, rel, hasDate, hasTime } | { error }.
     Range checks are the caller's (see explain): the parser only reads. */
  function parseWhen(text, nowMs, opts = {}) {
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    const s0 = normalize(text);
    if (!s0) return { error: "Type when — “tomorrow 9”, “fri 17:30” or “in 2h”" };
    const done = (ms, hasDate, hasTime) => ({
      ms,
      label: fFull(ms, now),
      rel: fRel(ms, now),
      hasDate,
      hasTime,
    });
    if (s0 === "now") return done(floorMin(now), true, true);
    let m =
      s0.match(/^now\s*\+\s*(.+)$/) ||
      s0.match(/^\+\s*(.+)$/) ||
      s0.match(/^in\s+(.+)$/) ||
      s0.match(/^(.+?)\s+from now$/);
    if (m) {
      const d = parseDuration(m[1]);
      return d.error ? d : done(roundMin(now + d.ms), true, true);
    }
    if (DURATION_HEAD.test(s0)) {
      const d = parseDuration(s0);
      if (!d.error) return done(roundMin(now + d.ms), true, true);
    }

    const s = s0
      .replace(/\bday after tomorrow\b/g, "overmorrow")
      .replace(/\b(\d{1,2})(st|nd|rd|th)\b/g, "$1")
      .replace(/\b(at|on|the|of|by)\b/g, " ")
      .replace(/\bo'?clock\b/g, " ")
      .replace(/(\d)\s+(am|pm|a|p)\b/g, "$1$2")
      .replace(/\s+/g, " ")
      .trim();
    const toks = s.split(" ").filter(Boolean);
    const today = dayStart(now);
    const st = { date: null, dateWord: null, month: null, day: null, year: null };
    Object.assign(st, { wd: null, wdNext: false, min: null, part: null, ampm: false });
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      const nx = toks[i + 1];
      let mm;
      const setDate = (ms, word) => {
        if (st.date != null) return { error: "Two days there — keep one" };
        st.date = ms;
        st.dateWord = word;
        return null;
      };
      let err = null;
      if (t === "today") err = setDate(today, "Today");
      else if (t === "tomorrow" || t === "tmrw" || t === "tmr" || t === "tom")
        err = setDate(addDays(today, 1), "Tomorrow");
      else if (t === "overmorrow") err = setDate(addDays(today, 2), "The day after tomorrow");
      else if (t === "yesterday") err = setDate(addDays(today, -1), "Yesterday");
      else if (t === "this") continue;
      else if (t === "next") {
        if (has(WEEKDAYS, nx)) st.wdNext = true;
        else if (nx === "week") {
          st.wd = 1;
          st.wdNext = true;
          i++;
        } else return { error: "Next what? Try “next monday 9am”" };
      } else if (has(PARTS, t)) {
        st.part = t;
        if (t === "tonight" && st.date == null) {
          st.date = today;
          st.dateWord = "Tonight";
        }
      } else if (has(WEEKDAYS, t)) st.wd = WEEKDAYS[t];
      else if (has(MONTHS, t)) {
        st.month = MONTHS[t];
        if (nx && /^\d{1,2}$/.test(nx) && st.day == null) {
          st.day = +nx;
          i++;
        }
      } else if (/^\d{1,2}$/.test(t) && has(MONTHS, nx)) {
        st.day = +t;
        st.month = MONTHS[nx];
        i++;
      } else if ((mm = t.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})?$/))) {
        st.day = +mm[1];
        st.month = +mm[2] - 1;
        if (mm[3]) st.year = mm[3].length === 2 ? 2000 + +mm[3] : +mm[3];
        if (st.month < 0 || st.month > 11) return { error: `There's no month ${mm[2]}` };
      } else if ((mm = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) {
        st.year = +mm[1];
        st.month = +mm[2] - 1;
        st.day = +mm[3];
        if (st.month < 0 || st.month > 11) return { error: `There's no month ${mm[2]}` };
      } else if (
        /^\d{4}$/.test(t) &&
        st.month != null &&
        st.year == null &&
        +t >= 2000 &&
        +t <= 2100
      )
        st.year = +t;
      else if (
        (mm = t.match(/^(\d{1,2})(?:[:.](\d{2}))?(am|pm|a|p)?$/)) ||
        (mm = t.match(/^(\d{3,4})(am|pm|a|p)?$/))
      ) {
        if (st.min != null) return { error: "Two times there — keep one" };
        let r;
        if (mm[0].length >= 3 && /^\d{3,4}/.test(mm[0]) && !/[:.]/.test(mm[0])) {
          const v = parseInt(mm[1], 10);
          r = toMinutes(Math.floor(v / 100), v % 100, mm[2]);
        } else r = toMinutes(+mm[1], mm[2] != null ? +mm[2] : 0, mm[3]);
        if (r.error) return r;
        st.min = r.min;
        st.ampm = /[ap]m?$/.test(t);
      } else if (t.includes("/")) return { error: "Write dates as “12.10.” or “oct 12”" };
      else return { error: `Didn't catch “${t}”` };
      if (err) return err;
    }

    /* "evening 7" means 19:00. */
    if (
      st.min != null &&
      st.part &&
      PM_PARTS.has(st.part) &&
      !st.ampm &&
      st.min >= 60 &&
      st.min < 720
    )
      st.min += 720;
    let minutes = st.min ?? (st.part ? PARTS[st.part] : null);
    const hasTime = minutes != null;
    if (minutes == null) minutes = opts.defaultTime ?? 540;
    const midnight = st.part === "midnight" && st.min == null;
    let ms;
    let hasDate = true;
    if (st.month != null) {
      if (st.day == null)
        return {
          error: `Which day in ${MO_LONG[st.month]}? Try “${MO[st.month].toLowerCase()} 12”`,
        };
      if (st.date != null) return { error: "Two days there — keep one" };
      const build = (yy) => {
        if (st.day < 1 || st.day > daysInMonth(yy, st.month)) return null;
        return withMinutes(mkDate(yy, st.month, st.day), minutes);
      };
      const y = st.year ?? yearOf(now);
      ms = build(y);
      if (ms == null)
        return { error: `${MO_LONG[st.month]} ${y} has ${daysInMonth(y, st.month)} days` };
      if (st.year == null && ms < now - 60 * DAY) ms = build(y + 1) ?? ms;
      const wd = new Date(ms).getDay();
      if (st.wd != null && wd !== st.wd)
        return { error: `${MO[st.month]} ${st.day} is a ${WD_LONG[wd]}` };
    } else if (st.wd != null) {
      if (st.date != null) {
        const wd = new Date(st.date).getDay();
        if (wd !== st.wd) return { error: `${st.dateWord} is a ${WD_LONG[wd]}` };
        ms = withMinutes(st.date, minutes);
      } else {
        let delta = (st.wd - new Date(now).getDay() + 7) % 7;
        if (st.wdNext && delta === 0) delta = 7;
        ms = withMinutes(addDays(today, delta), minutes);
        if (!st.wdNext && delta === 0 && ms <= now) ms = withMinutes(addDays(today, 7), minutes);
      }
    } else if (st.date != null) ms = withMinutes(st.date, minutes);
    else if (hasTime) {
      hasDate = false;
      ms = withMinutes(today, minutes);
      if (ms <= now) ms = withMinutes(addDays(today, 1), minutes);
    } else return { error: "Didn't catch that — try “tomorrow 9” or “in 2h”" };
    if (midnight && hasDate) ms = addDays(ms, 1);
    return done(ms, hasDate, hasTime);
  }

  /* Why a time can't be used, in plain words (null when it can), plus a one-click fix.
     The backend wants a start strictly in the future, so `min` is exclusive whenever it
     is "now", and anything at or before the live clock is refused even when the host's
     min is a few seconds stale. The fix sits ≥ 5 min ahead on a quarter hour, so it is
     still valid after the next sim tick. kind: "past" | "early" | "late". */
  function explainFull(ms, o = {}) {
    const now = o.now ?? resolveNow();
    if (!Number.isFinite(ms)) return { text: "Pick a time" };
    const lo = o.min;
    const hi = o.max;
    if (lo != null && (ms < lo || ms <= now)) {
      let fix = ceilQuarter(Math.max(lo, now + 5 * MIN));
      if (hi != null && fix > hi) fix = null;
      const fixLabel = fix == null ? null : fNear(fix, now);
      if (ms <= now + 30e3) {
        if (Math.abs(ms - now) < 60e3)
          return {
            kind: "past",
            text: "That's now — pick a later time",
            short: "That's now",
            fix,
            fixLabel,
          };
        return {
          kind: "past",
          text: `That was ${fRel(ms, now)} — pick a later time`,
          short: `That was ${fRel(ms, now)}`,
          fix,
          fixLabel,
        };
      }
      return {
        kind: "early",
        text: o.minReason ?? `Too early — the earliest is ${fFull(lo, now)}`,
        short: o.minReason ?? "Too early",
        fix,
        fixLabel,
      };
    }
    if (hi != null && ms > hi) {
      let fix = floorQuarter(hi);
      if ((lo != null && fix < lo) || fix <= now) fix = null;
      const horizon = Math.abs(hi - now - HORIZON) < DAY;
      return {
        kind: "late",
        text:
          o.maxReason ??
          (horizon
            ? `Past the 90-day limit — the latest is ${fDate(hi, now)}`
            : `Too late — the latest is ${fFull(hi, now)}`),
        short: o.maxReason ?? (horizon ? "Past the 90-day limit" : "Too late"),
        fix,
        fixLabel: fix == null ? null : fNear(fix, now),
      };
    }
    return null;
  }
  const explain = (ms, o) => explainFull(ms, o)?.text ?? null;

  /* Completions for the type field: 3–5 valid alternatives to what's typed. */
  const SUGG_DEFAULT = ["in 1 hour", "tonight", "tomorrow 9am", "monday 9am", "in 1 week"];
  function suggest(text, nowMs, o = {}) {
    const now = Number.isFinite(nowMs) ? nowMs : resolveNow();
    const s = normalize(text);
    const out = [];
    const seen = new Set();
    const add = (phrase) => {
      if (out.length >= 5) return;
      const r = parseWhen(phrase, now, o);
      if (r.error || seen.has(r.ms)) return;
      if (explain(r.ms, { now, min: o.min, max: o.max })) return;
      seen.add(r.ms);
      out.push({ phrase, ms: r.ms, label: r.label, rel: r.rel });
    };
    if (!s) {
      SUGG_DEFAULT.forEach(add);
      return out;
    }
    const exact = parseWhen(s, now, o);
    if (!exact.error) seen.add(exact.ms);
    /* Out of the window: the nearest valid time leads the list. */
    if (!exact.error) {
      const r = explainFull(exact.ms, { now, min: o.min, max: o.max });
      if (r?.fix != null && !seen.has(r.fix)) {
        seen.add(r.fix);
        out.push({
          phrase: `${MO[new Date(r.fix).getMonth()].toLowerCase()} ${new Date(r.fix).getDate()} ${fTime(r.fix)}`,
          ms: r.fix,
          label: fFull(r.fix, now),
          rel: fRel(r.fix, now),
          nearest: r.kind === "late" ? "Latest" : "Earliest",
        });
      }
    }
    const words = s.split(" ");
    const cands = [];
    let m;
    if ((m = s.match(/^(?:in|now ?\+|\+) ?(\d+)? ?([a-z]*)$/))) {
      if (!m[1]) cands.push("in 15 min", "in 30 min", "in 1 hour", "in 2 hours", "in 1 day");
      else {
        const n = m[1];
        const units = [`${n} min`, `${n} hours`, `${n} days`, `${n} weeks`];
        const u = m[2];
        for (const x of units) if (!u || x.split(" ")[1].startsWith(u)) cands.push(`in ${x}`);
        for (const x of units) cands.push(`in ${x}`);
      }
    } else if (/^\d{1,2}$/.test(s)) {
      const d = new Date(now);
      cands.push(`today ${s}:00`, `tomorrow ${s}:00`);
      cands.push(`${MO[d.getMonth()].toLowerCase()} ${s}`);
      cands.push(`${MO[(d.getMonth() + 1) % 12].toLowerCase()} ${s}`);
    }
    const pool = [
      "tonight",
      "tomorrow 9am",
      "tomorrow 14:00",
      "tomorrow 18:00",
      "today 18:00",
      "tomorrow evening",
      "next week",
      "in 1 hour",
      "in 2 hours",
      "noon",
    ];
    for (const w of WD_LONG.map((x) => x.toLowerCase()))
      pool.push(`${w} 9am`, `${w} 14:00`, `${w} 17:30`, `next ${w} 9am`);
    const prefixOf = (pw) => words.every((w, i) => pw[i] && pw[i].startsWith(w));
    for (const p of pool) if (prefixOf(p.split(" "))) cands.push(p);
    if (!exact.error && exact.hasDate && !exact.hasTime)
      cands.push(`${s} 9am`, `${s} 14:00`, `${s} 18:00`);
    if (!exact.error && exact.hasTime && !exact.hasDate) {
      const wd = WD_LONG[(new Date(now).getDay() + 2) % 7].toLowerCase();
      cands.push(`today ${s}`, `tomorrow ${s}`, `${wd} ${s}`);
    }
    /* A complete reading: offer the same time on nearby days, and a week later. */
    if (!exact.error && exact.hasDate && exact.hasTime && !/^(in|now|\+)/.test(s)) {
      const hm = fmtMin(minutesOf(exact.ms));
      const d = new Date(exact.ms);
      const wd = WD_LONG[d.getDay()].toLowerCase();
      const next = WD_LONG[(d.getDay() + 1) % 7].toLowerCase();
      const wk = new Date(addDays(exact.ms, 7));
      cands.push(
        `${next} ${hm}`,
        `tomorrow ${hm}`,
        `${MO[wk.getMonth()].toLowerCase()} ${wk.getDate()} ${hm}`,
        `${wd} 9am`,
      );
    }
    cands.forEach(add);
    if (out.length < 3) SUGG_DEFAULT.forEach(add);
    return out;
  }

  /* ============================================================
     Schedule math (mirrors data.js: end is inclusive, interval is elapsed time)
     ============================================================ */
  function kindOf(sc) {
    if (!sc) return null;
    return sc.kind ?? sc.type ?? (sc.runAt != null ? "once" : "fixed-interval");
  }
  function occurrences(sc, fromMs, toMs = Infinity, limit = Infinity) {
    const kind = kindOf(sc);
    if (!kind) return [];
    if (kind === "once") return sc.runAt >= fromMs && sc.runAt <= toMs ? [sc.runAt] : [];
    const { startsAt, intervalMs, endsAt } = sc;
    if (!(intervalMs > 0) || !Number.isFinite(startsAt) || !(endsAt >= startsAt)) return [];
    const end = Math.min(endsAt, toMs);
    const k = fromMs > startsAt ? Math.ceil((fromMs - startsAt) / intervalMs) : 0;
    const out = [];
    for (let t = startsAt + k * intervalMs; t <= end && out.length < limit; t += intervalMs)
      out.push(t);
    return out;
  }
  function countRuns(sc, fromMs) {
    const kind = kindOf(sc);
    if (!kind) return 0;
    if (kind === "once") return sc.runAt >= fromMs ? 1 : 0;
    const { startsAt, intervalMs, endsAt } = sc;
    if (!(intervalMs > 0) || !(endsAt >= startsAt)) return 0;
    const k = fromMs > startsAt ? Math.ceil((fromMs - startsAt) / intervalMs) : 0;
    const first = startsAt + k * intervalMs;
    return first > endsAt ? 0 : Math.floor((endsAt - first) / intervalMs) + 1;
  }
  function intervalLabel(ms) {
    if (!(ms > 0)) return "—";
    if (ms % WEEK === 0) return ms === WEEK ? "Every week" : `Every ${ms / WEEK} weeks`;
    if (ms % DAY === 0) return ms === DAY ? "Every day" : `Every ${ms / DAY} days`;
    if (ms % HOUR === 0) return ms === HOUR ? "Every hour" : `Every ${ms / HOUR} hours`;
    const m = Math.round(ms / MIN);
    if (m < 180) return `Every ${m} minutes`;
    return `Every ${Math.floor(m / 60)} h ${m % 60} min`;
  }

  /* ============================================================
     Popover — a top-layer surface that grows out of the control that
     opened it and folds back into it (the app's B · Morph, popover
     profile: grow ≈320 ms, content from 30 % of travel, fold 240 ms).
     ============================================================ */
  const HAS_POPOVER = typeof HTMLElement !== "undefined" && "showPopover" in HTMLElement.prototype;
  let openPop = null;

  function createPop(owner, o) {
    const root = mk("div", `pk-pop ${o.cls ?? ""}`);
    const surface = mk("div", "pk-surface");
    surface.tabIndex = -1;
    if (o.role) surface.setAttribute("role", o.role);
    if (o.label) surface.setAttribute("aria-label", o.label);
    if (o.id) surface.id = o.id;
    root.append(surface);
    if (HAS_POPOVER) root.setAttribute("popover", "manual");
    else root.hidden = true;
    owner.append(root);

    let isOpen = false;
    let origin = null;
    let ghost = null;
    let running = [];
    let flipped = false;
    let raf = 0;
    let morphing = false;
    let gen = 0;
    let layerOff = null;
    const anchorEl = () => o.anchor?.() ?? owner;

    function reveal(v) {
      if (HAS_POPOVER) {
        try {
          if (v) root.showPopover();
          else root.hidePopover();
        } catch {}
      } else root.hidden = !v;
    }
    function stopAnims() {
      for (const a of running) {
        try {
          a.cancel();
        } catch {}
      }
      running = [];
      ghost?.remove();
      ghost = null;
      delete root.dataset.morphing;
      morphing = false;
    }

    /* Below the anchor (or above when that side has more room), kept inside the
       surface it opened from: the nearest real dialog, else the app window, else the
       viewport — never hanging over the page behind a scrim. Token popovers (.pop)
       are skipped: they are too small to contain a calendar. Measures the containing
       block so it also works without the top layer. */
    function boundsOf(anchor) {
      const vw = document.documentElement.clientWidth;
      const vh = window.innerHeight;
      const view = { left: 0, top: 0, right: vw, bottom: vh };
      const host =
        o.bounds?.() ??
        anchor.closest('[role="dialog"]:not(.pop):not(.pk-surface), dialog, #app-window');
      if (!host) return { b: view, view };
      const r = host.getBoundingClientRect();
      const b = {
        left: Math.max(0, r.left),
        top: Math.max(0, r.top),
        right: Math.min(vw, r.right),
        bottom: Math.min(vh, r.bottom),
      };
      return { b, view };
    }
    function place() {
      if (!isOpen) return;
      const anchor = anchorEl();
      const a = anchor.getBoundingClientRect();
      root.style.left = "0px";
      root.style.top = "0px";
      const base = root.getBoundingClientRect();
      const w = surface.offsetWidth;
      const hh = surface.offsetHeight;
      const gap = o.gap ?? 6;
      const pad = 8;
      const { b, view } = boundsOf(anchor);
      /* An axis the surface can't fit in the host falls back to the viewport. */
      const bx = w + 2 * pad <= b.right - b.left ? b : view;
      const by = hh + 2 * pad <= b.bottom - b.top ? b : view;
      const align =
        o.align ?? ((a.left + a.right) / 2 > (bx.left + bx.right) / 2 ? "end" : "start");
      let x = align === "end" ? a.right - w : a.left;
      x = clampN(x, bx.left + pad, Math.max(bx.left + pad, bx.right - w - pad));
      const below = by.bottom - a.bottom - gap - pad;
      const above = a.top - by.top - gap - pad;
      flipped = hh > below && above > below;
      let y = flipped ? a.top - gap - hh : a.bottom + gap;
      y = clampN(y, by.top + pad, Math.max(by.top + pad, by.bottom - hh - pad));
      root.style.left = `${Math.round(x - base.left)}px`;
      root.style.top = `${Math.round(y - base.top)}px`;
      root.dataset.side = flipped ? "top" : "bottom";
    }

    const rectIn = (r, rr) => ({
      left: `${r.left - rr.left}px`,
      top: `${r.top - rr.top}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
    });
    const radius = (el, fb) => parseFloat(getComputedStyle(el).borderTopLeftRadius) || fb;

    function grow(org) {
      const rr = root.getBoundingClientRect();
      const from = org.getBoundingClientRect();
      const to = surface.getBoundingClientRect();
      ghost = mk("div", "pk-ghost");
      root.prepend(ghost);
      root.dataset.morphing = "";
      morphing = true;
      const dur = 320;
      const g = ghost.animate(
        [
          { ...rectIn(from, rr), borderRadius: `${radius(org, 8)}px`, opacity: 0 },
          { opacity: 1, offset: 0.28 },
          { ...rectIn(to, rr), borderRadius: `${radius(surface, 12)}px`, opacity: 1 },
        ],
        { duration: dur, easing: EASE_PK, fill: "forwards" },
      );
      const rise = flipped ? -4 : 4;
      const c = surface.animate(
        [
          { opacity: 0, transform: `translateY(${rise}px)` },
          { opacity: 1, transform: "none" },
        ],
        { duration: 200, delay: dur * 0.3, easing: EASE_PK, fill: "backwards" },
      );
      running.push(g, c);
      const my = gen;
      g.finished.then(
        () => {
          if (my !== gen) return;
          ghost?.remove();
          ghost = null;
          delete root.dataset.morphing;
          morphing = false;
        },
        () => {},
      );
    }

    function show(originEl) {
      if (openPop && openPop !== self) openPop.hide({ focus: false, instant: true });
      gen++;
      stopAnims();
      origin = originEl ?? null;
      const was = isOpen;
      isOpen = true;
      openPop = self;
      reveal(true);
      place();
      if (was) return;
      listen(true);
      layerOff = labLayer({
        el: root,
        anchor: o.layerAnchor?.() ?? anchorEl(),
        dismissOnOutside: true,
        close: (reason) => hide({ focus: reason === "escape" || reason === "close" }),
      });
      if (!motionOK()) {
        running.push(fade(surface, 0, 1, 100));
        return;
      }
      if (o.morph !== false && origin?.isConnected) grow(origin);
      else
        running.push(
          surface.animate(
            [
              { opacity: 0, transform: `translateY(${flipped ? 3 : -3}px)` },
              { opacity: 1, transform: "none" },
            ],
            { duration: 160, easing: EASE_PK },
          ),
        );
    }

    function hide({ focus = true, instant = false } = {}) {
      if (!isOpen) return;
      isOpen = false;
      if (openPop === self) openPop = null;
      listen(false);
      layerOff?.();
      layerOff = null;
      o.onHide?.();
      const back = origin?.isConnected ? origin : null;
      if (focus && root.contains(document.activeElement))
        (back ?? o.focusBack?.())?.focus({ preventScroll: true });
      const my = ++gen;
      const finish = () => {
        if (my !== gen) return;
        stopAnims();
        reveal(false);
        o.onClosed?.();
      };
      if (instant) return finish();
      /* Interrupting a grow folds from the current frame: read rects now. */
      const from = (ghost ?? surface).getBoundingClientRect();
      stopAnims();
      if (!motionOK()) {
        const a = fade(surface, 1, 0, 90);
        running.push(a);
        a.finished.then(finish, finish);
        return;
      }
      if (o.morph !== false && back) {
        const rr = root.getBoundingClientRect();
        const to = back.getBoundingClientRect();
        ghost = mk("div", "pk-ghost");
        root.prepend(ghost);
        root.dataset.morphing = "";
        morphing = true;
        const c = fade(surface, getComputedStyle(surface).opacity, 0, 70);
        const g = ghost.animate(
          [
            { ...rectIn(from, rr), borderRadius: `${radius(surface, 12)}px`, opacity: 1 },
            { opacity: 1, offset: 0.5 },
            { ...rectIn(to, rr), borderRadius: `${radius(back, 8)}px`, opacity: 0 },
          ],
          { duration: 240, easing: EASE_PK, fill: "forwards" },
        );
        running.push(c, g);
        g.finished.then(finish, finish);
      } else {
        const a = surface.animate(
          [
            { opacity: 1, transform: "none" },
            { opacity: 0, transform: `translateY(${flipped ? 3 : -3}px)` },
          ],
          { duration: 120, easing: EASE_PK, fill: "forwards" },
        );
        running.push(a);
        a.finished.then(finish, finish);
      }
    }

    const keep = (t) => t instanceof Node && (root.contains(t) || !!o.keepOpen?.(t));
    const onDocDown = (e) => {
      if (keep(e.target)) return;
      hide({ focus: false });
    };
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      hide();
    };
    const onFocusOut = (e) => {
      const to = e.relatedTarget;
      if (!to || keep(to)) return;
      hide({ focus: false });
    };
    const onViewport = (e) => {
      if (e?.target instanceof Node && root.contains(e.target)) return;
      if (raf || morphing) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        place();
      });
    };
    function listen(on) {
      const f = on ? "addEventListener" : "removeEventListener";
      document[f]("pointerdown", onDocDown, true);
      root[f]("keydown", onKey);
      root[f]("focusout", onFocusOut);
      window[f]("resize", onViewport);
      window[f]("scroll", onViewport, true);
    }

    const self = {
      root,
      surface,
      get open() {
        return isOpen;
      },
      show,
      hide,
      place,
      destroy() {
        if (isOpen) hide({ focus: false, instant: true });
        listen(false);
        root.remove();
      },
    };
    return self;
  }

  /* ============================================================
     Month grid (WAI-ARIA APG date grid).
     o: { value(), min(), max(), now(), rangeStart?(), compact, onPick(dayMs), maxNote }
     ============================================================ */
  function createGrid(o) {
    const id = nid("cal");
    const el = mk("div", `pk-cal${o.compact ? " is-compact" : ""}`);
    el.innerHTML = `
      <div class="pk-cal-head">
        <div class="pk-cal-title" id="${id}-t" aria-live="polite"><span></span></div>
        <button type="button" class="pk-icon-btn" data-nav="-1" aria-label="Previous month">${icon("chevL")}</button>
        <button type="button" class="pk-icon-btn" data-nav="1" aria-label="Next month">${icon("chevR")}</button>
      </div>
      <div class="pk-grid" role="grid" aria-labelledby="${id}-t">
        <div class="pk-wk" role="row">${[1, 2, 3, 4, 5, 6, 0]
          .map(
            (d) =>
              `<span role="columnheader" aria-label="${WD_LONG[d]}"><abbr title="${WD_LONG[d]}">${WD[d].slice(0, 2)}</abbr></span>`,
          )
          .join("")}</div>
        <div class="pk-weeks" role="rowgroup"></div>
      </div>`;
    const title = el.querySelector(".pk-cal-title");
    const weeks = el.querySelector(".pk-weeks");
    const gridEl = el.querySelector(".pk-grid");
    const prevBtn = el.querySelector('[data-nav="-1"]');
    const nextBtn = el.querySelector('[data-nav="1"]');
    const cells = [];
    for (let r = 0; r < 6; r++) {
      const row = mk("div", "pk-row");
      row.setAttribute("role", "row");
      for (let c = 0; c < 7; c++) {
        const cell = mk("div", "pk-day", '<span class="pk-n"></span>');
        cell.setAttribute("role", "gridcell");
        cell.tabIndex = -1;
        row.append(cell);
        cells.push(cell);
      }
      weeks.append(row);
    }

    const today0 = () => dayStart(o.now());
    let view = monthStart(o.value() ?? today0());
    let focusDay = dayStart(o.value() ?? today0());
    let hover = null;
    let slideOld = [];

    const lo = () => (o.min() != null ? dayStart(o.min()) : -Infinity);
    const hi = () => (o.max() != null ? dayStart(o.max()) : Infinity);
    const pickable = (d) => d >= lo() && d <= hi();

    function paint() {
      const vd = new Date(view);
      title.firstElementChild.textContent = `${MO_LONG[vd.getMonth()]} ${vd.getFullYear()}`;
      const lead = (vd.getDay() + 6) % 7;
      let d = addDays(view, -lead);
      const L = lo();
      const H = hi();
      const today = today0();
      const v = o.value();
      const sel = v != null ? dayStart(v) : null;
      const rs = o.rangeStart?.() != null ? dayStart(o.rangeStart()) : null;
      const re = rs != null ? (hover ?? sel) : null;
      const r0 = re != null ? Math.min(rs, re) : null;
      const r1 = re != null ? Math.max(rs, re) : null;
      for (let i = 0; i < 42; i++, d = addDays(d, 1)) {
        const c = cells[i];
        const dt = new Date(d);
        c.dataset.ms = d;
        c.firstChild.textContent = dt.getDate();
        const dis = d < L || d > H;
        setAttr(c, "data-out", dt.getMonth() !== vd.getMonth());
        c.setAttribute("aria-disabled", dis ? "true" : "false");
        setAttr(c, "aria-selected", d === sel, "true");
        setAttr(c, "aria-current", d === today, "date");
        /* No window band: out-of-window days are ghosted; the horizon keeps an end cap. */
        setAttr(c, "data-win-end", d === H);
        setAttr(c, "data-range", r0 != null && d >= r0 && d <= r1);
        setAttr(c, "data-range-start", r0 != null && d === r0);
        setAttr(c, "data-range-end", r0 != null && d === r1);
        c.tabIndex = d === focusDay ? 0 : -1;
        const why = dis
          ? d > H
            ? `, unavailable, ${o.maxNote ?? "beyond the 90-day limit"}`
            : ", unavailable, in the past"
          : "";
        c.setAttribute(
          "aria-label",
          `${WD_LONG[dt.getDay()]}, ${MO_LONG[dt.getMonth()]} ${dt.getDate()}, ${dt.getFullYear()}${d === today ? ", today" : ""}${why}`,
        );
      }
      prevBtn.setAttribute(
        "aria-disabled",
        String(view <= monthStart(L === -Infinity ? -8.64e15 : L)),
      );
      nextBtn.setAttribute("aria-disabled", String(addMonths(view, 1) > H));
    }

    function cellFor(d) {
      return cells.find((c) => +c.dataset.ms === d) ?? null;
    }

    /* Month change: a short horizontal slide (only for deliberate paging). */
    function setView(next, dir, animate) {
      if (next === view) return paint();
      const anim = animate && dir && motionOK();
      let old = null;
      let oldTitle = null;
      if (anim) {
        for (const n of slideOld) n.remove();
        old = weeks.cloneNode(true);
        old.className = "pk-weeks pk-weeks-ghost";
        old.removeAttribute("role");
        old.setAttribute("aria-hidden", "true");
        old.inert = true;
        for (const n of old.querySelectorAll("[tabindex]")) n.removeAttribute("tabindex");
        old.style.top = `${weeks.offsetTop}px`;
        gridEl.append(old);
        oldTitle = title.firstElementChild.cloneNode(true);
        oldTitle.className = "pk-cal-title-ghost";
        oldTitle.setAttribute("aria-hidden", "true");
        title.append(oldTitle);
        slideOld = [old, oldTitle];
      }
      view = next;
      paint();
      if (!anim) return;
      const dx = 22 * dir;
      const out = [
        { opacity: 1, transform: "none" },
        { opacity: 0, transform: `translateX(${-dx}px)` },
      ];
      const inn = [
        { opacity: 0, transform: `translateX(${dx}px)` },
        { opacity: 1, transform: "none" },
      ];
      const kill = (n) => () => n.remove();
      old
        .animate(out, { duration: 150, easing: "ease-out", fill: "forwards" })
        .finished.then(kill(old), kill(old));
      oldTitle
        .animate(out, { duration: 150, easing: "ease-out", fill: "forwards" })
        .finished.then(kill(oldTitle), kill(oldTitle));
      weeks.animate(inn, { duration: 240, easing: EASE_PK });
      title.firstElementChild.animate(inn, { duration: 240, easing: EASE_PK });
    }

    function moveFocus(d, animate) {
      const L = lo();
      const H = hi();
      const loM = L === -Infinity ? -Infinity : monthStart(L);
      const hiM = H === Infinity ? Infinity : monthLastDay(H);
      d = clampN(dayStart(d), loM, hiM);
      focusDay = d;
      if (o.rangeStart?.() != null) hover = d;
      const mv = monthStart(d);
      if (mv !== view) setView(mv, mv > view ? 1 : -1, animate);
      else paint();
      cellFor(d)?.focus({ preventScroll: true });
    }

    function pick(d) {
      if (!pickable(d)) return;
      focusDay = d;
      o.onPick(d);
    }

    weeks.addEventListener("keydown", (e) => {
      let d = focusDay;
      const dow = (new Date(d).getDay() + 6) % 7;
      let animate = false;
      switch (e.key) {
        case "ArrowLeft":
          d = addDays(d, -1);
          break;
        case "ArrowRight":
          d = addDays(d, 1);
          break;
        case "ArrowUp":
          d = addDays(d, -7);
          break;
        case "ArrowDown":
          d = addDays(d, 7);
          break;
        case "Home":
          d = addDays(d, -dow);
          break;
        case "End":
          d = addDays(d, 6 - dow);
          break;
        case "PageUp":
          d = addMonths(d, e.shiftKey ? -12 : -1);
          animate = !e.repeat;
          break;
        case "PageDown":
          d = addMonths(d, e.shiftKey ? 12 : 1);
          animate = !e.repeat;
          break;
        case "Enter":
        case " ":
          e.preventDefault();
          pick(focusDay);
          return;
        default:
          return;
      }
      e.preventDefault();
      moveFocus(d, animate);
    });
    weeks.addEventListener("click", (e) => {
      const c = e.target.closest(".pk-day");
      if (!c || c.parentElement?.parentElement !== weeks) return;
      const d = +c.dataset.ms;
      if (!pickable(d)) {
        c.focus({ preventScroll: true });
        return;
      }
      focusDay = d;
      const mv = monthStart(d);
      if (mv !== view && !o.compact) setView(mv, mv > view ? 1 : -1, true);
      pick(d);
    });
    if (o.rangeStart) {
      weeks.addEventListener("pointerover", (e) => {
        const c = e.target.closest(".pk-day");
        if (!c) return;
        const d = +c.dataset.ms;
        if (!pickable(d) || hover === d) return;
        hover = d;
        paint();
      });
      weeks.addEventListener("pointerleave", () => {
        hover = null;
        paint();
      });
    }
    for (const b of [prevBtn, nextBtn])
      b.addEventListener("click", () => {
        if (b.getAttribute("aria-disabled") === "true") return;
        const dir = +b.dataset.nav;
        const nv = addMonths(view, dir);
        const fd = new Date(focusDay);
        const nd = new Date(nv);
        focusDay = mkDate(
          nd.getFullYear(),
          nd.getMonth(),
          Math.min(fd.getDate(), daysInMonth(nd.getFullYear(), nd.getMonth())),
        );
        setView(monthStart(nv), dir, true);
      });

    paint();
    return {
      el,
      paint,
      focusDay: () => focusDay,
      /* Re-anchor on the value (or the first pickable day). */
      reset() {
        const v = o.value();
        const L = lo();
        let d = v != null ? dayStart(v) : today0();
        if (d < L) d = L;
        if (d > hi()) d = hi();
        focusDay = d;
        hover = null;
        view = monthStart(d);
        paint();
      },
      focus() {
        (cellFor(focusDay) ?? cells[0]).focus({ preventScroll: true });
      },
      show(d) {
        focusDay = dayStart(d);
        const mv = monthStart(d);
        if (mv !== view) setView(mv, mv > view ? 1 : -1, true);
        else paint();
      },
    };
  }

  /* ============================================================
     Time column: a typed field + 15-minute slots.
     o: { day(), value(), min(), max(), now(), onPick(minutes), onReject(ms), say(text|null, tone) }
     Messages go to the panel footer (full width) — never into this narrow column.
     The list shows whole rows only (fixed height, row snap) and is never scrolled
     for the user while they are browsing it.
     ============================================================ */
  const SLOT_H = 28;
  function createTimeCol(o) {
    const id = nid("t");
    const el = mk("div", "pk-time");
    el.innerHTML = `<input class="pk-time-input" type="text" aria-label="Time, 24-hour" placeholder="09:00" spellcheck="false" autocomplete="off" maxlength="8">
      <div class="pk-slots" role="listbox" aria-label="Times" id="${id}"></div>`;
    const input = el.querySelector("input");
    const list = el.querySelector(".pk-slots");
    const slots = [];
    for (let m = 0; m < 1440; m += 15) {
      const s = mk("div", "pk-slot");
      s.setAttribute("role", "option");
      s.id = `${id}-${m}`;
      s.dataset.min = m;
      s.textContent = fmtMin(m);
      if (m % 60 === 0) s.dataset.hour = "";
      s.tabIndex = -1;
      list.append(s);
      slots.push(s);
    }
    let custom = null;
    /* Browsing: once the user scrolls, hovers or arrows through the list, only their
       own picks move it again (until the popover reopens). */
    let browsed = false;
    let hovering = false;
    const browse = () => (browsed = true);
    list.addEventListener("wheel", browse, { passive: true });
    list.addEventListener("touchmove", browse, { passive: true });
    list.addEventListener("pointerenter", () => (hovering = true));
    list.addEventListener("pointerleave", () => (hovering = false));
    const options = () => [...list.children];
    const enabledAt = (m) => {
      const ms = withMinutes(o.day(), m);
      const lo = o.min();
      const hi = o.max();
      return !((lo != null && (ms < lo || ms <= o.now())) || (hi != null && ms > hi));
    };
    const selMin = () => {
      const v = o.value();
      return v != null && sameDay(v, o.day()) ? minutesOf(v) : null;
    };

    function paint() {
      const sel = selMin();
      if (sel != null && sel % 15 !== 0) {
        if (!custom) {
          custom = mk("div", "pk-slot is-custom");
          custom.setAttribute("role", "option");
          custom.tabIndex = -1;
          custom.id = `${id}-c`;
        }
        custom.dataset.min = sel;
        custom.textContent = fmtMin(sel);
        slots[Math.floor(sel / 15)].after(custom);
      } else if (custom && document.activeElement !== custom) {
        custom.remove();
        custom = null;
      }
      const all = options();
      const focused = all.find((s) => s === document.activeElement);
      const act =
        focused ??
        all.find((s) => +s.dataset.min === sel && enabledAt(sel)) ??
        all.find((s) => enabledAt(+s.dataset.min));
      for (const s of all) {
        const m = +s.dataset.min;
        setAttr(s, "aria-selected", m === sel, "true");
        const dis = enabledAt(m) ? "false" : "true";
        if (s.getAttribute("aria-disabled") !== dis) s.setAttribute("aria-disabled", dis);
        s.tabIndex = s === act ? 0 : -1;
      }
      if (document.activeElement !== input) input.value = sel != null ? fmtMin(sel) : "";
    }

    /* Selected row sits 4th from the top: whole rows above and below. */
    function scrollTo(s, smooth) {
      if (!s) return;
      const top = Math.max(0, s.offsetTop - 3 * SLOT_H);
      list.scrollTo({ top, behavior: smooth && motionOK() ? "smooth" : "auto" });
    }
    function scrollToSelected(smooth, { force = false } = {}) {
      if (!force && (browsed || hovering)) return;
      const all = options();
      const sel = selMin();
      scrollTo(
        all.find((s) => +s.dataset.min === sel) ?? all.find((s) => s.tabIndex === 0),
        smooth,
      );
    }
    function keepVisible(s) {
      if (s.offsetTop < list.scrollTop) list.scrollTop = s.offsetTop;
      else if (s.offsetTop + s.offsetHeight > list.scrollTop + list.clientHeight)
        list.scrollTop = s.offsetTop + s.offsetHeight - list.clientHeight;
    }
    function focusOpt(s) {
      for (const x of options()) x.tabIndex = -1;
      s.tabIndex = 0;
      s.focus({ preventScroll: true });
      keepVisible(s);
    }
    function pickAt(m) {
      if (!enabledAt(m)) return o.onReject?.(withMinutes(o.day(), m));
      o.say?.(null);
      o.onPick(m);
    }

    list.addEventListener("keydown", (e) => {
      if (/^[0-9]$/.test(e.key)) {
        e.preventDefault();
        input.focus();
        input.value = e.key;
        onInput();
        return;
      }
      const all = options().filter((s) => s.getAttribute("aria-disabled") !== "true");
      const i = all.indexOf(document.activeElement);
      let j;
      switch (e.key) {
        case "ArrowDown":
          j = i + 1;
          break;
        case "ArrowUp":
          j = i - 1;
          break;
        case "PageDown":
          j = i + 4;
          break;
        case "PageUp":
          j = i - 4;
          break;
        case "Home":
          j = 0;
          break;
        case "End":
          j = all.length - 1;
          break;
        case "Enter":
        case " ":
          e.preventDefault();
          if (document.activeElement?.dataset.min != null)
            pickAt(+document.activeElement.dataset.min);
          return;
        default:
          return;
      }
      e.preventDefault();
      browse();
      if (all.length) focusOpt(all[clampN(j, 0, all.length - 1)]);
    });
    list.addEventListener("click", (e) => {
      const s = e.target.closest(".pk-slot");
      if (s) pickAt(+s.dataset.min);
    });

    function onInput() {
      for (const s of options()) delete s.dataset.preview;
      const raw = input.value.trim();
      if (!raw) return o.say?.(null);
      const m = parseTime(raw);
      if (m == null) return o.say?.("Try 9:30, 21:05 or 9pm", "info");
      o.say?.(null);
      const near =
        options().find((s) => +s.dataset.min === m) ?? slots[Math.min(95, Math.round(m / 15))];
      near.dataset.preview = "";
      scrollTo(near, true);
    }
    input.addEventListener("input", onInput);
    input.addEventListener("focus", () => input.select());
    input.addEventListener("blur", () => {
      for (const s of options()) delete s.dataset.preview;
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const m = parseTime(input.value);
        if (m == null) return o.say?.("Try 9:30, 21:05 or 9pm", "warn");
        pickAt(m);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        const s = options().find((x) => x.tabIndex === 0);
        if (s) focusOpt(s);
      }
    });

    return {
      el,
      paint,
      scrollToSelected,
      resetBrowse() {
        browsed = false;
      },
      /* The typed field keeps what the user typed until a value is accepted. */
      syncInput() {
        const sel = selMin();
        input.value = sel != null ? fmtMin(sel) : "";
      },
    };
  }

  /* ============================================================
     Calendar popover: grid + time column + quick picks (or a compact
     date-only grid). ctx: { value(), min(), max(), now(), label }
     commit(ms, src) → bool (false when out of range, hint shown elsewhere)
     ============================================================ */
  function quickPicks(now) {
    const inHour = new Date(now + HOUR);
    const extra = inHour.getSeconds() || inHour.getMilliseconds() ? 1 : 0;
    inHour.setMinutes(Math.ceil((inHour.getMinutes() + extra) / 5) * 5, 0, 0);
    const today = dayStart(now);
    const dow = new Date(now).getDay();
    const toMonday = (1 - dow + 7) % 7 || 7;
    return [
      ["In 1 hour", inHour.getTime()],
      ["Tonight 21:00", withMinutes(today, 1260)],
      ["Tomorrow 09:00", withMinutes(addDays(today, 1), 540)],
      ["Monday 09:00", withMinutes(addDays(today, toMonday), 540)],
    ];
  }

  /* Sources that change the value from outside the time column: only these
     scroll it (never a range refresh on a sim tick, never the user's own pick). */
  const SCROLL_SRC = new Set(["external", "grid", "quick", "fix"]);

  function attachCalendar(container, ctx, commit, o) {
    /* o: { anchor(), origin(), compact, rangeStart?(), pickDay?(day) → ms|null, legend?(),
            onOpenChange?(open), keepOpen?(t), align?, inline?() → element|null, tz? }
       inline: when it returns an element, the panel opens in that element (in flow,
       no second floating surface) instead of a popover. */
    const pop = createPop(container, {
      cls: `pk-pop-cal${o.compact ? " is-compact" : ""}`,
      role: "dialog",
      label: ctx.label,
      anchor: o.anchor,
      layerAnchor: o.layerAnchor,
      align: o.align,
      keepOpen: o.keepOpen,
      focusBack: o.origin,
      onHide: () => o.onOpenChange?.(false),
    });
    let built = null;
    let inlineEl = null;
    let inlineOff = null;

    function build() {
      const el = mk("div", `pk-panel${o.compact ? " is-compact" : ""}`);
      const main = mk("div", "pk-panel-main");
      el.append(main);
      /* A day picked whose current time isn't allowed (today, 09:00 already gone):
         it is shown as chosen, the time column lists that day, and nothing is set
         until a time or the offered fix is accepted. */
      let pend = null;
      const dayOf = () => pend ?? (ctx.value() != null ? dayStart(ctx.value()) : grid.focusDay());
      const grid = createGrid({
        value: () => pend ?? ctx.value(),
        min: ctx.min,
        max: ctx.max,
        now: ctx.now,
        rangeStart: o.rangeStart,
        compact: o.compact,
        maxNote: o.maxNote,
        onPick: (d) => onDay(d),
      });
      main.append(grid.el);
      let time = null;
      let quick = null;
      if (!o.compact) {
        main.append(mk("div", "pk-vr"));
        time = createTimeCol({
          day: dayOf,
          value: ctx.value,
          min: ctx.min,
          max: ctx.max,
          now: ctx.now,
          onPick: (m) => {
            if (commit(withMinutes(dayOf(), m), "time")) {
              pend = null;
              hide();
            }
          },
          onReject: (ms) => reject(ms),
          say: (t, tone) => setMeta(t, tone),
        });
        main.append(time.el);
        quick = mk("div", "pk-quick");
        quick.setAttribute("role", "group");
        quick.setAttribute("aria-label", "Quick picks");
        for (const [label] of quickPicks(ctx.now())) {
          const b = mk("button", "pk-qp", `${icon("check")}<span>${escx(label)}</span>`);
          b.type = "button";
          quick.append(b);
        }
        el.append(quick);
        quick.addEventListener("click", (e) => {
          const b = e.target.closest(".pk-qp");
          if (!b || b.getAttribute("aria-disabled") === "true") return;
          if (commit(+b.dataset.ms, "quick")) {
            pend = null;
            hide();
          }
        });
        const say = (e) => {
          const b = e.target.closest?.(".pk-qp");
          if (!b || (metaMsg && metaMsg.tone === "warn" && metaMsg.fix)) return;
          setMeta(b.dataset.why || b.dataset.when, b.dataset.why ? "warn" : "info");
        };
        const unsay = () => {
          if (metaMsg && metaMsg.tone !== "warn") setMeta(null);
          else if (metaMsg && !metaMsg.fix) setMeta(null);
        };
        quick.addEventListener("pointerover", say);
        quick.addEventListener("focusin", say);
        quick.addEventListener("pointerleave", unsay);
        quick.addEventListener("focusout", unsay);
      }
      /* Footer: the window's limit, or one full-width message with its fix. */
      const meta = mk("div", "pk-panel-meta");
      meta.innerHTML = `<span class="pk-meta-l"></span><span class="pk-meta-r"></span>`;
      const sr = mk("span", "pk-sr");
      sr.setAttribute("role", "status");
      el.append(meta, sr);
      meta.addEventListener("click", (e) => {
        const b = e.target.closest(".pk-fix");
        if (!b || !metaMsg?.fix) return;
        if (commit(metaMsg.fix.ms, "fix")) {
          pend = null;
          setMeta(null);
          hide();
        }
      });
      let metaMsg = null;
      function setMeta(text, tone = "info", fix = null) {
        metaMsg = text ? { text, tone, fix } : null;
        paintMeta();
        const say = metaMsg && tone === "warn" ? `${text}${fix ? `. ${fix.label}?` : ""}` : "";
        if (sr.textContent !== say) sr.textContent = say;
      }
      function limitText() {
        const max = ctx.max();
        const now = ctx.now();
        const tz = o.tz || ctx.tz ? `${tzName()} · ` : "";
        if (max == null) return tz.replace(/ · $/, "");
        const horizon = Math.abs(max - now - HORIZON) < DAY;
        return `${tz}${horizon ? `90-day limit · ${fDate(max, now)}` : `Latest ${fDate(max, now)}`}`;
      }
      function paintMeta() {
        const l = meta.firstElementChild;
        const r = meta.lastElementChild;
        if (metaMsg) {
          meta.dataset.tone = metaMsg.tone;
          if (l.textContent !== metaMsg.text) l.textContent = metaMsg.text;
          const fx = metaMsg.fix
            ? `<button type="button" class="pk-fix">${escx(metaMsg.fix.label)}</button>`
            : metaMsg.tone === "info"
              ? escx(limitText())
              : "";
          if (r.innerHTML !== fx) r.innerHTML = fx;
          return;
        }
        delete meta.dataset.tone;
        const lg = o.legend?.() ?? "";
        if (l.innerHTML !== lg) l.innerHTML = lg;
        const lt = escx(limitText());
        if (r.innerHTML !== lt) r.innerHTML = lt;
      }
      /* One plain sentence + a one-click fix; the value only changes on accept. */
      function reject(ms) {
        const now = ctx.now();
        const r = explainFull(ms, { now, min: ctx.min(), max: ctx.max() });
        if (!r) return setMeta(null);
        const at = sameDay(ms, now) ? fTime(ms) : fFull(ms, now);
        const text = r.kind === "past" ? `${at} has passed` : (r.short ?? r.text);
        const fix =
          r.fix != null
            ? { ms: r.fix, label: `Use ${sameDay(r.fix, ms) ? fTime(r.fix) : r.fixLabel}` }
            : null;
        setMeta(text, "warn", fix);
      }

      function onDay(d) {
        const ms = o.pickDay ? o.pickDay(d) : combine(d);
        if (ms == null) return setMeta(`No times left on ${fDay(d, ctx.now())}`, "warn");
        const r = explainFull(ms, { now: ctx.now(), min: ctx.min(), max: ctx.max() });
        if (r) {
          if (time && r.fix != null && sameDay(r.fix, d)) {
            pend = d;
            grid.paint();
            time.paint();
            time.scrollToSelected(true, { force: true });
          }
          return reject(ms);
        }
        pend = null;
        if (!commit(ms, "grid")) return reject(ms);
        setMeta(null);
        if (o.compact) hide();
      }
      function combine(d) {
        const v = ctx.value();
        return withMinutes(d, v != null ? minutesOf(v) : 540);
      }
      function syncQuick() {
        if (!quick) return;
        const now = ctx.now();
        quickPicks(now).forEach(([label, ms], i) => {
          const b = quick.children[i];
          const why = explain(ms, { now, min: ctx.min(), max: ctx.max() });
          const on = ctx.value() === ms && pend == null;
          b.dataset.ms = ms;
          b.dataset.why = why ?? "";
          b.dataset.when = `${fFull(ms, now)} · ${fRel(ms, now)}`;
          b.setAttribute("aria-disabled", why ? "true" : "false");
          b.setAttribute("aria-pressed", on ? "true" : "false");
          b.setAttribute("aria-label", `${label}, ${why ?? fFull(ms, now)}`);
        });
      }
      function sync(src) {
        if (src === "external" || src === "open") pend = null;
        grid.paint();
        time?.paint();
        if (time && SCROLL_SRC.has(src)) time.scrollToSelected(true);
        if (src === "external" || src === "fix" || src === "quick") time?.syncInput();
        syncQuick();
        paintMeta();
      }
      return {
        el,
        grid,
        time,
        sync,
        setMeta,
        clearPending() {
          pend = null;
        },
      };
    }

    function ensure() {
      if (!built) built = build();
      return built;
    }
    function prepare() {
      const b = ensure();
      b.clearPending();
      b.grid.reset();
      b.setMeta(null);
      b.time?.resetBrowse();
      b.sync("open");
    }

    /* ---- inline (embedded) mode: the panel replaces part of the host surface */
    function openInline(host) {
      prepare();
      inlineEl = host;
      if (built.el.parentElement !== host) host.append(built.el);
      host.hidden = false;
      o.onOpenChange?.(true);
      if (motionOK())
        built.el.animate(
          [
            { opacity: 0, transform: "translateY(-4px)" },
            { opacity: 1, transform: "none" },
          ],
          { duration: 200, easing: EASE_PK },
        );
      else fade(built.el, 0, 1, 100);
      built.time?.scrollToSelected(false, { force: true });
      built.grid.focus();
      inlineOff = labLayer({
        el: host,
        anchor: o.layerAnchor?.() ?? o.anchor?.(),
        dismissOnOutside: false,
        close: (reason) => closeInline({ focus: reason === "escape" || reason === "close" }),
      });
      host.addEventListener("keydown", onInlineKey);
    }
    function onInlineKey(e) {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      closeInline({ focus: true });
    }
    function closeInline({ focus = true } = {}) {
      if (!inlineEl) return;
      const host = inlineEl;
      inlineEl = null;
      inlineOff?.();
      inlineOff = null;
      host.removeEventListener("keydown", onInlineKey);
      const hadFocus = host.contains(document.activeElement);
      host.hidden = true;
      o.onOpenChange?.(false);
      if (focus || hadFocus) o.origin?.()?.focus({ preventScroll: true });
    }

    function open(originEl) {
      const ih = o.inline?.();
      if (ih) return openInline(ih);
      prepare();
      if (built.el.parentElement !== pop.surface) pop.surface.append(built.el);
      o.onOpenChange?.(true);
      pop.show(originEl ?? o.origin?.());
      built.time?.scrollToSelected(false, { force: true });
      built.grid.focus();
    }
    function hide(opts) {
      if (inlineEl) closeInline(opts);
      else pop.hide(opts);
    }
    return {
      open,
      close: (opts) => hide(opts),
      toggle(originEl) {
        if (pop.open || inlineEl) hide();
        else open(originEl);
      },
      get isOpen() {
        return pop.open || !!inlineEl;
      },
      sync(src) {
        if (built && (pop.open || inlineEl)) built.sync(src);
      },
      setLabel(text) {
        pop.surface.setAttribute("aria-label", text);
      },
      destroy() {
        if (inlineEl) closeInline({ focus: false });
        pop.destroy();
        built?.el.remove();
      },
    };
  }

  /* ============================================================
     Shared bits
     ============================================================ */
  function hintEl(cls = "") {
    const el = mk("div", `pk-hint ${cls}`, '<div class="pk-hint-in"></div>');
    el.setAttribute("aria-live", "polite");
    const inner = el.firstElementChild;
    let key = "";
    return {
      el,
      /* text: string | null; fix: { label, onClick } */
      set(text, tone = "warn", fix = null) {
        const k = text ? `${tone}|${text}|${fix?.label ?? ""}` : "";
        if (k === key) return;
        key = k;
        if (!text) {
          delete el.dataset.on;
          return;
        }
        el.dataset.on = "";
        el.dataset.tone = tone;
        inner.innerHTML = `${tone === "warn" ? icon("alert") : ""}<span>${escx(text)}</span>${fix ? `<button type="button" class="pk-fix">${escx(fix.label)}</button>` : ""}`;
        if (fix) inner.querySelector(".pk-fix").addEventListener("click", fix.onClick);
      },
    };
  }

  /* Sliding plate behind the checked radio of a row. Supports wrapping rows. */
  function radioRow(row, onSelect) {
    const plate = row.querySelector(":scope > .pk-plate");
    const radios = () => [...row.querySelectorAll(':scope > [role="radio"]')];
    const disabled = (b) => b.getAttribute("aria-disabled") === "true";
    let placed = false;
    function movePlate(animate) {
      const cur = radios().find((b) => b.getAttribute("aria-checked") === "true");
      if (!cur || !cur.offsetWidth) {
        plate.style.opacity = "0";
        return;
      }
      const set = () => {
        plate.style.opacity = "1";
        plate.style.transform = `translate(${cur.offsetLeft}px, ${cur.offsetTop}px)`;
        plate.style.width = `${cur.offsetWidth}px`;
        plate.style.height = `${cur.offsetHeight}px`;
      };
      if (!animate || !placed || !motionOK()) {
        plate.style.transition = "none";
        set();
        void plate.offsetWidth;
        plate.style.transition = "";
        placed = true;
      } else set();
    }
    function check(btn, animate = true) {
      const list = radios();
      for (const b of list) {
        const on = b === btn;
        b.setAttribute("aria-checked", on ? "true" : "false");
        b.tabIndex = on ? 0 : -1;
      }
      if (!btn) {
        const first = list.find((b) => !disabled(b));
        if (first) first.tabIndex = 0;
      }
      movePlate(animate);
    }
    row.addEventListener("click", (e) => {
      const b = e.target.closest('[role="radio"]');
      if (!b || b.parentElement !== row || disabled(b)) return;
      onSelect(b, "click");
    });
    row.addEventListener("keydown", (e) => {
      const list = radios().filter((b) => !disabled(b));
      const i = list.indexOf(document.activeElement);
      if (i < 0) return;
      let j;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") j = (i + 1) % list.length;
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp")
        j = (i - 1 + list.length) % list.length;
      else if (e.key === "Home") j = 0;
      else if (e.key === "End") j = list.length - 1;
      else return;
      e.preventDefault();
      list[j].focus();
      onSelect(list[j], "key");
    });
    const ro =
      typeof ResizeObserver === "function" ? new ResizeObserver(() => movePlate(false)) : null;
    ro?.observe(row);
    return { check, movePlate, destroy: () => ro?.disconnect() };
  }

  /* Crossfading text slot (chip, totals): new layer fades in over the old. */
  function crossfader(el) {
    let key = null;
    return (k, html, attrs = {}) => {
      if (k === key) return;
      key = k;
      const layer = mk("span", "pk-xf", html);
      for (const [a, v] of Object.entries(attrs)) layer.dataset[a] = v;
      const olds = [...el.children].filter((c) => !c.dataset.leaving);
      el.append(layer);
      if (!olds.length) return;
      const moving = motionOK();
      for (const o of olds) {
        o.dataset.leaving = "1";
        o.setAttribute("aria-hidden", "true");
        fade(o, 1, 0, 90).finished.then(
          () => o.remove(),
          () => o.remove(),
        );
      }
      layer.animate(
        moving
          ? [
              { opacity: 0, transform: "translateY(2px)" },
              { opacity: 1, transform: "none" },
            ]
          : [{ opacity: 0 }, { opacity: 1 }],
        { duration: moving ? 160 : 100, easing: EASE_PK },
      );
    };
  }

  /* ============================================================
     dateTime(host, opts)
     ============================================================ */
  function dateTime(host, opts = {}) {
    const variant = ["calendar", "type", "segments"].includes(opts.variant)
      ? opts.variant
      : "calendar";
    const getNow = () => resolveNow(opts.now);
    let value = Number.isFinite(opts.value) ? opts.value : null;
    let min = opts.min !== undefined ? opts.min : getNow();
    let max = opts.max !== undefined ? opts.max : getNow() + HORIZON;
    const root = mk("div", `pk pk-dt pk-v-${variant}`);
    host.append(root);
    let invalid = null;
    const ctx = {
      root,
      label: opts.label ?? "Date and time",
      tz: !!opts.tz,
      inline: opts.inline,
      value: () => value,
      min: () => min,
      max: () => max,
      now: getNow,
      setInvalid(r) {
        if (r === invalid) return;
        invalid = r;
        opts.onInvalid?.(r);
      },
      reason(ms) {
        return explainFull(ms, { now: getNow(), min, max });
      },
    };
    let view;
    /* src: "grid" | "time" | "quick" | "fix" (calendar) · "type" | "suggestion" |
       "blur" (type) · "segments" (stepping/typing a segment). onChange(ms, { via })
       fires when the value changes; onCommit(ms, { changed, via }) on every user
       accept, even of the same value (hosts close their popovers on it). */
    function commit(ms, src) {
      const why = explain(ms, { now: getNow(), min, max });
      if (why) {
        ctx.setInvalid(why);
        return false;
      }
      ctx.setInvalid(null);
      const changed = ms !== value;
      if (changed) {
        value = ms;
        view.sync(src);
        opts.onChange?.(ms, { via: src });
      } else view.sync(src);
      opts.onCommit?.(ms, { changed, via: src });
      return true;
    }
    view = (variant === "type" ? typeView : variant === "segments" ? segmentsView : calendarView)(
      ctx,
      commit,
    );
    view.sync("init");
    return {
      el: root,
      value: () => value,
      set(ms) {
        value = Number.isFinite(ms) ? ms : null;
        view.sync("external");
      },
      setRange(lo, hi) {
        if (lo === min && hi === max) return;
        min = lo;
        max = hi;
        view.refresh();
      },
      refresh: () => view.refresh(),
      focus: () => view.focus(),
      open: () => view.open?.(),
      setText: (t) => view.setText?.(t),
      /* e.g. "First run" ↔ "Runs at" when a host switches Once/Repeats. */
      setLabel(text) {
        if (!text || text === ctx.label) return;
        ctx.label = text;
        view.setLabel?.(text);
      },
      destroy() {
        view.destroy?.();
        root.remove();
      },
    };
  }

  /* ---------------- calendar: a trigger that grows into the popover */
  function calendarView(ctx, commit) {
    const trig = mk("button", "pk-trigger");
    trig.type = "button";
    trig.setAttribute("aria-haspopup", "dialog");
    trig.setAttribute("aria-expanded", "false");
    trig.innerHTML = `${icon("cal")}<span class="pk-trig-val"></span><span class="pk-trig-rel"></span>`;
    const hint = hintEl();
    ctx.root.append(trig, hint.el);
    const valEl = trig.querySelector(".pk-trig-val");
    const relEl = trig.querySelector(".pk-trig-rel");
    const cal = attachCalendar(ctx.root, ctx, commit, {
      anchor: () => trig,
      origin: () => trig,
      keepOpen: (t) => trig.contains(t),
      onOpenChange: (on) => trig.setAttribute("aria-expanded", String(on)),
    });
    trig.addEventListener("click", () => cal.toggle(trig));
    trig.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" && !cal.isOpen) {
        e.preventDefault();
        cal.open(trig);
      }
    });
    function paint() {
      const v = ctx.value();
      const now = ctx.now();
      valEl.textContent = v != null ? fFull(v, now) : "Pick a time";
      relEl.textContent = v != null ? fRel(v, now) : "";
      trig.setAttribute(
        "aria-label",
        `${ctx.label}: ${v != null ? `${fFull(v, now)}, ${fRel(v, now)}` : "not set"}. Change`,
      );
      const r = v != null ? ctx.reason(v) : null;
      trig.toggleAttribute("data-invalid", !!r);
      hint.set(
        r ? (r.fix != null ? (r.short ?? r.text) : r.text) : null,
        "warn",
        r?.fix != null ? { label: `Use ${r.fixLabel}`, onClick: () => commit(r.fix, "fix") } : null,
      );
    }
    return {
      sync(src) {
        paint();
        cal.sync(src);
      },
      refresh() {
        paint();
        cal.sync("range");
      },
      setLabel(text) {
        paint();
        cal.setLabel(text);
      },
      focus: () => trig.focus(),
      open: () => cal.open(trig),
      destroy: () => cal.destroy(),
    };
  }

  /* ---------------- type: one field that reads plain phrases
     Standalone it floats its suggestions under the field. Embedded — inside a
     popover, sheet or dialog (auto-detected, or opts.inline) — the suggestions and
     the calendar render in flow inside that surface: one surface, one shadow, and
     Escape reverts an edit in one press, then reaches the host. */
  function typeView(ctx, commit) {
    const listId = nid("sugg");
    const chipId = nid("chip");
    const embedded =
      ctx.inline != null
        ? !!ctx.inline
        : !!ctx.root.closest('.pop, [popover], [role="dialog"], dialog');
    ctx.root.classList.toggle("is-embedded", embedded);
    ctx.root.insertAdjacentHTML(
      "beforeend",
      `<div class="pk-field">
        <input class="pk-input" type="text" role="combobox" aria-autocomplete="list" aria-expanded="false"
          aria-controls="${listId}" aria-describedby="${chipId}" aria-label="${escx(ctx.label)}"
          spellcheck="false" autocomplete="off" placeholder="tomorrow 9, fri 17:30, in 2h">
        <button type="button" class="pk-icon-btn pk-cal-btn" aria-label="Open calendar" aria-haspopup="dialog" aria-expanded="false">${icon("cal")}</button>
      </div>
      <div class="pk-chipline" id="${chipId}"><span class="pk-chip"></span></div>
      ${
        embedded
          ? `<div class="pk-inl-list" role="listbox" id="${listId}" aria-label="Suggestions"></div>
             <div class="pk-inl-cal" hidden></div>`
          : ""
      }
      <span class="pk-sr" role="status"></span>`,
    );
    const field = ctx.root.querySelector(".pk-field");
    const input = field.querySelector("input");
    const calBtn = field.querySelector(".pk-cal-btn");
    const chipLine = ctx.root.querySelector(".pk-chipline");
    const chip = chipLine.querySelector(".pk-chip");
    const inlList = ctx.root.querySelector(".pk-inl-list");
    const inlCal = ctx.root.querySelector(".pk-inl-cal");
    const sr = ctx.root.querySelector(".pk-sr");
    const setChip = crossfader(chip);

    const sugg = embedded
      ? null
      : createPop(ctx.root, {
          cls: "pk-pop-sugg",
          role: "listbox",
          label: "Suggestions",
          id: listId,
          morph: false,
          gap: 2,
          anchor: () => chipLine,
          layerAnchor: () => field,
          keepOpen: (t) => field.contains(t),
          onHide: () => {
            input.setAttribute("aria-expanded", "false");
            input.removeAttribute("aria-activedescendant");
          },
        });
    sugg?.surface.removeAttribute("tabindex");
    const listEl = () => (embedded ? inlList : sugg.surface);
    const listOpen = () => (embedded ? !inlList.hidden && items.length > 0 : sugg.open);
    let calOpen = false;
    const cal = attachCalendar(ctx.root, ctx, commitFromCalendar, {
      anchor: () => field,
      origin: () => calBtn,
      layerAnchor: () => field,
      keepOpen: (t) => calBtn.contains(t),
      inline: () => (embedded ? inlCal : null),
      onOpenChange: (on) => {
        calOpen = on;
        calBtn.setAttribute("aria-expanded", String(on));
        if (embedded) {
          inlList.hidden = on;
          if (!on) renderList();
        }
      },
    });

    let parsed = null;
    let items = [];
    let active = -1;
    let errTimer = 0;
    let srTimer = 0;
    let justSet = false;
    /* Screen readers hear the settled reading, not every keystroke. */
    function announce(text) {
      clearTimeout(srTimer);
      srTimer = setTimeout(() => {
        if (sr.textContent !== text) sr.textContent = text;
      }, 600);
    }
    /* While an edit is pending, Escape (via core's layer stack) reverts it — and,
       floating, first closes the list — before it reaches the host's layer. */
    let editOff = null;
    function trackEdit() {
      const on = document.activeElement === input && editing();
      if (on && !editOff)
        editOff = labLayer({
          el: field,
          anchor: field,
          dismissOnOutside: true,
          close: (reason) => {
            if (reason === "outside") return;
            if (!embedded && sugg.open) return closeList();
            revert();
          },
        });
      else if (!on && editOff) {
        editOff();
        editOff = null;
      }
    }
    function revert() {
      input.value = canonical();
      ctx.setInvalid(null);
      active = -1;
      paintChip();
      if (embedded) renderList();
      else closeList();
      trackEdit();
    }

    function commitFromCalendar(ms, src) {
      const ok = commit(ms, src);
      if (ok) {
        input.value = fFull(ms, ctx.now());
        parsed = null;
        justSet = true;
        paintChip();
      }
      return ok;
    }

    function canonical() {
      const v = ctx.value();
      return v != null ? fFull(v, ctx.now()) : "";
    }
    const editing = () => normalize(input.value) !== normalize(canonical());

    function paintChip(immediateError = false) {
      const v = ctx.value();
      const now = ctx.now();
      clearTimeout(errTimer);
      if (!editing() || !input.value.trim()) {
        parsed = null;
        if (!input.value.trim() && document.activeElement === input)
          return setChip("hint", `<span>Type a day and a time — “fri 17:30”, “in 2h”</span>`, {
            tone: "idle",
          });
        const r = v != null ? ctx.reason(v) : null;
        if (r) return chipWarn(r);
        if (v == null) return setChip("none", "<span>No time set</span>", { tone: "idle" });
        if (justSet)
          return setChip(
            `set|${v}`,
            `${icon("check")}<span class="pk-rel">${escx(fRel(v, now))}</span>`,
            { tone: "set" },
          );
        return setChip(
          `idle|${fRel(v, now)}`,
          `<span class="pk-rel">${escx(fRel(v, now))}</span>`,
          {
            tone: "idle",
          },
        );
      }
      parsed = parseWhen(input.value, now, { defaultTime: v != null ? minutesOf(v) : 540 });
      if (parsed.error) {
        const show = () => {
          setChip(`err|${parsed.error}`, `${icon("alert")}<span>${escx(parsed.error)}</span>`, {
            tone: "warn",
          });
          ctx.setInvalid(parsed.error);
          announce(parsed.error);
        };
        if (immediateError) return show();
        setChip("wait", "<span>Keep typing…</span>", { tone: "idle" });
        errTimer = setTimeout(show, 650);
        return;
      }
      const r = ctx.reason(parsed.ms);
      if (r) return chipWarn(r, parsed);
      setChip(
        `ok|${parsed.ms}|${parsed.rel}`,
        `${icon("arrow")}<b>${escx(parsed.label)}</b> <span class="pk-sep">·</span> <span class="pk-rel">${escx(parsed.rel)}</span><kbd>↵</kbd>`,
        { tone: "ok" },
      );
      announce(`${parsed.label}, ${parsed.rel}. Enter to set.`);
    }
    function chipWarn(r, p) {
      const fix =
        r.fix != null
          ? `<button type="button" class="pk-fix" data-fix="${r.fix}">Use ${escx(r.fixLabel)}</button>`
          : "";
      const lead = p ? `<b>${escx(p.label)}</b> <span class="pk-sep">·</span> ` : "";
      const text = fix ? (r.short ?? r.text) : r.text;
      setChip(
        `warn|${r.text}|${p?.ms ?? ""}|${r.fixLabel ?? ""}`,
        `${icon("alert")}<span class="pk-chip-why">${lead}${escx(text)}</span>${fix}`,
        { tone: "warn" },
      );
      ctx.setInvalid(r.text);
      if (p) announce(`${p.label}: ${r.text}${r.fixLabel ? `. Use ${r.fixLabel}?` : ""}`);
    }
    chip.addEventListener("click", (e) => {
      const b = e.target.closest(".pk-fix");
      if (!b) return;
      accept(+b.dataset.fix, "fix");
    });

    /* Accepting rewrites the phrase as the value it became ("fri 17:30" →
       "Fri, Oct 9 · 17:30"), so the field always reads back what is set. */
    function accept(ms, via = "type") {
      if (!commit(ms, via)) return paintChip(true);
      clearTimeout(errTimer);
      input.value = canonical();
      justSet = true;
      parsed = null;
      paintChip();
      if (embedded) {
        active = -1;
        renderList();
      } else closeList();
      trackEdit();
    }

    function optionsHtml() {
      const typed = editing() ? normalize(input.value) : "";
      return items
        .map((it, i) => {
          const head = !it.nearest && typed && it.phrase.startsWith(typed) ? typed.length : 0;
          const ph = it.nearest
            ? `<span class="pk-opt-near">${escx(it.nearest)} allowed</span>`
            : `<span class="pk-opt-typed">${escx(it.phrase.slice(0, head))}</span>${escx(it.phrase.slice(head))}`;
          return `<div class="pk-opt" role="option" id="${listId}-${i}" aria-selected="${i === active}" data-i="${i}">
              <span class="pk-opt-ph">${ph}</span>
              <span class="pk-opt-when">${escx(it.label)}</span></div>`;
        })
        .join("");
    }
    function renderList() {
      const now = ctx.now();
      items = suggest(editing() ? input.value : "", now, {
        min: ctx.min(),
        max: ctx.max(),
        defaultTime: ctx.value() != null ? minutesOf(ctx.value()) : 540,
      });
      if (embedded) {
        if (calOpen) return;
        active = Math.min(active, items.length - 1);
        const html = optionsHtml();
        if (inlList.innerHTML !== html) inlList.innerHTML = html;
        inlList.hidden = !items.length;
        input.setAttribute("aria-expanded", String(items.length > 0));
        if (active >= 0) input.setAttribute("aria-activedescendant", `${listId}-${active}`);
        else input.removeAttribute("aria-activedescendant");
        return;
      }
      if (!items.length || document.activeElement !== input) return closeList();
      active = Math.min(active, items.length - 1);
      sugg.surface.innerHTML =
        optionsHtml() +
        `<div class="pk-opt-foot" aria-hidden="true"><kbd>↑</kbd><kbd>↓</kbd> choose <kbd>↵</kbd> set <kbd>esc</kbd> close</div>`;
      sugg.surface.style.minWidth = `${field.offsetWidth}px`;
      input.setAttribute("aria-expanded", "true");
      if (active >= 0) input.setAttribute("aria-activedescendant", `${listId}-${active}`);
      else input.removeAttribute("aria-activedescendant");
      if (!sugg.open) sugg.show();
      else sugg.place();
    }
    function closeList() {
      active = -1;
      if (embedded) {
        for (const el of inlList.querySelectorAll(".pk-opt"))
          el.setAttribute("aria-selected", "false");
        input.removeAttribute("aria-activedescendant");
        return;
      }
      if (sugg.open) sugg.hide({ focus: false });
    }
    function moveActive(d) {
      if (!listOpen()) return renderList();
      active =
        active < 0 ? (d > 0 ? 0 : items.length - 1) : (active + d + items.length) % items.length;
      for (const el of listEl().querySelectorAll(".pk-opt"))
        el.setAttribute("aria-selected", String(+el.dataset.i === active));
      input.setAttribute("aria-activedescendant", `${listId}-${active}`);
      listEl().querySelector(`#${listId}-${active}`)?.scrollIntoView?.({ block: "nearest" });
    }
    listEl().addEventListener("pointerdown", (e) => {
      const opt = e.target.closest(".pk-opt");
      e.preventDefault();
      if (!opt) return;
      const it = items[+opt.dataset.i];
      if (it) accept(it.ms, "suggestion");
    });

    input.addEventListener("focus", () => {
      input.select();
      justSet = false;
      paintChip();
      if (embedded && calOpen) cal.close({ focus: false });
      renderList();
    });
    input.addEventListener("input", () => {
      justSet = false;
      active = -1;
      paintChip();
      renderList();
      trackEdit();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        moveActive(1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        moveActive(-1);
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (listOpen() && active >= 0 && items[active])
          return accept(items[active].ms, "suggestion");
        if (!editing()) {
          /* Enter on the value as it stands is still an accept (hosts close on it). */
          const v = ctx.value();
          if (v != null && !ctx.reason(v)) commit(v, "type");
          return closeList();
        }
        const p = parseWhen(input.value, ctx.now(), {
          defaultTime: ctx.value() != null ? minutesOf(ctx.value()) : 540,
        });
        if (p.error) return paintChip(true);
        accept(p.ms, "type");
      } else if (e.key === "Escape") {
        /* Only reached without core's layer stack. */
        if (!embedded && sugg.open) {
          e.preventDefault();
          e.stopPropagation();
          closeList();
        } else if (editing()) {
          e.preventDefault();
          e.stopPropagation();
          revert();
        }
      } else if (e.key === "Tab" && !embedded) closeList();
    });
    input.addEventListener("blur", () => {
      if (!embedded) closeList();
      if (editing() && input.value.trim()) {
        const p = parseWhen(input.value, ctx.now(), {
          defaultTime: ctx.value() != null ? minutesOf(ctx.value()) : 540,
        });
        if (!p.error && !ctx.reason(p.ms)) {
          commit(p.ms, "blur");
          input.value = canonical();
        }
      } else if (!input.value.trim()) input.value = canonical();
      justSet = false;
      paintChip(true);
      trackEdit();
      if (embedded) renderList();
    });
    calBtn.addEventListener("click", () => {
      closeList();
      cal.toggle(calBtn);
    });

    if (embedded) renderList();

    return {
      sync(src) {
        if (src !== "type" && document.activeElement !== input) input.value = canonical();
        if (src === "external") justSet = false;
        if (!editing())
          ctx.setInvalid(ctx.value() != null ? (ctx.reason(ctx.value())?.text ?? null) : null);
        paintChip();
        cal.sync(src);
      },
      refresh() {
        if (document.activeElement !== input && !editing()) input.value = canonical();
        paintChip();
        if (embedded && !editing() && !calOpen) renderList();
        cal.sync("range");
      },
      setLabel(text) {
        input.setAttribute("aria-label", text);
        cal.setLabel(text);
      },
      focus: () => input.focus(),
      open() {
        input.focus();
      },
      setText(t) {
        if (embedded && calOpen) cal.close({ focus: false });
        input.focus();
        input.value = t;
        justSet = false;
        active = -1;
        paintChip(true);
        renderList();
        trackEdit();
      },
      destroy() {
        clearTimeout(errTimer);
        clearTimeout(srTimer);
        editOff?.();
        sugg?.destroy();
        cal.destroy();
      },
    };
  }

  /* ---------------- segments: a react-aria-style DateField */
  const SEGS = ["day", "month", "year", "hour", "minute"];
  const SEG_LABEL = { day: "Day", month: "Month", year: "Year", hour: "Hour", minute: "Minute" };
  const SEG_EMPTY = { day: "dd", month: "mmm", year: "yyyy", hour: "hh", minute: "mm" };

  function segmentsView(ctx, commit) {
    const hasYearVariance = () => yearOf(ctx.min() ?? ctx.now()) !== yearOf(ctx.max() ?? ctx.now());
    ctx.root.insertAdjacentHTML(
      "beforeend",
      `<div class="pk-segfield" role="group" aria-label="${escx(ctx.label)}">
        <span class="pk-seg-ro"></span>
        ${SEGS.map(
          (s) =>
            `${s === "hour" ? '<span class="pk-seg-lit pk-seg-dot" aria-hidden="true">·</span>' : ""}${s === "minute" ? '<span class="pk-seg-lit" aria-hidden="true">:</span>' : ""}<span class="pk-seg" role="spinbutton" tabindex="0" data-seg="${s}" aria-label="${SEG_LABEL[s]}" inputmode="numeric"></span>`,
        ).join("")}
        <button type="button" class="pk-icon-btn pk-cal-btn" aria-label="Open calendar" aria-haspopup="dialog" aria-expanded="false">${icon("cal")}</button>
      </div>`,
    );
    const hint = hintEl();
    ctx.root.append(hint.el);
    const field = ctx.root.querySelector(".pk-segfield");
    const ro = field.querySelector(".pk-seg-ro");
    const segEl = Object.fromEntries(
      SEGS.map((s) => [s, field.querySelector(`[data-seg="${s}"]`)]),
    );
    const calBtn = field.querySelector(".pk-cal-btn");
    let parts = {};
    let buf = "";
    let bufSeg = null;
    let bufTimer = 0;
    /* Until the user edits the year, a month/day edit lands on the occurrence of that
       date nearest the allowed window (Jan in an Oct → Jan window means next Jan). */
    let yearTouched = false;

    function inferYear() {
      if (yearTouched || parts.year == null || parts.month == null || parts.day == null) return;
      const lo = ctx.min();
      const hi = ctx.max();
      if (lo == null || hi == null) return;
      const mins = (parts.hour ?? 9) * 60 + (parts.minute ?? 0);
      const at = (y) =>
        parts.day > daysInMonth(y, parts.month)
          ? null
          : withMinutes(mkDate(y, parts.month, parts.day), mins);
      const dist = (ms) => (ms == null ? Infinity : ms <= lo ? lo - ms + 1 : ms > hi ? ms - hi : 0);
      let best = parts.year;
      let bd = dist(at(best));
      for (const y of [parts.year - 1, parts.year + 1]) {
        const d = dist(at(y));
        if (d < bd) {
          bd = d;
          best = y;
        }
      }
      parts.year = best;
    }

    function fromValue() {
      const v = ctx.value();
      if (v == null) parts = { day: null, month: null, year: null, hour: null, minute: null };
      else {
        const d = new Date(v);
        parts = {
          day: d.getDate(),
          month: d.getMonth(),
          year: d.getFullYear(),
          hour: d.getHours(),
          minute: d.getMinutes(),
        };
      }
    }
    const dim = () => (parts.month == null ? 31 : daysInMonth(parts.year ?? 2028, parts.month));
    const range = (s) => {
      const y0 = yearOf(ctx.min() ?? ctx.now());
      const y1 = yearOf(ctx.max() ?? ctx.now() + HORIZON);
      return {
        day: [1, dim()],
        month: [0, 11],
        year: [Math.min(y0, parts.year ?? y0), Math.max(y1, parts.year ?? y1)],
        hour: [0, 23],
        minute: [0, 59],
      }[s];
    };
    const complete = () => SEGS.every((s) => parts[s] != null);
    const msOf = () =>
      withMinutes(mkDate(parts.year, parts.month, parts.day), parts.hour * 60 + parts.minute);

    function text(s) {
      if (bufSeg === s && buf)
        return s === "month" && /[a-z]/.test(buf) ? (MO[parts.month] ?? buf) : buf;
      const v = parts[s];
      if (v == null) return SEG_EMPTY[s];
      if (s === "month") return MO[v];
      if (s === "year") return String(v);
      return pad2(v);
    }
    function paint() {
      for (const s of SEGS) {
        const el = segEl[s];
        const v = parts[s];
        const [lo, hi] = range(s);
        el.textContent = text(s);
        setAttr(el, "data-empty", v == null && !(bufSeg === s && buf));
        setAttr(el, "data-typing", bufSeg === s && !!buf);
        el.setAttribute("aria-valuemin", s === "month" ? lo + 1 : lo);
        el.setAttribute("aria-valuemax", s === "month" ? hi + 1 : hi);
        if (v == null) {
          el.removeAttribute("aria-valuenow");
          el.setAttribute("aria-valuetext", "Empty");
        } else {
          el.setAttribute("aria-valuenow", s === "month" ? v + 1 : v);
          el.setAttribute(
            "aria-valuetext",
            s === "month" ? MO_LONG[v] : s === "hour" ? `${v} o'clock` : String(v),
          );
        }
      }
      const dateKnown = parts.day != null && parts.month != null && parts.year != null;
      ro.textContent = dateKnown
        ? WD[new Date(parts.year, parts.month, parts.day).getDay()]
        : "–––";
      segEl.year.toggleAttribute(
        "data-quiet",
        !hasYearVariance() && parts.year === yearOf(ctx.now()),
      );
    }
    function validate() {
      if (bufSeg && buf) return; /* a half-typed value is not an answer yet */
      if (!complete()) {
        const missing = SEGS.filter((s) => parts[s] == null).map((s) => SEG_LABEL[s].toLowerCase());
        const msg = `Fill in the ${missing.join(" and ")}`;
        field.removeAttribute("data-invalid");
        hint.set(msg, "muted");
        ctx.setInvalid(msg);
        return;
      }
      const ms = msOf();
      const r = ctx.reason(ms);
      if (r) {
        field.setAttribute("data-invalid", "");
        hint.set(
          r.fix != null ? (r.short ?? r.text) : r.text,
          "warn",
          r.fix != null ? { label: `Use ${r.fixLabel}`, onClick: () => commitFix(r.fix) } : null,
        );
        ctx.setInvalid(r.text);
        return;
      }
      field.removeAttribute("data-invalid");
      hint.set(null);
      commit(ms, "segments");
    }
    function commitFix(ms) {
      if (commit(ms, "fix")) {
        fromValue();
        paint();
        validate();
      }
    }
    function change(s, v, { settle = true } = {}) {
      parts[s] = v;
      if (s === "year") yearTouched = true;
      if (s === "month" || s === "day") inferYear();
      if ((s === "month" || s === "year") && parts.day != null && parts.day > dim())
        parts.day = dim();
      paint();
      if (settle) validate();
    }
    /* Buffer timed out: the typed value stands, now judge it. */
    function settleBuf() {
      const had = !!(bufSeg && buf);
      const s = bufSeg;
      clearBuf();
      if (had && (s === "month" || s === "day")) inferYear();
      paint();
      if (had) validate();
    }
    function clearBuf() {
      buf = "";
      bufSeg = null;
      clearTimeout(bufTimer);
    }
    function move(s, d) {
      clearBuf();
      const i = SEGS.indexOf(s) + d;
      if (i >= 0 && i < SEGS.length) segEl[SEGS[i]].focus();
      paint();
    }
    function step(s, dir, big) {
      clearBuf();
      const cur = parts[s];
      const now = new Date(ctx.value() ?? ctx.now());
      if (cur == null) {
        const dflt = {
          day: now.getDate(),
          month: now.getMonth(),
          year: now.getFullYear(),
          hour: 9,
          minute: 0,
        };
        return change(s, dflt[s]);
      }
      const [lo, hi] = range(s);
      const span = hi - lo + 1;
      const wrap = (n) => ((((n - lo) % span) + span) % span) + lo;
      let n;
      if (s === "minute") {
        const st = big ? 15 : 5;
        n = dir > 0 ? Math.floor(cur / st) * st + st : Math.ceil(cur / st) * st - st;
        n = ((n % 60) + 60) % 60;
      } else if (s === "year") n = clampN(cur + dir, lo, hi);
      else n = wrap(cur + dir * (big ? (s === "day" ? 7 : s === "month" ? 3 : 6) : 1));
      change(s, n);
    }
    function typeDigit(s, ch) {
      clearTimeout(bufTimer);
      if (bufSeg !== s) {
        buf = "";
        bufSeg = s;
      }
      bufTimer = setTimeout(settleBuf, 1400);
      if (s === "year") {
        buf = (buf.length >= 4 ? "" : buf) + ch;
        if (buf.length === 4) {
          const y = +buf;
          clearBuf();
          change("year", y);
          return move("year", 1);
        }
        parts.year = null;
        yearTouched = true;
        return paint();
      }
      const hi = s === "month" ? 12 : s === "day" ? dim() : s === "hour" ? 23 : 59;
      const lo = s === "day" || s === "month" ? 1 : 0;
      let b = /^\d+$/.test(buf) ? buf + ch : ch;
      let n = +b;
      if (n > hi) {
        b = ch;
        n = +ch;
      }
      buf = b;
      if (n >= lo) parts[s] = s === "month" ? n - 1 : n;
      else parts[s] = null;
      if (b.length >= 2 || n * 10 > hi) {
        clearBuf();
        change(s, parts[s]);
        if (parts[s] != null) move(s, 1);
        return;
      }
      paint();
    }
    function typeLetter(ch) {
      clearTimeout(bufTimer);
      if (bufSeg !== "month" || /\d/.test(buf)) buf = "";
      bufSeg = "month";
      let b = buf + ch;
      let hits = MO_LONG.filter((n) => n.toLowerCase().startsWith(b));
      if (!hits.length) {
        b = ch;
        hits = MO_LONG.filter((n) => n.toLowerCase().startsWith(b));
      }
      if (!hits.length) return;
      buf = b;
      bufTimer = setTimeout(settleBuf, 1400);
      const m = MO_LONG.indexOf(hits[0]);
      if (hits.length === 1) {
        clearBuf();
        change("month", m);
        return move("month", 1);
      }
      /* "j": Jan, Jun or Jul — wait for the next letter before judging. */
      change("month", m, { settle: false });
    }

    field.addEventListener("keydown", (e) => {
      const el = e.target.closest?.(".pk-seg");
      if (!el) return;
      const s = el.dataset.seg;
      const k = e.key;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (k === "ArrowUp" || k === "ArrowDown") {
        e.preventDefault();
        step(s, k === "ArrowUp" ? 1 : -1, e.shiftKey);
      } else if (k === "PageUp" || k === "PageDown") {
        e.preventDefault();
        step(s, k === "PageUp" ? 1 : -1, true);
      } else if (k === "Home" || k === "End") {
        e.preventDefault();
        clearBuf();
        const [lo, hi] = range(s);
        change(s, k === "Home" ? lo : hi);
      } else if (k === "ArrowLeft" || k === "ArrowRight") {
        e.preventDefault();
        move(s, k === "ArrowLeft" ? -1 : 1);
      } else if (k === "Backspace" || k === "Delete") {
        e.preventDefault();
        if (bufSeg === s && buf) {
          buf = buf.slice(0, -1);
          if (!buf) {
            clearBuf();
            parts[s] = null;
          } else if (/^\d+$/.test(buf)) parts[s] = s === "month" ? +buf - 1 : +buf;
          paint();
          validate();
        } else if (parts[s] != null) change(s, null);
        else if (k === "Backspace") move(s, -1);
      } else if (/^[0-9]$/.test(k)) {
        e.preventDefault();
        typeDigit(s, k);
      } else if (s === "month" && /^[a-z]$/i.test(k)) {
        e.preventDefault();
        typeLetter(k.toLowerCase());
      } else if (k === " ") e.preventDefault();
    });
    field.addEventListener("focusout", (e) => {
      if (e.relatedTarget && field.contains(e.relatedTarget)) return;
      settleBuf();
    });
    /* Clicking the literals or weekday focuses the nearest segment. */
    field.addEventListener("pointerdown", (e) => {
      if (e.target === field || e.target.classList.contains("pk-seg-lit") || e.target === ro) {
        e.preventDefault();
        const first = SEGS.find((s) => parts[s] == null) ?? "day";
        segEl[first].focus();
      }
    });

    const cal = attachCalendar(ctx.root, ctx, commitFromCal, {
      compact: true,
      anchor: () => field,
      align: "end",
      origin: () => calBtn,
      keepOpen: (t) => calBtn.contains(t),
      onOpenChange: (on) => calBtn.setAttribute("aria-expanded", String(on)),
      /* Keeps the typed time; a passed time on today is offered a fix in the footer. */
      pickDay: (d) => withMinutes(d, (parts.hour ?? 9) * 60 + (parts.minute ?? 0)),
    });
    function commitFromCal(ms, src) {
      const ok = commit(ms, src);
      if (ok) {
        fromValue();
        paint();
        validate();
      }
      return ok;
    }
    calBtn.addEventListener("click", () => cal.toggle(calBtn));

    return {
      sync(src) {
        if (src !== "segments") {
          clearBuf();
          yearTouched = false;
          fromValue();
          paint();
          if (complete()) {
            const r = ctx.reason(msOf());
            field.toggleAttribute("data-invalid", !!r);
            hint.set(
              r ? (r.fix != null ? (r.short ?? r.text) : r.text) : null,
              "warn",
              r?.fix != null
                ? { label: `Use ${r.fixLabel}`, onClick: () => commitFix(r.fix) }
                : null,
            );
          }
        } else paint();
        cal.sync(src);
      },
      refresh() {
        paint();
        /* A sim tick never judges a half-typed segment. */
        if (complete() && !(bufSeg && buf)) {
          const r = ctx.reason(msOf());
          field.toggleAttribute("data-invalid", !!r);
          hint.set(
            r ? (r.fix != null ? (r.short ?? r.text) : r.text) : null,
            "warn",
            r?.fix != null ? { label: `Use ${r.fixLabel}`, onClick: () => commitFix(r.fix) } : null,
          );
        }
        cal.sync("range");
      },
      setLabel(text) {
        field.setAttribute("aria-label", text);
        cal.setLabel(text);
      },
      focus: () => segEl.day.focus(),
      open: () => cal.open(calBtn),
      destroy() {
        clearTimeout(bufTimer);
        cal.destroy();
      },
    };
  }

  /* ============================================================
     calendarPopover(anchorEl, opts) — the calendar popover on any control
     (e.g. a sentence token). Appends next to the anchor.
     ============================================================ */
  function calendarPopover(anchorEl, opts = {}) {
    const getNow = () => resolveNow(opts.now);
    let value = Number.isFinite(opts.value) ? opts.value : null;
    let min = opts.min !== undefined ? opts.min : getNow();
    let max = opts.max !== undefined ? opts.max : getNow() + HORIZON;
    const container = opts.container ?? anchorEl.parentElement ?? document.body;
    const ctx = {
      label: opts.label ?? "Date and time",
      value: () => value,
      min: () => min,
      max: () => max,
      now: getNow,
    };
    let cal;
    const commit = (ms, src) => {
      if (explain(ms, { now: getNow(), min, max })) return false;
      const changed = ms !== value;
      if (changed) {
        value = ms;
        opts.onChange?.(ms, { via: src });
      }
      cal.sync(src);
      opts.onCommit?.(ms, { changed, via: src });
      return true;
    };
    cal = attachCalendar(container, ctx, commit, {
      compact: !!opts.compact,
      tz: !!opts.tz,
      anchor: () => anchorEl,
      origin: () => anchorEl,
      keepOpen: (t) => anchorEl.contains(t),
      onOpenChange: (on) => anchorEl.setAttribute("aria-expanded", String(on)),
    });
    anchorEl.setAttribute("aria-haspopup", "dialog");
    anchorEl.setAttribute("aria-expanded", "false");
    return {
      open: (o) => cal.open(o ?? anchorEl),
      close: () => cal.close(),
      toggle: (o) => cal.toggle(o ?? anchorEl),
      set(ms) {
        value = ms;
        cal.sync("external");
      },
      setRange(lo, hi) {
        min = lo;
        max = hi;
        cal.sync("range");
      },
      setLabel(text) {
        if (!text) return;
        ctx.label = text;
        cal.setLabel(text);
      },
      destroy: () => cal.destroy(),
    };
  }

  /* ============================================================
     segmented(host, { options, value, label, onChange }) — radiogroup + plate
     ============================================================ */
  function segmented(host, opts = {}) {
    const root = mk("div", "pk pk-segrow");
    root.setAttribute("role", "radiogroup");
    if (opts.label) root.setAttribute("aria-label", opts.label);
    root.innerHTML = `<span class="pk-plate" aria-hidden="true"></span>${(opts.options ?? [])
      .map((o, i) => `<button type="button" role="radio" data-i="${i}">${escx(o.label)}</button>`)
      .join("")}`;
    host.append(root);
    let value = opts.value;
    const rr = radioRow(root, (b) => {
      const o = opts.options[+b.dataset.i];
      if (o.value === value) return rr.check(b);
      value = o.value;
      rr.check(b);
      opts.onChange?.(value);
    });
    const btnFor = (v) =>
      root.querySelector(`[data-i="${opts.options.findIndex((o) => o.value === v)}"]`);
    rr.check(btnFor(value), false);
    return {
      el: root,
      set(v) {
        value = v;
        rr.check(btnFor(v));
      },
      destroy() {
        rr.destroy();
        root.remove();
      },
    };
  }

  /* ============================================================
     interval(host, { valueMs, onChange, onInvalid?, label?, dstHint? }) — presets +
     custom, ≥ 15 min. The chips say which interval; nothing restates it. The only
     line under them is a validation hint (with a one-click fix) or a short note.
     dstHint: true adds "elapsed time" to day-based intervals for hosts without a
     run preview (the preview owns DST and dates it when the range crosses a change).
     ============================================================ */
  const IV_PRESETS = [
    ["15m", 15 * MIN],
    ["30m", 30 * MIN],
    ["1h", HOUR],
    ["2h", 2 * HOUR],
    ["6h", 6 * HOUR],
    ["Daily", DAY],
    ["Weekly", WEEK],
  ];
  const UNIT_MS = { min: MIN, h: HOUR, d: DAY };
  const unitWord = (u, n) =>
    u === "min" ? "min" : u === "h" ? (n === 1 ? "hour" : "hours") : n === 1 ? "day" : "days";
  const fmtAmt = (n) => String(Math.round(n * 100) / 100);

  function interval(host, opts = {}) {
    let value = clampN(Number.isFinite(opts.valueMs) ? opts.valueMs : HOUR, MIN_INTERVAL, HORIZON);
    const root = mk("div", "pk pk-iv");
    const cid = nid("ivc");
    root.innerHTML = `
      <div class="pk-segrow" role="radiogroup" aria-label="${escx(opts.label ?? "Repeat every")}">
        <span class="pk-plate" aria-hidden="true"></span>
        ${IV_PRESETS.map(([t, ms]) => `<button type="button" role="radio" data-ms="${ms}" aria-label="${escx(intervalLabel(ms))}">${t}</button>`).join("")}
        <button type="button" role="radio" data-custom aria-label="Custom interval">Custom</button>
      </div>
      <div class="pk-reveal pk-iv-custom" id="${cid}" role="group" aria-label="Custom interval"><div class="pk-reveal-in">
        <div class="pk-stepper">
          <button type="button" class="pk-icon-btn" data-step="-1" aria-label="Less">${icon("minus")}</button>
          <input class="pk-step-input" type="text" inputmode="decimal" aria-label="Interval amount" autocomplete="off">
          <button type="button" class="pk-icon-btn" data-step="1" aria-label="More">${icon("plus")}</button>
        </div>
        <div class="pk-segrow pk-units" role="radiogroup" aria-label="Unit">
          <span class="pk-plate" aria-hidden="true"></span>
          <button type="button" role="radio" data-unit="min">min</button>
          <button type="button" role="radio" data-unit="h">hours</button>
          <button type="button" role="radio" data-unit="d">days</button>
        </div>
      </div></div>`;
    host.append(root);
    const hint = hintEl("pk-iv-hint");
    root.append(hint.el);
    const row = root.querySelector(".pk-segrow");
    const customBtn = row.querySelector("[data-custom]");
    const reveal = root.querySelector(".pk-iv-custom");
    const input = root.querySelector(".pk-step-input");
    const unitRow = root.querySelector(".pk-units");
    const preset = (ms) => IV_PRESETS.find((p) => p[1] === ms);
    let customOpen = !preset(value);
    const bestUnit = (ms) => (ms % DAY === 0 ? "d" : ms % HOUR === 0 ? "h" : "min");
    let unit = bestUnit(value);
    let amount = value / UNIT_MS[unit];
    /* note: { text, tone: "muted" } — stays until the next change.
       bad: { text, fixMs } while the typed amount can't be used. */
    let note = null;
    let bad = null;
    let lastInvalid = null;

    const rr = radioRow(row, (b, how) => {
      if (b === customBtn) {
        if (!customOpen) {
          customOpen = true;
          unit = bestUnit(value);
          amount = value / UNIT_MS[unit];
        }
        note = null;
        paint(true);
        if (how === "click") {
          input.focus();
          input.select();
        }
        return;
      }
      customOpen = false;
      note = null;
      setBad(null);
      setValue(+b.dataset.ms);
    });
    const ur = radioRow(unitRow, (b) => {
      const next = b.dataset.unit;
      if (next === unit) return ur.check(b);
      /* Convert what is set (1 day → 24 hours → 1,440 min), never reinterpret the number. */
      setBad(null);
      unit = next;
      const exact = value / UNIT_MS[unit];
      const two = Math.round(exact * 100) / 100;
      if (Math.abs(two - exact) < 1e-9) {
        amount = two;
        note = null;
        input.value = fmtAmt(amount);
        paint(true);
      } else {
        amount = Math.max(1, Math.round(exact));
        note = { text: `Rounded to ${fmtAmt(amount)} ${unitWord(unit, amount)}` };
        input.value = fmtAmt(amount);
        setValue(amount * UNIT_MS[unit], true);
      }
    });

    function setBad(b) {
      bad = b;
      const why = b ? b.text : null;
      if (why !== lastInvalid) {
        lastInvalid = why;
        opts.onInvalid?.(why);
      }
    }
    function paintHint() {
      if (bad)
        hint.set(bad.text, "warn", {
          label: `Use ${fDuration(bad.fixMs)}`,
          onClick: () => {
            const ms = bad?.fixMs ?? MIN_INTERVAL;
            setBad(null);
            note = null;
            amount = ms / UNIT_MS[unit];
            input.value = fmtAmt(amount);
            setValue(ms, true);
            input.focus();
          },
        });
      else if (note) hint.set(note.text, "muted");
      else if (opts.dstHint && value % DAY === 0)
        hint.set("Elapsed time — shifts an hour when clocks change", "muted");
      else hint.set(null);
    }
    function paint(animate) {
      rr.check(customOpen ? customBtn : row.querySelector(`[data-ms="${value}"]`), animate);
      reveal.toggleAttribute("data-open", customOpen);
      reveal.inert = !customOpen;
      if (document.activeElement !== input && !bad) input.value = fmtAmt(amount);
      ur.check(unitRow.querySelector(`[data-unit="${unit}"]`), animate);
      if (customOpen) requestAnimationFrame(() => ur.movePlate(false));
      paintHint();
    }
    function setValue(ms, keepUnit) {
      const v = clampN(Math.round(ms), MIN_INTERVAL, HORIZON);
      if (!keepUnit) {
        if (customOpen) amount = v / UNIT_MS[unit];
        else {
          unit = bestUnit(v);
          amount = v / UNIT_MS[unit];
        }
      }
      if (v !== value) {
        value = v;
        opts.onChange?.(v);
      }
      paint(true);
    }
    function stepBy(d) {
      setBad(null);
      note = null;
      const size = unit === "min" ? 5 : 1;
      let n = Math.round(amount * 100) / 100 + d * size;
      if (n * UNIT_MS[unit] < MIN_INTERVAL) {
        n = MIN_INTERVAL / UNIT_MS[unit];
        if (d < 0) note = { text: "15 min is the shortest interval" };
      } else if (n * UNIT_MS[unit] > HORIZON) {
        n = HORIZON / UNIT_MS[unit];
        if (d > 0) note = { text: "90 days is the longest interval" };
      }
      amount = n;
      input.value = fmtAmt(amount);
      setValue(n * UNIT_MS[unit], true);
    }
    root
      .querySelectorAll("[data-step]")
      .forEach((b) => b.addEventListener("click", () => stepBy(+b.dataset.step)));
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        stepBy((e.key === "ArrowUp" ? 1 : -1) * (e.shiftKey ? 3 : 1));
      } else if (e.key === "Enter") {
        e.preventDefault();
        normalizeInput();
      }
    });
    function readInput() {
      const n = parseFloat(input.value.replace(",", "."));
      return Number.isFinite(n) && n > 0 ? n : null;
    }
    /* While typing: a usable amount applies live; an unusable one says why (and
       offers the nearest valid one) without pretending it applied. */
    input.addEventListener("input", () => {
      note = null;
      const n = readInput();
      if (n == null) {
        setBad(null);
        return paintHint();
      }
      const ms = n * UNIT_MS[unit];
      const typed = `${fmtAmt(n)} ${unitWord(unit, n)}`;
      if (ms < MIN_INTERVAL) {
        setBad({ text: `${typed} is under the 15-minute minimum`, fixMs: MIN_INTERVAL });
        return paintHint();
      }
      if (ms > HORIZON) {
        setBad({ text: `${typed} is over the 90-day limit`, fixMs: HORIZON });
        return paintHint();
      }
      setBad(null);
      amount = n;
      setValue(ms, true);
    });
    /* Leaving the field: an unusable amount becomes the nearest valid one, and says so. */
    function normalizeInput() {
      const n = readInput();
      if (n == null) {
        setBad(null);
        input.value = fmtAmt(amount);
        return paintHint();
      }
      const ms = n * UNIT_MS[unit];
      if (ms < MIN_INTERVAL || ms > HORIZON) {
        const to = ms < MIN_INTERVAL ? MIN_INTERVAL : HORIZON;
        setBad(null);
        amount = to / UNIT_MS[unit];
        note = {
          text: `Set to ${fDuration(to)} — ${to === MIN_INTERVAL ? "the shortest" : "the longest"} interval`,
        };
        input.value = fmtAmt(amount);
        return setValue(to, true);
      }
      input.value = fmtAmt(n);
    }
    input.addEventListener("blur", (e) => {
      /* Heading for the hint's own fix: let that click decide. */
      if (e.relatedTarget && hint.el.contains(e.relatedTarget)) return;
      normalizeInput();
    });
    paint(false);
    return {
      el: root,
      value: () => value,
      set(ms) {
        const v = clampN(ms, MIN_INTERVAL, HORIZON);
        value = v;
        customOpen = !preset(v);
        unit = bestUnit(v);
        amount = v / UNIT_MS[unit];
        note = null;
        setBad(null);
        paint(true);
      },
      destroy() {
        rr.destroy();
        ur.destroy();
        root.remove();
      },
    };
  }

  /* ============================================================
     until(host, { startMs, valueMs, nowMs, intervalMs?, onChange, label?, summary? })
     — the end of a recurring schedule, always inside 90 days. One chip row and at
     most one read-back line; the 90-day limit is stated once.
     summary: "auto" (default) — hidden when a run preview shares the surface (the
              preview owns count and last run), full otherwise (e.g. in a popover);
              "full" | true — "Until Sat, Nov 7 · 09:00 · 31 runs";
              "bound" — "Until Sat, Nov 7 · 09:00"; false — no line (limit and
              validation notes still show).
     ============================================================ */
  const UNTIL = [
    ["1 day", DAY],
    ["1 week", WEEK],
    ["2 weeks", 2 * WEEK],
    ["30 days", 30 * DAY],
  ];
  /* A preset's end: day-based presets keep the start's wall-clock time across a
     clock change. Hosts should seed their default end with this. */
  function endFor(startMs, presetMs) {
    return presetMs % DAY === 0 ? addDays(startMs, Math.round(presetMs / DAY)) : startMs + presetMs;
  }

  function until(host, opts = {}) {
    let start = Number.isFinite(opts.startMs) ? opts.startMs : resolveNow() + HOUR;
    let now = Number.isFinite(opts.nowMs) ? opts.nowMs : resolveNow();
    let iv = Number.isFinite(opts.intervalMs) ? opts.intervalMs : null;
    let value = Number.isFinite(opts.valueMs) ? opts.valueMs : endFor(start, WEEK);
    const maxOf = () => floorMin(now + HORIZON);
    const plus = (d) => endFor(start, d);
    /* mode: dur {ms} · max · date · clamped {from} (a preset that no longer fits) */
    let mode = detect(value);
    let normalized = false;
    if (mode.kind === "dur" && value !== plus(mode.ms) && plus(mode.ms) <= maxOf()) {
      value = plus(mode.ms);
      normalized = true;
    }

    const root = mk("div", "pk pk-until");
    root.innerHTML = `
      <div class="pk-segrow" role="radiogroup" aria-label="${escx(opts.label ?? "Ends")}">
        <span class="pk-plate" aria-hidden="true"></span>
        ${UNTIL.map(([t, ms]) => `<button type="button" role="radio" data-dur="${ms}">${t}</button>`).join("")}
        <button type="button" role="radio" data-max aria-label="Until the 90-day limit">Max</button>
        <button type="button" role="radio" data-date>${icon("cal")}<span class="pk-date-l">On a date…</span></button>
      </div>
      <div class="pk-until-sum"></div>`;
    host.append(root);
    const hint = hintEl();
    root.append(hint.el);
    const row = root.querySelector(".pk-segrow");
    const maxBtn = row.querySelector("[data-max]");
    const dateBtn = row.querySelector("[data-date]");
    const dateL = dateBtn.querySelector(".pk-date-l");
    const sumEl = root.querySelector(".pk-until-sum");

    function detect(v) {
      for (const [, d] of UNTIL)
        if (Math.abs(v - plus(d)) < MIN || Math.abs(v - start - d) < MIN)
          return { kind: "dur", ms: d };
      if (v <= maxOf() + MIN && v > maxOf() - DAY && v - start > DAY) return { kind: "max" };
      return { kind: "date" };
    }
    function emit(v) {
      if (v === value) return;
      value = v;
      opts.onChange?.(v);
    }
    /* A preset that would pass the limit ends at the limit and selects nothing. */
    function applyDur(d) {
      const end = plus(d);
      if (end > maxOf()) {
        mode = { kind: "clamped", from: d };
        emit(maxOf());
      } else {
        mode = { kind: "dur", ms: d };
        emit(end);
      }
    }

    const rr = radioRow(row, (b, how) => {
      if (b === dateBtn) {
        /* Arrowing onto it makes the current end an explicit date (APG: arrows
           check); a click or Enter/Space opens the calendar and only a pick changes it. */
        if (how === "click") return cal.toggle(dateBtn);
        mode = { kind: "date" };
        paint(true);
        return;
      }
      if (b === maxBtn) {
        mode = { kind: "max" };
        emit(maxOf());
      } else applyDur(+b.dataset.dur);
      paint(true);
    });

    /* "On a date…": a compact grid, range drawn from the start; picks the end of that day. */
    const calCtx = {
      label: "End date",
      value: () => value,
      min: () => start,
      max: () => maxOf(),
      now: () => now,
    };
    const cal = attachCalendar(
      root,
      calCtx,
      (ms) => {
        if (ms < start || ms > maxOf()) return false;
        mode = { kind: "date" };
        emit(ms);
        paint(true);
        return true;
      },
      {
        compact: true,
        anchor: () => dateBtn,
        origin: () => dateBtn,
        keepOpen: (t) => dateBtn.contains(t),
        rangeStart: () => start,
        maxNote: "beyond the 90-day limit",
        legend: () => `From ${escx(fDate(start, now))}`,
        pickDay: (d) => Math.min(withMinutes(d, 1439), maxOf()),
      },
    );

    function summaryMode() {
      const want = opts.summary ?? "auto";
      if (want === true) return "full";
      if (want !== "auto") return want;
      if (root.closest(".pop, [popover]")) return "full";
      const scope = root.closest('[role="dialog"], dialog, [data-dir]') ?? document.body;
      return scope.querySelector(".pk-pv") ? false : "full";
    }

    function paint(animate) {
      const max = maxOf();
      for (const b of row.querySelectorAll("[data-dur]")) {
        const over = plus(+b.dataset.dur) > max;
        b.setAttribute("aria-disabled", over ? "true" : "false");
        if (over) b.dataset.tip = `Past the 90-day limit (${fDate(max, now)})`;
        else delete b.dataset.tip;
      }
      maxBtn.dataset.tip = `Until ${fDate(max, now)}, the 90-day limit`;
      const checked =
        mode.kind === "dur"
          ? row.querySelector(`[data-dur="${mode.ms}"]`)
          : mode.kind === "max"
            ? maxBtn
            : mode.kind === "date"
              ? dateBtn
              : null;
      rr.check(checked, animate);
      const dl = mode.kind === "date" ? fDate(value, now) : "On a date…";
      if (dateL.textContent !== dl) dateL.textContent = dl;
      dateBtn.setAttribute(
        "aria-label",
        mode.kind === "date"
          ? `On ${fDate(value, now)}. Opens a calendar`
          : "On a date. Opens a calendar",
      );
      requestAnimationFrame(() => rr.movePlate(false));
      paintSummary();
      cal.sync("external");
    }

    function paintSummary() {
      const max = maxOf();
      const sm = summaryMode();
      const atLimit = mode.kind === "max" || mode.kind === "clamped";
      const endOfDay = minutesOf(value) === 1439;
      const runs = iv && value >= start ? Math.floor((value - start) / iv) + 1 : null;
      const runsT =
        runs != null ? `${runs.toLocaleString("en-US")} ${runs === 1 ? "run" : "runs"}` : null;
      let head;
      let tail = [];
      if (atLimit) {
        head = `Ends ${fDate(value, now)} · ${fTime(value)}`;
        tail.push("the 90-day limit");
      } else if (endOfDay) head = `Through ${fDay(value, now)}`;
      else head = `Until ${fFull(value, now)}`;
      /* The duration only adds something when a date (not a duration) was picked. */
      if (sm === "full" && mode.kind === "date" && value >= start)
        tail.push(fDuration(value - start));
      if (sm === "full" && runsT) tail.push(runsT);
      const html =
        sm === false
          ? ""
          : `<b>${escx(head)}</b>${tail.map((p) => ` <span class="pk-sep">·</span> <span class="tnum">${escx(p)}</span>`).join("")}`;
      if (sumEl.innerHTML !== html) sumEl.innerHTML = html;
      sumEl.hidden = sm === false;

      if (value < start) hint.set("Ends before it starts — pick a later end", "warn");
      else if (value > max + MIN)
        hint.set(`Past the 90-day limit — the latest is ${fDate(max, now)}`, "warn", {
          label: `Use ${fDate(max, now)}`,
          onClick: () => {
            mode = { kind: "max" };
            emit(maxOf());
            paint(true);
          },
        });
      else if (mode.kind === "clamped" && sm === false) {
        /* Without a read-back line, say why no preset is selected (once). */
        const preset = UNTIL.find((u) => u[1] === mode.from)?.[0] ?? "That";
        hint.set(`${preset} would pass the 90-day limit, so it ends at the limit`, "muted");
      } else hint.set(null);
    }

    paint(false);
    /* Re-check "auto" once the host has mounted its preview, and report a normalized
       end (elapsed → wall-clock) once, after the host's own setup has run. */
    queueMicrotask(() => {
      if (!root.isConnected) return;
      paintSummary();
      if (normalized) opts.onChange?.(value);
    });
    return {
      el: root,
      value: () => value,
      set(ms) {
        value = ms;
        mode = detect(ms);
        paint(true);
      },
      update(u = {}) {
        let changed = false;
        if (Number.isFinite(u.nowMs) && u.nowMs !== now) now = u.nowMs;
        if (u.intervalMs !== undefined && u.intervalMs !== iv) {
          iv = u.intervalMs;
          changed = true;
        }
        if (Number.isFinite(u.startMs) && u.startMs !== start) {
          start = u.startMs;
          changed = true;
          if (mode.kind === "dur") applyDur(mode.ms);
          else if (mode.kind === "clamped") applyDur(mode.from);
          else if (mode.kind === "max") emit(maxOf());
        }
        paint(changed);
      },
      destroy() {
        rr.destroy();
        cal.destroy();
        root.remove();
      },
    };
  }

  /* ============================================================
     preview(host, { schedule, nowMs, title?, approvals? }) — next runs, count, strip.
     It owns the run count, the last run and the clock-change note, so the end and
     interval pickers next to it don't restate them. One quiet note line at most:
     the approval load when runs come often (approvals: "auto" | true | false), or
     the dated clock change for day-based intervals. Screen readers get one
     settled read-back (debounced), never the per-minute repaints.
     ============================================================ */
  function preview(host, opts = {}) {
    let sc = opts.schedule ?? null;
    let now = Number.isFinite(opts.nowMs) ? opts.nowMs : resolveNow();
    const root = mk("section", "pk pk-pv");
    root.setAttribute("aria-label", opts.title ?? "Next runs");
    root.innerHTML = `
      <div class="pk-pv-head"><span class="pk-pv-title">${escx(opts.title ?? "Next runs")}</span><span class="pk-pv-total tnum"></span></div>
      <ol class="pk-pv-list"></ol>
      <div class="pk-pv-strip" aria-hidden="true"><div class="pk-pv-ticks"></div></div>
      <p class="pk-pv-note"></p>
      <span class="pk-sr" role="status"></span>`;
    host.append(root);
    const list = root.querySelector(".pk-pv-list");
    const total = root.querySelector(".pk-pv-total");
    const strip = root.querySelector(".pk-pv-strip");
    const ticks = root.querySelector(".pk-pv-ticks");
    const noteEl = root.querySelector(".pk-pv-note");
    const sr = root.querySelector(".pk-sr");
    const setTotal = crossfader(total);
    let rows = new Map();
    let marks = [];
    let lastUpdate = 0;
    let shownCount = null;
    let tween = 0;
    let srTimer = 0;
    let noteText = "";

    const sig = (s) =>
      !s ? "" : [kindOf(s), s.runAt, s.startsAt, s.intervalMs, s.endsAt].join("|");
    let lastSig = sig(sc);

    function window_() {
      const kind = kindOf(sc);
      if (!kind) return null;
      const next5 = occurrences(sc, now, Infinity, 5);
      const count = countRuns(sc, now);
      if (!next5.length) return { kind, next5, count: 0 };
      const first = next5[0];
      const last =
        kind === "once"
          ? first
          : sc.startsAt + Math.floor((sc.endsAt - sc.startsAt) / sc.intervalMs) * sc.intervalMs;
      return { kind, next5, count, first, last };
    }

    /* The relative time only on a day's first row: the rest of that day reads by time. */
    function rowHtml(ms, prev) {
      const same = prev != null && sameDay(prev, ms);
      const day = same ? "" : fDay(ms, now);
      const rel = same ? "" : fRel(ms, now);
      return `<span class="pk-pv-day">${escx(day)}</span><span class="pk-pv-time tnum">${fTime(ms)}</span><span class="pk-pv-rel tnum">${escx(rel)}</span>`;
    }

    function renderRows(next, animate) {
      const before = new Map();
      const listTop = list.getBoundingClientRect().top;
      for (const [k, el] of rows) before.set(k, el.getBoundingClientRect().top - listTop);
      const nextRows = new Map();
      next.forEach((ms, i) => {
        let el = rows.get(ms);
        if (el) rows.delete(ms);
        else {
          el = mk("li", "pk-pv-row");
          el._new = true;
        }
        const html = rowHtml(ms, next[i - 1]);
        if (el._html !== html) {
          el.innerHTML = html;
          el._html = html;
        }
        nextRows.set(ms, el);
      });
      for (const [k, el] of rows) {
        if (animate) {
          el.classList.add("is-leaving");
          el.setAttribute("aria-hidden", "true");
          el.style.top = `${before.get(k)}px`;
          el.animate([{ opacity: 1 }, { opacity: 0 }], {
            duration: 160,
            fill: "forwards",
          }).finished.then(
            () => el.remove(),
            () => el.remove(),
          );
        } else el.remove();
      }
      for (const el of nextRows.values()) list.append(el);
      let i = 0;
      for (const [k, el] of nextRows) {
        if (animate) {
          if (el._new)
            el.animate(
              [
                { opacity: 0, transform: "translateY(6px)" },
                { opacity: 1, transform: "none" },
              ],
              { duration: 260, delay: i * 24, easing: EASE_PK, fill: "backwards" },
            );
          else {
            const dy = before.get(k) - (el.getBoundingClientRect().top - listTop);
            if (Math.abs(dy) > 0.5)
              el.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], {
                duration: 300,
                easing: EASE_PK,
              });
          }
        }
        el._new = false;
        i++;
      }
      rows = nextRows;
    }

    function paintCount(n, w, animate) {
      const fmtN = (x) => Math.round(x).toLocaleString("en-US");
      const tail = w && w.count > 1 ? ` · last ${fDateTime(w.last, now)}` : "";
      const render = (x) =>
        n === 0
          ? "No runs left"
          : w.kind === "once" || n === 1
            ? "Runs once"
            : `<b>${fmtN(x)}</b> runs${escx(tail)}`;
      cancelAnimationFrame(tween);
      const from = shownCount;
      shownCount = n;
      if (!animate || from == null || from === n || !motionOK() || n <= 1 || from <= 1) {
        setTotal(`${n}|${tail}`, render(n));
        return;
      }
      setTotal(`${n}|${tail}`, render(from));
      const layer = total.lastElementChild;
      const t0 = performance.now();
      const step = (t) => {
        const p = Math.min(1, (t - t0) / 320);
        const e = 1 - Math.pow(1 - p, 3);
        layer.innerHTML = render(from + (n - from) * e);
        if (p < 1) tween = requestAnimationFrame(step);
      };
      tween = requestAnimationFrame(step);
    }

    /* Ticks from the first to the last run, the next five marked. When ticks would
       sit under 3 px apart the strip says nothing a tick can — it steps aside and the
       note line gives the rate instead. */
    function paintStrip(w, animate) {
      for (const m of marks) m.remove();
      marks = [];
      const W = root.clientWidth;
      const span = w && w.kind !== "once" && w.count > 1 ? w.last - w.first : 0;
      const period = span > 0 ? (sc.intervalMs / span) * (W - 1) : 0;
      const show = span > 0 && period >= 3;
      if (strip.hidden === show) strip.hidden = !show;
      if (!show) return;
      if (!animate) ticks.style.transition = "none";
      ticks.style.backgroundSize = `${period}px 100%`;
      ticks.style.backgroundPositionX = "0px";
      if (!animate) {
        void ticks.offsetWidth;
        ticks.style.transition = "";
      }
      w.next5.forEach((t, i) => {
        const x = ((t - w.first) / span) * (W - 1);
        const m = mk("i", `pk-pv-mark${i === 0 ? " is-next" : ""}`);
        m.style.left = `${x}px`;
        strip.append(m);
        marks.push(m);
      });
    }

    function dstNote(w) {
      if (!w || !w.count || w.kind === "once" || sc.intervalMs % DAY !== 0) return "";
      const runs = occurrences(sc, now, Infinity, 400);
      const t0 = minutesOf(runs[0]);
      const i = runs.findIndex((t) => minutesOf(t) !== t0);
      if (i < 1) return "";
      const prev = runs[i - 1];
      const off0 = new Date(prev).getTimezoneOffset();
      let at = prev;
      while (at < runs[i] && new Date(at).getTimezoneOffset() === off0) at += HOUR;
      const back = new Date(runs[i]).getTimezoneOffset() > off0;
      return `Clocks go ${back ? "back" : "forward"} on ${fDate(at, now)} — from then on runs land at ${fTime(runs[i])}, since the interval is elapsed time.`;
    }
    function loadNote(w) {
      const want = opts.approvals ?? "auto";
      if (!w || !w.count || want === false) return "";
      if (w.kind === "once")
        return want === true ? "It waits up to 15 min for your approval when it's due." : "";
      const perDay = DAY / sc.intervalMs;
      if (perDay > 8 && w.count > 8)
        return `About ${Math.round(perDay)} runs a day — each waits up to 15 min for your approval.`;
      return want === true ? "Each run waits up to 15 min for your approval." : "";
    }
    function paintNote(w) {
      const t = dstNote(w) || loadNote(w);
      if (t === noteText) return;
      noteText = t;
      noteEl.textContent = t;
    }
    function announce(w) {
      clearTimeout(srTimer);
      srTimer = setTimeout(() => {
        const head = !w
          ? "No schedule"
          : !w.count
            ? "No runs left"
            : w.kind === "once" || w.count === 1
              ? `Runs once, ${fFull(w.first, now)}`
              : `${w.count.toLocaleString("en-US")} runs, first ${fFull(w.first, now)}, last ${fFull(w.last, now)}`;
        const text = noteText ? `${head}. ${noteText}` : `${head}.`;
        if (sr.textContent !== text) sr.textContent = text;
      }, 500);
    }

    function render(animate, say) {
      const w = window_();
      const anim = animate && motionOK();
      if (!w) {
        renderRows([], anim);
        setTotal("none", "No schedule");
        paintStrip(null, false);
        paintNote(null);
        if (say) announce(null);
        return;
      }
      renderRows(w.next5, anim);
      root.toggleAttribute("data-empty", !w.count);
      if (!w.count) list.dataset.empty = "Nothing left to run in this window";
      else delete list.dataset.empty;
      paintCount(w.count, w, anim);
      paintStrip(w, anim);
      paintNote(w);
      if (say) announce(w);
    }

    const ro =
      typeof ResizeObserver === "function"
        ? new ResizeObserver(() => paintStrip(window_(), false))
        : null;
    ro?.observe(root);
    render(false, false);

    return {
      el: root,
      update(next, nowMs) {
        const t = performance.now();
        const burst = t - lastUpdate < 140;
        lastUpdate = t;
        const nowChanged = Number.isFinite(nowMs) && nowMs !== now;
        if (Number.isFinite(nowMs)) now = nowMs;
        const s = sig(next);
        const schedChanged = s !== lastSig;
        sc = next ?? null;
        lastSig = s;
        if (schedChanged) render(!burst, true);
        else if (nowChanged) render(true, false);
      },
      destroy() {
        ro?.disconnect();
        cancelAnimationFrame(tween);
        clearTimeout(srTimer);
        root.remove();
      },
    };
  }

  /* ============================================================
     Self-test — parser cases against a fixed now (the sim's start:
     Wed Oct 7 2026, 10:42 local).
     ============================================================ */
  const T = (y, m, d, hh, mm) => new Date(y, m - 1, d, hh, mm).getTime();
  const CASES = [
    ["in 2h", T(2026, 10, 7, 12, 42)],
    ["in 2 h", T(2026, 10, 7, 12, 42)],
    ["in 45 min", T(2026, 10, 7, 11, 27)],
    ["in 1h30", T(2026, 10, 7, 12, 12)],
    ["in 1 hour 30 minutes", T(2026, 10, 7, 12, 12)],
    ["in an hour", T(2026, 10, 7, 11, 42)],
    ["in a week", T(2026, 10, 14, 10, 42)],
    ["in 3 days", T(2026, 10, 10, 10, 42)],
    ["2h", T(2026, 10, 7, 12, 42)],
    ["now+30m", T(2026, 10, 7, 11, 12)],
    ["now + 2h", T(2026, 10, 7, 12, 42)],
    ["+15m", T(2026, 10, 7, 10, 57)],
    ["tomorrow 9", T(2026, 10, 8, 9, 0)],
    ["tomorrow 9am", T(2026, 10, 8, 9, 0)],
    ["Tomorrow at 9:30pm", T(2026, 10, 8, 21, 30)],
    ["tomorrow evening 7", T(2026, 10, 8, 19, 0)],
    ["tonight", T(2026, 10, 7, 21, 0)],
    ["tonight 22:30", T(2026, 10, 7, 22, 30)],
    ["fri 17:30", T(2026, 10, 9, 17, 30)],
    ["friday 5pm", T(2026, 10, 9, 17, 0)],
    ["wed 9", T(2026, 10, 14, 9, 0)],
    ["wed 14:00", T(2026, 10, 7, 14, 0)],
    ["next monday 9am", T(2026, 10, 12, 9, 0)],
    ["next wed", T(2026, 10, 14, 9, 0)],
    ["oct 12 14:00", T(2026, 10, 12, 14, 0)],
    ["12 oct 14:00", T(2026, 10, 12, 14, 0)],
    ["october 12th at 2pm", T(2026, 10, 12, 14, 0)],
    ["12.10. 14:00", T(2026, 10, 12, 14, 0)],
    ["12.10.2026 14:00", T(2026, 10, 12, 14, 0)],
    ["2026-10-12 14:00", T(2026, 10, 12, 14, 0)],
    ["14:00", T(2026, 10, 7, 14, 0)],
    ["9:00", T(2026, 10, 8, 9, 0)],
    ["9pm", T(2026, 10, 7, 21, 0)],
    ["9 p.m.", T(2026, 10, 7, 21, 0)],
    ["1730", T(2026, 10, 7, 17, 30)],
    ["noon", T(2026, 10, 7, 12, 0)],
    ["midnight", T(2026, 10, 8, 0, 0)],
    ["day after tomorrow", T(2026, 10, 9, 9, 0)],
    ["jan 3", T(2027, 1, 3, 9, 0)],
    ["thu, oct 8 · 09:00", T(2026, 10, 8, 9, 0)],
    ["fri oct 8", "error"],
    ["tomorrow fri", "error"],
    ["feb 30", "error"],
    ["in 2", "error"],
    ["banana", "error"],
    ["25:00", "error"],
    ["13pm", "error"],
    ["10/12", "error"],
  ];
  const TIME_CASES = [
    ["9", 540],
    ["9:30", 570],
    ["21:05", 1265],
    ["9pm", 1260],
    ["12am", 0],
    ["930", 570],
    ["24:00", null],
    ["x", null],
  ];
  function selfTest() {
    const now = T(2026, 10, 7, 10, 42);
    const fail = [];
    for (const [phrase, want] of CASES) {
      const r = parseWhen(phrase, now);
      const ok = want === "error" ? !!r.error : r.ms === want;
      if (!ok)
        fail.push(
          `${phrase} → ${r.error ?? fFull(r.ms, now)} (want ${want === "error" ? "error" : fFull(want, now)})`,
        );
    }
    for (const [t, want] of TIME_CASES) {
      const got = parseTime(t);
      if (got !== want) fail.push(`time ${t} → ${got} (want ${want})`);
    }
    const total = CASES.length + TIME_CASES.length;
    return { total, pass: total - fail.length, fail };
  }

  window.Pickers = {
    dateTime,
    calendarPopover,
    interval,
    until,
    preview,
    segmented,
    parseWhen,
    parseTime,
    explain,
    suggest,
    intervalLabel,
    occurrences,
    countRuns,
    fmt: {
      full: fFull,
      day: fDay,
      time: fTime,
      date: fDate,
      dateTime: fDateTime,
      rel: fRel,
      duration: fDuration,
    },
    selfTest,
    endFor,
    HORIZON_MS: HORIZON,
    MIN_INTERVAL_MS: MIN_INTERVAL,
  };
})();
