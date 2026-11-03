import { Asset } from "expo-asset";
import { File } from "expo-file-system";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { WebView, type WebViewMessageEvent, type WebViewNavigation } from "react-native-webview";

import terminalRendererAsset from "./renderer/terminal-renderer.html";
import { TERMINAL_COLORS } from "./terminalController";
import {
  isAllowedTerminalRendererNavigation,
  TERMINAL_WEBVIEW_SECURITY_PROPS,
} from "./terminalRendererDocument";

let rendererDocument: Promise<string> | null = null;

/** The generated, app-owned document; read once, then kept in memory. */
function readBundledTerminalRenderer(): Promise<string> {
  rendererDocument ??= (async () => {
    const asset = Asset.fromModule(terminalRendererAsset);
    await asset.downloadAsync();
    if (!asset.localUri) throw new Error("Terminal renderer asset is unavailable.");
    return new File(asset.localUri).text();
  })().catch((error: unknown) => {
    rendererDocument = null;
    throw error;
  });
  return rendererDocument;
}

// The renderer never opens windows; a request for one is dropped.
const dropWindowRequest = () => undefined;

const BACKGROUND = TERMINAL_COLORS.background;

/**
 * Hosts only the generated renderer document. Terminal bytes cross the typed
 * postMessage bridge and are never interpolated into script or appended to the
 * cached asset, which holds public renderer code alone.
 */
export function TerminalWebView(props: {
  readonly generation: number;
  /** Hands the controller this WebView's sender once it can receive, and `null` when it cannot. */
  readonly onSender: (generation: number, send: ((encoded: string) => boolean) | null) => void;
  readonly onMessage: (rawMessage: string, generation: number) => void;
  readonly onFailure: (generation: number) => void;
}) {
  const { generation, onSender, onMessage, onFailure } = props;
  const webViewRef = useRef<WebView>(null);
  const [document, setDocument] = useState<string | null>(null);
  const failureReported = useRef(false);

  useEffect(() => {
    let cancelled = false;
    failureReported.current = false;
    void readBundledTerminalRenderer().then(
      (html) => {
        if (!cancelled) setDocument(html);
      },
      () => {
        if (cancelled || failureReported.current) return;
        failureReported.current = true;
        onFailure(generation);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [generation, onFailure]);

  useEffect(() => {
    if (document === null) return undefined;
    onSender(generation, (encoded) => {
      const webView = webViewRef.current;
      if (webView === null) return false;
      webView.postMessage(encoded);
      return true;
    });
    return () => onSender(generation, null);
  }, [document, generation, onSender]);

  const reportFailure = () => {
    if (failureReported.current) return;
    failureReported.current = true;
    onFailure(generation);
  };
  const handleMessage = (event: WebViewMessageEvent) => {
    onMessage(event.nativeEvent.data, generation);
  };

  if (document === null) {
    return (
      <View className="flex-1 items-center justify-center" style={{ backgroundColor: BACKGROUND }}>
        <ActivityIndicator accessibilityLabel="Loading terminal" />
      </View>
    );
  }

  return (
    <WebView
      ref={webViewRef}
      source={{ html: document }}
      originWhitelist={["about:*"]}
      javaScriptEnabled={TERMINAL_WEBVIEW_SECURITY_PROPS.javaScriptEnabled}
      incognito={TERMINAL_WEBVIEW_SECURITY_PROPS.incognito}
      cacheEnabled={TERMINAL_WEBVIEW_SECURITY_PROPS.cacheEnabled}
      domStorageEnabled={TERMINAL_WEBVIEW_SECURITY_PROPS.domStorageEnabled}
      allowFileAccess={TERMINAL_WEBVIEW_SECURITY_PROPS.allowFileAccess}
      allowFileAccessFromFileURLs={TERMINAL_WEBVIEW_SECURITY_PROPS.allowFileAccessFromFileURLs}
      allowUniversalAccessFromFileURLs={
        TERMINAL_WEBVIEW_SECURITY_PROPS.allowUniversalAccessFromFileURLs
      }
      sharedCookiesEnabled={TERMINAL_WEBVIEW_SECURITY_PROPS.sharedCookiesEnabled}
      thirdPartyCookiesEnabled={TERMINAL_WEBVIEW_SECURITY_PROPS.thirdPartyCookiesEnabled}
      setSupportMultipleWindows={TERMINAL_WEBVIEW_SECURITY_PROPS.setSupportMultipleWindows}
      allowsInlineMediaPlayback={TERMINAL_WEBVIEW_SECURITY_PROPS.allowsInlineMediaPlayback}
      mediaPlaybackRequiresUserAction={
        TERMINAL_WEBVIEW_SECURITY_PROPS.mediaPlaybackRequiresUserAction
      }
      allowsLinkPreview={TERMINAL_WEBVIEW_SECURITY_PROPS.allowsLinkPreview}
      dataDetectorTypes={TERMINAL_WEBVIEW_SECURITY_PROPS.dataDetectorTypes}
      geolocationEnabled={false}
      mediaCapturePermissionGrantType="deny"
      allowsBackForwardNavigationGestures={false}
      mixedContentMode="never"
      overScrollMode="never"
      // xterm scrolls its own viewport; the page itself never moves.
      scrollEnabled={false}
      bounces={false}
      // The software keyboard resizes the screen, not the page.
      automaticallyAdjustContentInsets={false}
      contentInsetAdjustmentBehavior="never"
      keyboardDisplayRequiresUserAction={false}
      hideKeyboardAccessoryView
      textInteractionEnabled
      onShouldStartLoadWithRequest={(request: WebViewNavigation) =>
        isAllowedTerminalRendererNavigation(request.url)
      }
      onOpenWindow={dropWindowRequest}
      onMessage={handleMessage}
      onError={reportFailure}
      onHttpError={reportFailure}
      onContentProcessDidTerminate={reportFailure}
      onRenderProcessGone={reportFailure}
      style={{ flex: 1, backgroundColor: BACKGROUND }}
    />
  );
}
