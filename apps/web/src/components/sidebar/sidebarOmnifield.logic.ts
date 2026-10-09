import type { EnvironmentId } from "@ryco/contracts";

import type {
  InboxSidebarEnvironment,
  InboxSidebarSectionKey,
} from "../inboxSidebar/inboxSidebarModel";

/**
 * The sidebar's Omnifield: one field that narrows the Inbox list as you type,
 * takes `@machine` and `is:status` tokens, and hands any text to the command
 * palette as "Search everywhere". In Projects mode there is no list to narrow,
 * so it only searches.
 */
export type OmnifieldMode = "inbox" | "projects";

export const INBOX_STATUS_OPTIONS: ReadonlyArray<{
  readonly value: InboxSidebarSectionKey;
  readonly label: string;
}> = [
  { value: "pinned", label: "Pinned" },
  { value: "focus", label: "Focus" },
  { value: "active", label: "Active now" },
  { value: "needs-input", label: "Needs input" },
  { value: "recent", label: "Recent" },
  { value: "snoozed", label: "Snoozed" },
  { value: "settled", label: "Settled" },
];

export type OmnifieldInput =
  | { readonly kind: "idle" }
  | { readonly kind: "text"; readonly term: string }
  /** `cut` is how many trailing characters the token occupies, leading space included. */
  | { readonly kind: "machine"; readonly term: string; readonly cut: number }
  | { readonly kind: "status"; readonly term: string; readonly cut: number };

const MACHINE_TOKEN = /(?:^|\s)@(\S*)$/;
const STATUS_TOKEN = /(?:^|\s)is:(\S*)$/i;

export function parseOmnifieldInput(value: string, mode: OmnifieldMode): OmnifieldInput {
  if (mode === "inbox") {
    const machine = value.match(MACHINE_TOKEN);
    if (machine) {
      return { kind: "machine", term: (machine[1] ?? "").toLowerCase(), cut: machine[0].length };
    }
    const status = value.match(STATUS_TOKEN);
    if (status) {
      return { kind: "status", term: (status[1] ?? "").toLowerCase(), cut: status[0].length };
    }
  }
  const term = value.trim();
  return term ? { kind: "text", term } : { kind: "idle" };
}

/** The free text the Inbox list filters by. A token still being typed narrows nothing. */
export function omnifieldListQuery(value: string): string {
  const input = parseOmnifieldInput(value, "inbox");
  return input.kind === "text" ? input.term : "";
}

/** The field's value once a picked token is removed from its end. */
export function removeTypedToken(value: string, cut: number): string {
  return value.slice(0, value.length - cut).trimEnd();
}

export interface OmnifieldMachine {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly online: boolean;
  /** "this machine" or "offline"; null when there is nothing to add. */
  readonly meta: string | null;
}

export function omnifieldMachines(
  environments: ReadonlyArray<InboxSidebarEnvironment>,
  primaryEnvironmentId: EnvironmentId | null,
): ReadonlyArray<OmnifieldMachine> {
  return environments.map((environment) => {
    const online = environment.connectionState === "connected";
    return {
      environmentId: environment.environmentId,
      label: environment.label,
      online,
      meta:
        environment.environmentId === primaryEnvironmentId
          ? "this machine"
          : environment.connectionState === "offline"
            ? "offline"
            : null,
    };
  });
}

/** Items whose label contains `term`, those starting with it first. */
export function rankByTerm<T>(
  items: ReadonlyArray<T>,
  term: string,
  keys: (item: T) => ReadonlyArray<string>,
): ReadonlyArray<T> {
  const ranked: Array<{ item: T; rank: number; index: number }> = [];
  items.forEach((item, index) => {
    const candidates = keys(item).map((key) => key.toLowerCase());
    if (!candidates.some((candidate) => candidate.includes(term))) return;
    ranked.push({
      item,
      rank: candidates.some((candidate) => candidate.startsWith(term)) ? 0 : 1,
      index,
    });
  });
  return ranked
    .toSorted((left, right) => left.rank - right.rank || left.index - right.index)
    .map((entry) => entry.item);
}

/** Splits `label` around the first case-insensitive occurrence of `term`, for highlighting. */
export function splitLabelAtTerm(
  label: string,
  term: string,
): { readonly before: string; readonly match: string; readonly after: string } | null {
  if (!term) return null;
  const start = label.toLowerCase().indexOf(term.toLowerCase());
  if (start < 0) return null;
  return {
    before: label.slice(0, start),
    match: label.slice(start, start + term.length),
    after: label.slice(start + term.length),
  };
}

export type OmnifieldOption =
  | { readonly kind: "insert"; readonly token: "@" | "is:" }
  | { readonly kind: "machine"; readonly environmentId: EnvironmentId }
  | { readonly kind: "status"; readonly status: InboxSidebarSectionKey }
  | { readonly kind: "everywhere"; readonly query: string };

export type OmnifieldSuggestionRow =
  | { readonly type: "group"; readonly label: string }
  | { readonly type: "separator" }
  | { readonly type: "hint"; readonly parts: ReadonlyArray<string> }
  | {
      readonly type: "option";
      readonly option: OmnifieldOption;
      /** Shown before the label: "@", "is:" or "is". */
      readonly symbol: string | null;
      readonly label: string;
      /** Highlighted part of the label. */
      readonly term: string;
      readonly meta: string | null;
      /** Machine options carry an online dot. */
      readonly online: boolean | null;
    };

export interface OmnifieldSuggestionInput {
  readonly mode: OmnifieldMode;
  readonly value: string;
  /** The funnel was pressed: list every machine and status. */
  readonly showAllFilters: boolean;
  readonly machines: ReadonlyArray<OmnifieldMachine>;
  /** Rows per section in the list as shown, or null when a status filter hides the others. */
  readonly statusCounts: Readonly<Partial<Record<InboxSidebarSectionKey, number>>> | null;
  /** Rows the Inbox list shows for the current filters. */
  readonly matchCount: number;
  readonly paletteShortcutLabel: string | null;
}

export function matchCountHint(count: number, term: string): string {
  const subject =
    count === 0
      ? "No thread here matches"
      : count === 1
        ? "1 thread here matches"
        : `${count} threads here match`;
  return `${subject} “${term}”`;
}

function machineSample(machines: ReadonlyArray<OmnifieldMachine>): string | null {
  if (machines.length === 0) return null;
  const sample = machines
    .slice(0, 2)
    .map((machine) => machine.label)
    .join(", ");
  return machines.length > 2 ? `${sample}…` : sample;
}

export function buildOmnifieldSuggestions(
  input: OmnifieldSuggestionInput,
): ReadonlyArray<OmnifieldSuggestionRow> {
  const parsed = parseOmnifieldInput(input.value, input.mode);
  const machineRows = (term: string): OmnifieldSuggestionRow[] =>
    rankByTerm(input.machines, term, (machine) => [machine.label]).map((machine) => ({
      type: "option",
      option: { kind: "machine", environmentId: machine.environmentId },
      symbol: null,
      label: machine.label,
      term,
      meta: machine.meta,
      online: machine.online,
    }));
  const statusRows = (term: string): OmnifieldSuggestionRow[] =>
    rankByTerm(INBOX_STATUS_OPTIONS, term, (status) => [status.label, status.value]).map(
      (status) => {
        // An absent section has no rows; while a status filter hides the others, counts are unknown.
        const count = input.statusCounts ? (input.statusCounts[status.value] ?? 0) : undefined;
        return {
          type: "option",
          option: { kind: "status", status: status.value },
          symbol: "is",
          label: status.label,
          term,
          meta: count === undefined ? null : String(count),
          online: null,
        };
      },
    );
  const everywhere = (query: string): OmnifieldSuggestionRow => ({
    type: "option",
    option: { kind: "everywhere", query },
    symbol: null,
    label: `Search everywhere for “${query}”`,
    term: "",
    meta: null,
    online: null,
  });

  switch (parsed.kind) {
    case "machine": {
      const rows = machineRows(parsed.term);
      return [
        { type: "group", label: "Machine" },
        ...(rows.length > 0 ? rows : [{ type: "hint", parts: ["No machine matches"] } as const]),
      ];
    }
    case "status": {
      const rows = statusRows(parsed.term);
      return [
        { type: "group", label: "Status" },
        ...(rows.length > 0 ? rows : [{ type: "hint", parts: ["No status matches"] } as const]),
      ];
    }
    case "text":
      return input.mode === "projects"
        ? [everywhere(parsed.term)]
        : [
            { type: "hint", parts: [matchCountHint(input.matchCount, parsed.term)] },
            everywhere(parsed.term),
          ];
    case "idle":
      if (input.mode === "projects") {
        return [{ type: "hint", parts: ["Type to search threads, projects and commands"] }];
      }
      if (input.showAllFilters) {
        return [
          { type: "group", label: "Machine" },
          ...machineRows(""),
          { type: "separator" },
          { type: "group", label: "Status" },
          ...statusRows(""),
        ];
      }
      return [
        {
          type: "option",
          option: { kind: "insert", token: "@" },
          symbol: "@",
          label: "Machine",
          term: "",
          meta: machineSample(input.machines),
          online: null,
        },
        {
          type: "option",
          option: { kind: "insert", token: "is:" },
          symbol: "is:",
          label: "Status",
          term: "",
          meta: "needs input, pinned…",
          online: null,
        },
        { type: "separator" },
        {
          type: "hint",
          parts: [
            ...(input.paletteShortcutLabel
              ? [`${input.paletteShortcutLabel} search everywhere`]
              : []),
            "⌫ remove token",
          ],
        },
      ];
  }
}
