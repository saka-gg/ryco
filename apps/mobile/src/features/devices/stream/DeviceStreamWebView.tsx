import { Asset } from "expo-asset";
import { File } from "expo-file-system";
import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { WebView, type WebViewMessageEvent, type WebViewNavigation } from "react-native-webview";

import {
  isAllowedTerminalRendererNavigation,
  TERMINAL_WEBVIEW_SECURITY_PROPS,
} from "../../terminal/terminalRendererDocument";
import deviceStreamAsset from "./renderer/device-stream.html";
import type { DeviceStreamHostMessage } from "./deviceStreamProtocol";

let streamDocument: Promise<string> | null = null;

/** The generated, app-owned document; read once, then kept in memory. */
function readBundledDeviceStreamDocument(): Promise<string> {
  streamDocument ??= (async () => {
    const asset = Asset.fromModule(deviceStreamAsset);
    await asset.downloadAsync();
    if (!asset.localUri) throw new Error("Device stream document is unavailable.");
    return new File(asset.localUri).text();
  })().catch((error: unknown) => {
    streamDocument = null;
    throw error;
  });
  return streamDocument;
}

const dropWindowRequest = () => undefined;

/**
 * Hosts only the generated device stream document, under the terminal
 * WebView's containment (`TERMINAL_WEBVIEW_SECURITY_PROPS`: no storage,
 * cookies, files or windows; the document's CSP denies every network class).
 * Frames and touches cross the typed postMessage bridge
 * (`deviceStreamProtocol.ts`) and are never interpolated into script.
 */
export function DeviceStreamWebView(props: {
  /** Hands the owner this WebView's sender once it can receive, and `null` when it cannot. */
  readonly onSender: (send: ((message: DeviceStreamHostMessage) => boolean) | null) => void;
  readonly onMessage: (raw: string) => void;
  readonly onFailure: () => void;
  readonly background: string;
}) {
  const { onSender, onMessage, onFailure, background } = props;
  const webViewRef = useRef<WebView>(null);
  const [document, setDocument] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const failureReported = useRef(false);
  const reportFailure = () => {
    if (failureReported.current) return;
    failureReported.current = true;
    onSender(null);
    onFailure();
  };

  useEffect(() => {
    let cancelled = false;
    void readBundledDeviceStreamDocument().then(
      (html) => {
        if (!cancelled) setDocument(html);
      },
      () => {
        if (!cancelled) reportFailure();
      },
    );
    return () => {
      cancelled = true;
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- read once per mount
  }, []);

  useEffect(() => {
    if (!loaded) return undefined;
    onSender((message) => {
      const webView = webViewRef.current;
      if (webView === null) return false;
      webView.postMessage(JSON.stringify(message));
      return true;
    });
    return () => onSender(null);
  }, [loaded, onSender]);

  if (document === null) {
    return <View style={{ flex: 1, backgroundColor: background }} />;
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
      scrollEnabled={false}
      bounces={false}
      automaticallyAdjustContentInsets={false}
      contentInsetAdjustmentBehavior="never"
      onShouldStartLoadWithRequest={(request: WebViewNavigation) =>
        isAllowedTerminalRendererNavigation(request.url)
      }
      onOpenWindow={dropWindowRequest}
      onLoadEnd={() => setLoaded(true)}
      onMessage={(event: WebViewMessageEvent) => onMessage(event.nativeEvent.data)}
      onError={reportFailure}
      onHttpError={reportFailure}
      onContentProcessDidTerminate={reportFailure}
      onRenderProcessGone={reportFailure}
      style={{ flex: 1, backgroundColor: background }}
    />
  );
}
