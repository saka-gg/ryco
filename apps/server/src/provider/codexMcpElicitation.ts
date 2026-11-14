import type { ProviderUserInputAnswers, RuntimeMode, UserInputQuestion } from "@ryco/contracts";
import * as Schema from "effect/Schema";
import { isHttpLink } from "@ryco/shared/userInputExchange";
import * as EffectCodexSchema from "effect-codex-app-server/schema";
import { asRecord } from "@ryco/shared/unknownValue";

/**
 * Codex `mcpServer/elicitation/request` → one Ryco pending question, and the user's answer → the
 * MCP elicitation response. Every mode (approval-style form, form with fields, URL) rides the
 * existing question flow, so every client that answers questions today answers these too. The
 * client only sends option labels or typed text; this module keeps the request and builds the
 * response. Design: docs/superpowers/specs/2026-11-06-codex-mcp-elicitation.md.
 *
 * Pure module: no Effect services, no I/O.
 */

export type CodexElicitationParams = EffectCodexSchema.McpServerElicitationRequestParams;
export type CodexElicitationResponse = EffectCodexSchema.McpServerElicitationRequestResponse;

/** How long a question waits for an answer before Ryco answers `cancel`. */
export const CODEX_ELICITATION_TIMEOUT_MS = 15 * 60 * 1000;

export const ELICITATION_APPROVAL_QUESTION_ID = "decision";
const FIELD_QUESTION_PREFIX = "field:";

export const ELICITATION_LABELS = {
  allowOnce: "Allow once",
  allowForChat: "Allow for this chat",
  alwaysAllow: "Always allow",
  deny: "Deny",
  continue: "Continue",
  decline: "Decline",
  skip: "Skip",
  yes: "Yes",
  no: "No",
} as const;

const COMPUTER_USE_CONNECTOR_ID = "computer-use";
const COMPUTER_USE_TITLE = "Codex Computer Use";
const MAX_DISPLAY_PARAMS = 3;
const MAX_DISPLAY_VALUE_CHARS = 80;
const MAX_FIELDS = 20;
const MAX_OPTIONS = 50;

type ElicitationField =
  | {
      readonly kind: "string";
      readonly key: string;
      readonly required: boolean;
      readonly minLength?: number;
      readonly maxLength?: number;
    }
  | {
      readonly kind: "number";
      readonly key: string;
      readonly required: boolean;
      readonly integer: boolean;
      readonly minimum?: number;
      readonly maximum?: number;
    }
  | { readonly kind: "boolean"; readonly key: string; readonly required: boolean }
  | {
      readonly kind: "enum";
      readonly key: string;
      readonly required: boolean;
      readonly multiple: boolean;
      /** label → value, in display order. */
      readonly options: ReadonlyArray<{ readonly label: string; readonly value: string }>;
      readonly minItems?: number;
      readonly maxItems?: number;
    };

export type CodexElicitationPlan =
  | {
      readonly kind: "approval";
      readonly questions: ReadonlyArray<UserInputQuestion>;
      readonly offersSession: boolean;
      readonly offersAlways: boolean;
      /** How full access answers it without asking (see `autoAcceptInRuntimeMode`). */
      readonly fullAccess: "ask" | "accept-once" | "accept-for-chat";
    }
  | {
      readonly kind: "form";
      readonly questions: ReadonlyArray<UserInputQuestion>;
      readonly fields: ReadonlyArray<ElicitationField>;
    }
  | { readonly kind: "url"; readonly questions: ReadonlyArray<UserInputQuestion> }
  | { readonly kind: "unsupported"; readonly reason: string };

export type CodexElicitationAnswer =
  | { readonly ok: true; readonly response: CodexElicitationResponse }
  | { readonly ok: false; readonly questionId: string; readonly reason: string };

function readText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed === "" ? undefined : trimmed;
}

function readCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** The name the question card shows above the prompt. */
export function elicitationTitle(params: CodexElicitationParams): string {
  const meta = asRecord(params._meta);
  if (meta?.connector_id === COMPUTER_USE_CONNECTOR_ID) return COMPUTER_USE_TITLE;
  return readText(meta?.connector_name) ?? readText(params.serverName) ?? "MCP server";
}

function persistOffers(meta: Record<string, unknown> | undefined, mode: "session" | "always") {
  const persist = meta?.persist;
  if (typeof persist === "string") return persist === mode;
  return Array.isArray(persist) && persist.includes(mode);
}

/** Up to three `name: value` lines the message does not already say. */
function displayParamLines(meta: Record<string, unknown> | undefined, message: string): string[] {
  const display = Array.isArray(meta?.tool_params_display) ? meta.tool_params_display : [];
  const lines: string[] = [];
  for (const raw of display) {
    if (lines.length >= MAX_DISPLAY_PARAMS) break;
    const entry = asRecord(raw);
    const name = readText(entry?.display_name) ?? readText(entry?.name);
    if (!name || entry?.value === undefined) continue;
    const value =
      typeof entry.value === "string" ? readText(entry.value) : JSON.stringify(entry.value);
    if (!value || message.includes(value)) continue;
    lines.push(`${name}: ${truncate(value, MAX_DISPLAY_VALUE_CHARS)}`);
  }
  return lines;
}

function joinPrompt(parts: ReadonlyArray<string | undefined>): string {
  return parts.filter((part): part is string => part !== undefined && part !== "").join(" ");
}

function option(label: string, description: string) {
  return { label, description };
}

function isMessageOnlySchema(schema: unknown): boolean {
  if (schema === null || schema === undefined) return true;
  const record = asRecord(schema);
  const properties = asRecord(record?.properties);
  return (
    record?.type === "object" && properties !== undefined && Object.keys(properties).length === 0
  );
}

const isTypedElicitationSchema = Schema.is(
  EffectCodexSchema.McpServerElicitationRequestParams__McpElicitationSchema,
);

function readEnumOptions(
  property: Record<string, unknown>,
): Array<{ label: string; value: string }> | undefined {
  const fromConst = (entries: unknown) =>
    Array.isArray(entries)
      ? entries.flatMap((entry) => {
          const record = asRecord(entry);
          return typeof record?.const === "string"
            ? [{ value: record.const, label: readText(record.title) ?? record.const }]
            : [];
        })
      : [];
  const fromEnum = (values: unknown, names?: unknown) =>
    Array.isArray(values)
      ? values.flatMap((value, index) =>
          typeof value === "string"
            ? [
                {
                  value,
                  label: (Array.isArray(names) ? readText(names[index]) : undefined) ?? value,
                },
              ]
            : [],
        )
      : [];
  if (property.type === "array") {
    const items = asRecord(property.items);
    if (!items) return undefined;
    return items.anyOf !== undefined ? fromConst(items.anyOf) : fromEnum(items.enum);
  }
  if (property.oneOf !== undefined) return fromConst(property.oneOf);
  if (property.enum !== undefined) return fromEnum(property.enum, property.enumNames);
  return undefined;
}

function readField(
  key: string,
  property: Record<string, unknown>,
  required: boolean,
): ElicitationField | undefined {
  const enumOptions = readEnumOptions(property);
  if (enumOptions !== undefined) {
    // Labels are what the client sends back, so they must be unique and not reserved.
    const labels = new Set<string>();
    const options = enumOptions.map((entry) => {
      let label = entry.label;
      if (labels.has(label) || isReservedLabel(label)) label = `${label} (${entry.value})`;
      labels.add(label);
      return { label, value: entry.value };
    });
    if (options.length === 0 || options.length > MAX_OPTIONS || labels.size !== options.length) {
      return undefined;
    }
    const minItems = readCount(property.minItems);
    const maxItems = readCount(property.maxItems);
    return {
      kind: "enum",
      key,
      required,
      multiple: property.type === "array",
      options,
      ...(minItems !== undefined ? { minItems } : {}),
      ...(maxItems !== undefined ? { maxItems } : {}),
    };
  }
  switch (property.type) {
    case "string": {
      const minLength = readCount(property.minLength);
      const maxLength = readCount(property.maxLength);
      return {
        kind: "string",
        key,
        required,
        ...(minLength !== undefined ? { minLength } : {}),
        ...(maxLength !== undefined ? { maxLength } : {}),
      };
    }
    case "number":
    case "integer": {
      const minimum = readCount(property.minimum);
      const maximum = readCount(property.maximum);
      return {
        kind: "number",
        key,
        required,
        integer: property.type === "integer",
        ...(minimum !== undefined ? { minimum } : {}),
        ...(maximum !== undefined ? { maximum } : {}),
      };
    }
    case "boolean":
      return { kind: "boolean", key, required };
    default:
      return undefined;
  }
}

function isReservedLabel(label: string): boolean {
  return (
    label === ELICITATION_LABELS.decline ||
    label === ELICITATION_LABELS.skip ||
    label === ELICITATION_LABELS.yes ||
    label === ELICITATION_LABELS.no
  );
}

function fieldQuestion(
  field: ElicitationField,
  property: Record<string, unknown>,
  header: string,
  message: string,
  isFirst: boolean,
): UserInputQuestion {
  const label = readText(property.title) ?? field.key;
  const description = readText(property.description);
  const prompt = joinPrompt([
    isFirst ? message : undefined,
    `${label}${field.required ? "" : " (optional)"}:`,
    description,
  ]);
  const options =
    field.kind === "enum"
      ? field.options.map((entry) => option(entry.label, entry.label))
      : field.kind === "boolean"
        ? [
            option(ELICITATION_LABELS.yes, ELICITATION_LABELS.yes),
            option(ELICITATION_LABELS.no, ELICITATION_LABELS.no),
          ]
        : [];
  return {
    id: `${FIELD_QUESTION_PREFIX}${field.key}`,
    header,
    question: prompt,
    options: [
      ...options,
      ...(field.required ? [] : [option(ELICITATION_LABELS.skip, "Leave it empty")]),
      option(ELICITATION_LABELS.decline, "Share nothing"),
    ],
    multiSelect: field.kind === "enum" && field.multiple,
  };
}

function planForm(
  schema: Record<string, unknown>,
  header: string,
  message: string,
): CodexElicitationPlan {
  const properties = asRecord(schema.properties) ?? {};
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((key): key is string => typeof key === "string")
      : [],
  );
  const entries = Object.entries(properties);
  if (entries.length > MAX_FIELDS) {
    return { kind: "unsupported", reason: `form has ${entries.length} fields` };
  }
  const fields: ElicitationField[] = [];
  const questions: UserInputQuestion[] = [];
  for (const [key, raw] of entries) {
    const property = asRecord(raw);
    const field =
      property && key.trim() !== "" ? readField(key, property, required.has(key)) : undefined;
    if (!field || !property) {
      return { kind: "unsupported", reason: `field '${key}' has no supported type` };
    }
    fields.push(field);
    questions.push(fieldQuestion(field, property, header, message, questions.length === 0));
  }
  return { kind: "form", questions, fields };
}

/** Builds the question for a Codex elicitation, or says why Ryco cannot show it. */
export function planCodexElicitation(params: CodexElicitationParams): CodexElicitationPlan {
  const header = elicitationTitle(params);
  const meta = asRecord(params._meta);
  const message = readText(params.message) ?? "The MCP server asks for your input.";

  if (params.mode === "url") {
    const url = readText(params.url);
    if (!url) return { kind: "unsupported", reason: "URL request without a URL" };
    // Only a link a browser opens safely is offered; anything else is answered `cancel`.
    if (!isHttpLink(url))
      return { kind: "unsupported", reason: "URL request without an http(s) link" };
    return {
      kind: "url",
      questions: [
        {
          id: ELICITATION_APPROVAL_QUESTION_ID,
          header,
          question: joinPrompt([message, `Link: ${url}`]),
          options: [
            option(ELICITATION_LABELS.continue, "I opened the link"),
            option(ELICITATION_LABELS.deny, "Don't open it"),
          ],
          multiSelect: false,
          link: url,
        },
      ],
    };
  }

  const schema = params.requestedSchema;
  if (isMessageOnlySchema(schema)) {
    const offersSession = persistOffers(meta, "session");
    const offersAlways = persistOffers(meta, "always");
    const subtitle = readText(meta?.subtitle);
    const computerUse = meta?.connector_id === COMPUTER_USE_CONNECTOR_ID;
    const toolCall =
      meta?.codex_approval_kind === "mcp_tool_call" && meta.codex_requires_user_input !== true;
    // Computer Use asks again on its next action after a one-time allow, so it offers only the
    // remembered choices, like Ryco's own Computer Use (unless it offers none).
    const offersOnce = !computerUse || (!offersSession && !offersAlways);
    return {
      kind: "approval",
      offersSession,
      offersAlways,
      fullAccess: !toolCall
        ? "ask"
        : computerUse
          ? // An app approval, like Ryco's own Computer Use skips in full access; anything else
            // it asks for (recording computer audio) always asks.
            isComputerUseAppApproval(meta)
            ? "accept-for-chat"
            : "ask"
          : "accept-once",
      questions: [
        {
          id: ELICITATION_APPROVAL_QUESTION_ID,
          header,
          question: joinPrompt([message, subtitle, ...displayParamLines(meta, message)]),
          options: [
            ...(offersOnce ? [option(ELICITATION_LABELS.allowOnce, "Ask again next time")] : []),
            ...(offersSession
              ? [option(ELICITATION_LABELS.allowForChat, "Don't ask again in this chat")]
              : []),
            ...(offersAlways ? [option(ELICITATION_LABELS.alwaysAllow, "Don't ask again")] : []),
            option(ELICITATION_LABELS.deny, "Don't allow it"),
          ],
          multiSelect: false,
        },
      ],
    };
  }

  // `openai/form` carries an untyped schema; only a typed object schema can become questions.
  if (params.mode === "openai/form" && !isTypedElicitationSchema(schema)) {
    return { kind: "unsupported", reason: "openai/form schema is not a typed object schema" };
  }
  const record = asRecord(schema);
  if (!record) return { kind: "unsupported", reason: "form without a schema" };
  return planForm(record, header, message);
}

function isComputerUseAppApproval(meta: Record<string, unknown> | undefined): boolean {
  return readText(asRecord(meta?.tool_params)?.app) !== undefined;
}

/**
 * Full access answers approval-style tool-call elicitations itself, like Codex's own
 * `approvalPolicy: "never"` and Ryco's own Computer Use: Computer Use app approvals for this
 * chat (never a lasting "always" grant), other tool calls once. Anything that asks for data or
 * a link always asks.
 */
export function autoAcceptInRuntimeMode(
  plan: CodexElicitationPlan,
  runtimeMode: RuntimeMode,
): CodexElicitationResponse | undefined {
  if (runtimeMode !== "full-access" || plan.kind !== "approval") return undefined;
  switch (plan.fullAccess) {
    case "ask":
      return undefined;
    case "accept-once":
      return { action: "accept" };
    case "accept-for-chat":
      return plan.offersSession
        ? { action: "accept", _meta: { persist: "session" } }
        : { action: "accept" };
  }
}

export const CODEX_ELICITATION_CANCEL: CodexElicitationResponse = { action: "cancel" };

function answerValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value))
    return value.filter((entry): entry is string => typeof entry === "string");
  return [];
}

function answerText(value: unknown): string | undefined {
  const [first] = answerValues(value);
  return first === undefined ? undefined : first.trim();
}

function fail(questionId: string, reason: string): CodexElicitationAnswer {
  return { ok: false, questionId, reason };
}

function answerApproval(
  plan: Extract<CodexElicitationPlan, { kind: "approval" | "url" }>,
  answers: ProviderUserInputAnswers,
): CodexElicitationAnswer {
  const choice = answerText(answers[ELICITATION_APPROVAL_QUESTION_ID]);
  if (plan.kind === "url") {
    return {
      ok: true,
      response: { action: choice === ELICITATION_LABELS.continue ? "accept" : "decline" },
    };
  }
  switch (choice) {
    case ELICITATION_LABELS.allowOnce:
      return { ok: true, response: { action: "accept" } };
    case ELICITATION_LABELS.allowForChat:
      return plan.offersSession
        ? { ok: true, response: { action: "accept", _meta: { persist: "session" } } }
        : { ok: true, response: { action: "accept" } };
    case ELICITATION_LABELS.alwaysAllow:
      return plan.offersAlways
        ? { ok: true, response: { action: "accept", _meta: { persist: "always" } } }
        : { ok: true, response: { action: "accept" } };
    default:
      // Deny, typed text, or nothing: never allow by accident.
      return { ok: true, response: { action: "decline" } };
  }
}

function answerField(
  field: ElicitationField,
  questionId: string,
  raw: unknown,
): { readonly skip: true } | { readonly value: unknown } | CodexElicitationAnswer {
  const values = answerValues(raw).map((entry) => entry.trim());
  if (values.length === 0 || (values.length === 1 && values[0] === "")) {
    return field.required ? fail(questionId, "an answer is required") : { skip: true };
  }
  if (!field.required && values.length === 1 && values[0] === ELICITATION_LABELS.skip) {
    return { skip: true };
  }
  const text = values[0]!;
  switch (field.kind) {
    case "string": {
      if (field.minLength !== undefined && text.length < field.minLength) {
        return fail(questionId, `use at least ${field.minLength} characters`);
      }
      if (field.maxLength !== undefined && text.length > field.maxLength) {
        return fail(questionId, `use at most ${field.maxLength} characters`);
      }
      return { value: text };
    }
    case "number": {
      const number = Number(text);
      if (text === "" || !Number.isFinite(number)) return fail(questionId, "enter a number");
      if (field.integer && !Number.isInteger(number))
        return fail(questionId, "enter a whole number");
      if (field.minimum !== undefined && number < field.minimum) {
        return fail(questionId, `enter ${field.minimum} or more`);
      }
      if (field.maximum !== undefined && number > field.maximum) {
        return fail(questionId, `enter ${field.maximum} or less`);
      }
      return { value: number };
    }
    case "boolean": {
      const lower = text.toLowerCase();
      if (text === ELICITATION_LABELS.yes || lower === "true" || lower === "yes")
        return { value: true };
      if (text === ELICITATION_LABELS.no || lower === "false" || lower === "no")
        return { value: false };
      return fail(questionId, "choose Yes or No");
    }
    case "enum": {
      const picked: string[] = [];
      for (const entry of field.multiple ? values : [text]) {
        const match =
          field.options.find((candidate) => candidate.label === entry) ??
          field.options.find((candidate) => candidate.value === entry);
        if (!match) return fail(questionId, `'${entry}' is not one of the choices`);
        if (!picked.includes(match.value)) picked.push(match.value);
      }
      if (!field.multiple) return { value: picked[0] };
      if (field.minItems !== undefined && picked.length < field.minItems) {
        return fail(questionId, `choose at least ${field.minItems}`);
      }
      if (field.maxItems !== undefined && picked.length > field.maxItems) {
        return fail(questionId, `choose at most ${field.maxItems}`);
      }
      return { value: picked };
    }
  }
}

/** The MCP response for the user's answers, or the question whose answer is not valid. */
export function answerCodexElicitation(
  plan: Exclude<CodexElicitationPlan, { kind: "unsupported" }>,
  answers: ProviderUserInputAnswers,
): CodexElicitationAnswer {
  if (plan.kind !== "form") return answerApproval(plan, answers);
  const declined = plan.questions.some((question) =>
    answerValues(answers[question.id]).some((value) => value.trim() === ELICITATION_LABELS.decline),
  );
  if (declined) return { ok: true, response: { action: "decline" } };
  const content: Record<string, unknown> = {};
  for (const field of plan.fields) {
    const questionId = `${FIELD_QUESTION_PREFIX}${field.key}`;
    const result = answerField(field, questionId, answers[questionId]);
    if ("ok" in result) return result;
    if ("value" in result) content[field.key] = result.value;
  }
  return { ok: true, response: { action: "accept", content } };
}
