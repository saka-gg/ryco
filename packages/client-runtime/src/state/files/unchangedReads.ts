import type {
  ProjectListEntriesInput,
  ProjectListEntriesResult,
  ProjectReadFileInput,
  ProjectReadFileResult,
} from "@ryco/contracts";

/**
 * Re-reads that send what the client already holds (the listing's `revision`,
 * the file's `version`) so a node with nothing new answers `unchanged` in about
 * a hundred bytes. The held value is then returned as is (same object, so
 * nothing downstream re-renders). Older nodes ignore the field and answer in
 * full, which is used as is; they also never send a `revision`, so a client
 * that only ever talked to one never sends one.
 */

export async function listEntriesSince(
  listEntries: (input: ProjectListEntriesInput) => Promise<ProjectListEntriesResult>,
  cwd: string,
  held: ProjectListEntriesResult | null,
): Promise<ProjectListEntriesResult> {
  const knownRevision = held?.revision;
  const result = await listEntries(knownRevision ? { cwd, knownRevision } : { cwd });
  if (result.unchanged !== true) return result;
  if (held && held.revision === result.revision) return held;
  // Unchanged against a listing this client no longer holds: ask for it whole.
  return listEntries({ cwd });
}

export async function readFileSince(
  readFile: (input: ProjectReadFileInput) => Promise<ProjectReadFileResult>,
  input: { readonly cwd: string; readonly relativePath: string },
  held: ProjectReadFileResult | null,
): Promise<ProjectReadFileResult> {
  const reference = { cwd: input.cwd, relativePath: input.relativePath };
  const knownVersion = held?.relativePath === input.relativePath ? held.version : undefined;
  const result = await readFile(knownVersion ? { ...reference, knownVersion } : reference);
  if (result.unchanged !== true) return result;
  if (held && held.relativePath === result.relativePath && held.version === result.version) {
    return held;
  }
  return readFile(reference);
}
