/**
 * What a browser address bar accepts, for every client: an HTTP(S) address,
 * `http://` assumed when the scheme is left out, and never credentials in the
 * URL. Throws a message fit for the address bar otherwise.
 */
export function normalizeBrowserUrl(value: string): string {
  const raw = value.trim();
  const url = new URL(/^[a-z][a-z\d+.-]*:\/\//iu.test(raw) ? raw : `http://${raw}`);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || !url.hostname)
    throw new Error("Enter an HTTP(S) URL without embedded credentials.");
  return url.href;
}
