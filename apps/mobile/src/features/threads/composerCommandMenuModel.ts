// The composer's `/`, `$` and `@` autocomplete: which rows a trigger lists and
// what picking one does to the draft. Trigger detection and the ranking are the
// web composer's (`detectComposerTrigger`, `@ryco/shared/composerCommandSearch`),
// so both clients read the same prompt the same way; only the phone's set of
// built-in commands differs (it has no `/goal` or `/computer-use`).
import {
  formatThreadMentionPath,
  replaceTextRange,
  type ComposerTrigger,
} from "@ryco/client-runtime/state/composer";
import type {
  ProjectEntry,
  ServerProviderSkill,
  ServerProviderSlashCommand,
  ThreadId,
} from "@ryco/contracts";
import {
  formatProviderSkillDisplayName,
  searchProviderSkills,
  searchSlashCommandItems,
} from "@ryco/shared/composerCommandSearch";
import { formatComposerMentionSource } from "@ryco/shared/composerInlineTokens";

export type ComposerBuiltInCommand = "model" | "plan" | "default" | "btw";

export type ComposerCommandItem =
  | {
      readonly id: string;
      readonly type: "path";
      readonly path: string;
      readonly kind: ProjectEntry["kind"];
      readonly label: string;
      readonly description: string;
    }
  | {
      readonly id: string;
      readonly type: "thread";
      readonly threadId: ThreadId;
      readonly label: string;
      readonly description: string;
    }
  | {
      readonly id: string;
      readonly type: "slash-command";
      readonly command: ComposerBuiltInCommand;
      readonly label: string;
      readonly description: string;
    }
  | {
      readonly id: string;
      readonly type: "provider-slash-command";
      readonly command: ServerProviderSlashCommand;
      readonly label: string;
      readonly description: string;
    }
  | {
      readonly id: string;
      readonly type: "skill";
      readonly skill: ServerProviderSkill;
      readonly label: string;
      readonly description: string;
    };

/** The thread fields a `@` mention row needs (a sidebar summary carries them). */
export interface ComposerMentionThread {
  readonly id: ThreadId;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt?: string | undefined;
  readonly archivedAt: string | null;
}

/** What the composer can do for a built-in command; an absent one is not offered. */
export interface ComposerCommandOffers {
  readonly model: boolean;
  readonly interactionMode: boolean;
  readonly sideChat: boolean;
}

/** Rows the menu lists at most, so a large skill or file list stays one short scroll. */
export const COMPOSER_MENU_MAX_SKILLS = 20;
export const COMPOSER_MENU_MAX_THREADS = 5;

const BUILT_IN_COMMANDS: ReadonlyArray<{
  readonly command: ComposerBuiltInCommand;
  readonly description: string;
  readonly offeredBy: keyof ComposerCommandOffers;
}> = [
  { command: "model", description: "Switch the model for this thread", offeredBy: "model" },
  {
    command: "plan",
    description: "Switch this thread into plan mode",
    offeredBy: "interactionMode",
  },
  {
    command: "default",
    description: "Switch this thread back to normal build mode",
    offeredBy: "interactionMode",
  },
  { command: "btw", description: "Ask a side question in a side chat", offeredBy: "sideChat" },
];

function skillItem(skill: ServerProviderSkill, label: string): ComposerCommandItem {
  return {
    id: `skill:${skill.name}`,
    type: "skill",
    skill,
    label,
    description:
      skill.shortDescription ??
      skill.description ??
      (skill.scope ? `${skill.scope} skill` : "Run provider skill"),
  };
}

/**
 * Skills also answer `/`: a bare `/`, `/skill` or `/skill:` lists them all, and
 * any other query matches their name, title or description. Typing `$` instead
 * ranks them on their own.
 */
export function matchesSlashSkillQuery(skill: ServerProviderSkill, query: string): boolean {
  if (!skill.enabled) return false;
  const normalized = query.toLowerCase();
  const skillQuery =
    normalized === "skill"
      ? ""
      : normalized.startsWith("skill:")
        ? normalized.slice("skill:".length)
        : normalized;
  if (!skillQuery) return true;
  return [skill.name, skill.displayName, skill.shortDescription, skill.description].some((value) =>
    value?.toLowerCase().includes(skillQuery),
  );
}

function threadRecency(thread: ComposerMentionThread): string {
  return thread.updatedAt ?? thread.createdAt;
}

/** Live threads whose title matches, most recently active first. */
export function matchComposerMentionThreads(input: {
  readonly threads: ReadonlyArray<ComposerMentionThread>;
  readonly query: string;
  readonly excludeThreadId: ThreadId | null;
}): ComposerCommandItem[] {
  const query = input.query.trim().toLowerCase();
  return input.threads
    .filter(
      (thread) =>
        thread.archivedAt === null &&
        thread.id !== input.excludeThreadId &&
        thread.title.trim().length > 0 &&
        (query.length === 0 || thread.title.toLowerCase().includes(query)),
    )
    .toSorted((left, right) => threadRecency(right).localeCompare(threadRecency(left)))
    .slice(0, COMPOSER_MENU_MAX_THREADS)
    .map((thread) => ({
      id: `thread:${thread.id}`,
      type: "thread" as const,
      threadId: thread.id,
      label: thread.title.trim(),
      description: "Thread",
    }));
}

function pathItem(entry: ProjectEntry): ComposerCommandItem {
  const separator = entry.path.lastIndexOf("/");
  return {
    id: `path:${entry.kind}:${entry.path}`,
    type: "path",
    path: entry.path,
    kind: entry.kind,
    label: separator >= 0 ? entry.path.slice(separator + 1) : entry.path,
    description: entry.parentPath ?? (separator > 0 ? entry.path.slice(0, separator) : ""),
  };
}

export function buildComposerCommandItems(input: {
  readonly trigger: ComposerTrigger | null;
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
  readonly offers: ComposerCommandOffers;
  readonly threads: ReadonlyArray<ComposerMentionThread>;
  readonly currentThreadId: ThreadId | null;
  readonly pathEntries: ReadonlyArray<ProjectEntry>;
}): ComposerCommandItem[] {
  const { trigger } = input;
  if (!trigger) return [];
  switch (trigger.kind) {
    case "slash-command": {
      const builtIns = BUILT_IN_COMMANDS.filter((entry) => input.offers[entry.offeredBy]).map(
        (entry) => ({
          id: `cmd:${entry.command}`,
          type: "slash-command" as const,
          command: entry.command,
          label: `/${entry.command}`,
          description: entry.description,
        }),
      );
      // A provider expands its commands only at the start of the message.
      const providerCommands =
        trigger.rangeStart === 0
          ? input.slashCommands.map((command) => ({
              id: `pcmd:${command.name}`,
              type: "provider-slash-command" as const,
              command,
              label: `/${command.name}`,
              description: command.description ?? command.input?.hint ?? "Run provider command",
            }))
          : [];
      const commands = searchSlashCommandItems(
        [...builtIns, ...providerCommands],
        trigger.query.trim().toLowerCase(),
      );
      const skills = input.skills
        .filter((skill) => matchesSlashSkillQuery(skill, trigger.query))
        .slice(0, COMPOSER_MENU_MAX_SKILLS)
        .map((skill) => skillItem(skill, `skill:${skill.name}`));
      return [...commands, ...skills];
    }
    case "skill":
      return searchProviderSkills(input.skills, trigger.query, COMPOSER_MENU_MAX_SKILLS).map(
        (skill) => skillItem(skill, formatProviderSkillDisplayName(skill)),
      );
    case "path":
      return [
        ...matchComposerMentionThreads({
          threads: input.threads,
          query: trigger.query,
          excludeThreadId: input.currentThreadId,
        }),
        ...input.pathEntries.map(pathItem),
      ];
    case "source-control":
      // `#` issue and pull-request context is not on the phone yet.
      return [];
  }
}

/** What else picking a row asks the composer to do, besides editing the draft. */
export type ComposerCommandAction =
  | { readonly kind: "interaction-mode"; readonly mode: "plan" | "default" }
  | { readonly kind: "open-model-picker" }
  | { readonly kind: "open-side-chat" };

export interface ComposerCommandSelection {
  readonly text: string;
  readonly cursor: number;
  readonly action: ComposerCommandAction | null;
}

function insertionFor(item: ComposerCommandItem): string | null {
  switch (item.type) {
    case "path":
      return `${formatComposerMentionSource(item.path)} `;
    case "thread":
      return `@${formatThreadMentionPath(item.threadId)} `;
    case "skill":
      return `$${item.skill.name} `;
    case "provider-slash-command":
      return `/${item.command.name} `;
    case "slash-command":
      return null;
  }
}

function actionFor(item: ComposerCommandItem): ComposerCommandAction | null {
  if (item.type !== "slash-command") return null;
  switch (item.command) {
    case "plan":
    case "default":
      return { kind: "interaction-mode", mode: item.command };
    case "model":
      return { kind: "open-model-picker" };
    case "btw":
      return { kind: "open-side-chat" };
  }
}

/**
 * The draft after picking `item` for `trigger`: a mention, skill or provider
 * command replaces the typed token (and one space already after it, so a
 * re-picked token does not double the space); a built-in command removes the
 * token and hands the composer an action instead.
 */
export function resolveComposerCommandSelection(input: {
  readonly draft: string;
  readonly trigger: Pick<ComposerTrigger, "rangeStart" | "rangeEnd">;
  readonly item: ComposerCommandItem;
}): ComposerCommandSelection {
  const insertion = insertionFor(input.item);
  const { rangeStart } = input.trigger;
  const rangeEnd =
    insertion !== null && input.draft[input.trigger.rangeEnd] === " "
      ? input.trigger.rangeEnd + 1
      : input.trigger.rangeEnd;
  const result = replaceTextRange(input.draft, rangeStart, rangeEnd, insertion ?? "");
  return { text: result.text, cursor: result.cursor, action: actionFor(input.item) };
}
