/**
 * Whether a link may leave the app: an absolute http(s) URL, which opens in
 * the browser. Text the phone shows from elsewhere (a pull request's body and
 * comments, a workspace's markdown) can link to anything, and one tap on a
 * `tel:` or `sms:` link, another app's deep link or one of Ryco's own routes
 * would act for the reader. A relative link is not opened either: it points
 * into a place this app does not navigate to.
 */
export function isWebLink(url: string): boolean {
  return /^https?:\/\//iu.test(url);
}
