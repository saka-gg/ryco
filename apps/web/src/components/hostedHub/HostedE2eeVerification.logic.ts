// docs/relay-e2ee-protocol.md §13.5's `WebSAS`, as the only shape a surface can
// render it in.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE CODE AND ITS CEILING ARE ONE VALUE
// ─────────────────────────────────────────────────────────────────────────────
// §13.5 puts an **advisory-only disclosure duty** on the display, not on the
// derivation: "The web UI text accompanying the `WebSAS` MUST state that the
// comparison catches accidental wrong-node routing and some network
// interposition while the loaded code is honest, and **cannot** protect against
// the Hub operator, who serves the code that displays it."
//
// A duty a caller can discharge separately is a duty a caller can forget, so
// {@link hostedE2eeVerificationView} returns the groups, the display value, the
// duty, and the second sentence that goes with it — the pointer at the rest of
// the account, or the command that reads the node's end — as ONE object with
// four required fields. There is no exported function that hands back the eight
// characters alone: rendering the code without the denial requires deleting a
// field from a returned value rather than omitting a call, which is the
// difference between a rule and a mechanism.
//
// ─────────────────────────────────────────────────────────────────────────────
// TWO LENGTHS, AND NEITHER OF THEM IS A BARE CODE
// ─────────────────────────────────────────────────────────────────────────────
// The connection surface used to draw three paragraphs under eight characters,
// and almost none of it was what an owner needed while comparing them. The copy
// is now written at two lengths and the LENGTH IS NOT A CALLER'S FREE CHOICE:
// {@link HostedE2eeVerificationPlacement} is a required argument, both of its
// branches fill both text fields, and both branches carry §13.5's two clauses in
// full. So a surface picks which length it is drawing, never whether the duty
// comes with it — and the short branch ships the pointer at the long one in the
// same object, so the short form is never presented as the whole account.
//
// THE SHORT FORM IS ONLY SHORT BECAUSE OF THAT POINTER, SO THE POINTER HAS TO
// RESOLVE. Settings → Security is owner-only in hosted mode
// (`settingsSections.logic.ts`), and this component draws on any locked
// `web-unsigned` channel whatever role the reader holds. A viewer or an operator
// — or an owner inside the reconnect window, where the role snapshot is not
// fresh and the gate fails closed — reading "Settings → Security explains what
// else this tab cannot check" beside the code is being sent to a section their
// dialog does not list, and §2.2's no-pin reason then lives nowhere they can
// reach. {@link hostedE2eeVerificationPlacement} makes that a decision over the
// SAME predicate the settings nav filters on: where the long form is reachable,
// the surface draws the short one and points at it; where it is not, the surface
// draws the long one itself. Nothing is promised that cannot be delivered, and
// no reader loses a clause.
//
// WHAT LEFT THE SHORT FORM AND WHY. The character count and the grouping
// instruction: the owner is looking at the format while they read it. The bit
// arithmetic and the window-and-one-attempt justification behind it: §13.5's
// entropy "is justified by that window and not by an offline work factor", which
// makes the number a derivation rather than an instruction, and §13.5 forbids
// using the derivation "to strengthen the claims of §2.4 or §17.5" — so the
// number could never do the one job a sentence beside the code has. And the
// parenthetical bounding what a match catches — "anyone standing in for your
// node who is not also serving this page" — which the following clause already
// bounds by naming the party it cannot catch. None of that is a claim; dropping
// it removes no protection an owner was told about.
//
// WHAT NEITHER FORM MAY LOSE. §2.2's web row denies the active-Hub column for
// TWO separate reasons — "the Hub can originate an unsigned NX session **and**
// controls the served code" — and only the second is §13.5's clause. The short
// form carries §13.5's duty; the long form carries both reasons, kept apart, in
// the order that makes clear one needs no substituted bundle at all.
//
// AND NEITHER MAY LOSE THE RESIDUAL DENIAL. It briefly did, on the reading that
// it restated the served-code clause. It does not: §13.5 grounds it in the
// GRINDING model instead — an interposer "authors the client-facing
// `E2EEServerAccept` itself", knows every `sessionBindingHash` input, and "can
// vary its own Noise ephemeral and recompute the `WebSAS` until the two strings
// match, entirely offline" — so "the interposition it catches is bounded by the
// grinding model above" holds for an interposer who is not the Hub and who
// serves no page. A reader who grants an honest bundle and trusts the operator
// has discounted every other clause in both forms; this is the one that still
// applies to them, which is exactly why it is the one that may not be dropped.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THE COPY MAY NOT SAY
// ─────────────────────────────────────────────────────────────────────────────
// §13.5: "Implementations MUST NOT present the `WebSAS` as unforgeable against
// an active interposer", "MUST NOT present the `WebSAS` as an operator-proof or
// E2EE-verification guarantee", and "MUST NOT describe a match as proof that no
// interposer is present".
//
// The forms mirror the sentence `apps/server`'s CLI already prints beside the
// node-side code, so the two halves of the compare-out-of-band flow read as one
// instruction. They diverge in the CLI's final clause only: it ends "a match is
// not proof that no interposer is present", and the scan in
// `HostedRelayTrustNotice.logic.test.ts` is a bare substring match that cannot
// tell that denial from a claim. This module makes the same denial without the
// tokens — "a match does not rule out someone sitting in the middle", in both
// forms, which is also the wording `NODE_SESSION_WEB_SAS_ADVISORY` uses at the
// node end — so no future edit can strand one of them in the affirmative.

import { E2EE_CROCKFORD_ALPHABET, E2EE_WEB_SAS_CHARS } from "@ryco/shared/relayE2eeConstants";

/**
 * Split §13.5's rendered value into its display groups, in derivation order.
 *
 * The rendering is the shared derivation's (`deriveE2eeWebSas`); this only
 * re-splits it, and refuses anything that is not the exact `E2EE_WEB_SAS_CHARS`
 * format — `groups` runs of `charsPerGroup` characters from
 * `E2EE_CROCKFORD_ALPHABET`, joined by a single `separator`. A surface that
 * silently re-grouped, truncated, padded, or lower-cased would show the owner a
 * different string from the one the node CLI prints, in the one ceremony that
 * consists of comparing the two — and §13.5 is explicit that "there is no
 * separate check character; as with the safety number, the fixed length and
 * grouping are the checksum".
 *
 * Returns `[]` for every non-conforming input, including the empty string.
 */
export function e2eeWebSasGroups(display: string): ReadonlyArray<string> {
  const groups = display.split(E2EE_WEB_SAS_CHARS.separator);
  if (groups.length !== E2EE_WEB_SAS_CHARS.groups) return [];
  for (const group of groups) {
    if (group.length !== E2EE_WEB_SAS_CHARS.charsPerGroup) return [];
    for (const character of group) {
      if (!E2EE_CROCKFORD_ALPHABET.includes(character)) return [];
    }
  }
  return groups;
}

/**
 * The entropy the SHIPPED format displays, derived rather than written.
 *
 * §13.5 renders `out` "in five-bit groups; each group indexes
 * `E2EE_CROCKFORD_ALPHABET`", so one character carries exactly
 * `log2(alphabet)` bits and the displayed total is that times
 * `E2EE_WEB_SAS_CHARS.chars`. Both inputs are shipped constants, so a §13.5
 * format change moves this number in the same edit.
 *
 * NO SENTENCE QUOTES IT ANY MORE, AND IT STAYS ANYWAY. The caption that used to
 * state it was cut because §13.5's entropy "is justified by that window and not
 * by an offline work factor" — a derivation, not something an owner acts on. The
 * INVARIANT behind it is not copy: §3.2.1 S11 requires the rendered format to
 * clear `E2EE_WEB_SAS_MIN_DISPLAYED_BITS`, and a format change that quietly
 * dropped below the floor would be a real regression whatever the surface says.
 * `HostedE2eeVerification.logic.test.ts` pins that relationship here, over the
 * constants, which is where it belonged all along.
 */
export const E2EE_WEB_SAS_DISPLAYED_BITS =
  E2EE_WEB_SAS_CHARS.chars * Math.log2(E2EE_CROCKFORD_ALPHABET.length);

/**
 * §13.5's advisory-only disclosure duty, in the fewest words that discharge it.
 *
 * Both clauses, one on each side of the semicolon: what a match catches, and
 * what it cannot protect against. This is the whole of the accompanying text on
 * the connection surface, and it is the reason the surface may draw the code at
 * all — a bare code violates a MUST.
 *
 * IT ENDS WITH A CLAUSE THAT SURVIVES ITS OWN ANTECEDENT. Everything before the
 * last comma is conditioned on the served code: the first clause holds "while
 * the loaded code is honest" and the second names the party that serves it. A
 * reader who grants the condition — an owner running their own Hub, or one who
 * trusts their org's operator — would otherwise be left with a sentence that
 * states no limit at all, which is the reading §13.5's third MUST NOT exists to
 * stop. The residual denial holds whether or not the bundle is honest.
 *
 * IT IS ALSO WHERE THE POINTER AT THE COMPARISON LIVES. `HostedRelayTrustNotice`
 * mounts on surfaces that draw no code and therefore may not mention one, so the
 * instruction to compare belongs here, in the value that renders only where the
 * characters do. It says "for this session" for the same reason the long form
 * does: §13.5 makes the string session-bound — "it changes on every channel" —
 * and `ryco e2ee sessions` prints a row per channel, so an owner with several
 * live channels is looking for one row and not for a value in a list.
 */
export const E2EE_WEB_SAS_ADVISORY =
  "Compare this code with the one your node's CLI shows for this session. A match catches " +
  "accidental wrong-node routing and some network interposition while the loaded code is honest; " +
  "it cannot protect against the Hub operator, who serves this page, and it does not rule out " +
  "someone sitting in the middle.";

/**
 * Where the rest of the account is, so the short form is never the whole story.
 *
 * It ships in the same object as {@link E2EE_WEB_SAS_ADVISORY} and is required
 * for the same reason: a short form whose pointer a caller could drop is a short
 * form that silently becomes the only thing an owner is ever offered.
 *
 * IT NAMES A SECTION, SO THE SECTION HAS TO BE THERE. `SettingsDialog.test.ts`
 * asserts this sentence contains the label the settings nav actually draws for
 * `security`, so renaming the section fails a test instead of stranding the
 * pointer; {@link hostedE2eeVerificationPlacement} keeps it from being drawn for
 * a reader whose dialog does not list that section at all; and
 * `settingsSearchIndex.ts` carries the section's rows, so a reader who searches
 * for what this sentence names is not told it does not exist.
 */
export const E2EE_WEB_SAS_MORE =
  "Settings → Connections → Node security explains what else this tab cannot check.";

/**
 * The long form, for the one surface an owner opens to read about this.
 *
 * IT NAMES BOTH OF §2.2'S REASONS AND KEEPS THEM APART. The web row is denied
 * the active-Hub column twice — "the Hub can originate an unsigned NX session
 * **and** controls the served code" — and the two have different preconditions.
 * The first needs nothing at all (§8.10: NX client→node is "never authenticated
 * at the Noise level … a Hub can originate an NX session", and node→client
 * encrypts "to an **anonymous ephemeral initiator** — any active party,
 * including the Hub"), and this tier holds no pin of any kind (§2.3's web
 * bullet, §6.3, §13.1) with which to tell the far end apart. The second is
 * §2.4's served-code ceiling. Collapsing them into one leaves a reader who
 * trusts the bundle concluding the Hub is outside the channel; it is not.
 *
 * THE NO-PIN REASON IS THE TAB'S, NOT THE MATCH'S. This sentence used to read
 * "it cannot tell you whether the far end is your machine or the Hub standing in
 * for it" with "a match" as its subject — which is the one thing the ceremony is
 * for. §13.5 opens the same paragraph by instructing it ("the owner compares the
 * two out of band"), and the first sentence here has just said a match catches
 * some network interposition; telling the reader two lines later that the
 * comparison cannot speak to who the far end is makes performing it pointless.
 * The true statement is `HostedRelayTrustNotice`'s — the TAB pins no node
 * identity, which is why the comparison is the only evidence there is — so §2.2's
 * first reason is stated with the subject it belongs to.
 *
 * IT DOES NOT COUNT ITS LIMITS. "Two separate things it cannot do" closed the
 * list at two, and both of them were the Hub; §13.5's residual is neither, so an
 * enumerating frame asserted a completeness the section denies. The limits are
 * listed without a count and the residual denial closes them.
 *
 * It carries no entropy arithmetic and no format instruction, for the reason the
 * short form does not: an owner reading Settings wants what this protects them
 * from and what it does not, not the derivation.
 */
export const E2EE_WEB_SAS_DETAIL =
  "Compare this code with the one your node's CLI shows for this session. A match catches " +
  "accidental wrong-node routing and some network interposition while the loaded code is honest. " +
  "This tab pins no node identity, so that comparison is the only thing that speaks to whether " +
  "the far end is your machine or the Hub standing in for it — and it cannot protect against the " +
  "Hub operator, who serves this page and could serve code that completes the same handshake and " +
  "displays this same code anyway. A match does not rule out someone sitting in the middle.";

/**
 * What to do about it, on the surface that has room to say how.
 *
 * The long form's counterpart to {@link E2EE_WEB_SAS_MORE}: the short form's
 * second field points at where to read more, and this one points at the command
 * that produces the other half of the comparison. Both branches fill the field,
 * so neither can ship a code with one sentence and a gap.
 */
export const E2EE_WEB_SAS_COMPARE =
  "Run `ryco e2ee sessions` on the machine running the node to read its end of the comparison.";

/**
 * What the surface says when the channel locked but no §13.5 code reached it.
 *
 * §13.5's duty is a DISPLAY duty, and the derivation is allowed to fail without
 * costing the channel: `publishWebVerificationCode` in
 * `packages/client-runtime/src/relay/relayE2eeInitiator.ts` returns silently on
 * a derivation failure, and {@link hostedE2eeVerificationView} returns `null` for
 * anything that is not the exact display format. Rendering nothing in that state
 * failed OPEN on the duty: the surface kept the strongest claim this tier can
 * make while the one check behind it had quietly gone missing, and an owner
 * looking for the value could not tell "this build shows none" from "this
 * session produced none". The absence gets a sentence instead.
 */
export const E2EE_WEB_SAS_UNAVAILABLE =
  "No session code is available for this channel, so there is nothing here to compare against " +
  "your node's CLI.";

/**
 * Which length is being drawn, and therefore which second sentence comes with
 * it.
 *
 * `inline` is the short form and its pointer at Settings → Security: the node
 * menu, where an owner is mid-comparison and has room for one line. `settings`
 * is the long form and the command that reads the node's end — the page the
 * pointer leads to, and the form any surface must draw when that page is not
 * one this reader can open ({@link hostedE2eeVerificationPlacement}).
 *
 * IT IS A REQUIRED ARGUMENT WITH NO DEFAULT. A default would make the long form
 * opt-in, and the surface most likely to forget to opt in is the one an owner
 * navigated to specifically to read it.
 */
export type HostedE2eeVerificationPlacement = "inline" | "settings";

/**
 * The short form only where its pointer resolves, and the long form everywhere
 * else.
 *
 * `inline` promises that Settings → Security carries the rest of the account.
 * That section is owner-only in hosted mode and fails closed while the role
 * snapshot is stale, while `HostedE2eeVerification` draws on any locked
 * `web-unsigned` channel — so for a viewer, an operator, or an owner
 * mid-reconnect the promise is false and §2.2's no-pin reason, which lives only
 * in the long form, is reachable nowhere. Rather than shorten the account for those readers, they get
 * the long one where they are standing: the same two required fields, with the
 * command that produces the other end of the comparison in place of a pointer at
 * a section their dialog does not list.
 *
 * The caller passes the answer from `settingsSectionReachable("security", …)`
 * rather than a role, so this cannot drift from the gate the settings nav
 * filters on — it is the same predicate, asked once more.
 */
export function hostedE2eeVerificationPlacement(
  securitySettingsReachable: boolean,
): HostedE2eeVerificationPlacement {
  return securitySettingsReachable ? "inline" : "settings";
}

/**
 * Everything a surface needs to render §13.5, and nothing it can render without.
 *
 * All four fields are required. {@link HostedE2eeVerificationView.advisory} in
 * particular is not optional and has no default: a caller holding this object
 * has already been handed the denial, so the only way to draw the code without
 * it is to deliberately drop a field.
 */
export interface HostedE2eeVerificationView {
  /** The validated groups, in derivation order. */
  readonly groups: ReadonlyArray<string>;
  /**
   * The groups re-joined with the format's own separator — what a surface
   * draws, so no renderer picks a separator of its own.
   */
  readonly display: string;
  /** §13.5's duty at this placement's length. Both clauses, either way. */
  readonly advisory: string;
  /** Where the rest of it is (`inline`), or what to do about it (`settings`). */
  readonly more: string;
}

/** The two sentences each placement ships, so neither can travel half-dressed. */
const PLACEMENT_TEXT = {
  inline: { advisory: E2EE_WEB_SAS_ADVISORY, more: E2EE_WEB_SAS_MORE },
  settings: { advisory: E2EE_WEB_SAS_DETAIL, more: E2EE_WEB_SAS_COMPARE },
} as const satisfies Record<
  HostedE2eeVerificationPlacement,
  { readonly advisory: string; readonly more: string }
>;

/**
 * Every placement, for the scans that read them all.
 *
 * A placement added to the union becomes a required key of `PLACEMENT_TEXT` and
 * so stops the repository compiling until someone writes it both sentences. This
 * makes the same fact enumerable at runtime, and both gates are BUILT from it
 * rather than from a list of constant names: `HostedRelayTrustNotice.logic.test`
 * derives its prohibited-claims corpus by rendering every placement, and
 * `HostedE2eeVerification.logic.test` runs §13.5's clause assertions over the
 * same loop. A new length is therefore scanned and duty-checked on the day it
 * compiles rather than the day someone remembers to list it.
 */
export const HOSTED_E2EE_VERIFICATION_PLACEMENTS = Object.keys(
  PLACEMENT_TEXT,
) as ReadonlyArray<HostedE2eeVerificationPlacement>;

/**
 * The §13.5 view for the current channel, or `null` when there is nothing this
 * tier may draw.
 *
 * `null` for an absent code and for anything that is not the exact display
 * format. A malformed value means this client did not derive the string the node
 * is showing, and half a comparison is worse than none: the owner would compare
 * something, see it differ, and learn nothing about why.
 */
export function hostedE2eeVerificationView(
  code: string | null,
  placement: HostedE2eeVerificationPlacement,
): HostedE2eeVerificationView | null {
  if (code === null) return null;
  const groups = e2eeWebSasGroups(code);
  if (groups.length === 0) return null;
  const { advisory, more } = PLACEMENT_TEXT[placement];
  return {
    groups,
    display: groups.join(E2EE_WEB_SAS_CHARS.separator),
    advisory,
    more,
  };
}
