import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Modal, Platform, Pressable, ScrollView, View } from "react-native";

import { useThemeColor } from "../lib/useThemeColor";
import { cn } from "../lib/cn";
import { AppText } from "./AppText";
import {
  isConfirmQuoteReadToEnd,
  settleConfirmDialog,
  UNMEASURED_CONFIRM_QUOTE_SCROLL,
  type ConfirmQuoteScroll,
} from "./confirmDialogModel";

export type ConfirmDialogRequest = {
  readonly title: string;
  readonly message?: string;
  readonly cancelText?: string;
  readonly confirmText: string;
  readonly destructive?: boolean;
  readonly onConfirm: () => void;
  readonly onCancel?: () => void;
  /** A second way to go ahead, shown between cancel and confirm. */
  readonly alternative?: {
    readonly text: string;
    readonly destructive?: boolean;
    readonly onPress: () => void;
  };
  /**
   * Text the reader must read before confirming (a page's message to send),
   * shown exactly as given in a box of its own, apart from the title and
   * message, with `caption` under it. A long one scrolls, and Confirm stays
   * disabled until the reader has scrolled to its end. It always shows in the
   * app's own dialog: a system alert would run it into the message.
   */
  readonly quote?: { readonly text: string; readonly caption: string };
  /**
   * Confirm stays disabled this long after the dialog appears, starting over
   * with every touch while it waits, so a burst of taps cannot land on it.
   */
  readonly confirmDelayMs?: number;
};

let presentRequest: ((request: ConfirmDialogRequest) => void) | null = null;

/**
 * Imperative confirm dialog, Alert.alert-shaped. Native iOS alerts already
 * match the app (and support per-button destructive red), so the app's own
 * dialog is for Android, where the native dialog can only theme all confirm
 * buttons at once, and for a dialog with a quote or a Confirm delay, which a
 * system alert cannot show. Requires ConfirmDialogHost to be mounted at the
 * app root.
 */
export function showConfirmDialog(request: ConfirmDialogRequest): void {
  if (
    Platform.OS === "ios" &&
    request.quote === undefined &&
    request.confirmDelayMs === undefined
  ) {
    Alert.alert(request.title, request.message, [
      {
        text: request.cancelText ?? "Cancel",
        style: "cancel",
        ...(request.onCancel ? { onPress: request.onCancel } : {}),
      },
      ...(request.alternative
        ? [
            {
              text: request.alternative.text,
              style: request.alternative.destructive
                ? ("destructive" as const)
                : ("default" as const),
              onPress: request.alternative.onPress,
            },
          ]
        : []),
      {
        text: request.confirmText,
        style: request.destructive ? "destructive" : "default",
        onPress: request.onConfirm,
      },
    ]);
    return;
  }
  presentRequest?.(request);
}

/**
 * Android-style alert dialog matching the native one themed by
 * withAndroidModernAlertDialog — left-aligned text, right-aligned text
 * buttons — with what the native theme can't do: a per-dialog destructive
 * button color and a dimmer message than the title.
 */
export function ConfirmDialogHost() {
  const [shown, setShown] = useState<{
    readonly request: ConfirmDialogRequest;
    readonly id: number;
  } | null>(null);
  const nextId = useRef(0);

  useEffect(() => {
    presentRequest = (request) => {
      nextId.current += 1;
      setShown({ request, id: nextId.current });
    };
    return () => {
      presentRequest = null;
    };
  }, []);

  // Closes first, then answers: an answer that asks again shows its dialog.
  const settle = useCallback(
    (action: (() => void) | undefined) => settleConfirmDialog(() => setShown(null), action),
    [],
  );

  return (
    <Modal
      visible={shown !== null}
      transparent
      animationType="fade"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={() => settle(shown?.request.onCancel)}
    >
      {shown === null ? null : (
        // Keyed by request, so a dialog asked again starts its waits over.
        <ConfirmDialogCard key={shown.id} request={shown.request} onSettle={settle} />
      )}
    </Modal>
  );
}

/** One dialog's card: its text, its quote, and its buttons. */
export function ConfirmDialogCard(props: {
  readonly request: ConfirmDialogRequest;
  readonly onSettle: (action: (() => void) | undefined) => void;
}) {
  const { request, onSettle } = props;
  const pressedOverlay = useThemeColor("--color-subtle");
  const delayMs = request.confirmDelayMs;
  const [armed, setArmed] = useState(delayMs === undefined);
  // Bumped by a touch while Confirm waits, which starts the wait over.
  const [waitStart, setWaitStart] = useState(0);
  useEffect(() => {
    if (delayMs === undefined || armed) return;
    const timeout = setTimeout(() => setArmed(true), delayMs);
    return () => clearTimeout(timeout);
  }, [delayMs, armed, waitStart]);
  const [read, setRead] = useState(request.quote === undefined);
  const quoteScroll = useRef<ConfirmQuoteScroll>(UNMEASURED_CONFIRM_QUOTE_SCROLL);
  const measureQuote = (patch: Partial<ConfirmQuoteScroll>) => {
    quoteScroll.current = { ...quoteScroll.current, ...patch };
    if (!read && isConfirmQuoteReadToEnd(quoteScroll.current)) setRead(true);
  };
  const canConfirm = armed && read;

  return (
    <View
      className="flex-1 items-center justify-center bg-backdrop px-8"
      onTouchStart={() => {
        if (!armed) setWaitStart((count) => count + 1);
      }}
    >
      <View className="w-full rounded-[24px] bg-card px-6 pb-4 pt-5">
        <AppText className="text-lg font-ryco-medium">{request.title}</AppText>
        {request.message === undefined ? null : (
          // A long message scrolls, so the buttons stay on screen.
          <ScrollView className="mt-2" style={{ maxHeight: 320 }}>
            <AppText className="text-sm text-foreground-secondary">{request.message}</AppText>
          </ScrollView>
        )}
        {request.quote === undefined ? null : (
          <>
            <ScrollView
              className="mt-3 rounded-xl border border-border bg-subtle px-3 py-2"
              style={{ maxHeight: 240 }}
              scrollEventThrottle={16}
              onLayout={(event) => measureQuote({ viewport: event.nativeEvent.layout.height })}
              onContentSizeChange={(_width, height) => measureQuote({ content: height })}
              onScroll={(event) =>
                measureQuote({
                  offset: event.nativeEvent.contentOffset.y,
                  viewport: event.nativeEvent.layoutMeasurement.height,
                  content: event.nativeEvent.contentSize.height,
                })
              }
            >
              <AppText selectable className="text-sm text-foreground">
                {request.quote.text}
              </AppText>
            </ScrollView>
            <AppText className="mt-2 text-xs text-foreground-muted">
              {read ? request.quote.caption : `${request.quote.caption} · Scroll to the end first.`}
            </AppText>
          </>
        )}
        <View className="mt-5 flex-row flex-wrap justify-end gap-1">
          <View className="overflow-hidden rounded-full">
            <Pressable
              accessibilityRole="button"
              className="min-h-10 items-center justify-center px-4"
              android_ripple={{ color: pressedOverlay }}
              onPress={() => onSettle(request.onCancel)}
            >
              <AppText className="text-base font-ryco-medium">
                {request.cancelText ?? "Cancel"}
              </AppText>
            </Pressable>
          </View>
          {request.alternative === undefined ? null : (
            <View className="overflow-hidden rounded-full">
              <Pressable
                accessibilityRole="button"
                className="min-h-10 items-center justify-center px-4"
                android_ripple={{ color: pressedOverlay }}
                onPress={() => onSettle(request.alternative?.onPress)}
              >
                <AppText
                  className={cn(
                    "text-base font-ryco-medium",
                    request.alternative.destructive && "text-danger-foreground",
                  )}
                >
                  {request.alternative.text}
                </AppText>
              </Pressable>
            </View>
          )}
          <View className="overflow-hidden rounded-full">
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: !canConfirm }}
              disabled={!canConfirm}
              className={cn(
                "min-h-10 items-center justify-center px-4",
                !canConfirm && "opacity-40",
              )}
              android_ripple={{ color: pressedOverlay }}
              onPress={() => onSettle(request.onConfirm)}
            >
              <AppText
                className={cn(
                  "text-base font-ryco-medium",
                  request.destructive && "text-danger-foreground",
                )}
              >
                {request.confirmText}
              </AppText>
            </Pressable>
          </View>
        </View>
      </View>
    </View>
  );
}
