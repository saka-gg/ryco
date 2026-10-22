/**
 * PrivacyGuardedFolders - the home folders macOS guards with a privacy (TCC) prompt. Reading
 * anything inside one asks the user, so an unattended node would prompt or log EPERM (amendment
 * 34). Folder search never opens one from a home root, and a destination the client suggests on
 * its own (`projects.previewDestination` with `suggested`) is never looked inside of, unless the
 * folder holds one of the node's code roots.
 *
 * @module PrivacyGuardedFolders
 */
import path from "node:path";

import { foldPathCase } from "../project/projectDestination.ts";

/** The guarded folders directly in home, by lowercased name (macOS volumes fold case). */
const PRIVACY_GUARDED_HOME_FOLDERS: ReadonlyMap<string, string> = new Map(
  ["Desktop", "Documents", "Downloads", "Pictures", "Movies", "Music"].map((name) => [
    name.toLowerCase(),
    name,
  ]),
);

/** Whether a folder named `name`, directly in home, is guarded on `platform`. */
export const isPrivacyGuardedHomeFolderName = (name: string, platform: NodeJS.Platform): boolean =>
  platform === "darwin" && PRIVACY_GUARDED_HOME_FOLDERS.has(name.toLowerCase());

const isAtOrBelow = (root: string, candidate: string, platform: NodeJS.Platform) => {
  const relative = path.relative(foldPathCase(root, platform), foldPathCase(candidate, platform));
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
};

/**
 * The guarded home folder `candidate` is or lies in (`~/Documents` for `~/Documents/site`, as
 * macOS spells it), by its path alone: nothing is read. Null on other platforms, outside the guarded folders, and when
 * `candidate` lies in one of `openRoots` that is that folder or inside it (a code root there, or
 * the default project directory), where the node keeps projects and reads anyway.
 */
export const privacyGuardedFolderOf = (input: {
  readonly candidate: string;
  readonly homeDir: string;
  readonly platform: NodeJS.Platform;
  readonly openRoots: ReadonlyArray<string>;
}): string | null => {
  if (input.platform !== "darwin") return null;
  const home = path.resolve(input.homeDir);
  const candidate = path.resolve(input.candidate);
  if (!isAtOrBelow(home, candidate, input.platform)) return null;
  // The first name below home, as in `candidate` (whose case may differ from home's).
  const segments = (target: string) => target.split(path.sep).filter((part) => part.length > 0);
  const name = PRIVACY_GUARDED_HOME_FOLDERS.get(
    (segments(candidate)[segments(home).length] ?? "").toLowerCase(),
  );
  if (name === undefined) return null;
  const guarded = path.join(home, name);
  const open = input.openRoots.some(
    (root) =>
      isAtOrBelow(guarded, root, input.platform) && isAtOrBelow(root, candidate, input.platform),
  );
  return open ? null : guarded;
};
