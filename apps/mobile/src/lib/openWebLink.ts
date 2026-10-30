import * as Linking from "expo-linking";

import { isWebLink } from "./webLink";

/** Opens a web link in the browser; anything else (see `isWebLink`) is ignored. */
export function openWebLink(url: string | null): void {
  if (url === null || !isWebLink(url)) return;
  void Linking.openURL(url).catch(() => undefined);
}
