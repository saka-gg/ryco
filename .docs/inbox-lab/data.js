/* ============================================================
   Data + store + shared markup helpers
   ============================================================ */
const IC = {
  check: '<path d="M20 6 9 17l-5-5"/>',
  more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  pin: '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  branch:
    '<line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
  fork: '<circle cx="12" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9"/><path d="M12 12v3"/>',
  pr: '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><line x1="6" x2="6" y1="9" y2="21"/>',
  prDraft:
    '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M18 6V5"/><path d="M18 11v-1"/><line x1="6" x2="6" y1="9" y2="21"/>',
  merge:
    '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/>',
  prClosed:
    '<circle cx="6" cy="6" r="3"/><path d="M6 9v12"/><path d="m21 3-6 6"/><path d="m21 9-6-6"/><path d="M18 11.5V15"/><circle cx="18" cy="18" r="3"/>',
  laptop:
    '<path d="M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9m16 0H4m16 0 1.28 2.55a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45L4 16"/>',
  server:
    '<rect width="20" height="8" x="2" y="2" rx="2" ry="2"/><rect width="20" height="8" x="2" y="14" rx="2" ry="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/>',
  monitor:
    '<rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  chevR: '<path d="m9 18 6-6-6-6"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"/>',
  play: '<polygon points="6 3 20 12 6 21 6 3"/>',
  pause:
    '<rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/>',
  reset: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/>',
  edit: '<path d="M12 22h6a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v10"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10.4 12.6a2 2 0 1 1 3 3L8 21l-4 1 1-4Z"/>',
  read: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
  msg: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
  archive:
    '<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
  external:
    '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  retry:
    '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  open: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
};
const ic = (name, cls = "") =>
  `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${IC[name] || ""}</svg>`;

const R_PATH =
  "M6035,9744C5514,9700 5112,9433 4886,8982C4838,8886 4786,8729 4764,8610L4746,8515L4742,7231L4739,5947L4758,5928L4796,5962C4818,5981 4975,6121 5147,6273L5459,6550L5462,7502L5465,8455L5491,8532C5576,8779 5754,8952 6002,9028L6055,9044L6605,9048C6908,9050 7178,9049 7206,9045L7258,9039L7364,8975L7392,8930C7407,8905 7424,8863 7429,8835L7438,8786L7429,8725C7424,8692 7406,8636 7389,8601L7358,8538L7295,8474L7233,8411L7161,8376L7088,8341L7032,8335C6708,8298 6509,8207 6296,7996C6187,7889 6155,7846 5901,7472L5708,7188L5714,7167C5717,7155 5741,7123 5768,7095C5794,7068 5840,7016 5870,6980C5919,6922 6037,6786 6370,6405C6428,6340 6528,6225 6594,6150C6659,6076 6732,5994 6757,5968L6801,5920L7710,5920L7710,5933C7710,5939 7666,5997 7612,6061C7503,6191 7498,6197 7009,6774C6599,7259 6590,7270 6590,7283C6590,7305 6683,7421 6753,7486L6827,7555L6975,7629L7040,7640C7076,7646 7148,7659 7200,7670C7628,7751 8003,8123 8102,8563L8123,8655L8122,8795L8122,8935L8097,9030C8048,9217 7971,9350 7832,9482C7695,9612 7569,9680 7385,9723L7295,9743L6685,9745C6350,9746 6057,9746 6035,9744Z";
const R_LOGO = `<svg viewBox="227 227 800 800" aria-hidden="true"><g transform="matrix(0.125617,0,0,-0.125617,-180.839814,1610.932617)"><path fill="currentColor" d="${R_PATH}"/></g></svg>`;

const PROV_SVG = {
  codex: `<svg viewBox="0 0 256 260"><path fill="currentColor" d="M239.184 106.203a64.716 64.716 0 0 0-5.576-53.103C219.452 28.459 191 15.784 163.213 21.74A65.586 65.586 0 0 0 52.096 45.22a64.716 64.716 0 0 0-43.23 31.36c-14.31 24.602-11.061 55.634 8.033 76.74a64.665 64.665 0 0 0 5.525 53.102c14.174 24.65 42.644 37.324 70.446 31.36a64.72 64.72 0 0 0 48.754 21.744c28.481.025 53.714-18.361 62.414-45.481a64.767 64.767 0 0 0 43.229-31.36c14.137-24.558 10.875-55.423-8.083-76.483Zm-97.56 136.338a48.397 48.397 0 0 1-31.105-11.255l1.535-.87 51.67-29.825a8.595 8.595 0 0 0 4.247-7.367v-72.85l21.845 12.636c.218.111.37.32.409.563v60.367c-.056 26.818-21.783 48.545-48.601 48.601Zm-104.466-44.61a48.345 48.345 0 0 1-5.781-32.589l1.534.921 51.722 29.826a8.339 8.339 0 0 0 8.441 0l63.181-36.425v25.221a.87.87 0 0 1-.358.665l-52.335 30.184c-23.257 13.398-52.97 5.431-66.404-17.803ZM23.549 85.38a48.499 48.499 0 0 1 25.58-21.333v61.39a8.288 8.288 0 0 0 4.195 7.316l62.874 36.272-21.845 12.636a.819.819 0 0 1-.767 0L41.353 151.53c-23.211-13.454-31.171-43.144-17.804-66.405v.256Zm179.466 41.695-63.08-36.63L161.73 77.86a.819.819 0 0 1 .768 0l52.233 30.184a48.6 48.6 0 0 1-7.316 87.635v-61.391a8.544 8.544 0 0 0-4.4-7.213Zm21.742-32.69-1.535-.922-51.619-30.081a8.39 8.39 0 0 0-8.492 0L99.98 99.808V74.587a.716.716 0 0 1 .307-.665l52.233-30.133a48.652 48.652 0 0 1 72.236 50.391v.205ZM88.061 139.097l-21.845-12.585a.87.87 0 0 1-.41-.614V65.685a48.652 48.652 0 0 1 79.757-37.346l-1.535.87-51.67 29.825a8.595 8.595 0 0 0-4.246 7.367l-.051 72.697Zm11.868-25.58 28.138-16.217 28.188 16.218v32.434l-28.086 16.218-28.188-16.218-.052-32.434Z"/></svg>`,
  claude: `<svg viewBox="0 0 256 257"><path fill="#d97757" d="m50.228 170.321 50.357-28.257.843-2.463-.843-1.361h-2.462l-8.426-.518-28.775-.778-24.952-1.037-24.175-1.296-6.092-1.297L0 125.796l.583-3.759 5.12-3.434 7.324.648 16.202 1.101 24.304 1.685 17.629 1.037 26.118 2.722h4.148l.583-1.685-1.426-1.037-1.101-1.037-25.147-17.045-27.22-18.017-14.258-10.37-7.713-5.25-3.888-4.925-1.685-10.758 7-7.713 9.397.649 2.398.648 9.527 7.323 20.35 15.75L94.817 91.9l3.889 3.24 1.555-1.102.195-.777-1.75-2.917-14.453-26.118-15.425-26.572-6.87-11.018-1.814-6.61c-.648-2.723-1.102-4.991-1.102-7.778l7.972-10.823L71.42 0 82.05 1.426l4.472 3.888 6.61 15.101 10.694 23.786 16.591 32.34 4.861 9.592 2.592 8.879.973 2.722h1.685v-1.556l1.36-18.211 2.528-22.36 2.463-28.776.843-8.1 4.018-9.722 7.971-5.25 6.222 2.981 5.12 7.324-.713 4.73-3.046 19.768-5.962 30.98-3.889 20.739h2.268l2.593-2.593 10.499-13.934 17.628-22.036 7.778-8.749 9.073-9.657 5.833-4.601h11.018l8.1 12.055-3.628 12.443-11.342 14.388-9.398 12.184-13.48 18.147-8.426 14.518.778 1.166 2.01-.194 30.46-6.481 16.462-2.982 19.637-3.37 8.88 4.148.971 4.213-3.5 8.62-20.998 5.184-24.628 4.926-36.682 8.685-.454.324.519.648 16.526 1.555 7.065.389h17.304l32.21 2.398 8.426 5.574 5.055 6.805-.843 5.184-12.962 6.611-17.498-4.148-40.83-9.721-14-3.5h-1.944v1.167l11.666 11.406 21.387 19.314 26.767 24.887 1.36 6.157-3.434 4.86-3.63-.518-23.526-17.693-9.073-7.972-20.545-17.304h-1.36v1.814l4.73 6.935 25.017 37.59 1.296 11.536-1.814 3.76-6.481 2.268-7.13-1.297-14.647-20.544-15.1-23.138-12.185-20.739-1.49.843-7.194 77.448-3.37 3.953-7.778 2.981-6.48-4.925-3.436-7.972 3.435-15.749 4.148-20.544 3.37-16.333 3.046-20.285 1.815-6.74-.13-.454-1.49.194-15.295 20.999-23.267 31.433-18.406 19.702-4.407 1.75-7.648-3.954.713-7.064 4.277-6.286 25.47-32.405 15.36-20.092 9.917-11.6-.065-1.686h-.583L44.07 198.125l-12.055 1.555-5.185-4.86.648-7.972 2.463-2.593 20.35-13.999-.064.065Z"/></svg>`,
  cursor: `<svg viewBox="0 0 466.73 532.09"><path fill="currentColor" d="M457.43,125.94L244.42,2.96c-6.84-3.95-15.28-3.95-22.12,0L9.3,125.94c-5.75,3.32-9.3,9.46-9.3,16.11v247.99c0,6.65,3.55,12.79,9.3,16.11l213.01,122.98c6.84,3.95,15.28,3.95,22.12,0l213.01-122.98c5.75-3.32,9.3-9.46,9.3-16.11v-247.99c0-6.65-3.55-12.79-9.3-16.11h-.01ZM444.05,151.99l-205.63,356.16c-1.39,2.4-5.06,1.42-5.06-1.36v-233.21c0-4.66-2.49-8.97-6.53-11.31L24.87,145.67c-2.4-1.39-1.42-5.06,1.36-5.06h411.26c5.84,0,9.49,6.33,6.57,11.39h-.01Z"/></svg>`,
  copilot: `<svg viewBox="0 0 256 208"><path fill="currentColor" d="M205.3 31.4c14 14.8 20 35.2 22.5 63.6 6.6 0 12.8 1.5 17 7.2l7.8 10.6c2.2 3 3.4 6.6 3.4 10.4v28.7a12 12 0 0 1-4.8 9.5C215.9 187.2 172.3 208 128 208c-49 0-98.2-28.3-123.2-46.6a12 12 0 0 1-4.8-9.5v-28.7c0-3.8 1.2-7.4 3.4-10.5l7.8-10.5c4.2-5.7 10.4-7.2 17-7.2 2.5-28.4 8.4-48.8 22.5-63.6C77.3 3.2 112.6 0 127.6 0h.4c14.7 0 50.4 2.9 77.3 31.4ZM128 78.7c-3 0-6.5.2-10.3.6a27.1 27.1 0 0 1-6 12.1 45 45 0 0 1-32 13c-6.8 0-13.9-1.5-19.7-5.2-5.5 1.9-10.8 4.5-11.2 11-.5 12.2-.6 24.5-.6 36.8 0 6.1 0 12.3-.2 18.5 0 3.6 2.2 6.9 5.5 8.4C79.9 185.9 105 192 128 192s48-6 74.5-18.1a9.4 9.4 0 0 0 5.5-8.4c.3-18.4 0-37-.8-55.3-.4-6.6-5.7-9.1-11.2-11-5.8 3.7-13 5.1-19.7 5.1a45 45 0 0 1-32-12.9 27.1 27.1 0 0 1-6-12.1c-3.4-.4-6.9-.5-10.3-.6Zm-27 44c5.8 0 10.5 4.6 10.5 10.4v19.2a10.4 10.4 0 0 1-20.8 0V133c0-5.8 4.6-10.4 10.4-10.4Zm53.4 0c5.8 0 10.4 4.6 10.4 10.4v19.2a10.4 10.4 0 0 1-20.8 0V133c0-5.8 4.7-10.4 10.4-10.4Zm-73-94.4c-11.2 1.1-20.6 4.8-25.4 10-10.4 11.3-8.2 40.1-2.2 46.2A31.2 31.2 0 0 0 75 91.7c6.8 0 19.6-1.5 30.1-12.2 4.7-4.5 7.5-15.7 7.2-27-.3-9.1-2.9-16.7-6.7-19.9-4.2-3.6-13.6-5.2-24.2-4.3Zm69 4.3c-3.8 3.2-6.4 10.8-6.7 19.9-.3 11.3 2.5 22.5 7.2 27a41.7 41.7 0 0 0 30 12.2c8.9 0 17-2.9 21.3-7.2 6-6.1 8.2-34.9-2.2-46.3-4.8-5-14.2-8.8-25.4-9.9-10.6-1-20 .7-24.2 4.3ZM128 56c-2.6 0-5.6.2-9 .5.4 1.7.5 3.7.7 5.7 0 1.5 0 3-.2 4.5 3.2-.3 6-.3 8.5-.3 2.6 0 5.3 0 8.5.3-.2-1.6-.2-3-.2-4.5.2-2 .3-4 .7-5.7-3.4-.3-6.4-.5-9-.5Z"/></svg>`,
  opencode: `<svg viewBox="0 0 32 40"><path d="M24 32H8V16H24V32Z" fill="var(--oc-in)"/><path d="M24 8H8V32H24V8ZM32 40H0V0H32V40Z" fill="var(--oc-out)"/></svg>`,
};
const PROVIDERS = {
  codex: { name: "Codex" },
  claude: { name: "Claude" },
  cursor: { name: "Cursor" },
  copilot: { name: "GitHub Copilot" },
  opencode: { name: "OpenCode" },
};
const PROJECTS = {
  ryco: { name: "ryco", kind: "ryco" },
  hub: { name: "ryco-hub", kind: "ryco-dark" },
  cs2: { name: "cs2inspect-web", kind: "mono", mono: "CS", hue: 45 },
};
const MACHINES = {
  mbp: { label: "MacBook M5", icon: "laptop", local: true },
  mini: { label: "Mac mini", icon: "monitor", local: false },
  fsn: { label: "hetzner-fsn1", icon: "server", local: false },
};
const KIND_IC = { read: "read", search: "search", edit: "edit", run: "terminal" };

const s = (k, now, done) => ({ k, now, done });
const STEPS = {
  t1: [
    s("read", "Reading PlanSidebar.tsx", "Read PlanSidebar.tsx"),
    s("search", "Searching overviewSections", "Searched overviewSections"),
    s("edit", "Editing overviewLayouts.tsx", "Edited overviewLayouts.tsx"),
    s("run", "Running bun typecheck", "Ran bun typecheck"),
    s("edit", "Editing PlanSidebar.browser.tsx", "Edited PlanSidebar.browser.tsx"),
    s("run", "Running browser tests", "Ran browser tests"),
  ],
  t2: [
    s("run", "Running ssh-keygen", "Ran ssh-keygen"),
    s("edit", "Writing ~/.ryco/node.json", "Wrote ~/.ryco/node.json"),
    s("run", "Checking relay handshake", "Checked relay handshake"),
  ],
  t4: [
    s("read", "Reading pages/picker.vue", "Read pages/picker.vue"),
    s("edit", "Migrating usePickerStore", "Migrated usePickerStore"),
    s("run", "Running nuxi typecheck", "Ran nuxi typecheck"),
  ],
  t5: [
    s("read", "Reading CHANGELOG.md", "Read CHANGELOG.md"),
    s("search", "Scanning 23 merged PRs", "Scanned 23 merged PRs"),
    s("edit", "Drafting release notes", "Drafted release notes"),
  ],
  t5b: [s("run", "Running gh release create --draft", "Ran gh release create --draft")],
};

const NOW0 = Date.parse("2026-10-02T14:32:00");
const MIN = 60e3;

const INIT = () => [
  {
    id: "t1",
    title: "Explore Interactive Overview Sidebar Designs",
    project: "ryco",
    machine: "mbp",
    provider: "codex",
    model: "GPT-5.6 Terra",
    branch: "ryco/overview-sidebar-design-explore",
    worktree: true,
    pr: { n: 624, state: "open", checks: { pass: 3, run: 2, fail: 0 } },
    diff: { files: 9, add: 212, del: 58 },
    state: "working",
    at: NOW0 - 252e3,
    pinned: true,
    steps: STEPS.t1,
    stepIdx: 2,
    stepAt: 0,
    finishAt: 12,
    last: "Reading the current PlanSidebar layout before splitting it into three layout components.",
    result: {
      last: "Implemented Stack, Hybrid and Board layouts behind the new panelLayout preference. Typecheck and the browser suite pass.",
      diff: { files: 11, add: 248, del: 61 },
      checks: { pass: 5, run: 0, fail: 0 },
    },
  },
  {
    id: "t2",
    title: "Research Ryco Hub Remote Setup",
    project: "ryco",
    machine: "mbp",
    provider: "claude",
    model: "Opus 5.5",
    branch: "ryco/research-remote-connect-setup",
    worktree: true,
    pr: { n: 642, state: "draft", checks: { pass: 4, run: 0, fail: 0 } },
    diff: { files: 14, add: 530, del: 96 },
    state: "input",
    at: NOW0 - 128e3,
    input: { kind: "approval", cmd: 'ssh-keygen -t ed25519 -f ~/.ryco/node_key -N ""' },
    last: "I need a node key before I can test the relay handshake.",
    after: {
      steps: STEPS.t2,
      run: 10,
      result: {
        last: "Generated the node key, wrote ~/.ryco/node.json and verified the relay handshake end to end.",
        diff: { files: 15, add: 561, del: 97 },
      },
    },
  },
  {
    id: "t3",
    title: "Fix flaky reconnect test in hosted lifecycle",
    project: "hub",
    machine: "fsn",
    provider: "codex",
    model: "GPT-5.6 Sol",
    branch: "fix/reconnect-flake",
    worktree: true,
    pr: { n: 96, state: "open", checks: { pass: 6, run: 0, fail: 0 } },
    diff: { files: 7, add: 184, del: 41 },
    state: "done",
    unread: true,
    at: NOW0 - 6 * MIN,
    ran: "6m 40s",
    last: "The flake came from a stale relay generation publishing readiness after reconnect. Generations are now checked before readiness is accepted; ran the suite 50× with no failures.",
  },
  {
    id: "t4",
    title: "Migrate weapon skin picker to Nuxt 4",
    project: "cs2",
    machine: "mbp",
    provider: "cursor",
    model: "Composer 2",
    branch: "nuxt4-picker",
    worktree: false,
    pr: null,
    diff: { files: 3, add: 41, del: 12 },
    state: "error",
    at: NOW0 - 12 * MIN,
    error: "Provider exited unexpectedly (code 1)",
    errorDetail: "cursor-agent: ECONNRESET while streaming tool output",
    last: "Started migrating usePickerStore to the Nuxt 4 composables layout.",
    after: {
      steps: STEPS.t4,
      run: 12,
      result: {
        last: "Picker migrated to Nuxt 4. Two components still use the Options API, flagged in TODO.md.",
        diff: { files: 8, add: 196, del: 143 },
      },
    },
  },
  {
    id: "t5",
    title: "Write release notes for 0.9",
    project: "ryco",
    machine: "mini",
    provider: "claude",
    model: "Sonnet 5.5",
    branch: "main",
    worktree: false,
    pr: null,
    diff: null,
    state: "idle",
    at: NOW0 - 26 * 60 * MIN,
    last: "Collected the merged PRs since 0.8. Ready to draft when you are.",
  },
  {
    id: "t6",
    title: "Bump effect to 3.18",
    project: "ryco",
    machine: "mbp",
    provider: "copilot",
    model: "GPT-5.6",
    branch: "ryco/bump-effect",
    worktree: true,
    pr: { n: 631, state: "merged", checks: { pass: 6, run: 0, fail: 0 } },
    diff: { files: 4, add: 22, del: 19 },
    state: "idle",
    settled: true,
    at: NOW0 - 3 * 1440 * MIN,
    last: "Bumped effect and fixed two deprecated Schema calls.",
  },
  {
    id: "t7",
    title: "Tune mobile file viewer scroll",
    project: "ryco",
    machine: "mbp",
    provider: "opencode",
    model: "Qwen3 Coder",
    branch: "ryco/mobile-file-scroll",
    worktree: true,
    pr: { n: 610, state: "closed", checks: null },
    diff: { files: 2, add: 18, del: 7 },
    state: "idle",
    settled: true,
    at: NOW0 - 5 * 1440 * MIN,
    last: "Closed in favour of the native viewer work.",
  },
];

/* ------------------------------------------------------------ store */
const S = {
  threads: INIT(),
  selected: "t1",
  now: NOW0,
  simT: 0,
  playing: true,
  settledOpen: false,
  snoozedOpen: false,
};
const T = (id) => S.threads.find((t) => t.id === id);
const clone = (o) => JSON.parse(JSON.stringify(o));

/* ------------------------------------------------------------ format */
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
function ago(ms) {
  const sec = Math.max(0, Math.round((S.now - ms) / 1000));
  if (sec < 45) return "now";
  const m = Math.round(sec / 60);
  if (m < 60) return m + "m";
  const hr = Math.round(m / 60);
  if (hr < 24) return hr + "h";
  return Math.round(hr / 24) + "d";
}
function elapsed(ms) {
  const sec = Math.max(0, Math.floor((S.now - ms) / 1000));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}
function longDur(msSpan) {
  const sec = Math.max(0, Math.floor(msSpan / 1000));
  const m = Math.floor(sec / 60);
  if (m >= 1440) return `${Math.floor(m / 1440)}d`;
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return m ? `${m}m ${sec % 60}s` : `${sec}s`;
}
const clockOf = (ms) =>
  new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
const shortTitle = (t, n = 30) => (t.length > n ? t.slice(0, n - 1) + "…" : t);

/* ------------------------------------------------------------ semantics */
const gstate = (t) => (t.settled ? "settled" : t.snoozed ? "snoozed" : t.state);
const isLive = (t) => t.state === "working" || t.state === "connecting";
function inputLabel(t) {
  return t.input?.kind === "approval" ? "Needs approval" : "Has a question";
}
function stateLabel(t) {
  if (t.settled) return "Settled";
  if (t.snoozed) return "Snoozed";
  return (
    {
      working: "Working",
      connecting: "Reconnecting",
      input: inputLabel(t),
      done: "Done",
      error: "Error",
      idle: "Idle",
    }[t.state] || t.state
  );
}
const canSettle = (t) => ["done", "idle", "error"].includes(t.state);
function settleBlock(t) {
  if (t.state === "input")
    return t.input?.kind === "approval"
      ? "Resolve the pending approval first"
      : "Answer the pending question first";
  if (isLive(t)) return "Wait for the running work to finish";
  return null;
}
const timeFor = (t) => (isLive(t) ? elapsed(t.at) : ago(t.at));
function timeTip(t) {
  if (t.settled) return `Settled ${clockOf(t.at)}`;
  if (isLive(t)) return `Running for ${longDur(S.now - t.at)}`;
  if (t.state === "input") return `Waiting on you for ${longDur(S.now - t.at)}`;
  if (t.state === "done") return `Finished ${clockOf(t.at)}${t.ran ? ` · ran ${t.ran}` : ""}`;
  return `Last activity ${longDur(S.now - t.at)} ago`;
}
function glyphTip(t) {
  if (t.settled) return "Settled";
  if (t.snoozed) return "Snoozed until tomorrow 09:00";
  switch (t.state) {
    case "working":
      return `Working · ${longDur(S.now - t.at)}`;
    case "connecting":
      return `Reconnecting to ${MACHINES[t.machine].label}`;
    case "input":
      return `${inputLabel(t)} · ${longDur(S.now - t.at)}`;
    case "done":
      return t.unread ? "Done · not opened yet" : "Done";
    case "error":
      return `Error · ${t.error}`;
    default:
      return "Idle · nothing running";
  }
}
const curStep = (t) => t.steps?.[t.stepIdx];

/* ------------------------------------------------------------ markup */
const DONE_SVG = `<svg viewBox="0 0 14 14"><circle cx="7" cy="7" r="6.2" fill="var(--ok-fill)"/><path class="draw" pathLength="1" d="M4.3 7.3l1.8 1.8 3.7-3.9" fill="none" stroke="var(--check-ink)" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ERR_SVG = `<svg viewBox="0 0 14 14"><circle cx="7" cy="7" r="6.2" fill="var(--err-fill)"/><path d="M7 3.9v3.6" stroke="#fff" stroke-width="1.7" stroke-linecap="round"/><circle cx="7" cy="10" r="1" fill="#fff"/></svg>`;
function glyph(t, forced) {
  const st = forced || gstate(t);
  if (st === "done") return `<span class="g g-done">${DONE_SVG}</span>`;
  if (st === "error") return `<span class="g g-error">${ERR_SVG}</span>`;
  if (st === "settled") return `<span class="g g-settled">${ic("check")}</span>`;
  if (st === "snoozed") return `<span class="g g-snoozed">${ic("clock")}</span>`;
  return `<span class="g g-${st}"></span>`;
}
function fav(pid) {
  const p = PROJECTS[pid];
  if (p.kind === "mono") return `<span class="fav mono" style="--hue:${p.hue}">${p.mono}</span>`;
  return `<span class="fav ${p.kind}">${R_LOGO}</span>`;
}
const pv = (id) => `<span class="pv">${PROV_SVG[id]}</span>`;
const PR_META = {
  open: { icon: "pr", label: "Open" },
  draft: { icon: "prDraft", label: "Draft" },
  merged: { icon: "merge", label: "Merged" },
  closed: { icon: "prClosed", label: "Closed" },
};
function checksText(c) {
  if (!c) return "no checks";
  const total = c.pass + c.run + c.fail;
  if (c.fail) return `${c.fail} of ${total} checks failing`;
  if (c.run) return `${c.pass}/${total} checks · ${c.run} running`;
  return `${total} checks passed`;
}
const prTip = (pr) => `PR #${pr.n} · ${PR_META[pr.state].label} · ${checksText(pr.checks)}`;
function prChip(pr, boxed = false) {
  const m = PR_META[pr.state];
  return `<span class="pr pr-${pr.state} ${boxed ? "boxed" : ""}" data-tip="${esc(prTip(pr))}">${ic(m.icon)}<span>#${pr.n}</span></span>`;
}
function dots(c) {
  if (!c) return "";
  const out = [];
  for (let i = 0; i < c.pass; i++) out.push("<i></i>");
  for (let i = 0; i < c.fail; i++) out.push('<i class="fail"></i>');
  for (let i = 0; i < c.run; i++) out.push('<i class="run"></i>');
  return `<span class="dots" data-tip="${esc(checksText(c))}">${out.join("")}</span>`;
}
const diffstat = (d) =>
  d
    ? `<span class="ds"><span class="add">+${d.add}</span><span class="del">−${d.del}</span></span>`
    : "";
function machineMark(t) {
  const m = MACHINES[t.machine];
  if (m.local) return "";
  return `<span class="mach" data-tip="Runs on ${esc(m.label)}">${ic(m.icon)}</span>`;
}
const provTip = (t) => `${PROVIDERS[t.provider].name} · ${t.model}`;

/* State block: the one actionable thing for this state. Used by the
   hover card (A), agent card (C), approval popover (B) and main pane. */
function stateBlock(t, opts = {}) {
  const who = PROVIDERS[t.provider].name;
  if (t.settled || t.snoozed) return `<p class="msg">${esc(t.last)}</p>`;
  switch (t.state) {
    case "connecting":
    case "working":
      return "";
    case "input":
      if (t.input.kind === "approval")
        return `<div class="blk"><div class="cap">${ic("terminal")}${who} wants to run</div><pre class="code">${esc(t.input.cmd)}</pre><div class="btns"><button class="btn" data-act="deny" data-id="${t.id}">Deny</button><button class="btn pri" data-act="approve" data-id="${t.id}">Approve <kbd>⏎</kbd></button></div></div>`;
      return `<div class="blk"><div class="cap">${ic("msg")}${who} asks</div><p class="q">${esc(t.input.q)}</p><div class="btns">${t.input.options
        .map(
          (o, i) =>
            `<button class="btn ${i === 0 ? "pri" : ""}" data-act="answer" data-i="${i}" data-id="${t.id}">${esc(o)}</button>`,
        )
        .join("")}</div></div>`;
    case "error":
      return `<div class="blk"><pre class="code err">${esc(t.error)}\n${esc(t.errorDetail || "")}</pre><div class="btns"><button class="btn pri" data-act="retry" data-id="${t.id}">${ic("retry")}Retry</button></div></div>`;
    default:
      return `<p class="msg">${esc(t.last)}</p>`;
  }
}

/* Rich card used by A (hover card) and C (agent popover). */
function cardKey(t) {
  return [
    t.id,
    gstate(t),
    t.stepIdx,
    t.input?.kind,
    t.unread,
    t.pinned,
    JSON.stringify(t.pr),
    t.diff?.add,
  ].join("|");
}
function richCard(t, opts = {}) {
  const m = MACHINES[t.machine];
  const P = PROJECTS[t.project];
  return `<div class="hc-head"><span class="hc-state st-${gstate(t)}">${glyph(t)}<span>${stateLabel(t)}</span></span><span class="hc-time" data-live="time">${isLive(t) ? elapsed(t.at) : ago(t.at) + " ago"}</span></div>
  <div class="hc-title">${esc(t.title)}</div>
  ${stateBlock(t, opts)}
  <div class="hc-meta">
    <div class="hc-line">${fav(t.project)}<span class="strong">${esc(P.name)}</span><span class="sep">/</span>${ic(t.worktree ? "fork" : "branch")}<span class="mono trunc">${esc(t.branch)}</span></div>
    <div class="hc-line">${ic(m.icon)}<span>${esc(m.label)}</span><span class="sep">·</span>${pv(t.provider)}<span>${esc(t.model)}</span></div>
    ${
      t.pr
        ? `<div class="hc-line">${prChip(t.pr, true)}<span>${PR_META[t.pr.state].label}</span>${t.pr.checks ? `<span class="sep">·</span>${dots(t.pr.checks)}` : ""}${t.diff ? `<span class="sep">·</span>${diffstat(t.diff)}` : ""}</div>`
        : t.diff
          ? `<div class="hc-line">${diffstat(t.diff)}<span class="dim">${t.diff.files} files</span></div>`
          : ""
    }
  </div>`;
}

/* ------------------------------------------------------------ sim */
function startWork(t, steps, runSecs, result, thenInput, afterInput) {
  t.state = "working";
  t.at = S.now;
  t.steps = steps;
  t.stepIdx = 0;
  t.stepAt = S.simT;
  t.finishAt = S.simT + runSecs;
  t.result = result;
  t.thenInput = thenInput || null;
  t.afterInput = afterInput || null;
  t.input = null;
  t.error = null;
  t.unread = false;
}
function finish(t) {
  if (t.result?.last) t.last = t.result.last;
  if (t.result?.diff) t.diff = t.result.diff;
  if (t.result?.checks && t.pr) t.pr.checks = t.result.checks;
  if (t.thenInput) {
    t.state = "input";
    t.input = t.thenInput;
    t.after = t.afterInput;
    t.thenInput = null;
    t.at = S.now;
    return;
  }
  t.ran = longDur(S.now - t.at);
  t.state = "done";
  t.unread = true;
  t.at = S.now;
  t.finishAt = null;
}
const SCRIPT = [
  {
    t: 17,
    run() {
      const t = T("t5");
      if (!t || t.state !== "idle" || t.settled || t.snoozed) return;
      startWork(
        t,
        STEPS.t5,
        11,
        { last: "Drafted the 0.9 notes in CHANGELOG.md." },
        {
          kind: "question",
          q: "Also publish these notes as a draft GitHub release?",
          options: ["Yes, draft it", "Only CHANGELOG"],
        },
        {
          steps: STEPS.t5b,
          run: 7,
          result: {
            last: "Drafted GitHub release v0.9.0 from the changelog.",
            diff: { files: 1, add: 64, del: 0 },
          },
        },
      );
    },
  },
];
function tick() {
  S.now += 1000;
  S.simT += 1;
  for (const t of S.threads) {
    if (t.state === "connecting" && S.simT >= t.until) {
      t.state = "working";
      t.at = S.now;
      t.stepAt = S.simT;
    } else if (t.state === "working") {
      if (t.finishAt != null && S.simT >= t.finishAt) finish(t);
      else if (S.simT - t.stepAt >= 4 && t.stepIdx < t.steps.length - 1) {
        t.stepIdx++;
        t.stepAt = S.simT;
      }
    }
  }
  for (const ev of SCRIPT) if (ev.t === S.simT) ev.run();
}
