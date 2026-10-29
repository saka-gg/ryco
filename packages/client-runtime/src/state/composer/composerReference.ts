import { BROWSER_ELEMENT_MAX_PER_PROMPT } from "@ryco/contracts/browser-element-limits";

import {
  type BrowserElementReference,
  type BrowserElementReferenceDraft,
  browserElementReferenceKey,
  decodeBrowserElementReferenceDraft,
  formatBrowserElementTitle,
} from "./browserElementReference.ts";
import {
  decodeFileReferenceDraft,
  FILE_REFERENCE_PROMPT_MAX_COUNT,
  type FileReference,
  type FileReferenceDraft,
  fileReferenceKey,
  formatFileReferenceTitle,
} from "./fileReference.ts";

/**
 * What a composer's reference chips carry: lines of a workspace file or a page
 * element picked in the project browser. Each kind is sent as its own block.
 */
export type ComposerReference = FileReference | BrowserElementReference;
/** A reference waiting in a composer draft, shown there as a chip until it is sent. */
export type ComposerReferenceDraft = FileReferenceDraft | BrowserElementReferenceDraft;

/** Whether `reference` is a picked page element (a file reference has no `kind`). */
export function isBrowserElementReference<T extends ComposerReference>(
  reference: T,
): reference is Extract<T, BrowserElementReference> {
  return "kind" in reference && reference.kind === "browser-element";
}

/**
 * A draft reference of either kind read back from storage, re-checked like a
 * fresh one; null when it does not hold up or is of a kind this client does not
 * know. An entry without `kind` is a file reference (drafts written before page
 * elements existed).
 */
export function decodeComposerReferenceDraft(value: unknown): ComposerReferenceDraft | null {
  if (typeof value !== "object" || value === null) return null;
  const kind = (value as { readonly kind?: unknown }).kind;
  if (kind === undefined) return decodeFileReferenceDraft(value);
  return kind === "browser-element" ? decodeBrowserElementReferenceDraft(value) : null;
}

/** Identity for de-duplicating references in one prompt; the kinds never collide. */
export function composerReferenceKey(reference: ComposerReference): string {
  return isBrowserElementReference(reference)
    ? browserElementReferenceKey(reference)
    : fileReferenceKey(reference);
}

/** How many references of `reference`'s kind one prompt carries; the composer refuses more. */
function composerReferenceLimit(reference: ComposerReference): number {
  return isBrowserElementReference(reference)
    ? BROWSER_ELEMENT_MAX_PER_PROMPT
    : FILE_REFERENCE_PROMPT_MAX_COUNT;
}

/** The references of each kind, in order. */
export function splitComposerReferences<T extends ComposerReference>(
  references: ReadonlyArray<T>,
): {
  readonly fileReferences: Array<Exclude<T, BrowserElementReference>>;
  readonly browserElements: Array<Extract<T, BrowserElementReference>>;
} {
  const fileReferences: Array<Exclude<T, BrowserElementReference>> = [];
  const browserElements: Array<Extract<T, BrowserElementReference>> = [];
  for (const reference of references) {
    if (isBrowserElementReference(reference)) browserElements.push(reference);
    else fileReferences.push(reference as Exclude<T, BrowserElementReference>);
  }
  return { fileReferences, browserElements };
}

/**
 * The references one draft keeps, in order: the first of any repeated id or
 * key, and no more of a kind than one prompt carries
 * (`FILE_REFERENCE_PROMPT_MAX_COUNT` files, `BROWSER_ELEMENT_MAX_PER_PROMPT`
 * page elements).
 */
export function normalizeComposerReferenceDrafts(
  references: ReadonlyArray<ComposerReferenceDraft>,
): ComposerReferenceDraft[] {
  const ids = new Set<string>();
  const keys = new Set<string>();
  let files = 0;
  let elements = 0;
  const kept: ComposerReferenceDraft[] = [];
  for (const reference of references) {
    const key = composerReferenceKey(reference);
    if (ids.has(reference.id) || keys.has(key)) continue;
    const element = isBrowserElementReference(reference);
    if ((element ? elements : files) >= composerReferenceLimit(reference)) continue;
    if (element) elements += 1;
    else files += 1;
    ids.add(reference.id);
    keys.add(key);
    kept.push(reference);
  }
  return kept;
}

/**
 * How adding a reference to a draft went: `updated` when the draft already
 * held it (the same lines, whose new excerpt and note replace the old, or the
 * same element with the same note, whose new pick replaces the old), `full`
 * when the draft holds as many of its kind as one prompt carries.
 */
export type ComposerReferenceDraftAddOutcome = "added" | "updated" | "full";

/** `references` with `reference` added, or the outcome that kept it out. */
export function addComposerReferenceDraft(
  references: ReadonlyArray<ComposerReferenceDraft>,
  reference: ComposerReferenceDraft,
): {
  readonly outcome: ComposerReferenceDraftAddOutcome;
  readonly references: ComposerReferenceDraft[];
} {
  const key = composerReferenceKey(reference);
  const index = references.findIndex((entry) => composerReferenceKey(entry) === key);
  if (index >= 0) {
    const next = [...references];
    // The chip keeps its place and identity; what it carries is the latest pick.
    next[index] = { ...reference, id: references[index]!.id };
    return { outcome: "updated", references: next };
  }
  const element = isBrowserElementReference(reference);
  const sameKind = references.filter(
    (entry) => isBrowserElementReference(entry) === element,
  ).length;
  if (sameKind >= composerReferenceLimit(reference)) {
    return { outcome: "full", references: [...references] };
  }
  return { outcome: "added", references: [...references, reference] };
}

/** A reference's full name for a tooltip or a first message's title. */
export function formatComposerReferenceTitle(reference: ComposerReference): string {
  return isBrowserElementReference(reference)
    ? formatBrowserElementTitle(reference)
    : formatFileReferenceTitle(reference);
}
