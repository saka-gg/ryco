/**
 * Top-level directories of the web dist that hold static files the app fetches
 * one at a time, on demand, outside the module graph. `vscode-icons` is the
 * self-hosted file icon set (`apps/web/public/vscode-icons`, ~1,100 SVGs): a
 * file tree requests the few icons it shows, never the set.
 *
 * Bundle measurements leave these out. Counting them would report the whole
 * icon set as bundle bytes and files although no page loads it in bulk, and an
 * icon-set upgrade would read as a JavaScript regression.
 */
export const ON_DEMAND_WEB_ASSET_DIRECTORIES: ReadonlySet<string> = new Set(["vscode-icons"]);

/** Whether a dist-relative path (either separator) lies in an on-demand asset directory. */
export function isOnDemandWebAssetPath(distRelativePath: string): boolean {
  const [topLevel] = distRelativePath.replaceAll("\\", "/").replace(/^\.\//u, "").split("/");
  return topLevel !== undefined && ON_DEMAND_WEB_ASSET_DIRECTORIES.has(topLevel);
}
