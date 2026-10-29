/**
 * Pure mappings between OpenCode 2.x API objects and the 1.x SDK shapes Ryco's adapter, provider
 * probe and text generation are written against (`OpenCodeApi`, `openCodeApi.ts`). The 2.x facade
 * (`openCodeV2Client.ts`) applies them to requests and responses, `openCodeV2Events.ts` to the
 * event stream.
 *
 * Nothing here copies a model's or provider's `settings`, `headers` or `body`: 2.x model lists
 * carry provider credentials there (`apiKey`). Adapted from Synara (`openCodeV2Mapping.ts`). Types
 * only from both SDKs, and loaded with the facade through `import()`, so none of it is in the boot
 * chunk.
 */
import type {
  AgentInfo,
  ConfigEntry,
  FormField,
  FormField1,
  FormInfo,
  FormInfo1,
  FormReplied,
  McpAddInput,
  ModelInfo,
  ModelRef,
  PermissionAsked,
  PermissionRequest as V2PermissionRequest,
  PermissionRuleset as V2PermissionRuleset,
  ProviderInfo,
  SessionCreated,
  SessionFormReplyInput,
  SessionInfo,
  SessionPromptInput,
} from "@opencode/client";
import type {
  Agent,
  AgentPartInput,
  FilePartInput,
  McpLocalConfig,
  McpRemoteConfig,
  PermissionRequest,
  PermissionRuleset,
  ProviderListResponse,
  QuestionAnswer,
  QuestionInfo,
  QuestionRequest,
  Session,
  SubtaskPartInput,
  TextPartInput,
} from "@opencode-ai/sdk/v2";

/** 1.x permission and tool names 2.x renamed; `write` and `patch` fold into `edit`. */
const V2_NAMES = new Map([
  ["bash", "shell"],
  ["task", "subagent"],
  ["write", "edit"],
  ["patch", "edit"],
]);
const V1_NAMES = new Map([
  ["shell", "bash"],
  ["subagent", "task"],
]);

/** The 1.x name for a 2.x tool or permission action (`shell` is `bash`, `subagent` is `task`). */
export const openCodeV1Name = (name: string): string => V1_NAMES.get(name) ?? name;

/**
 * 2.x rules for a 1.x ruleset. Both generations let the last matching rule win, so the order is
 * kept: Ryco's restricted rulesets lead with `* * ask` and narrow it afterwards.
 */
export function openCodeV2Rules(rules: PermissionRuleset): V2PermissionRuleset {
  return rules.map(({ permission, pattern, action }) => ({
    action: V2_NAMES.get(permission) ?? permission,
    resource: pattern,
    effect: action,
  }));
}

export function openCodeV1Rules(rules: V2PermissionRuleset): PermissionRuleset {
  return rules.map(({ action, resource, effect }) => ({
    permission: openCodeV1Name(action),
    pattern: resource,
    action: effect,
  }));
}

interface SessionFields {
  readonly id: string;
  readonly slug: string;
  readonly version: string;
  readonly created: number;
  readonly updated: number;
  readonly source: Pick<
    SessionInfo,
    "projectID" | "location" | "parentID" | "title" | "agent" | "model" | "metadata" | "permissions"
  >;
}

function session({ id, slug, version, created, updated, source }: SessionFields): Session {
  return {
    id,
    slug,
    version,
    projectID: source.projectID,
    directory: source.location.directory,
    title: source.title ?? "",
    time: { created, updated },
    ...(source.parentID !== undefined ? { parentID: source.parentID } : {}),
    ...(source.agent !== undefined ? { agent: source.agent } : {}),
    ...(source.model !== undefined
      ? {
          model: {
            id: source.model.id,
            providerID: source.model.providerID,
            ...(source.model.variant !== undefined ? { variant: source.model.variant } : {}),
          },
        }
      : {}),
    ...(source.metadata !== undefined ? { metadata: source.metadata } : {}),
    ...(source.permissions !== undefined
      ? { permission: openCodeV1Rules(source.permissions) }
      : {}),
  };
}

/** A 2.x session as the 1.x `Session` (2.x sessions have no slug; the ID stands in). */
export const openCodeV2Session = (info: SessionInfo): Session =>
  session({
    id: info.id,
    slug: info.id,
    version: "2",
    created: info.time.created,
    updated: info.time.updated,
    source: info,
  });

/** The session a `session.created` event announces (a child session carries `parentID`). */
export const openCodeV2CreatedSession = (event: SessionCreated): Session =>
  session({
    id: event.data.sessionID,
    slug: event.data.slug,
    version: event.data.version,
    created: event.created,
    updated: event.created,
    source: event.data,
  });

type V1Model = ProviderListResponse["all"][number]["models"][string];

const modalities = (values: ReadonlyArray<string>) => ({
  text: values.includes("text"),
  audio: values.includes("audio"),
  image: values.includes("image"),
  video: values.includes("video"),
  pdf: values.includes("pdf"),
});

function v1Model(model: ModelInfo): V1Model {
  const cost = model.cost.find((entry) => entry.tier === undefined) ?? model.cost[0];
  return {
    id: model.id,
    providerID: model.providerID,
    name: model.name,
    ...(model.family !== undefined ? { family: model.family } : {}),
    // The request target lives in `settings`, which may hold credentials.
    api: { id: model.modelID, url: "", npm: "" },
    capabilities: {
      temperature: model.capabilities.temperature ?? false,
      reasoning: model.variants.length > 0,
      attachment: model.capabilities.input.some((input) => input !== "text"),
      toolcall: model.capabilities.tools,
      input: modalities(model.capabilities.input),
      output: modalities(model.capabilities.output),
      interleaved: false,
    },
    cost: cost
      ? { input: cost.input, output: cost.output, cache: { ...cost.cache } }
      : { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: {
      context: model.limit.context,
      output: model.limit.output,
      ...(model.limit.input !== undefined ? { input: model.limit.input } : {}),
    },
    status: model.status,
    options: {},
    headers: {},
    release_date: "",
    // Variant settings and headers stay behind too: the picker needs only the IDs.
    variants: Object.fromEntries(model.variants.map((variant) => [variant.id, {}])),
  };
}

/**
 * The 1.x provider list for 2.x providers and models. Only enabled models are listed, and a
 * provider counts as connected when it has one. The caller lists models before providers: a cold
 * 2.x server fills its provider list on the first model lookup.
 */
export function openCodeV2ProviderList(
  providers: ReadonlyArray<ProviderInfo>,
  models: ReadonlyArray<ModelInfo>,
): ProviderListResponse {
  const enabled = new Map<string, Array<ModelInfo>>();
  for (const model of models) {
    if (!model.enabled) continue;
    const list = enabled.get(model.providerID);
    if (list) list.push(model);
    else enabled.set(model.providerID, [model]);
  }
  return {
    all: providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      source: "api",
      env: [],
      options: {},
      models: Object.fromEntries(
        (enabled.get(provider.id) ?? []).map((model) => [model.id, v1Model(model)]),
      ),
    })),
    default: {},
    connected: providers.filter((provider) => enabled.has(provider.id)).map(({ id }) => id),
  };
}

/** OpenCode's built-in default agent. */
const BUILD_AGENT = "build";

/**
 * The agent a prompt without one runs on: the configured `default_agent` (from the highest-priority
 * document that sets one; `config.get` lists them lowest priority first) when it names a visible
 * primary agent, as on 1.x. Otherwise `build`, or the first visible primary agent when `build` is
 * disabled.
 */
export function openCodeV2DefaultAgent(
  config: ReadonlyArray<ConfigEntry>,
  agents: ReadonlyArray<AgentInfo>,
): string {
  const primary = agents
    .filter((agent) => agent.mode !== "subagent" && !agent.hidden)
    .map((agent) => agent.id);
  let configured: string | undefined;
  for (const entry of config) {
    if (entry.type === "document" && entry.info.default_agent) {
      configured = entry.info.default_agent;
    }
  }
  if (configured !== undefined && primary.includes(configured)) return configured;
  return primary.includes(BUILD_AGENT) ? BUILD_AGENT : (primary[0] ?? BUILD_AGENT);
}

/** A 2.x agent as the 1.x `Agent` (its system prompt and request settings stay behind). */
export function openCodeV2Agent(agent: AgentInfo): Agent {
  return {
    name: agent.id,
    mode: agent.mode,
    hidden: agent.hidden,
    options: {},
    permission: openCodeV1Rules(agent.permissions),
    ...(agent.description !== undefined ? { description: agent.description } : {}),
    ...(agent.color !== undefined ? { color: agent.color } : {}),
    ...(agent.steps !== undefined ? { steps: agent.steps } : {}),
    ...(agent.model !== undefined
      ? {
          model: { providerID: agent.model.providerID, modelID: agent.model.id },
          ...(agent.model.variant !== undefined ? { variant: agent.model.variant } : {}),
        }
      : {}),
  };
}

/** A 2.x permission request (listed or asked) as the 1.x request the adapter keeps pending. */
export function openCodeV2Permission(
  request: V2PermissionRequest | PermissionAsked["data"],
): PermissionRequest {
  return {
    id: request.id,
    sessionID: request.sessionID,
    permission: openCodeV1Name(request.action),
    patterns: request.resources,
    always: request.save ?? [],
    metadata: request.metadata ?? {},
    ...(request.source !== undefined
      ? { tool: { messageID: request.source.messageID, callID: request.source.id } }
      : {}),
  };
}

/** A form as `form.list` returns it or as `form.created` carries it. */
export type OpenCodeV2Form = FormInfo | FormInfo1;
type FormFieldInfo = FormField | FormField1;

const formFields = (form: OpenCodeV2Form): ReadonlyArray<FormFieldInfo> => form.fields;

const optionLabel = (option: { readonly value: string; readonly label?: string }) =>
  option.label || option.value;

/**
 * External fields (a URL to open), hidden fields and conditional fields have no 1.x question
 * shape. Such a form is offered as a single question whose only option cancels it.
 */
export const isUnsupportedOpenCodeV2Form = (form: OpenCodeV2Form): boolean =>
  formFields(form).some(
    (field) => field.type === "external" || field.hidden === true || (field.when?.length ?? 0) > 0,
  );

function formQuestion(form: OpenCodeV2Form, field: FormFieldInfo): QuestionInfo {
  const header = field.title || form.title || field.key;
  const question = field.description || field.title || field.key;
  switch (field.type) {
    case "boolean":
      return {
        header,
        question,
        options: [
          { label: "Yes", description: "Yes" },
          { label: "No", description: "No" },
        ],
        custom: false,
      };
    case "multiselect":
    case "string": {
      const options = (field.options ?? []).map((option) => ({
        label: optionLabel(option),
        description: option.description || optionLabel(option),
      }));
      return {
        header,
        question,
        options,
        ...(field.type === "multiselect" ? { multiple: true } : {}),
        custom: options.length === 0 || field.custom === true,
      };
    }
    default:
      return { header, question, options: [], custom: true };
  }
}

/** A 2.x form as the 1.x question request: one question per field, in field order. */
export function openCodeV2Question(form: OpenCodeV2Form): QuestionRequest {
  const tool = formTool(form);
  return {
    id: form.id,
    sessionID: form.sessionID,
    questions: isUnsupportedOpenCodeV2Form(form)
      ? [
          {
            header: form.title || "OpenCode form",
            question: "This form needs OpenCode's interface. Complete it there, or cancel it here.",
            options: [{ label: "Cancel", description: "Cancel this OpenCode form" }],
            custom: false,
          },
        ]
      : formFields(form).map((field) => formQuestion(form, field)),
    ...(tool ? { tool } : {}),
  };
}

/** The question tool call a form belongs to (`metadata.tool`), when it names one. */
function formTool(form: OpenCodeV2Form): QuestionRequest["tool"] {
  const tool: unknown = form.metadata?.tool;
  if (typeof tool !== "object" || tool === null) return undefined;
  const { messageID, id } = tool as { readonly messageID?: unknown; readonly id?: unknown };
  return typeof messageID === "string" && typeof id === "string"
    ? { messageID, callID: id }
    : undefined;
}

export type OpenCodeV2FormResponse =
  | { readonly type: "reply"; readonly answer: SessionFormReplyInput["answer"] }
  | { readonly type: "cancel" };

const optionValue = (field: FormFieldInfo, answer: string): string =>
  ("options" in field ? field.options : undefined)?.find(
    (option) => optionLabel(option) === answer || option.value === answer,
  )?.value ?? answer;

function fieldAnswer(
  field: FormFieldInfo,
  values: ReadonlyArray<string>,
): string | number | boolean | ReadonlyArray<string> {
  switch (field.type) {
    case "multiselect":
      return values.map((value) => optionValue(field, value));
    case "boolean": {
      const value = values[0]?.trim().toLowerCase();
      if (value === "yes" || value === "true") return true;
      if (value === "no" || value === "false") return false;
      throw new Error(`OpenCode expects yes or no for ${field.title || field.key}.`);
    }
    case "number":
    case "integer": {
      const value = Number(values[0]?.trim());
      if (!Number.isFinite(value) || (field.type === "integer" && !Number.isInteger(value))) {
        throw new Error(
          `OpenCode expects ${field.type === "integer" ? "a whole number" : "a number"} for ${field.title || field.key}.`,
        );
      }
      return value;
    }
    default:
      return values.map((value) => optionValue(field, value)).join(", ");
  }
}

/**
 * How to settle a form given the 1.x positional answers. A form without a 1.x shape is cancelled
 * (its only option is Cancel), and so is a form answered with nothing at all: 1.x accepted an
 * empty answer, while 2.x rejects a missing required field and would keep the turn waiting.
 * Rejects (throws) a partly answered form that misses a required field or has an invalid value.
 */
export function openCodeV2FormResponse(
  form: OpenCodeV2Form,
  answers: ReadonlyArray<QuestionAnswer>,
): OpenCodeV2FormResponse {
  if (isUnsupportedOpenCodeV2Form(form)) return { type: "cancel" };
  const fields = formFields(form);
  const values = fields.map((_, index) =>
    (answers[index] ?? []).filter((value) => value.trim().length > 0),
  );
  if (values.every((value) => value.length === 0)) return { type: "cancel" };
  const answer: Array<[string, string | number | boolean | ReadonlyArray<string>]> = [];
  for (const [index, field] of fields.entries()) {
    const fieldValues = values[index] ?? [];
    if (fieldValues.length > 0) answer.push([field.key, fieldAnswer(field, fieldValues)]);
    else if ("required" in field && field.required === true) {
      throw new Error(`OpenCode needs an answer for ${field.title || field.key}.`);
    }
  }
  // Own properties whatever the keys are named (`Object.fromEntries` never sets a prototype).
  return { type: "reply", answer: Object.fromEntries(answer) };
}

/** A settled form's answer as 1.x positional answers, with option values shown as labels. */
export function openCodeV2FormAnswers(
  form: OpenCodeV2Form,
  answer: FormReplied["data"]["answer"],
): Array<QuestionAnswer> {
  if (isUnsupportedOpenCodeV2Form(form)) return [];
  return formFields(form).map((field) => {
    const value = answer[field.key];
    if (value === undefined) return [];
    if (typeof value === "boolean") return [value ? "Yes" : "No"];
    const options = "options" in field ? field.options : undefined;
    return (Array.isArray(value) ? value : [String(value)]).map(
      (entry) => options?.find((option) => option.value === entry)?.label || entry,
    );
  });
}

/** The 2.x model reference for a 1.x prompt's model and variant. */
export const openCodeV2ModelRef = (
  model: { readonly providerID: string; readonly modelID: string },
  variant: string | undefined,
): ModelRef => ({
  providerID: model.providerID,
  id: model.modelID,
  ...(variant ? { variant } : {}),
});

type PromptPart = TextPartInput | FilePartInput | AgentPartInput | SubtaskPartInput;

/**
 * The text, files and agent mentions of a 1.x prompt. A 2.x prompt has one text, so text parts
 * are joined; a file is referenced by its URL (`data:` or `file:`), which carries its type.
 * Subtask parts have no 2.x prompt counterpart (Ryco sends none).
 */
export function openCodeV2Prompt(
  parts: ReadonlyArray<PromptPart> | undefined,
): Pick<SessionPromptInput, "text" | "files" | "agents"> {
  const text: Array<string> = [];
  const files: Array<{ uri: string; name?: string }> = [];
  const agents: Array<{ name: string }> = [];
  for (const part of parts ?? []) {
    if (part.type === "text") text.push(part.text);
    else if (part.type === "file") {
      files.push({ uri: part.url, ...(part.filename ? { name: part.filename } : {}) });
    } else if (part.type === "agent") agents.push({ name: part.name });
  }
  return {
    text: text.join("\n\n"),
    ...(files.length > 0 ? { files } : {}),
    ...(agents.length > 0 ? { agents } : {}),
  };
}

type V2McpConfig = McpAddInput["config"];

/**
 * A 1.x MCP server config as 2.x takes it: `enabled` turns into `disabled`, the one timeout bounds
 * both the tool catalog and each call, and OAuth settings use snake_case keys.
 */
export function openCodeV2McpConfig(config: McpLocalConfig | McpRemoteConfig): V2McpConfig {
  const common = {
    disabled: config.enabled === false,
    ...(config.timeout !== undefined
      ? { timeout: { catalog: config.timeout, execution: config.timeout } }
      : {}),
  };
  if (config.type === "local") {
    return {
      type: "local",
      command: config.command,
      ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
      ...(config.environment !== undefined ? { environment: config.environment } : {}),
      ...common,
    };
  }
  const oauth = config.oauth;
  return {
    type: "remote",
    url: config.url,
    ...(config.headers !== undefined ? { headers: config.headers } : {}),
    ...(oauth === false
      ? { oauth: false }
      : oauth !== undefined
        ? {
            oauth: {
              ...(oauth.clientId !== undefined ? { client_id: oauth.clientId } : {}),
              ...(oauth.clientSecret !== undefined ? { client_secret: oauth.clientSecret } : {}),
              ...(oauth.scope !== undefined ? { scope: oauth.scope } : {}),
              ...(oauth.callbackPort !== undefined ? { callback_port: oauth.callbackPort } : {}),
              ...(oauth.redirectUri !== undefined ? { redirect_uri: oauth.redirectUri } : {}),
            },
          }
        : {}),
    ...common,
  };
}
