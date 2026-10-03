/**
 * The product film: one GSAP timeline, scrubbed by scroll, that rewinds the
 * Stage to an empty thread and plays a full Ryco run across five chapters.
 *
 * Built only with `.to()` tweens on top of an explicit initial `set`, so the
 * whole thing is reversible frame-for-frame when you scroll back up. Text is
 * "typed" by tweening a counter and writing slices into the existing React
 * text node (nodeValue), which keeps React's DOM ownership intact.
 */
import { gsap } from "@/lib/motion";
import {
  FULL_CROP,
  HEADER_H,
  NARROW_CROP,
  REVIEW_W,
  SIDEBAR_W,
  STAGE_H,
  STAGE_W,
  TERMINAL_H,
} from "./Stage";
import { ANSWER, PANES, PROMPT, TERMINAL_CMD } from "./script";

export const CHAPTERS = [
  { id: "ask", title: "Ask", line: "Write the task once. Pick any agent, any model." },
  { id: "work", title: "Work", line: "Every read, search, edit and command, logged as it lands." },
  {
    id: "parallel",
    title: "Parallel",
    line: "Six providers, six threads, all running side by side.",
  },
  { id: "review", title: "Review", line: "Per-turn diffs. Click a line to land in your editor." },
  { id: "run", title: "Run", line: "Real terminals in a drawer, right beside the thread." },
] as const;

export type ChapterId = (typeof CHAPTERS)[number]["id"];

/** Timeline positions (in film units) where each chapter begins. */
export const CHAPTER_AT: Record<ChapterId | "end", number> = {
  ask: 0,
  work: 2.3,
  parallel: 5.7,
  review: 8.2,
  run: 11.1,
  end: 14.2,
};

const setText = (el: Element | null, text: string) => {
  if (!el) return;
  const node = el.firstChild;
  if (node && node.nodeType === Node.TEXT_NODE) node.nodeValue = text;
  else el.textContent = text;
};

export function buildFilm(root: HTMLElement, opts: { narrow: boolean }) {
  const q = <T extends HTMLElement = HTMLElement>(s: string, scope: ParentNode = root) =>
    scope.querySelector<T>(`[data-s="${s}"]`)!;
  const qa = <T extends HTMLElement = HTMLElement>(s: string, scope: ParentNode = root) =>
    Array.from(scope.querySelectorAll<T>(`[data-s="${s}"]`));
  const z = (wide: number, narrow: number) => (opts.narrow ? narrow : wide);

  const win = q("window");
  const cam = q("cam");
  const cursor = q("cursor");
  const ring = q("cursor-ring");
  const chat = q("chat");
  const thread = q("thread");
  const composer = q("composer");
  const assistant = q("assistant");
  const mainTools = qa("tool", assistant);
  const sideRows = qa("side-row");
  const panes = qa("pane");
  const review = q("review");
  const terminal = q("terminal");
  const termLines = qa("term-line");

  /* Position of an element's centre in window (design) coordinates. Uses
     layout offsets, so it is unaffected by whatever transforms are in play. */
  const centre = (el: HTMLElement, dx = 0, dy = 0) => {
    let x = el.offsetWidth / 2;
    let y = el.offsetHeight / 2;
    let n: HTMLElement | null = el;
    while (n && n !== win) {
      x += n.offsetLeft;
      y += n.offsetTop;
      n = n.offsetParent as HTMLElement | null;
    }
    return { x: x + dx, y: y + dy };
  };

  /* --------------------------- initial (rewound) --------------------------- */
  gsap.set(cam, { transformOrigin: "0 0", scale: 1, x: 0, y: 0 });
  /* (camTo below re-homes the camera for the narrow crop before t=0) */
  gsap.set(cursor, { opacity: 0, x: 980, y: 560 });
  gsap.set(chat, { x: 0, y: 0 });
  gsap.set(q("title-new"), { opacity: 1 });
  gsap.set(q("title-real"), { opacity: 0 });
  gsap.set(q("side-title-new"), { opacity: 1 });
  gsap.set(q("side-title"), { opacity: 0 });
  gsap.set(qa("side-age")[0], { opacity: 0 });
  gsap.set(q("empty"), { opacity: 1 });
  gsap.set(q("user-msg"), { autoAlpha: 0, y: 18 });
  gsap.set(assistant, { autoAlpha: 0 });
  gsap.set(mainTools, { autoAlpha: 0, x: -8 });
  gsap.set(qa("tool-done", assistant), { opacity: 0 });
  gsap.set(assistant.querySelectorAll(".tool-spin"), { opacity: 1 });
  gsap.set(q("worked"), { autoAlpha: 0 });
  gsap.set(q("changes"), { autoAlpha: 0, y: 10 });
  gsap.set(q("diff-count"), { autoAlpha: 0, width: 0 });
  gsap.set(review, { x: REVIEW_W + 2 });
  gsap.set(terminal, { autoAlpha: 1, y: TERMINAL_H });
  gsap.set(termLines, { autoAlpha: 0 });
  gsap.set(q("toast"), { autoAlpha: 0, y: -8 });
  setText(q("typed"), "");
  setText(q("answer"), "");
  setText(q("term-cmd"), "");

  /* Panes are dealt out from the centre of the body like cards. */
  const bodyW = STAGE_W - SIDEBAR_W;
  const bodyH = STAGE_H - HEADER_H;
  gsap.set(q("grid"), { autoAlpha: 0 });
  panes.forEach((pane) => {
    const cx = pane.offsetLeft + pane.offsetWidth / 2;
    const cy = pane.offsetTop + pane.offsetHeight / 2;
    gsap.set(pane, { x: bodyW / 2 - cx, y: bodyH / 2 - cy, scale: 0.55, autoAlpha: 0 });
    gsap.set(qa("tool", pane), { autoAlpha: 0 });
    gsap.set(qa("tool-done", pane), { opacity: 0 });
    gsap.set(pane.querySelectorAll(".tool-spin"), { opacity: 1 });
    setText(q("pane-text", pane), "");
  });

  /* -------------------------------- helpers -------------------------------- */
  const tl = gsap.timeline({ defaults: { ease: "ryco", duration: 0.5 } });

  const type = (el: HTMLElement, text: string, at: number, duration: number) => {
    const proxy = { n: 0 };
    tl.to(
      proxy,
      {
        n: text.length,
        duration,
        ease: "none",
        onUpdate: () => setText(el, text.slice(0, Math.round(proxy.n))),
      },
      at,
    );
  };

  /* Camera: scale `s` around a focus point, centred in the visible crop.
     At s >= 1 it is clamped so the window always fills the frame; below 1 it
     is a deliberate pull-back that lets the window's edges show. */
  const crop = opts.narrow ? NARROW_CROP : FULL_CROP;
  const home = { x: crop.x + crop.w / 2, y: STAGE_H / 2 };
  const camTo = (s: number, focus: { x: number; y: number } | null, at: number, duration = 0.8) => {
    const f = focus ?? home;
    let x = home.x - s * f.x;
    let y = home.y - s * f.y;
    if (s >= 1) {
      x = gsap.utils.clamp(crop.x + crop.w - s * STAGE_W, crop.x, x);
      y = gsap.utils.clamp(STAGE_H - s * STAGE_H, 0, y);
    }
    tl.to(cam, { scale: s, x, y, duration, ease: "ryco.inOut" }, at);
  };

  const moveCursor = (to: { x: number; y: number }, at: number, duration = 0.45) =>
    tl.to(cursor, { x: to.x - 3, y: to.y - 2, duration, ease: "power3.inOut" }, at);

  const click = (target: HTMLElement | null, at: number) => {
    /* set + to (not fromTo): scrubbing back before `at` restores the ring's
       recorded hidden state instead of the visible "from" values. */
    tl.set(ring, { scale: 0.4, opacity: 0.9 }, at);
    tl.to(ring, { scale: 1.6, opacity: 0, duration: 0.35, ease: "power2.out" }, at + 0.001);
    tl.to(cursor, { scale: 0.86, duration: 0.08, yoyo: true, repeat: 1, ease: "power1.inOut" }, at);
    if (target)
      tl.to(
        target,
        { scale: 0.92, duration: 0.08, yoyo: true, repeat: 1, ease: "power1.inOut" },
        at,
      );
  };

  const showCursor = (at: number, from?: { x: number; y: number }) => {
    if (from) tl.set(cursor, { x: from.x, y: from.y }, at);
    tl.to(cursor, { opacity: 1, duration: 0.2 }, at);
  };
  const hideCursor = (at: number) => tl.to(cursor, { opacity: 0, duration: 0.25 }, at);

  /* ---------------------------------- ask ---------------------------------- */
  const A = CHAPTER_AT.ask;
  const composerFocus = { x: SIDEBAR_W + bodyW / 2, y: STAGE_H - 70 };
  camTo(z(1.14, 1), composerFocus, A, 0.9);
  tl.to(q("placeholder"), { opacity: 0, duration: 0.1 }, A + 0.15);
  tl.to(q("typed-caret"), { opacity: 1, duration: 0.05 }, A + 0.15);
  type(q("typed"), PROMPT, A + 0.2, 1.25);

  const send = q("send");
  const sendAt = centre(send);
  showCursor(A + 1.25, { x: sendAt.x + 110, y: sendAt.y + 70 });
  moveCursor(sendAt, A + 1.3, 0.35);
  click(send, A + 1.7);
  tl.to(q("typed-caret"), { opacity: 0, duration: 0.05 }, A + 1.72);
  tl.to(q("typed"), { opacity: 0, duration: 0.18 }, A + 1.74);
  {
    const proxy = { n: PROMPT.length };
    tl.to(
      proxy,
      {
        n: 0,
        duration: 0.01,
        onUpdate: () => setText(q("typed"), PROMPT.slice(0, Math.round(proxy.n))),
      },
      A + 1.95,
    );
  }
  tl.to(q("typed"), { opacity: 1, duration: 0.01 }, A + 1.97);
  tl.to(q("placeholder"), { opacity: 1, duration: 0.2 }, A + 1.98);
  tl.to(q("empty"), { opacity: 0, y: -14, duration: 0.3 }, A + 1.72);
  tl.to(q("user-msg"), { autoAlpha: 1, y: 0, duration: 0.5 }, A + 1.78);
  tl.to(q("title-new"), { opacity: 0, duration: 0.2 }, A + 1.85);
  tl.to(q("title-real"), { opacity: 1, duration: 0.3 }, A + 1.9);
  tl.to(q("side-title-new"), { opacity: 0, duration: 0.2 }, A + 1.85);
  tl.to(q("side-title"), { opacity: 1, duration: 0.3 }, A + 1.9);
  hideCursor(A + 1.9);
  camTo(1, null, A + 1.8, 0.7);

  /* ---------------------------------- work --------------------------------- */
  const W = CHAPTER_AT.work;
  const threadFocus = { x: SIDEBAR_W + bodyW / 2, y: HEADER_H + 250 };
  camTo(z(1.07, 1.1), threadFocus, W, 1.2);
  tl.to(assistant, { autoAlpha: 1, duration: 0.3 }, W);
  tl.to(sideRows[0].querySelector(".side-spin"), { opacity: 1, duration: 0.2 }, W);
  mainTools.forEach((row, i) => {
    const at = W + 0.2 + i * 0.36;
    tl.to(row, { autoAlpha: 1, x: 0, duration: 0.3 }, at);
    tl.to(row.querySelector(".tool-spin"), { opacity: 0, duration: 0.1 }, at + 0.26);
    tl.to(q("tool-done", row), { opacity: 1, duration: 0.15 }, at + 0.28);
    if (i === 2) tl.to(q("diff-count"), { autoAlpha: 1, width: "auto", duration: 0.35 }, at + 0.3);
  });
  tl.to(q("worked"), { autoAlpha: 1, duration: 0.25 }, W + 2.1);
  tl.to(q("answer-caret"), { opacity: 1, duration: 0.05 }, W + 2.15);
  type(q("answer"), ANSWER, W + 2.2, 0.95);
  tl.to(q("answer-caret"), { opacity: 0, duration: 0.05 }, W + 3.15);
  tl.to(q("changes"), { autoAlpha: 1, y: 0, duration: 0.4 }, W + 3.1);
  tl.to(sideRows[0].querySelector(".side-spin"), { opacity: 0, duration: 0.15 }, W + 3.15);
  tl.to(qa("side-age")[0], { opacity: 1, duration: 0.2 }, W + 3.2);
  camTo(1, null, W + 2.9, 0.7);

  /* -------------------------------- parallel ------------------------------- */
  const P = CHAPTER_AT.parallel;
  /* phones pull back to show the whole grid; wide screens already do */
  if (opts.narrow) camTo(0.6, { x: SIDEBAR_W + bodyW / 2, y: HEADER_H + bodyH / 2 }, P, 0.8);
  tl.to(
    q("btn-split"),
    { backgroundColor: "rgba(255,255,255,0.09)", color: "#e4e4e5", duration: 0.2 },
    P,
  );
  tl.to(
    thread,
    { autoAlpha: 0, scale: 0.94, transformOrigin: "50% 35%", duration: 0.45 },
    P + 0.05,
  );
  tl.to(composer, { autoAlpha: 0, y: 12, duration: 0.35 }, P + 0.05);
  tl.set(q("grid"), { autoAlpha: 1 }, P + 0.1);
  tl.to(
    panes,
    { x: 0, y: 0, scale: 1, autoAlpha: 1, duration: 0.75, stagger: 0.09, ease: "ryco" },
    P + 0.12,
  );
  sideRows.slice(1).forEach((row, i) => {
    tl.to(
      row.querySelector('[data-s="side-age"]'),
      { opacity: 0, duration: 0.12 },
      P + 0.3 + i * 0.08,
    );
    tl.to(row.querySelector(".side-spin"), { opacity: 1, duration: 0.12 }, P + 0.32 + i * 0.08);
  });
  panes.forEach((pane, i) => {
    const rows = qa("tool", pane);
    rows.forEach((row, r) => {
      const at = P + 0.7 + i * 0.12 + r * 0.32;
      tl.to(row, { autoAlpha: 1, duration: 0.2 }, at);
      tl.to(row.querySelector(".tool-spin"), { opacity: 0, duration: 0.1 }, at + 0.25);
      tl.to(q("tool-done", row), { opacity: 1, duration: 0.1 }, at + 0.27);
    });
    const textAt = P + 0.95 + i * 0.12 + rows.length * 0.3;
    const caret = pane.querySelector(".pane-caret")!;
    tl.to(caret, { opacity: 1, duration: 0.05 }, textAt);
    type(q("pane-text", pane), PANES[i].text, textAt, 0.9 + (i % 3) * 0.18);
    tl.to(caret, { opacity: 0, duration: 0.05 }, textAt + 1.3);
  });

  /* --------------------------------- review -------------------------------- */
  const R = CHAPTER_AT.review;
  if (opts.narrow) camTo(1, null, R, 0.6);
  tl.to([...panes].reverse(), { autoAlpha: 0, scale: 0.92, duration: 0.35, stagger: 0.04 }, R);
  tl.set(q("grid"), { autoAlpha: 0 }, R + 0.6);
  tl.to(
    q("btn-split"),
    { backgroundColor: "rgba(255,255,255,0)", color: "#9a9aa1", duration: 0.2 },
    R,
  );
  tl.to(thread, { autoAlpha: 1, scale: 1, duration: 0.45 }, R + 0.3);
  tl.to(composer, { autoAlpha: 1, y: 0, duration: 0.4 }, R + 0.35);
  [1, 3].forEach((i, k) => {
    tl.to(
      sideRows[i].querySelector(".side-spin"),
      { opacity: 0, duration: 0.12 },
      R + 0.5 + k * 0.3,
    );
    tl.to(
      sideRows[i].querySelector('[data-s="side-age"]'),
      { opacity: 1, duration: 0.12 },
      R + 0.52 + k * 0.3,
    );
  });

  const reviewBtn = q("review-btn");
  const reviewAt = centre(reviewBtn);
  showCursor(R + 0.75, { x: reviewAt.x + 140, y: reviewAt.y + 120 });
  moveCursor(reviewAt, R + 0.8, 0.45);
  click(reviewBtn, R + 1.3);
  tl.to(review, { x: 0, duration: 0.7, ease: "ryco" }, R + 1.38);
  tl.to(chat, { x: -REVIEW_W / 2, duration: 0.7, ease: "ryco" }, R + 1.38);

  const hit = q("diff-hit");
  const hitAt = centre(hit, -60, 0);
  camTo(z(1.1, 1.06), { x: STAGE_W - REVIEW_W / 2, y: hitAt.y + 40 }, R + 1.7, 0.9);
  moveCursor(hitAt, R + 1.85, 0.5);
  click(null, R + 2.4);
  tl.to(q("diff-hit-glow"), { opacity: 1, duration: 0.15 }, R + 2.4);
  tl.to(q("toast"), { autoAlpha: 1, y: 0, duration: 0.4 }, R + 2.5);
  hideCursor(R + 2.75);
  camTo(1, null, R + 2.6, 0.7);

  /* ----------------------------------- run --------------------------------- */
  const U = CHAPTER_AT.run;
  tl.to(q("toast"), { autoAlpha: 0, y: -8, duration: 0.3 }, U);
  tl.to(q("diff-hit-glow"), { opacity: 0, duration: 0.2 }, U);
  const termBtn = q("btn-term");
  const termAt = centre(termBtn);
  showCursor(U + 0.05, { x: termAt.x - 160, y: termAt.y + 140 });
  moveCursor(termAt, U + 0.1, 0.45);
  click(termBtn, U + 0.6);
  tl.to(
    termBtn,
    { backgroundColor: "rgba(255,255,255,0.09)", color: "#e4e4e5", duration: 0.2 },
    U + 0.62,
  );
  hideCursor(U + 0.8);
  tl.to(review, { x: REVIEW_W + 2, duration: 0.6, ease: "ryco.inOut" }, U + 0.65);
  tl.to(chat, { x: 0, y: -TERMINAL_H, duration: 0.7, ease: "ryco.inOut" }, U + 0.65);
  tl.to(terminal, { y: 0, duration: 0.7, ease: "ryco.inOut" }, U + 0.65);
  camTo(z(1.08, 1.12), { x: SIDEBAR_W + 300, y: STAGE_H - TERMINAL_H / 2 - 10 }, U + 1.0, 0.9);
  tl.to(q("term-caret"), { opacity: 1, duration: 0.05 }, U + 1.35);
  type(q("term-cmd"), TERMINAL_CMD, U + 1.4, 0.5);
  tl.to(q("term-caret"), { opacity: 0, duration: 0.05 }, U + 1.95);
  tl.to(termLines, { autoAlpha: 1, duration: 0.12, stagger: 0.11 }, U + 2.0);
  camTo(1, null, U + 2.75, 0.6);
  tl.to({}, { duration: 0.01 }, CHAPTER_AT.end);

  return tl;
}
