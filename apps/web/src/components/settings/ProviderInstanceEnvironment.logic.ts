import {
  ProviderInstanceEnvironmentVariableName,
  type ProviderInstanceEnvironmentVariable,
} from "@ryco/contracts";
import { Schema } from "effect";

const isEnvironmentVariableName = Schema.is(ProviderInstanceEnvironmentVariableName);
// Only for the error message; `ProviderInstanceEnvironmentVariableName` decides what is valid.
const ENVIRONMENT_VARIABLE_NAME_MAX_CHARS = 128;
// One `KEY=value` or `export KEY=value` line, as copied from a shell profile or `.env` file.
const ENVIRONMENT_ASSIGNMENT_PATTERN = /^(?:export\s+)?([^\s=]+)\s*=\s*(.*)$/;
const QUOTED_VALUE_PATTERN = /^(["'])(.*)\1$/;

export interface EnvironmentDraftRow {
  readonly id: string;
  readonly name: string;
  readonly value: string;
  readonly sensitive: boolean;
  /** The server holds this row's value as a stored secret; `value` stays empty until replaced. */
  readonly valueRedacted: boolean;
  /**
   * The version of this row the server holds or was last sent. A row whose draft cannot be
   * published keeps publishing this version, so an incomplete edit never deletes a variable.
   */
  readonly saved: ProviderInstanceEnvironmentVariable | undefined;
}

/** Errors always concern the name; a pending change waits for a new value. */
export interface EnvironmentDraftIssue {
  readonly kind: "error" | "pending";
  readonly message: string;
}

export interface EnvironmentDraftResolution {
  readonly environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>;
  /** The drafts with `saved` advanced to what each row now publishes. */
  readonly rows: ReadonlyArray<EnvironmentDraftRow>;
  readonly issues: ReadonlyMap<string, EnvironmentDraftIssue>;
}

const DUPLICATE_NAME_ISSUE: EnvironmentDraftIssue = {
  kind: "error",
  message: "Another variable already uses this name.",
};

let environmentDraftRowCount = 0;
const nextEnvironmentDraftRowId = () => `provider-env-${environmentDraftRowCount++}`;

export function environmentDraftRowFromVariable(
  variable: ProviderInstanceEnvironmentVariable,
  id = nextEnvironmentDraftRowId(),
): EnvironmentDraftRow {
  return {
    id,
    name: variable.name,
    value: variable.value,
    sensitive: variable.sensitive,
    valueRedacted: variable.valueRedacted === true,
    saved: variable,
  };
}

export function blankEnvironmentDraftRow(): EnvironmentDraftRow {
  return {
    id: nextEnvironmentDraftRowId(),
    name: "",
    value: "",
    sensitive: true,
    valueRedacted: false,
    saved: undefined,
  };
}

/** Whether the server keeps a secret for this variable. */
function holdsStoredSecret(variable: ProviderInstanceEnvironmentVariable): boolean {
  return variable.sensitive && (variable.valueRedacted === true || variable.value.length > 0);
}

/** Clearing the value of a stored secret keeps the stored value rather than saving an empty one. */
export function withEnvironmentDraftValue(
  row: EnvironmentDraftRow,
  value: string,
): EnvironmentDraftRow {
  return value.length === 0 && row.saved !== undefined && holdsStoredSecret(row.saved)
    ? { ...row, value: "", valueRedacted: true }
    : { ...row, value, valueRedacted: false };
}

export function revertEnvironmentDraftRow(row: EnvironmentDraftRow): EnvironmentDraftRow {
  return row.saved === undefined ? row : environmentDraftRowFromVariable(row.saved, row.id);
}

/**
 * Splits a pasted assignment. Anything else pastes verbatim, including a left side that is not
 * a valid name and an empty value or one starting with `=`, as in a padded base64 token.
 */
export function parseEnvironmentAssignment(
  text: string,
): { readonly name: string; readonly value: string } | null {
  const line = text.trim();
  if (/[\r\n]/.test(line)) return null;
  const [, name, value] = ENVIRONMENT_ASSIGNMENT_PATTERN.exec(line) ?? [];
  if (!name || !value || value.startsWith("=") || !isEnvironmentVariableName(name)) return null;
  return { name, value: QUOTED_VALUE_PATTERN.exec(value)?.[2] ?? value };
}

function isBlankEnvironmentDraft(row: EnvironmentDraftRow): boolean {
  return row.saved === undefined && row.name.trim().length === 0 && row.value.length === 0;
}

function environmentDraftVariable(row: EnvironmentDraftRow): ProviderInstanceEnvironmentVariable {
  return {
    name: row.name.trim(),
    value: row.value,
    sensitive: row.sensitive,
    ...(row.valueRedacted ? { valueRedacted: true } : {}),
  };
}

function describeInvalidName(name: string): string {
  if (name.length === 0) return "Enter a name for this variable.";
  if (name.length > ENVIRONMENT_VARIABLE_NAME_MAX_CHARS) {
    return `Names may be at most ${ENVIRONMENT_VARIABLE_NAME_MAX_CHARS} characters.`;
  }
  return "Names may only use letters, digits, and underscores, and cannot start with a digit.";
}

function describeEnvironmentDraftIssue(row: EnvironmentDraftRow): EnvironmentDraftIssue | null {
  const name = row.name.trim();
  if (!isEnvironmentVariableName(name)) {
    return { kind: "error", message: describeInvalidName(name) };
  }
  // The stored value lives under the saved name and only as a secret, so publishing a rename or
  // a plain-text copy without a new value would delete it.
  if (row.valueRedacted && row.saved !== undefined) {
    if (name !== row.saved.name) {
      return { kind: "pending", message: "Enter the value again to rename this stored secret." };
    }
    if (!row.sensitive) {
      return { kind: "pending", message: "Enter a new value to store it as plain text." };
    }
  }
  return null;
}

/**
 * A row that republishes its saved name keeps it; renamed and new rows yield and fall back to
 * their saved version. Repeats because a fallback can collide with a later claimant.
 */
function withholdDuplicateNames(
  rows: ReadonlyArray<EnvironmentDraftRow>,
  published: Map<string, ProviderInstanceEnvironmentVariable | undefined>,
  issues: Map<string, EnvironmentDraftIssue>,
): void {
  const keepsSavedName = (row: EnvironmentDraftRow) =>
    published.get(row.id)?.name === row.saved?.name;
  let withheld = true;
  while (withheld) {
    withheld = false;
    const claimed = new Set<string>();
    const yielding = rows.filter((row) => !keepsSavedName(row));
    for (const row of [...rows.filter(keepsSavedName), ...yielding]) {
      const variable = published.get(row.id);
      if (variable === undefined) continue;
      if (!claimed.has(variable.name)) {
        claimed.add(variable.name);
        continue;
      }
      if (keepsSavedName(row)) continue;
      issues.set(row.id, DUPLICATE_NAME_ISSUE);
      published.set(row.id, row.saved);
      withheld = true;
    }
  }
}

/**
 * Publishes every complete row. A row with an issue publishes its saved version instead (or
 * nothing when it was never saved), so it never blocks or deletes the others.
 */
export function resolveEnvironmentDrafts(
  rows: ReadonlyArray<EnvironmentDraftRow>,
): EnvironmentDraftResolution {
  const published = new Map<string, ProviderInstanceEnvironmentVariable | undefined>();
  const issues = new Map<string, EnvironmentDraftIssue>();
  for (const row of rows) {
    if (isBlankEnvironmentDraft(row)) continue;
    const issue = describeEnvironmentDraftIssue(row);
    if (issue === null) {
      published.set(row.id, environmentDraftVariable(row));
    } else {
      issues.set(row.id, issue);
      published.set(row.id, row.saved);
    }
  }
  withholdDuplicateNames(rows, published, issues);
  return {
    environment: rows.flatMap((row) => published.get(row.id) ?? []),
    rows: rows.map((row) => {
      const saved = published.get(row.id);
      // A published row shows its trimmed name; a row with an issue keeps what was typed.
      return saved === undefined || issues.has(row.id)
        ? { ...row, saved }
        : { ...row, name: saved.name, saved };
    }),
    issues,
  };
}

function sameEnvironmentVariable(
  left: ProviderInstanceEnvironmentVariable,
  right: ProviderInstanceEnvironmentVariable,
): boolean {
  return (
    left.name === right.name &&
    left.value === right.value &&
    left.sensitive === right.sensitive &&
    (left.valueRedacted ?? false) === (right.valueRedacted ?? false)
  );
}

export function sameEnvironment(
  left: ReadonlyArray<ProviderInstanceEnvironmentVariable>,
  right: ReadonlyArray<ProviderInstanceEnvironmentVariable>,
): boolean {
  return (
    left.length === right.length &&
    left.every((variable, index) => sameEnvironmentVariable(variable, right[index]!))
  );
}

/**
 * Rebuilds the drafts from a changed server environment. Rows without local edits take the
 * server version; unpublished and edited rows survive unless they depend on a stored secret the
 * server no longer holds. Row ids stay stable so inputs keep focus.
 */
export function reconcileEnvironmentDraftRows(
  rows: ReadonlyArray<EnvironmentDraftRow>,
  environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>,
): ReadonlyArray<EnvironmentDraftRow> {
  const unmatched = [...environment];
  const next: EnvironmentDraftRow[] = [];
  for (const row of rows) {
    const { saved } = row;
    if (saved === undefined) {
      next.push(row);
      continue;
    }
    const index = unmatched.findIndex((variable) => variable.name === saved.name);
    const edited = !sameEnvironmentVariable(environmentDraftVariable(row), saved);
    if (index === -1) {
      // The server removed the variable or rejected the write that added it. The server only
      // returns secrets redacted, so a visible secret was typed here and exists nowhere else.
      if (!row.valueRedacted && (edited || (saved.sensitive && saved.value.length > 0))) {
        next.push({ ...row, saved: undefined });
      }
      continue;
    }
    const variable = unmatched.splice(index, 1)[0]!;
    next.push(
      edited && !(row.valueRedacted && !holdsStoredSecret(variable))
        ? { ...row, saved: variable }
        : environmentDraftRowFromVariable(variable, row.id),
    );
  }
  for (const variable of unmatched) {
    next.push(environmentDraftRowFromVariable(variable));
  }
  return next;
}
