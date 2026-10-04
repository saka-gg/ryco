import {
  CONTEXT_HANDOFF_CONTEXT_VERSION,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
} from "@ryco/contracts";
import { truncateUnicodeSafe } from "@ryco/shared/String";
import { Data } from "effect";

import {
  type ContextHandoffBoundaryEntry,
  type ContextHandoffCheckpointEntry,
  type ContextHandoffDocument,
  type ContextHandoffMessageEntry,
  type ContextHandoffNoticeEntry,
  type ContextHandoffPlanEntry,
  type ContextHandoffSubagentEntry,
  type ContextHandoffToolEntry,
  countContextHandoffEntries,
  stableStringifyContextHandoff,
} from "./ContextHandoffBuilder.ts";
import type { ContextHandoffRenderedDocument } from "./ContextHandoffArtifacts.ts";

const CONTEXT_OPEN = '<context_handoff version="1" mode="full-context-fresh-session">\n';
const CONTEXT_CLOSE = "\n</context_handoff>\n\n<current_user_message>\n";
const MESSAGE_CLOSE = "\n</current_user_message>";

type SectionName =
  | "messages"
  | "plans"
  | "tools"
  | "checkpoints"
  | "notices"
  | "subagents"
  | "priorHandoffs";

type SectionEntryByName = {
  readonly messages: ContextHandoffMessageEntry;
  readonly plans: ContextHandoffPlanEntry;
  readonly tools: ContextHandoffToolEntry;
  readonly checkpoints: ContextHandoffCheckpointEntry;
  readonly notices: ContextHandoffNoticeEntry;
  readonly subagents: ContextHandoffSubagentEntry;
  readonly priorHandoffs: ContextHandoffBoundaryEntry;
};

type AnySectionEntry = SectionEntryByName[SectionName];

type RenderedDocument = ContextHandoffRenderedDocument;

interface MutableSections {
  messages: ContextHandoffMessageEntry[];
  plans: ContextHandoffPlanEntry[];
  tools: ContextHandoffToolEntry[];
  checkpoints: ContextHandoffCheckpointEntry[];
  notices: ContextHandoffNoticeEntry[];
  subagents: ContextHandoffSubagentEntry[];
  priorHandoffs: ContextHandoffBoundaryEntry[];
}

interface Candidate<K extends SectionName = SectionName> {
  readonly section: K;
  readonly entry: SectionEntryByName[K];
  readonly priority: number;
}

export class ContextHandoffRenderError extends Data.TaggedError("ContextHandoffRenderError")<{
  readonly reason: "invalid-budget" | "message-too-large";
  readonly message: string;
  readonly maxInputChars: number;
  readonly currentMessageChars: number;
  readonly minimumRequiredChars: number;
}> {}

export interface RenderContextHandoffInput {
  readonly document: ContextHandoffDocument;
  /** The canonical current user message. It is appended byte-for-byte as a JS string. */
  readonly currentMessage: string;
  readonly maxInputChars?: number | undefined;
}

export interface ContextHandoffRenderResult {
  readonly providerInput: string;
  readonly renderedContext: ContextHandoffRenderedDocument;
  readonly renderedContextJson: string;
  readonly contextChars: number;
  readonly inputChars: number;
  readonly includedEntryCount: number;
  readonly totalEntryCount: number;
  readonly truncated: boolean;
}

const SECTION_PRIORITY: Record<SectionName, number> = {
  notices: 100,
  plans: 90,
  messages: 80,
  checkpoints: 70,
  tools: 60,
  subagents: 50,
  priorHandoffs: 40,
};

const FIRST_PASS_ORDER: ReadonlyArray<SectionName> = [
  "notices",
  "plans",
  "messages",
  "checkpoints",
  "tools",
  "subagents",
  "priorHandoffs",
];

const CONTENT_STRING_KEYS = new Set([
  "text",
  "planMarkdown",
  "explanation",
  "step",
  "summary",
  "detail",
  "command",
  "output",
  "path",
  "kind",
  "header",
  "question",
  "label",
  "description",
  "error",
]);

function compareChronological(left: AnySectionEntry, right: AnySectionEntry): number {
  const createdAt = left.createdAt.localeCompare(right.createdAt);
  if (createdAt !== 0) {
    return createdAt;
  }
  const sequence =
    (left.sequence ?? Number.MAX_SAFE_INTEGER) - (right.sequence ?? Number.MAX_SAFE_INTEGER);
  if (sequence !== 0) {
    return sequence;
  }
  return left.id.localeCompare(right.id);
}

function compareCandidateRecency(left: Candidate, right: Candidate): number {
  if (left.priority !== right.priority) {
    return right.priority - left.priority;
  }
  const chronological = compareChronological(left.entry, right.entry);
  return chronological === 0 ? left.section.localeCompare(right.section) : -chronological;
}

function emptySections(): MutableSections {
  return {
    messages: [],
    plans: [],
    tools: [],
    checkpoints: [],
    notices: [],
    subagents: [],
    priorHandoffs: [],
  };
}

function minimalProvenance(document: ContextHandoffDocument): ContextHandoffDocument["provenance"] {
  const immediateSource = document.provenance.sources.at(-1)!;
  return {
    sources: [
      {
        providerInstanceId: immediateSource.providerInstanceId,
        driverKind: immediateSource.driverKind,
        modelSlug: immediateSource.modelSlug,
      },
    ],
    target: {
      providerInstanceId: document.provenance.target.providerInstanceId,
      driverKind: document.provenance.target.driverKind,
      modelSlug: document.provenance.target.modelSlug,
    },
  };
}

function renderedDocument(
  document: ContextHandoffDocument,
  sections: MutableSections,
  includeThread: boolean,
  includeFullProvenance: boolean,
): RenderedDocument {
  return {
    version: CONTEXT_HANDOFF_CONTEXT_VERSION,
    mode: "full-context-fresh-session",
    provenance: includeFullProvenance ? document.provenance : minimalProvenance(document),
    ...(includeThread ? { thread: document.thread } : {}),
    ...(sections.messages.length > 0 ? { messages: sections.messages } : {}),
    ...(sections.plans.length > 0 ? { plans: sections.plans } : {}),
    ...(sections.tools.length > 0 ? { tools: sections.tools } : {}),
    ...(sections.checkpoints.length > 0 ? { checkpoints: sections.checkpoints } : {}),
    ...(sections.notices.length > 0 ? { notices: sections.notices } : {}),
    ...(sections.subagents.length > 0 ? { subagents: sections.subagents } : {}),
    ...(sections.priorHandoffs.length > 0 ? { priorHandoffs: sections.priorHandoffs } : {}),
  };
}

function compactKnownValue(value: unknown, maxStringChars: number, key?: string): unknown {
  if (typeof value === "string") {
    return key && CONTENT_STRING_KEYS.has(key) ? truncateUnicodeSafe(value, maxStringChars) : value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => compactKnownValue(entry, maxStringChars));
  }
  if (value && typeof value === "object") {
    const compacted: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value)) {
      compacted[entryKey] = compactKnownValue(entryValue, maxStringChars, entryKey);
    }
    compacted.truncated = true;
    return compacted;
  }
  return value;
}

function compactEntry<K extends SectionName>(
  candidate: Candidate<K>,
  maxStringChars: number,
): Candidate<K> {
  return {
    ...candidate,
    entry: compactKnownValue(candidate.entry, maxStringChars) as SectionEntryByName[K],
  };
}

function sectionEntries<K extends SectionName>(
  document: ContextHandoffDocument,
  section: K,
): ReadonlyArray<SectionEntryByName[K]> {
  return document[section] as ReadonlyArray<SectionEntryByName[K]>;
}

function candidatesForDocument(document: ContextHandoffDocument): Candidate[] {
  const candidates: Candidate[] = [];
  for (const section of FIRST_PASS_ORDER) {
    for (const entry of sectionEntries(document, section)) {
      candidates.push({
        section,
        entry,
        priority: SECTION_PRIORITY[section],
      } as Candidate);
    }
  }
  return candidates.toSorted(compareCandidateRecency);
}

function documentHasTruncatedEntry(document: ContextHandoffDocument): boolean {
  return candidatesForDocument(document).some(
    (candidate) => "truncated" in candidate.entry && candidate.entry.truncated === true,
  );
}

function newestCandidateForSection(
  document: ContextHandoffDocument,
  section: SectionName,
): Candidate | undefined {
  const entries = [...sectionEntries(document, section)].toSorted(compareChronological);
  const entry = entries.at(-1);
  return entry ? ({ section, entry, priority: SECTION_PRIORITY[section] } as Candidate) : undefined;
}

function candidateKey(candidate: Candidate): string {
  return `${candidate.section}\u0000${candidate.entry.id}`;
}

function pushCandidate(sections: MutableSections, candidate: Candidate): void {
  const target = sections[candidate.section] as AnySectionEntry[];
  target.push(candidate.entry);
  target.sort(compareChronological);
}

function removeCandidate(sections: MutableSections, candidate: Candidate): void {
  const target = sections[candidate.section] as AnySectionEntry[];
  const index = target.findIndex((entry) => entry.id === candidate.entry.id);
  if (index >= 0) {
    target.splice(index, 1);
  }
}

function tryIncludeCandidate(input: {
  readonly document: ContextHandoffDocument;
  readonly sections: MutableSections;
  readonly candidate: Candidate;
  readonly availableContextChars: number;
  readonly includeThread: boolean;
  readonly includeFullProvenance: boolean;
}): { readonly included: boolean; readonly compacted: boolean } {
  const variants = [
    input.candidate,
    compactEntry(input.candidate, 4_096),
    compactEntry(input.candidate, 1_024),
    compactEntry(input.candidate, 256),
    compactEntry(input.candidate, 64),
  ];
  const seen = new Set<string>();
  for (let index = 0; index < variants.length; index += 1) {
    const variant = variants[index]!;
    const serializedEntry = stableStringifyContextHandoff(variant.entry);
    if (seen.has(serializedEntry)) {
      continue;
    }
    seen.add(serializedEntry);
    pushCandidate(input.sections, variant);
    const json = stableStringifyContextHandoff(
      renderedDocument(
        input.document,
        input.sections,
        input.includeThread,
        input.includeFullProvenance,
      ),
    );
    if (json.length <= input.availableContextChars) {
      return { included: true, compacted: index > 0 };
    }
    removeCandidate(input.sections, variant);
  }
  return { included: false, compacted: false };
}

function envelope(input: {
  readonly contextJson: string;
  readonly currentMessage: string;
}): string {
  return `${CONTEXT_OPEN}${input.contextJson}${CONTEXT_CLOSE}${input.currentMessage}${MESSAGE_CLOSE}`;
}

export function renderContextHandoffInput(
  input: RenderContextHandoffInput,
): ContextHandoffRenderResult {
  const maxInputChars = input.maxInputChars ?? PROVIDER_SEND_TURN_MAX_INPUT_CHARS;
  const fixedEnvelopeChars = CONTEXT_OPEN.length + CONTEXT_CLOSE.length + MESSAGE_CLOSE.length;
  if (!Number.isInteger(maxInputChars) || maxInputChars <= 0) {
    throw new ContextHandoffRenderError({
      reason: "invalid-budget",
      message: "Context handoff input budget must be a positive integer",
      maxInputChars,
      currentMessageChars: input.currentMessage.length,
      minimumRequiredChars: fixedEnvelopeChars,
    });
  }

  const availableContextChars = maxInputChars - fixedEnvelopeChars - input.currentMessage.length;
  const sections = emptySections();
  const minimumJson = stableStringifyContextHandoff(
    renderedDocument(input.document, sections, false, false),
  );
  const minimumRequiredChars =
    fixedEnvelopeChars + input.currentMessage.length + minimumJson.length;
  if (availableContextChars < minimumJson.length) {
    throw new ContextHandoffRenderError({
      reason: "message-too-large",
      message: "Current message leaves no room for a valid context handoff header",
      maxInputChars,
      currentMessageChars: input.currentMessage.length,
      minimumRequiredChars,
    });
  }

  const fullJson = stableStringifyContextHandoff(input.document);
  if (fullJson.length <= availableContextChars) {
    const providerInput = envelope({
      contextJson: fullJson,
      currentMessage: input.currentMessage,
    });
    return {
      providerInput,
      renderedContext: input.document,
      renderedContextJson: fullJson,
      contextChars: fullJson.length,
      inputChars: providerInput.length,
      includedEntryCount: countContextHandoffEntries(input.document),
      totalEntryCount: countContextHandoffEntries(input.document),
      truncated: documentHasTruncatedEntry(input.document),
    };
  }

  let includeFullProvenance = false;
  const fullProvenanceJson = stableStringifyContextHandoff(
    renderedDocument(input.document, sections, false, true),
  );
  if (fullProvenanceJson.length <= availableContextChars) {
    includeFullProvenance = true;
  }

  let includeThread = false;
  const withThreadJson = stableStringifyContextHandoff(
    renderedDocument(input.document, sections, true, includeFullProvenance),
  );
  if (withThreadJson.length <= availableContextChars) {
    includeThread = true;
  }

  let compactedAny = false;
  const includedKeys = new Set<string>();
  for (const section of FIRST_PASS_ORDER) {
    const candidate = newestCandidateForSection(input.document, section);
    if (!candidate) {
      continue;
    }
    const result = tryIncludeCandidate({
      document: input.document,
      sections,
      candidate,
      availableContextChars,
      includeThread,
      includeFullProvenance,
    });
    if (result.included) {
      includedKeys.add(candidateKey(candidate));
      compactedAny ||= result.compacted;
    }
  }

  for (const candidate of candidatesForDocument(input.document)) {
    if (includedKeys.has(candidateKey(candidate))) {
      continue;
    }
    const result = tryIncludeCandidate({
      document: input.document,
      sections,
      candidate,
      availableContextChars,
      includeThread,
      includeFullProvenance,
    });
    if (result.included) {
      includedKeys.add(candidateKey(candidate));
      compactedAny ||= result.compacted;
    }
  }

  const renderedContext = renderedDocument(
    input.document,
    sections,
    includeThread,
    includeFullProvenance,
  );
  const renderedContextJson = stableStringifyContextHandoff(renderedContext);
  const providerInput = envelope({
    contextJson: renderedContextJson,
    currentMessage: input.currentMessage,
  });
  const totalEntryCount = countContextHandoffEntries(input.document);
  const artifactWasTruncated = documentHasTruncatedEntry(input.document);
  return {
    providerInput,
    renderedContext,
    renderedContextJson,
    contextChars: renderedContextJson.length,
    inputChars: providerInput.length,
    includedEntryCount: includedKeys.size,
    totalEntryCount,
    truncated:
      compactedAny ||
      artifactWasTruncated ||
      includedKeys.size < totalEntryCount ||
      !includeThread ||
      !includeFullProvenance,
  };
}
