import { htmlRenderFileName } from "@ryco/shared/htmlRender";
import { Directory, File, Paths } from "expo-file-system";
import { Platform, Share } from "react-native";

// Sharing a page hands the system share sheet a file, the way the app shares
// its other attachments (`Share.share({ url })`), so the reader can save it,
// AirDrop it, or open it in another app. The app itself never opens the page
// outside its sandboxed WebView.

/**
 * React Native's share sheet carries a file only on iOS; Android's takes text
 * alone, which would send the page's markup as a message.
 */
export const HTML_RENDER_SHARE_SUPPORTED = Platform.OS === "ios";

/** The cache folder holding the copy the share sheet reads. */
const SHARE_DIRECTORY = "html-render-share";

/**
 * Writes the page to a cache file named after its title and opens the share
 * sheet on it. The copy is node-owned content, so it lives only while the
 * sheet is open: it is deleted when the sheet closes, and a copy a crash left
 * behind is cleared by the next share. Resolves when the sheet has closed.
 */
export async function shareHtmlRender(input: {
  readonly html: string;
  readonly title: string;
}): Promise<void> {
  const directory = new Directory(Paths.cache, SHARE_DIRECTORY);
  if (directory.exists) directory.delete();
  directory.create({ intermediates: true, idempotent: true });
  const file = new File(directory, htmlRenderFileName(input.title));
  try {
    file.write(input.html);
    await Share.share({ url: file.uri });
  } finally {
    try {
      if (directory.exists) directory.delete();
    } catch {
      // The next share clears it.
    }
  }
}
