import {
  mcpFormPendingSecretKeys,
  parseMcpSecretField,
  setMcpFormSecretCleared,
  setMcpFormSecretValue,
  type McpSecretKind,
  type McpServerFormState,
} from "@ryco/client-runtime/state/settings/mcpServers";

import type { AgentsMenuAction } from "./agentsModel";

/**
 * The MCP server editor's write-only secrets: environment values and static headers. The node
 * returns only which keys hold a value, never the value, so a row says "Set", "New value" or
 * "Clears on save", and its menu replaces, clears or keeps it. Nothing is ever prefilled.
 */

export const SECRET_KIND_LABEL: Readonly<Record<McpSecretKind, string>> = {
  env: "Environment value",
  header: "HTTP header",
};

export interface McpSecretRowView {
  readonly id: string;
  readonly kind: McpSecretKind;
  readonly key: string;
  readonly kindLabel: string;
  readonly value: "Set" | "New value" | "Clears on save";
  readonly actions: ReadonlyArray<AgentsMenuAction>;
}

export const SECRET_ACTION = {
  replace: "replace",
  clear: "clear",
  keep: "keep",
  drop: "drop",
} as const;

export function mcpSecretRows(form: McpServerFormState): ReadonlyArray<McpSecretRowView> {
  const pending = new Set<string>();
  for (const kind of ["env", "header"] as const) {
    for (const key of mcpFormPendingSecretKeys(form, kind)) pending.add(`${kind}.${key}`);
  }
  const stored = form.secretFields.flatMap((field) => {
    const parsed = parseMcpSecretField(field);
    if (!parsed) return [];
    const cleared = form.clearedSecretFields.includes(field);
    const replaced = pending.has(field);
    const value: McpSecretRowView["value"] = replaced
      ? "New value"
      : cleared
        ? "Clears on save"
        : "Set";
    return [
      {
        id: field,
        kind: parsed.kind,
        key: parsed.key,
        kindLabel: SECRET_KIND_LABEL[parsed.kind],
        value,
        actions: [
          { id: SECRET_ACTION.replace, title: "Replace…" },
          replaced
            ? { id: SECRET_ACTION.keep, title: "Keep the stored value" }
            : cleared
              ? { id: SECRET_ACTION.keep, title: "Keep" }
              : { id: SECRET_ACTION.clear, title: "Clear on save", destructive: true },
        ],
      } satisfies McpSecretRowView,
    ];
  });
  const storedFields = new Set(form.secretFields);
  const added = [...pending]
    .filter((field) => !storedFields.has(field))
    .flatMap((field) => {
      const parsed = parseMcpSecretField(field);
      if (!parsed) return [];
      return [
        {
          id: field,
          kind: parsed.kind,
          key: parsed.key,
          kindLabel: SECRET_KIND_LABEL[parsed.kind],
          value: "New value" as const,
          actions: [
            { id: SECRET_ACTION.replace, title: "Replace…" },
            { id: SECRET_ACTION.drop, title: "Remove", destructive: true },
          ],
        } satisfies McpSecretRowView,
      ];
    });
  return [...stored, ...added];
}

/** Applies a secret row's menu action other than Replace (which first asks for the value). */
export function applyMcpSecretAction(
  form: McpServerFormState,
  row: McpSecretRowView,
  actionId: string,
): McpServerFormState {
  switch (actionId) {
    case SECRET_ACTION.clear:
      return setMcpFormSecretCleared(
        setMcpFormSecretValue(form, row.kind, row.key, null),
        row.id,
        true,
      );
    case SECRET_ACTION.keep:
      return setMcpFormSecretCleared(
        setMcpFormSecretValue(form, row.kind, row.key, null),
        row.id,
        false,
      );
    case SECRET_ACTION.drop:
      return setMcpFormSecretValue(form, row.kind, row.key, null);
    default:
      return form;
  }
}

/** Why a typed key or value cannot be taken, or null when it can. */
export function mcpSecretEntryProblem(key: string, value: string): string | null {
  if (key.trim().length === 0) return "Give it a name.";
  if (/[=\r\n]/.test(key)) return "A name cannot contain = or a line break.";
  if (value.length === 0) return "Enter a value.";
  if (/[\r\n]/.test(value)) return "A value cannot contain a line break.";
  return null;
}

/** The answer of an iOS login-password prompt, which arrives as `{ login, password }`. */
export function readLoginPassword(
  value: unknown,
): { readonly login: string; readonly password: string } | null {
  if (typeof value !== "object" || value === null) return null;
  const { login, password } = value as { login?: unknown; password?: unknown };
  return typeof login === "string" && typeof password === "string" ? { login, password } : null;
}
