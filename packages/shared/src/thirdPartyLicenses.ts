/**
 * The open source license manifest a Ryco client ships: its shape, the compact form the build
 * writes, and the lookups the license screens use. Adapted from pingdotgg/t3code
 * (`packages/shared/src/thirdPartyLicenses.ts`, MIT, see THIRD_PARTY_NOTICES.md).
 *
 * `scripts/lib/third-party-licenses.ts` imports this file under Node's type stripping, so it stays
 * free of imports and non-erasable TypeScript.
 */

export interface ThirdPartyLicenseEntry {
  /** Where it ships: `mobile` (the app as a whole), `ios`, `android`, `assets`. */
  readonly bundles: ReadonlyArray<string>;
  /** `package` for an npm package; `custom` for a hand-maintained notice. */
  readonly kind: "custom" | "package";
  /** An SPDX license expression. */
  readonly license: string;
  readonly name: string;
  readonly noticeText: string;
  readonly sourceUrl: string | null;
  readonly version: string | null;
}

export interface ThirdPartyLicenseManifest {
  readonly schemaVersion: 1;
  readonly entries: ReadonlyArray<ThirdPartyLicenseEntry>;
}

/**
 * The serialized manifest. Many packages carry the same notice text (one monorepo's license in
 * each of its packages), so each distinct text is stored once and entries point at it.
 */
export interface EncodedThirdPartyLicenseManifest {
  readonly schemaVersion: 1;
  readonly notices: ReadonlyArray<string>;
  readonly entries: ReadonlyArray<
    Omit<ThirdPartyLicenseEntry, "noticeText"> & { readonly notice: number }
  >;
}

export function encodeThirdPartyLicenseManifest(
  manifest: ThirdPartyLicenseManifest,
): EncodedThirdPartyLicenseManifest {
  const notices: string[] = [];
  const noticeIndex = new Map<string, number>();
  const entries = manifest.entries.map(({ noticeText, ...entry }) => {
    let notice = noticeIndex.get(noticeText);
    if (notice === undefined) {
      notice = notices.length;
      notices.push(noticeText);
      noticeIndex.set(noticeText, notice);
    }
    return { ...entry, notice };
  });
  return { schemaVersion: 1, notices, entries };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is ReadonlyArray<string> {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function decodeEntry(
  value: unknown,
  index: number,
  notices: ReadonlyArray<string>,
): ThirdPartyLicenseEntry {
  if (!isRecord(value)) {
    throw new Error(`License entry ${String(index + 1)} is not an object.`);
  }
  const noticeText =
    typeof value.notice === "number" && Number.isInteger(value.notice)
      ? notices[value.notice]
      : undefined;
  if (
    !isStringArray(value.bundles) ||
    value.bundles.length === 0 ||
    (value.kind !== "custom" && value.kind !== "package") ||
    typeof value.license !== "string" ||
    typeof value.name !== "string" ||
    noticeText === undefined ||
    noticeText.length === 0 ||
    (value.sourceUrl !== null && !isHttpUrl(value.sourceUrl)) ||
    (value.version !== null && typeof value.version !== "string")
  ) {
    throw new Error(`License entry ${String(index + 1)} has an invalid shape.`);
  }
  return {
    bundles: value.bundles,
    kind: value.kind,
    license: value.license,
    name: value.name,
    noticeText,
    sourceUrl: value.sourceUrl,
    version: value.version,
  };
}

/** Decodes the generated (encoded) manifest; throws on any malformed or duplicate entry. */
export function decodeThirdPartyLicenseManifest(value: unknown): ThirdPartyLicenseManifest {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !isStringArray(value.notices) ||
    !Array.isArray(value.entries)
  ) {
    throw new Error("The open source license manifest has an unsupported format.");
  }
  const notices = value.notices;
  const entries = value.entries.map((entry: unknown, index) => decodeEntry(entry, index, notices));
  const entryKeys = new Set<string>();
  for (const entry of entries) {
    const key = thirdPartyLicenseEntryKey(entry);
    if (entryKeys.has(key)) {
      throw new Error(`The open source license manifest contains a duplicate entry: ${key}`);
    }
    entryKeys.add(key);
  }
  return { schemaVersion: 1, entries };
}

/** Entries matching every whitespace-separated term in their name, version or license. */
export function filterThirdPartyLicenseEntries(
  entries: ReadonlyArray<ThirdPartyLicenseEntry>,
  query: string,
): ReadonlyArray<ThirdPartyLicenseEntry> {
  const terms = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0);
  if (terms.length === 0) return entries;
  return entries.filter((entry) => {
    const searchable = [entry.name, entry.version, entry.license]
      .filter((value): value is string => value !== null)
      .join(" ")
      .toLowerCase();
    return terms.every((term) => searchable.includes(term));
  });
}

const BUNDLE_LABELS: Readonly<Record<string, string>> = {
  android: "Android",
  assets: "Assets",
  ios: "iOS",
  mobile: "App",
};

/** "iOS, Android" for an entry's bundles, in the order given. */
export function formatLicenseBundles(bundles: ReadonlyArray<string>): string {
  return bundles
    .map((bundle) =>
      Object.prototype.hasOwnProperty.call(BUNDLE_LABELS, bundle) ? BUNDLE_LABELS[bundle] : bundle,
    )
    .join(", ");
}

/** A stable key for an entry, safe in a route parameter. */
export function thirdPartyLicenseEntryKey(entry: ThirdPartyLicenseEntry): string {
  return encodeURIComponent(JSON.stringify([entry.kind, entry.name, entry.version]));
}

export function findThirdPartyLicenseEntry(
  entries: ReadonlyArray<ThirdPartyLicenseEntry>,
  key: string,
): ThirdPartyLicenseEntry | undefined {
  return entries.find((entry) => thirdPartyLicenseEntryKey(entry) === key);
}
