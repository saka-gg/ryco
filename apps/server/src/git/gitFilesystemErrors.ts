/** File providers may time out while downloading repository data for Git's mmap.
 * https://developer.apple.com/documentation/technotes/tn3150-getting-ready-for-data-less-files
 */
export function withGitFilesystemGuidance(detail: string): string {
  if (!/\bmmap failed:\s*Operation (?:timed out|cancel(?:ed|led))\b/i.test(detail)) {
    return detail;
  }
  return `${detail}\n\nGit could not read the repository files. If this repository is in a cloud-synced or network folder, make the repository (including .git) available offline, wait for downloads to finish, and retry.`;
}
