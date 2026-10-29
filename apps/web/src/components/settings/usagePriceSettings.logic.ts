import {
  USAGE_PRICE_OVERRIDE_LIMIT,
  type UsageModelPrice,
  type UsagePriceOverride,
  type UsagePriceOverrides,
} from "@ryco/contracts/settings";
import {
  normalizeUsageModelKey,
  validateUsagePriceOverrides,
  type UsagePriceOverrideIssueKind,
} from "@ryco/shared/usagePriceOverrides";

/** Prices in USD per million tokens; blank cache prices charge the input price. */
export const USAGE_PRICE_FIELDS = [
  { key: "inputUsdPerMillion", label: "Input", optional: false },
  { key: "outputUsdPerMillion", label: "Output", optional: false },
  { key: "cacheReadUsdPerMillion", label: "Cache read", optional: true },
  { key: "cacheWriteUsdPerMillion", label: "Cache write", optional: true },
] as const;
export type UsagePriceField = (typeof USAGE_PRICE_FIELDS)[number]["key"];

export type UsagePriceMode = "price" | "map";

/** A row's values as typed: numbers stay text until saved. */
export interface UsagePriceForm {
  readonly mode: UsagePriceMode;
  readonly prices: Readonly<Record<UsagePriceField, string>>;
  readonly mapTo: string;
}

/**
 * An unsaved edit: a new row, or a change to the saved entry of `model` (whose ID is fixed;
 * renaming is removing and adding). Absent fields keep the saved values, so a row nobody
 * edited follows the node's settings while others are edited.
 */
export interface UsagePriceDraft {
  readonly id: string;
  readonly model: string;
  readonly isNew: boolean;
  readonly mode?: UsagePriceMode;
  readonly prices?: Partial<Record<UsagePriceField, string>>;
  readonly mapTo?: string;
  readonly removed?: boolean;
}

export interface UsagePriceRow {
  readonly id: string;
  readonly model: string;
  readonly isNew: boolean;
  readonly removed: boolean;
  /** Has unsaved edits. */
  readonly edited: boolean;
  readonly form: UsagePriceForm;
}

export type UsagePricePatch = Record<string, UsagePriceOverride | null>;

export interface UsagePriceDraftResult {
  readonly rows: readonly UsagePriceRow[];
  /** Only the entries that change: `null` removes one. Empty while any edited row has an error. */
  readonly patch: UsagePricePatch;
  /** By row id; on rows without edits they are warnings that do not block saving. */
  readonly errors: ReadonlyMap<string, string>;
  /** An error no single row owns (too many entries). */
  readonly limitError: string | null;
  readonly blocked: boolean;
}

const MODEL_ID_MAX_LENGTH = 256;
const MAX_USD_PER_MILLION = 1_000_000;
const PRICE_PATTERN = /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

const ISSUE_MESSAGES: Readonly<Record<UsagePriceOverrideIssueKind, string>> = {
  duplicate: "This model is already listed.",
  "self-map": "Map to a different model.",
  loop: "These mappings form a loop, so none of them applies.",
  synthetic: "Placeholder models are never priced.",
};

/** A saved entry, or a new row, as the editor shows it. */
export function usagePriceForm(override?: UsagePriceOverride): UsagePriceForm {
  const price = override?.price;
  return {
    mode: override?.mapTo === undefined ? "price" : "map",
    prices: {
      inputUsdPerMillion: price?.inputUsdPerMillion.toString() ?? "",
      outputUsdPerMillion: price?.outputUsdPerMillion.toString() ?? "",
      cacheReadUsdPerMillion: price?.cacheReadUsdPerMillion?.toString() ?? "",
      cacheWriteUsdPerMillion: price?.cacheWriteUsdPerMillion?.toString() ?? "",
    },
    mapTo: override?.mapTo ?? "",
  };
}

function applyDraft(form: UsagePriceForm, draft: UsagePriceDraft | undefined): UsagePriceForm {
  if (draft === undefined) return form;
  return {
    mode: draft.mode ?? form.mode,
    prices: { ...form.prices, ...draft.prices },
    mapTo: draft.mapTo ?? form.mapTo,
  };
}

function isBlankNewRow(row: UsagePriceRow): boolean {
  return (
    row.isNew &&
    row.model.trim() === "" &&
    row.form.mapTo.trim() === "" &&
    Object.values(row.form.prices).every((value) => value.trim() === "")
  );
}

/** Blank cache prices charge the input price; 0 is free. */
export function parseUsagePriceForm(
  model: string,
  form: UsagePriceForm,
): { readonly override: UsagePriceOverride } | { readonly error: string } {
  const id = model.trim();
  if (id === "") return { error: "Enter a model ID." };
  if (id.length > MODEL_ID_MAX_LENGTH)
    return { error: `Model IDs have at most ${MODEL_ID_MAX_LENGTH} characters.` };
  if (form.mode === "map") {
    const mapTo = form.mapTo.trim();
    if (mapTo === "") return { error: "Enter the model to count it as." };
    if (mapTo.length > MODEL_ID_MAX_LENGTH)
      return { error: `Model IDs have at most ${MODEL_ID_MAX_LENGTH} characters.` };
    return { override: { mapTo } };
  }
  const price: Partial<Record<UsagePriceField, number>> = {};
  for (const field of USAGE_PRICE_FIELDS) {
    const raw = form.prices[field.key].trim();
    if (raw === "") {
      if (field.optional) continue;
      return { error: "Enter input and output prices." };
    }
    const value = PRICE_PATTERN.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isFinite(value) || value > MAX_USD_PER_MILLION)
      return { error: "Enter prices as numbers from 0 to 1,000,000." };
    price[field.key] = value;
  }
  const { inputUsdPerMillion, outputUsdPerMillion, ...cache } = price;
  if (inputUsdPerMillion === undefined || outputUsdPerMillion === undefined)
    return { error: "Enter input and output prices." };
  return {
    override: {
      price: { inputUsdPerMillion, outputUsdPerMillion, ...cache } satisfies UsageModelPrice,
    },
  };
}

function samePrice(left: UsageModelPrice, right: UsageModelPrice): boolean {
  return USAGE_PRICE_FIELDS.every((field) => left[field.key] === right[field.key]);
}

function sameOverride(left: UsagePriceOverride, right: UsagePriceOverride): boolean {
  if (left.mapTo !== undefined || right.mapTo !== undefined) return left.mapTo === right.mapTo;
  return (
    left.price !== undefined && right.price !== undefined && samePrice(left.price, right.price)
  );
}

/**
 * The rows to show (saved entries by model ID, then new rows), the settings patch that saves
 * the drafts, and what stops it: a row that does not parse, a model listed twice (in any case),
 * a mapping to itself or into a loop, or more than the node accepts.
 */
export function resolveUsagePriceDrafts(
  saved: UsagePriceOverrides,
  drafts: readonly UsagePriceDraft[],
): UsagePriceDraftResult {
  const edits = new Map(
    drafts.filter((draft) => !draft.isNew).map((draft) => [draft.model, draft]),
  );
  const savedRows: UsagePriceRow[] = Object.keys(saved).map((model) => {
    const draft = edits.get(model);
    return {
      id: savedRowId(model),
      model,
      isNew: false,
      removed: draft?.removed === true,
      edited: draft !== undefined,
      form: applyDraft(usagePriceForm(saved[model]), draft),
    };
  });
  const newRows: UsagePriceRow[] = drafts
    .filter((draft) => draft.isNew)
    .map((draft) => ({
      id: draft.id,
      model: draft.model,
      isNew: true,
      removed: false,
      edited: true,
      form: applyDraft(usagePriceForm(), draft),
    }));
  const rows = [
    ...savedRows.toSorted((left, right) => left.model.localeCompare(right.model)),
    ...newRows,
  ];

  const errors = new Map<string, string>();
  const patch: UsagePricePatch = {};
  const kept: Array<{ readonly row: UsagePriceRow; readonly override: UsagePriceOverride }> = [];
  // Saving keeps saved entries where they are and appends new ones. Of a model listed in several
  // cases the node prices the first in that order, so the others are the duplicates.
  for (const row of [...savedRows, ...newRows]) {
    if (row.removed) {
      patch[row.model] = null;
      continue;
    }
    if (isBlankNewRow(row)) continue;
    const parsed = parseUsagePriceForm(row.model, row.form);
    if ("error" in parsed) {
      errors.set(row.id, parsed.error);
      continue;
    }
    kept.push({ row, override: parsed.override });
    const current = row.isNew ? undefined : saved[row.model];
    if (current === undefined || !sameOverride(current, parsed.override))
      patch[row.model.trim()] = parsed.override;
  }

  // The shared check reports a repeated model on each occurrence after the first and every
  // other issue once per model ID, in the order given.
  const issues = validateUsagePriceOverrides(
    kept.map(({ row, override }) => [row.model.trim(), override] as const),
  );
  const issueByKey = new Map(
    issues
      .filter((issue) => issue.issue !== "duplicate")
      .map((issue) => [normalizeUsageModelKey(issue.key), issue.issue] as const),
  );
  const seen = new Set<string>();
  for (const { row } of kept) {
    const key = normalizeUsageModelKey(row.model);
    const issue = seen.has(key) ? "duplicate" : issueByKey.get(key);
    seen.add(key);
    if (issue !== undefined) errors.set(row.id, ISSUE_MESSAGES[issue]);
  }

  const entryCount = rows.filter((row) => !row.removed && !isBlankNewRow(row)).length;
  const limitError =
    entryCount > USAGE_PRICE_OVERRIDE_LIMIT
      ? `A node keeps at most ${USAGE_PRICE_OVERRIDE_LIMIT} models. Remove some to save.`
      : null;
  const blocked =
    limitError !== null || rows.some((row) => row.edited && !row.removed && errors.has(row.id));
  return { rows, patch: blocked ? {} : patch, errors, limitError, blocked };
}

export function savedRowId(model: string): string {
  return `saved:${model}`;
}

/** Whether a row for `model` is shown already (in any case). */
export function listsUsagePriceModel(rows: readonly UsagePriceRow[], model: string): boolean {
  const key = normalizeUsageModelKey(model);
  return rows.some((row) => !row.removed && normalizeUsageModelKey(row.model) === key);
}

/** `drafts` with `draft` replacing the one for the same row, or added. */
export function upsertUsagePriceDraft(
  drafts: readonly UsagePriceDraft[],
  draft: UsagePriceDraft,
): readonly UsagePriceDraft[] {
  const index = drafts.findIndex((entry) => entry.id === draft.id);
  return index === -1 ? [...drafts, draft] : drafts.with(index, draft);
}
