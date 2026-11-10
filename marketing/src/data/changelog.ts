/**
 * The release notes live in the monorepo's shared package, so the app's
 * What's new dialog and this site read the same entries. The file is pure
 * data with no imports, which lets this standalone app import it by path.
 */
export {
  CHANGELOG_RELEASES,
  type ChangelogHighlight,
  type ChangelogRelease,
} from "../../../packages/shared/src/releaseNotes.ts";
