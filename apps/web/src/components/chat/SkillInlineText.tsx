import { Children, cloneElement, isValidElement, use, type ReactNode } from "react";
import type { EnvironmentId, ServerProviderSkill, ThreadId } from "@ryco/contracts";
import { matchQuoteCitations, type QuoteCitation } from "@ryco/shared/quoteCitations";

import { formatProviderSkillDisplayName } from "../../providerSkillPresentation";
import {
  COMPOSER_INLINE_CHIP_ICON_CLASS_NAME,
  COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME,
  COMPOSER_INLINE_SKILL_CHIP_CLASS_NAME,
  SKILL_CHIP_ICON_SVG,
} from "../composerInlineChip";
import { matchThreadMentions } from "../../composer-editor-mentions";
import { ThreadMentionChip } from "./ThreadMentionChip";
import { QuoteCitationChip } from "./QuoteCitationChip";
import { QuoteCitationContext, type QuoteCitationRenderContext } from "./quoteCitationContext";
import {
  renderThreadMessageSearchHighlightedText,
  type ThreadMessageSearchHighlightCursor,
} from "./ThreadMessageSearchHighlight";

const SKILL_TOKEN_REGEX = /(^|\s)\$([a-zA-Z][a-zA-Z0-9:_-]*)(?=\s|$)/g;

type InlineSkill = Pick<ServerProviderSkill, "name" | "displayName">;

export interface SkillInlineTextSearchHighlight {
  query: string;
  activeOccurrenceIndex: number | null;
  cursor: ThreadMessageSearchHighlightCursor;
  keyPrefix: string;
}

function renderInlineTextSegment(input: {
  text: string;
  start: number;
  highlight: SkillInlineTextSearchHighlight | undefined;
}): ReactNode {
  if (!input.highlight) {
    return input.text;
  }
  return renderThreadMessageSearchHighlightedText({
    text: input.text,
    query: input.highlight.query,
    activeOccurrenceIndex: input.highlight.activeOccurrenceIndex,
    cursor: input.highlight.cursor,
    keyPrefix: `${input.highlight.keyPrefix}:${input.start}`,
  });
}

type InlineChipMatch =
  | {
      readonly kind: "skill";
      readonly start: number;
      readonly end: number;
      readonly skill: InlineSkill;
    }
  | {
      readonly kind: "thread";
      readonly start: number;
      readonly end: number;
      readonly threadId: ThreadId;
    }
  | {
      readonly kind: "quote";
      readonly start: number;
      readonly end: number;
      readonly citation: QuoteCitation;
      readonly number: number | null;
    };

/**
 * Known skills, thread mentions given the message's environment, and quotes
 * inside a sent message, in text order.
 */
function collectInlineChipMatches(
  text: string,
  skills: ReadonlyArray<InlineSkill>,
  environmentId: EnvironmentId | undefined,
  quoteCitations: QuoteCitationRenderContext | null,
): InlineChipMatch[] {
  const matches: InlineChipMatch[] = [];
  for (const match of text.matchAll(SKILL_TOKEN_REGEX)) {
    const prefix = match[1] ?? "";
    const name = match[2] ?? "";
    const skill = skills.find((candidate) => candidate.name === name);
    if (!skill) continue;
    const start = (match.index ?? 0) + prefix.length;
    matches.push({ kind: "skill", start, end: start + name.length + 1, skill });
  }
  if (environmentId) {
    for (const mention of matchThreadMentions(text)) matches.push({ kind: "thread", ...mention });
  }
  if (quoteCitations) {
    for (const quote of matchQuoteCitations(text, quoteCitations.quotes)) {
      matches.push({ kind: "quote", ...quote });
    }
  }
  return matches.toSorted((left, right) => left.start - right.start);
}

export function SkillInlineText(props: {
  text: string;
  skills: ReadonlyArray<InlineSkill>;
  /** Renders `@thread:` mentions as links to threads of this environment. */
  environmentId?: EnvironmentId | undefined;
  searchHighlight?: SkillInlineTextSearchHighlight | undefined;
}) {
  const quoteCitations = use(QuoteCitationContext);
  const nodes: ReactNode[] = [];
  let cursor = 0;

  for (const match of collectInlineChipMatches(
    props.text,
    props.skills,
    props.environmentId,
    quoteCitations,
  )) {
    if (match.start < cursor) continue;
    if (match.start > cursor) {
      nodes.push(
        renderInlineTextSegment({
          text: props.text.slice(cursor, match.start),
          start: cursor,
          highlight: props.searchHighlight,
        }),
      );
    }
    nodes.push(
      match.kind === "skill" ? (
        <SkillChip
          key={`${match.start}:${match.skill.name}`}
          skill={match.skill}
          rawText={props.text.slice(match.start, match.end)}
        />
      ) : match.kind === "quote" ? (
        <QuoteCitationChip
          key={`${match.start}:quote`}
          citation={match.citation}
          number={match.number}
        />
      ) : (
        <ThreadMentionChip
          key={`${match.start}:${match.threadId}`}
          environmentId={props.environmentId!}
          threadId={match.threadId}
          linked
        />
      ),
    );
    cursor = match.end;
  }

  if (cursor === 0) {
    return (
      <>
        {renderInlineTextSegment({
          text: props.text,
          start: 0,
          highlight: props.searchHighlight,
        })}
      </>
    );
  }
  if (cursor < props.text.length) {
    nodes.push(
      renderInlineTextSegment({
        text: props.text.slice(cursor),
        start: cursor,
        highlight: props.searchHighlight,
      }),
    );
  }
  return <>{nodes}</>;
}

export function renderSkillInlineMarkdownChildren(
  children: ReactNode,
  skills: ReadonlyArray<InlineSkill>,
  searchHighlight?: SkillInlineTextSearchHighlight | undefined,
  environmentId?: EnvironmentId | undefined,
): ReactNode {
  return Children.map(children, (child) => {
    if (typeof child === "string") {
      return (
        <SkillInlineText
          text={child}
          skills={skills}
          environmentId={environmentId}
          searchHighlight={searchHighlight}
        />
      );
    }
    if (!isValidElement<{ children?: ReactNode }>(child)) {
      return child;
    }
    if (child.type === "code" || child.type === "a") {
      return child;
    }
    if (!("children" in child.props)) {
      return child;
    }
    return cloneElement(
      child,
      undefined,
      renderSkillInlineMarkdownChildren(
        child.props.children,
        skills,
        searchHighlight,
        environmentId,
      ),
    );
  });
}

function SkillChip(props: { skill: InlineSkill; rawText: string }) {
  return (
    <span className="inline-flex align-middle leading-none">
      <span className="sr-only">{props.rawText}</span>
      <span aria-hidden="true" className={COMPOSER_INLINE_SKILL_CHIP_CLASS_NAME}>
        <span
          aria-hidden="true"
          className={COMPOSER_INLINE_CHIP_ICON_CLASS_NAME}
          dangerouslySetInnerHTML={{ __html: SKILL_CHIP_ICON_SVG }}
        />
        <span className={COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME}>
          {formatProviderSkillDisplayName(props.skill)}
        </span>
      </span>
    </span>
  );
}
