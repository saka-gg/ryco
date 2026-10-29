/**
 * Which repository a change request URL (or a checkout's remote) belongs to.
 * The helpers live in `@ryco/shared/git` so clients key pull request links the
 * same way; this module keeps the server's import path.
 */
export {
  azureRemoteRepositoryKey,
  changeRequestNumberFromUrl,
  changeRequestRepositoryKey,
} from "@ryco/shared/git";
