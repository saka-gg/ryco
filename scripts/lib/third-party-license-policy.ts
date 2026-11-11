/**
 * Which licenses may ship in a Ryco client, judged from an SPDX license expression.
 *
 * Permissive licenses ship freely. Weak copyleft licenses (MPL, EPL, CDDL) ship only through a
 * reviewed entry in `third-party-licenses.config.json` that names the package and says why it is
 * acceptable. Strong copyleft (GPL, LGPL, AGPL, SSPL, EUPL, CC-BY-SA and the like) and anything
 * unrecognized never ship: an unknown identifier needs a package override with the right SPDX id.
 *
 * Build-time only; the app never imports it.
 */

export type LicenseClass = "permissive" | "weak-copyleft" | "copyleft" | "unknown";

/** Permissive licenses: keep the notice, nothing else is owed. Canonical SPDX casing. */
export const PERMISSIVE_LICENSE_IDS: ReadonlySet<string> = new Set([
  "0BSD",
  "AFL-2.1",
  "Apache-2.0",
  "BlueOak-1.0.0",
  // SQLite's public-domain dedication.
  "blessing",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BSD-3-Clause-Clear",
  "BSL-1.0",
  "bzip2-1.0.6",
  "CC-BY-3.0",
  "CC-BY-4.0",
  "CC0-1.0",
  "ISC",
  "MIT",
  "MIT-0",
  "OFL-1.1",
  "Python-2.0",
  "Unicode-3.0",
  "Unicode-DFS-2016",
  "Unlicense",
  "W3C",
  "WTFPL",
  "X11",
  "Zlib",
]);

/** File-level copyleft: acceptable unmodified, but every use is reviewed. */
export const WEAK_COPYLEFT_LICENSE_IDS: ReadonlySet<string> = new Set([
  "CDDL-1.0",
  "CDDL-1.1",
  "EPL-1.0",
  "EPL-2.0",
  "MPL-1.1",
  "MPL-2.0",
]);

/** Prefixes of licenses that never ship in a client. */
const COPYLEFT_LICENSE_PREFIXES = [
  "AGPL-",
  "CC-BY-NC",
  "CC-BY-ND",
  "CC-BY-SA",
  "EUPL-",
  "GPL-",
  "LGPL-",
  "OSL-",
  "SSPL-",
];

const CANONICAL_IDS = new Map(
  [...PERMISSIVE_LICENSE_IDS, ...WEAK_COPYLEFT_LICENSE_IDS].map((id) => [id.toLowerCase(), id]),
);

/** Spellings packages use in `license` that are not SPDX ids but name one unambiguously. */
const ALIASES: Readonly<Record<string, string>> = {
  "apache 2.0": "Apache-2.0",
  "apache license 2.0": "Apache-2.0",
  "apache license, version 2.0": "Apache-2.0",
  "apache-2": "Apache-2.0",
  apache2: "Apache-2.0",
  "bsd-2": "BSD-2-Clause",
  "bsd-3": "BSD-3-Clause",
  "mit license": "MIT",
  "the mit license": "MIT",
};

/** The canonical SPDX id for one license id, or the input when it is not a known id. */
export function canonicalLicenseId(id: string): string {
  const trimmed = id.trim();
  const lower = trimmed.toLowerCase();
  return CANONICAL_IDS.get(lower) ?? ALIASES[lower] ?? trimmed;
}

/** The expression with each license id in canonical SPDX casing, for display. */
export function normalizeLicenseExpression(expression: string): string {
  return tokenize(expression)
    .map((token) => (typeof token === "string" ? token : canonicalLicenseId(token.id)))
    .join(" ")
    .replaceAll("( ", "(")
    .replaceAll(" )", ")");
}

export function classifyLicenseId(id: string): LicenseClass {
  // "GPL-2.0+" and "GPL-2.0-or-later" keep their family; "-only" likewise.
  const canonical = canonicalLicenseId(id.replace(/\+$/u, ""));
  if (PERMISSIVE_LICENSE_IDS.has(canonical)) return "permissive";
  if (WEAK_COPYLEFT_LICENSE_IDS.has(canonical)) return "weak-copyleft";
  const upper = canonical.toUpperCase();
  if (COPYLEFT_LICENSE_PREFIXES.some((prefix) => upper.startsWith(prefix.toUpperCase()))) {
    return "copyleft";
  }
  return "unknown";
}

const RANK: Readonly<Record<LicenseClass, number>> = {
  permissive: 3,
  "weak-copyleft": 2,
  copyleft: 1,
  unknown: 0,
};

type Token = "(" | ")" | "AND" | "OR" | "WITH" | { readonly id: string };

function tokenize(expression: string): ReadonlyArray<Token> {
  // A whole-expression alias such as "Apache 2.0" contains a space, so it is resolved first.
  const aliased = ALIASES[expression.trim().toLowerCase()] ?? expression;
  const tokens: Token[] = [];
  for (const raw of aliased.replaceAll("(", " ( ").replaceAll(")", " ) ").split(/\s+/u)) {
    if (raw.length === 0) continue;
    const upper = raw.toUpperCase();
    if (raw === "(" || raw === ")") tokens.push(raw);
    else if (upper === "AND" || upper === "OR" || upper === "WITH") tokens.push(upper);
    else tokens.push({ id: raw });
  }
  return tokens;
}

/**
 * Classifies an SPDX expression: an OR takes its most permissive branch (the recipient may choose
 * it), an AND its least permissive part, and `X WITH exception` classifies as X. A malformed
 * expression is unknown.
 */
export function classifyLicenseExpression(expression: string): LicenseClass {
  const tokens = tokenize(expression);
  let position = 0;
  const fail = (): never => {
    throw new Error("malformed");
  };
  const primary = (): LicenseClass => {
    const token = tokens[position++];
    if (token === "(") {
      const inner = disjunction();
      if (tokens[position++] !== ")") fail();
      return inner;
    }
    if (token === undefined || typeof token === "string") return fail();
    const licenseClass = classifyLicenseId(token.id);
    if (tokens[position] === "WITH") {
      position += 1;
      const exception = tokens[position++];
      if (exception === undefined || typeof exception === "string") fail();
    }
    return licenseClass;
  };
  const conjunction = (): LicenseClass => {
    let worst = primary();
    while (tokens[position] === "AND") {
      position += 1;
      const next = primary();
      if (RANK[next] < RANK[worst]) worst = next;
    }
    return worst;
  };
  const disjunction = (): LicenseClass => {
    let best = conjunction();
    while (tokens[position] === "OR") {
      position += 1;
      const next = conjunction();
      if (RANK[next] > RANK[best]) best = next;
    }
    return best;
  };
  try {
    if (tokens.length === 0) return "unknown";
    const result = disjunction();
    return position === tokens.length ? result : "unknown";
  } catch {
    return "unknown";
  }
}

export interface ReviewedLicense {
  readonly name: string;
  readonly license: string;
  readonly reason: string;
}

/**
 * Why a component may not ship under `license`, or null when it may. A weak copyleft license is
 * acceptable only with a reviewed entry for the same component name and license expression.
 */
export function licensePolicyViolation(
  component: { readonly name: string; readonly license: string },
  reviewed: ReadonlyArray<ReviewedLicense>,
): string | null {
  const licenseClass = classifyLicenseExpression(component.license);
  switch (licenseClass) {
    case "permissive":
      return null;
    case "weak-copyleft":
      return reviewed.some(
        (entry) => entry.name === component.name && entry.license === component.license,
      )
        ? null
        : `${component.name} uses the weak copyleft license "${component.license}", which needs a reviewed entry in "reviewedLicenses" with a reason.`;
    case "copyleft":
      return `${component.name} uses the copyleft license "${component.license}", which may not ship in a Ryco client.`;
    case "unknown":
      return `${component.name} declares "${component.license}", which is not a recognized license. Add a package override with its SPDX license id.`;
  }
}
