import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { E2EE_WEB_SAS_CHARS } from "@ryco/shared/relayE2eeConstants";
import { describe, expect, it } from "vite-plus/test";

import {
  HOSTED_E2EE_CHANNEL_STATUSES,
  type WebHostedE2eeChannelStatus,
} from "../../hostedHub/connectionStatus";
import {
  hostedE2eeVerificationView,
  E2EE_WEB_SAS_ADVISORY,
  E2EE_WEB_SAS_COMPARE,
  E2EE_WEB_SAS_DETAIL,
  E2EE_WEB_SAS_MORE,
  E2EE_WEB_SAS_UNAVAILABLE,
  HOSTED_E2EE_VERIFICATION_PLACEMENTS,
} from "./HostedE2eeVerification.logic";
import {
  hostedRelayTrustDisclosure,
  hostedRelayTrustDisclosureStatus,
  HOSTED_RELAY_TRUST_DISCLOSURE_STATES,
} from "./HostedRelayTrustNotice.logic";

/**
 * The prohibited-claims scan over every user-facing string this slice ships.
 *
 * Every sentence in these two modules is a security claim, and
 * `docs/relay-e2ee-protocol.md` bounds all of them. The scan is deliberately a
 * bare, case-insensitive substring match: it cannot tell a claim from its
 * negation, so the modules under test do not use the banned tokens in either
 * form. That direction is the safe one — a scan that tried to allow negations
 * would pass "this is end-to-end encrypted" the day someone deleted a "not".
 */

/** A well-formed §13.5 rendering, built from the constants rather than typed. */
const VALID_WEB_SAS = ["ABCD", "EFGH"].join(E2EE_WEB_SAS_CHARS.separator);

/**
 * Every string a user can read, flattened.
 *
 * THE §13.5 COPY IS IN HERE AT EVERY LENGTH IT SHIPS, AND THE LENGTHS ARE
 * ENUMERATED RATHER THAN LISTED. Splitting one sentence into a short form, a
 * long form, and the two pointers that carry them made four places a banned
 * claim could be written where there had been two — and naming those four here
 * would have left the FIFTH unscanned: a placement added to
 * `HOSTED_E2EE_VERIFICATION_PLACEMENTS` compiles as soon as it is written two
 * sentences, and a hand-written roster in this file has no way to notice. Both
 * fields of every placement are rendered through the shipped builder instead, so
 * a new length is scanned on the day it exists.
 */
function everyDisclosure(): ReadonlyArray<{ readonly where: string; readonly text: string }> {
  return [
    ...HOSTED_RELAY_TRUST_DISCLOSURE_STATES.map((status) => ({
      where: `disclosure(${status})`,
      text: hostedRelayTrustDisclosure(status).body,
    })),
    ...HOSTED_E2EE_VERIFICATION_PLACEMENTS.flatMap((placement) => {
      const view = hostedE2eeVerificationView(VALID_WEB_SAS, placement);
      // The code is built from the format constants, so a `null` here means the
      // splitter stopped accepting its own format — a failure worth reading as
      // itself rather than as an empty scan that passes everything.
      if (view === null) throw new Error(`no §13.5 view for the ${placement} placement`);
      return [
        { where: `webSas(${placement}).advisory`, text: view.advisory },
        { where: `webSas(${placement}).more`, text: view.more },
      ];
    }),
    { where: "webSasUnavailable", text: E2EE_WEB_SAS_UNAVAILABLE },
  ];
}

/** Native channel states this tier is fenced out of (`connectionStatus.ts`). */
const NATIVE_ONLY_STATUSES = ["verified", "account-trusted", "unverified"] as const;

describe("the hosted relay trust disclosure is a function of the channel state", () => {
  it("has copy for every channel state this tier can be in, and only those", () => {
    // Exhaustive over the SHARED enumeration, so a member added to
    // `HostedE2eeChannelStatus` fails here at runtime as well as at compile
    // time: `WebHostedE2eeChannelStatus` is `Exclude<…, "verified" |
    // "unverified">`, so a new member becomes a required key of the `Record`
    // backing `hostedRelayTrustDisclosure` in the same edit.
    const expected = HOSTED_E2EE_CHANNEL_STATUSES.filter(
      (status): status is WebHostedE2eeChannelStatus =>
        !(NATIVE_ONLY_STATUSES as ReadonlyArray<string>).includes(status),
    );
    expect([...HOSTED_RELAY_TRUST_DISCLOSURE_STATES].toSorted()).toEqual([...expected].toSorted());
    for (const status of expected) {
      expect(hostedRelayTrustDisclosure(status).body.length, status).toBeGreaterThan(0);
    }
  });

  it("says something different in every state", () => {
    // A selector that returned one string for every state would pass every
    // content assertion below while shipping exactly the defect this replaced.
    const bodies = HOSTED_RELAY_TRUST_DISCLOSURE_STATES.map(
      (status) => hostedRelayTrustDisclosure(status).body,
    );
    expect(new Set(bodies).size).toBe(bodies.length);
  });

  it("never retires into the sentence it replaced", () => {
    // §2.2: the retired constant asserts the opposite of what a locked NX
    // channel makes true, so no state may resurrect it — including the ones
    // where it happens to be accurate.
    for (const { where, text } of everyDisclosure()) {
      expect(text, where).not.toContain("not application-level end-to-end encrypted");
    }
  });
});

describe("which channel the disclosure speaks for", () => {
  it("discloses the selected node's channel while it has one", () => {
    for (const status of ["negotiating", "web-unsigned", "legacy"] as const) {
      expect(hostedRelayTrustDisclosureStatus(status, ["legacy", "web-unsigned"]), status).toBe(
        status,
      );
    }
  });

  it("says no channel is open only while none is open in this tab", () => {
    expect(hostedRelayTrustDisclosureStatus("unavailable", [])).toBe("unavailable");
    // The cursor can sit on a node with no channel while other nodes' channels
    // stay open: "No node channel is open in this tab" would then be false.
    expect(hostedRelayTrustDisclosureStatus("unavailable", ["web-unsigned"])).toBe("web-unsigned");
  });

  it("discloses the weakest channel open in this tab, never a stronger one", () => {
    expect(
      hostedRelayTrustDisclosureStatus("unavailable", ["web-unsigned", "negotiating", "legacy"]),
    ).toBe("legacy");
    expect(hostedRelayTrustDisclosureStatus("unavailable", ["web-unsigned", "negotiating"])).toBe(
      "negotiating",
    );
  });
});

describe("prohibited claims", () => {
  it.each([
    // §2.2/§2.4: this tier may never spell the native row's claim, qualified or
    // not — the scan cannot judge qualification, so the phrase is absent.
    "end-to-end encrypted",
    // §13.5: "MUST NOT present the `WebSAS` as an operator-proof or
    // E2EE-verification guarantee". §2.2's `verified` row is native-only.
    "verified",
    // §13.5: "MUST NOT describe a match as proof that no interposer is
    // present" — and "operator-proof" carries the same token.
    "proof",
    "no interposer",
    // The same MUST NOT written affirmatively. Every clause on this tier is
    // bounded — by an honest bundle, by the operator, or by the grinding window
    // — so nothing here may report that a match, a latch, or a lock RULES OUT
    // anything. The negations the copy does make read "does not rule out", which
    // this does not match.
    "rules out",
    // §2.6/§2.4: nothing here may be presented as unconditional.
    "cannot be intercepted",
    "unforgeable",
    "guaranteed",
  ])("never says %j", (phrase) => {
    for (const { where, text } of everyDisclosure()) {
      expect(text.toLowerCase(), `${where} says ${phrase}`).not.toContain(phrase);
    }
  });

  it("never describes the web latch as durable, cross-session, or Hub-resistant", () => {
    // §2.3: "It MUST NOT describe the web latch as durable, cross-session, or
    // Hub-resistant." §17.5: the web latch and the durable native latch "MUST
    // NOT be described in the same terms".
    for (const { where, text } of everyDisclosure()) {
      const lower = text.toLowerCase();
      for (const phrase of [
        "durable",
        "persists",
        "persistent",
        "remembers",
        "across sessions",
        "cross-session",
        "between sessions",
        "survives",
        "saved",
        "stored",
      ]) {
        expect(lower, `${where} says ${phrase}`).not.toContain(phrase);
      }
    }
  });
});

describe("§12.2 honest labeling of the fallback", () => {
  it("calls the fallen-back channel legacy and claims nothing about encryption", () => {
    const { body, tone } = hostedRelayTrustDisclosure("legacy");
    // "A client that falls back MUST label the channel **legacy** in every
    // user-facing surface and diagnostic and MUST NOT display any E2EE or
    // active-Hub confidentiality claim for it."
    expect(body.toLowerCase()).toContain("legacy");
    expect(body.toLowerCase()).toContain("plaintext");
    expect(body.toLowerCase()).not.toContain("encrypted channel to");
    expect(tone).toBe("caution");
    // Positive content, not just the label: who can read it, and what closes it.
    // Without these the sentence could shrink to "This channel fell back to
    // legacy plaintext." and still pass every check above.
    expect(body.toLowerCase()).toContain("readable by the hub");
    expect(body.toLowerCase()).toContain("only your node can refuse plaintext");
  });

  it("does not blame the node for a fallback this client cannot attribute", () => {
    // §12.2 covers both "a missing or stripped advertisement" and one "the node
    // itself could not emit", and this client cannot tell them apart.
    const { body } = hostedRelayTrustDisclosure("legacy");
    expect(body.toLowerCase()).toContain("cannot tell");
  });
});

describe("§2.3 and §2.4 in the encrypted state", () => {
  const { body, tone } = hostedRelayTrustDisclosure("web-unsigned");

  it("states §2.4's served-code ceiling in its own terms", () => {
    const lower = body.toLowerCase();
    // "The Hub serves every byte of the web application's JavaScript. A
    // malicious Hub may serve code that completes the genuine node handshake,
    // displays the genuine session `WebSAS`, and separately exfiltrates
    // plaintext or traffic keys."
    expect(lower).toContain("cannot protect against the hub operator");
    expect(lower).toContain("every byte of this page's javascript");
    expect(lower).toContain("completes the same handshake");
  });

  it("states the OTHER half of §2.2's active-Hub denial, which needs no served code", () => {
    // §2.2's web row: "**Not protected** — the Hub can originate an unsigned NX
    // session **and** controls the served code". Copy that named only the second
    // left honest served code as the sole stated condition, so a reader with no
    // reason to doubt the bundle concluded the Hub was outside the channel.
    // §8.10: NX client→node is "never authenticated at the Noise level … a Hub
    // can originate an NX session", and NX node→client encrypts "to an
    // **anonymous ephemeral initiator** — any active party, including the Hub".
    const lower = body.toLowerCase();
    expect(lower).toContain("pins no node identity");
    expect(lower).toContain("your machine or the hub standing in for it");
  });

  it("never asserts the peer identity this tier cannot establish", () => {
    // §2.3's web bullet: the web client "retains no durable latch, no pin of any
    // kind" (§6.3, §13.1), so what a locked channel here validated is a
    // self-signed first-contact statement and "your node" is a claim about the
    // far end that nothing on this tier checked.
    expect(body).not.toContain("This tab and your node");
    // The two places the copy may still say "your node" are the ones that are
    // about the NODE'S OWN policy rather than about who answered this channel.
    expect(body).toContain("Only your node can close the plaintext path");
  });

  it("states §2.3's web bullet: in-memory only, empty again every session", () => {
    const lower = body.toLowerCase();
    expect(lower).toContain("in memory only");
    expect(lower).toContain("after every reload");
    expect(lower).toContain("worth nothing against that operator");
    // "Only node-enforced effective `requireE2EE` closes the plaintext path for
    // web."
    expect(lower).toContain("only your node can close the plaintext path");
  });

  it("is qualified about what the encryption is worth", () => {
    // §2.2's web row protects passive and retroactive read only "while the
    // served web code is honest", so the sentence carries the condition rather
    // than asserting the property.
    expect(body.toLowerCase()).toContain("while the code this page is running is honest");
  });

  it("never wears a success tone", () => {
    // §2.2: no stronger claim for a weaker configuration — including by colour.
    expect(tone).toBe("advisory");
    expect(hostedRelayTrustDisclosure("unavailable").tone).toBe("caution");
    expect(hostedRelayTrustDisclosure("negotiating").tone).toBe("caution");
  });
});

describe("the states with no channel", () => {
  it("makes no E2EE claim in either direction before a channel exists", () => {
    for (const status of ["unavailable", "negotiating"] as const) {
      const lower = hostedRelayTrustDisclosure(status).body.toLowerCase();
      expect(lower, status).toContain("hub");
      expect(lower, status).not.toContain("ciphertext");
      // `unavailable` is the sign-in and directory state: it must not read as a
      // downgrade report, which is the claim `legacy` alone is allowed to make.
      expect(lower, status).not.toContain("fell back");
    }
  });

  it("says what the Hub can do with the payload, and not merely that a Hub exists", () => {
    // The negative scans above pass for any unique non-empty sentence that
    // contains "hub" — including "The Hub relays this.", which deletes the whole
    // substantive claim. `unavailable` is the sentence a first-time reader meets
    // on the sign-in surface, the node directory, and the install instructions,
    // before any channel exists, so it is the one that most needs pinning.
    const unavailable = hostedRelayTrustDisclosure("unavailable").body.toLowerCase();
    expect(unavailable).toContain("forwards what you send in a form it can read");
    expect(unavailable).toContain("not to log or keep it");

    // §4.4 `negotiating`: nothing is locked and nothing has been released.
    const negotiating = hostedRelayTrustDisclosure("negotiating").body.toLowerCase();
    expect(negotiating).toContain("released nothing");
    expect(negotiating).toContain("the hub can read");
  });
});

/**
 * THE DOCUMENT AND THE APP ARE ONE CLAIM, AND THIS IS THE ONLY THING JOINING THEM.
 *
 * `docs/hosted-hub-client.md` carried its own three-sentence confidentiality
 * paragraph — a verbatim twin of the constant this module replaced — and nothing
 * checked that the two agreed. The browser suites do import the copy, so they
 * catch a component that renders the wrong string; they structurally cannot
 * catch a DOCUMENT that says something the component never said, because they
 * never read the document. That is exactly how the repository ended up asserting
 * in public that a hosted channel "is not application-level end-to-end
 * encrypted" while the shipped tier was negotiating one.
 *
 * So the document quotes the shipped strings between named markers, and the
 * assertions below read them back. A divergence is a red test rather than a
 * review miss, and the fix is to re-quote rather than to re-word.
 */

const REPO_ROOT = new URL("../../../../../", import.meta.url);

function readRepoFile(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, REPO_ROOT)), "utf8");
}

const HOSTED_HUB_CLIENT_DOC = readRepoFile("docs/hosted-hub-client.md");

/**
 * Markdown prose as one line, so a hard-wrapped quotation compares equal to the
 * single-line constant it quotes.
 *
 * Blockquote markers are stripped and every whitespace run collapses to one
 * space. Both sides of every comparison go through this, so the check is over
 * WORDS and never over where a maintainer chose to break a line — the one
 * difference that carries no meaning, and the one a wrapping change would
 * otherwise turn into a failing test nobody could act on.
 */
function normalizeProse(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/^\s*>\s?/, ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Every `<!-- KIND:NAME -->` … `<!-- /KIND:NAME -->` block in a document.
 *
 * Two kinds, because the two sets are checked differently: `shipped-copy` is
 * keyed by channel state and is asserted EXHAUSTIVE against the tier's states,
 * while `shipped-text` names one constant each and would fail that assertion.
 */
function quotedBlocks(markdown: string, kind: string): ReadonlyMap<string, string> {
  const quoted = new Map<string, string>();
  const block = new RegExp(
    `<!--\\s*${kind}:([a-z-]+)\\s*-->([\\s\\S]*?)<!--\\s*/${kind}:\\1\\s*-->`,
    "g",
  );
  for (const [, name, body] of markdown.matchAll(block)) {
    // Both groups are mandatory in the pattern, so neither can be absent at
    // runtime; a dynamically built `RegExp` simply does not carry that to the
    // type checker. Skipping rather than asserting keeps the failure in the
    // exhaustiveness check below, where it reads as "the document is missing a
    // block" instead of as a thrown error inside a helper.
    if (name === undefined || body === undefined) continue;
    quoted.set(name, normalizeProse(body));
  }
  return quoted;
}

describe("docs/hosted-hub-client.md quotes the copy this slice ships", () => {
  it("quotes every channel state this tier can be in, and only those", () => {
    // Exhaustive in both directions. A state added to the tier fails here until
    // the document gains a paragraph for it, and a paragraph for a state that no
    // longer exists fails too — a document that quoted three of four states
    // would otherwise pass every verbatim check below while leaving the fourth
    // free to drift.
    const quoted = [...quotedBlocks(HOSTED_HUB_CLIENT_DOC, "shipped-copy").keys()].toSorted();
    expect(quoted).toEqual([...HOSTED_RELAY_TRUST_DISCLOSURE_STATES].toSorted());
  });

  it("quotes each disclosure verbatim", () => {
    const quoted = quotedBlocks(HOSTED_HUB_CLIENT_DOC, "shipped-copy");
    for (const status of HOSTED_RELAY_TRUST_DISCLOSURE_STATES) {
      expect(quoted.get(status), status).toBe(
        normalizeProse(hostedRelayTrustDisclosure(status).body),
      );
    }
  });

  it("quotes §13.5's copy verbatim, at every length it ships", () => {
    // The document describes the compare-to-CLI flow, and the sentences bounding
    // what a match is worth are as much a security claim as the disclosure is.
    // Paraphrasing them here would rebuild the drifting second copy this slice
    // exists to remove, one section further down the same file.
    //
    // ALL FOUR, because the split into a short and a long form is exactly where
    // a document falls behind: quoting only the inline line would have let the
    // long form — the one carrying §2.2's second reason — drift unwatched.
    const quoted = quotedBlocks(HOSTED_HUB_CLIENT_DOC, "shipped-text");
    for (const [name, text] of [
      ["web-sas-advisory", E2EE_WEB_SAS_ADVISORY],
      ["web-sas-more", E2EE_WEB_SAS_MORE],
      ["web-sas-detail", E2EE_WEB_SAS_DETAIL],
      ["web-sas-compare", E2EE_WEB_SAS_COMPARE],
    ] as const) {
      expect(quoted.get(name), name).toBe(normalizeProse(text));
    }
  });
});

/**
 * THE RETIRED CLAIM, SWEPT OVER THE REPOSITORY RATHER THAN OVER A LIST OF FILES.
 *
 * This guard began as a table of (path, phrase) pairs over three files, and BOTH
 * halves of that shape were blind in the same way the browser suites are.
 *
 * Enumerating PATHS cannot see a fourth file, and the claim was in fact written
 * in eight: the three the table named, plus two approved design specs that still
 * REQUIRED it of documents this repository ships, two checklist bullets that
 * still instructed an implementer to write it, and a stale future tense in the
 * canonical relay protocol. The specs are the sharpest of those, because
 * `docs/relay-architecture.html` is not doc-only — `apps/web` imports it as a
 * Vite `?url` asset and the desktop app bundles it — so a page regenerated
 * against its governing spec would have shipped the retired claim back to users.
 *
 * Enumerating PHRASES cannot see a paraphrase. Re-wording "they are not
 * application-level end-to-end encrypted" to "hosted channels are not encrypted
 * end to end" passed every row while the file went on stating the claim.
 *
 * So this walks the repository's text files and matches SHAPES. The two sites
 * that carry the retired sentence on purpose are allowlisted by path: a negative
 * test fixture and a change record are the correct homes for a retired claim,
 * and rewording either to satisfy a scan would delete the check it exists to be.
 *
 * WHAT IT DELIBERATELY DOES NOT COVER, so nobody reads a green run as more than
 * it is. The shapes are denials, and two neighbouring defects are not denials:
 * a requirement phrased positively ("so installing cannot be mistaken for
 * creating an end-to-end encrypted connection" — the wrong requirement, but not
 * the retired sentence), and a stale future tense ("allows LATER application-
 * level end-to-end encryption", which two historical documents quote verbatim as
 * a quotation of the relay protocol and which a scan therefore cannot forbid
 * without ordering an edit inside a quoted record). Both were corrected by hand
 * in the same change that widened this guard; neither has a mechanical check.
 */

/** Where the walk starts, and what it refuses to descend into. */
const SCAN_ROOTS = ["docs", "apps", "packages"] as const;
const SCAN_EXTENSIONS = [".md", ".html", ".ts", ".tsx"] as const;
const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".output",
  ".turbo",
  ".vite",
  "Pods",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
]);

/**
 * The shapes, not the sentences.
 *
 * Each is a denial of application-level payload encryption over a relay channel,
 * which is the claim this tier outgrew. They are deliberately anchored on the
 * denial itself — `not … end-to-end encrypted`, `adds no … encryption` — so a
 * synonym for "hosted channel" or a different sentence frame does not slip past,
 * while ordinary present-tense prose about the shipped layer does not trip them.
 */
const RETIRED_CLAIM_SHAPES: ReadonlyArray<{ readonly name: string; readonly pattern: RegExp }> = [
  {
    name: "denies application-level encryption of a relayed channel",
    pattern:
      /\bnot\s+(?:an?\s+)?application-(?:level|layer)\s+end-to-end\s+encr(?:ypted|yption)\b/i,
  },
  {
    name: "denies end-to-end encryption in plain words",
    pattern: /\b(?:is|are|was|were)\s+not\s+end[-\s]to[-\s]end\s+encrypted\b/i,
  },
  {
    name: "denies end-to-end encryption with the qualifier trailing",
    pattern: /\bnot\s+encrypted\s+end[-\s]to[-\s]end\b/i,
  },
  {
    name: "denies that a surface or delivery provides end-to-end encryption",
    pattern:
      /\b(?:does\s+not\s+create|adds?\s+no|provides?\s+no|offers?\s+no)\s+(?:an?\s+)?(?:application-(?:level|layer)\s+)?end-to-end\s+(?:payload\s+)?encr(?:ypted|yption)\b/i,
  },
  {
    name: "the retired trusted-relay sentence's second half",
    pattern: /\bobserve\s+forwarded\s+bytes\b/i,
  },
];

/**
 * A literal every shape above requires verbatim. `normalizeForScan` only strips
 * line leaders and collapses whitespace, so it cannot create one inside a word,
 * and a file without either cannot match: most of the repository skips the
 * normalization. The paraphrase test below keeps a new shape from outgrowing it.
 */
const SCAN_TRIGGER = /encr|forwarded/i;

/**
 * The two sites that hold the retired sentence deliberately, and why each must
 * keep holding it.
 */
const RETIRED_CLAIM_ALLOWLIST: ReadonlyArray<{ readonly path: string; readonly why: string }> = [
  {
    path: "apps/web/test/hostedConnectionVocabulary.ts",
    why: "the negative fixture four browser suites assert is nowhere on the page",
  },
  {
    path: "apps/web/src/components/hostedHub/HostedRelayTrustNotice.logic.ts",
    why: "the change record explaining, in the past tense, why this module is a selector",
  },
];

/** This file, which quotes the shapes it forbids. */
const SCAN_SELF_PATH = "apps/web/src/components/hostedHub/HostedRelayTrustNotice.logic.test.ts";

/**
 * Prose with comment leaders stripped as well as blockquote markers.
 *
 * `normalizeProse` is enough for Markdown; a wrapped `//` or `*` comment needs
 * this, because the leader lands mid-sentence when the lines are joined and
 * would break a match through the middle of the very claim being searched for.
 */
function normalizeForScan(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/^\s*(?:\/\/|\*|#{1,6}|>)\s?/, ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

let scanTargets: readonly string[] | undefined;

/** The repository walk, done once for the tests below. */
function collectScanTargets(): readonly string[] {
  if (scanTargets) return scanTargets;
  const found: string[] = [];
  const visit = (relativeDirectory: string): void => {
    let entries;
    try {
      entries = readdirSync(fileURLToPath(new URL(relativeDirectory, REPO_ROOT)), {
        withFileTypes: true,
      });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
        visit(`${relativeDirectory}${entry.name}/`);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!SCAN_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) continue;
      found.push(`${relativeDirectory}${entry.name}`);
    }
  };
  for (const root of SCAN_ROOTS) visit(`${root}/`);
  scanTargets = found;
  return found;
}

describe("no public file still carries the retired claim", () => {
  const allowed = new Set(RETIRED_CLAIM_ALLOWLIST.map(({ path }) => path));

  it("walks the repository's text files rather than a list of paths", () => {
    // A broken walk would make every assertion below pass vacuously, which is
    // the failure mode a scan has and a hardcoded table does not.
    const targets = collectScanTargets();
    expect(targets.length).toBeGreaterThan(500);
    for (const required of [
      "docs/hosted-hub-client.md",
      "docs/relay-architecture.html",
      "docs/relay-protocol.md",
      "docs/hosted-mobile-pwa-qualification.md",
      "docs/superpowers/plans/2026-07-19-hosted-mobile-pwa-experience.md",
      "docs/superpowers/specs/2026-07-29-desktop-hub-advanced-settings-and-relay-atlas-design.md",
      ...RETIRED_CLAIM_ALLOWLIST.map(({ path }) => path),
    ]) {
      expect(targets, required).toContain(required);
    }
  });

  // Reads every text file in the repository, which on a loaded CI runner takes longer than the
  // default five seconds.
  it("finds it in no file outside the two deliberate sites", () => {
    const offenders: string[] = [];
    for (const path of collectScanTargets()) {
      if (path === SCAN_SELF_PATH || allowed.has(path)) continue;
      const text = readRepoFile(path);
      if (!SCAN_TRIGGER.test(text)) continue;
      const prose = normalizeForScan(text);
      for (const { name, pattern } of RETIRED_CLAIM_SHAPES) {
        if (pattern.test(prose)) offenders.push(`${path}: ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  }, 30_000);

  it("keeps the allowlist honest: each allowed site still carries the sentence", () => {
    // An allowlist entry for a file that no longer states the claim is a hole
    // someone could later fill without the scan objecting.
    for (const { path, why } of RETIRED_CLAIM_ALLOWLIST) {
      const prose = normalizeForScan(readRepoFile(path));
      const carried = RETIRED_CLAIM_SHAPES.some(({ pattern }) => pattern.test(prose));
      expect(carried, `${path} is allowlisted as ${why}`).toBe(true);
    }
  });

  it("catches the paraphrases the retired phrase table could not", () => {
    // The table matched exact strings. These are the same claim in wordings no
    // row of it contained, and each must be caught by shape.
    for (const paraphrase of [
      "Hosted channels are not encrypted end to end.",
      "Ryco relay sessions are not end-to-end encrypted.",
      "Installing the app does not create end-to-end encryption.",
      "This tier adds no application-level end-to-end encryption.",
      "The relay may observe forwarded bytes while routing them.",
    ]) {
      const caught = RETIRED_CLAIM_SHAPES.some(({ pattern }) => pattern.test(paraphrase));
      expect(caught, paraphrase).toBe(true);
      // The scan only normalizes files the trigger admits.
      expect(SCAN_TRIGGER.test(paraphrase), paraphrase).toBe(true);
    }
  });
});

describe("the disclosure may not point at what the surface under it does not draw", () => {
  it("refers to no session code, on any state", () => {
    // This notice mounts at six sites across BOTH presentation tiers, and
    // §13.5's `WebSAS` renders at only two surfaces (the desktop thread
    // connection popover, where `HostedConnectionControls.tsx` mounts
    // `HostedE2eeVerification`, and Settings → Security, where
    // `NodeSecuritySettings.tsx` draws this tab's own channel; `AGENTS.md`
    // freezes the web phone tier). Copy here that
    // presupposed a comparison value on the page read identically on the phone
    // connection sheet, which draws none: it told that reader a §13.5
    // comparison existed and that a hostile Hub could forge it, while handing
    // them nothing to compare. The pointer lives with the comparison instead
    // (`HostedE2eeVerification.logic.ts`), which renders only where the
    // characters do.
    for (const status of HOSTED_RELAY_TRUST_DISCLOSURE_STATES) {
      const lower = hostedRelayTrustDisclosure(status).body.toLowerCase();
      expect(lower, status).not.toContain("session code");
      expect(lower, status).not.toContain("compare");
    }
    // …and the sentence that DOES point at it is still shipped, beside the code.
    expect(E2EE_WEB_SAS_ADVISORY.toLowerCase()).toContain("compare this code");
  });
});
