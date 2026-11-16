import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { StatusPill } from "../../components/StatusPill";
import { cn } from "../../lib/cn";
import { useThemeColor } from "../../lib/useThemeColor";
import {
  hostedStatusTone,
  type HostedAuthAction,
  type HostedDeliveryUnknownView,
} from "./hostedAuthModel";
import type { HostedConnectionStatusIndicator } from "@ryco/client-runtime/authorization";

/**
 * Presentational atoms shared by the hosted sign-in sheet and the hosted
 * account screen. Content surfaces stay opaque `bg-card` — glass is floating
 * chrome only — and every colour is a design token, never a literal.
 *
 * Only SF Symbols that already have an Android mapping in `AppSymbol.tsx` are
 * used here (`person.crop.circle`, `exclamationmark.triangle`, `link`), so no
 * glyph silently renders as nothing on Android.
 */

/** The primary CTA: white capsule, black label. */
export function HostedPrimaryButton(props: { readonly action: HostedAuthAction }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: props.action.disabled }}
      disabled={props.action.disabled}
      onPress={props.action.run}
      className={cn(
        "mx-5 mt-4 items-center rounded-full px-5 py-3.5 active:opacity-80",
        props.action.disabled ? "bg-subtle-strong" : "bg-primary",
      )}
    >
      <Text
        className={cn(
          "text-base font-ryco-bold",
          props.action.disabled ? "text-foreground-muted" : "text-primary-foreground",
        )}
      >
        {props.action.label}
      </Text>
    </Pressable>
  );
}

/** The Hub connection status, rendered from the runtime's own indicator. */
export function HostedStatusRow(props: {
  readonly indicator: HostedConnectionStatusIndicator;
  readonly roleLabel?: string | null;
}) {
  const tone = hostedStatusTone(props.indicator);
  return (
    <View className="flex-row items-center gap-2.5">
      <StatusPill
        size="compact"
        label={tone.label}
        pillClassName={tone.pillClassName}
        textClassName={tone.textClassName}
      />
      {props.roleLabel ? (
        <Text className="font-sans text-xs text-foreground-muted">{props.roleLabel}</Text>
      ) : null}
    </View>
  );
}

/**
 * The mandatory delivery-unknown acknowledgement.
 *
 * A request may or may not have reached the node and Ryco did not resend it.
 * The notice therefore has no dismiss affordance of its own and no timeout:
 * the only way past it is the explicit acknowledgement, which stays visible but
 * disabled until session replay has settled.
 */
export function HostedDeliveryUnknownNotice(props: { readonly view: HostedDeliveryUnknownView }) {
  const iconColor = useThemeColor("--color-warning");
  return (
    <View
      accessibilityRole="alert"
      className="mx-5 mt-4 rounded-2xl border border-warning-border bg-warning-bg p-4"
    >
      <View className="flex-row items-start gap-2.5">
        <View className="pt-0.5">
          {/* Bare SF name: `exclamationmark.triangle` already resolves through
              ANDROID_ICON_BY_SF_SYMBOL, so no new mapping is needed. */}
          <SymbolView
            name="exclamationmark.triangle"
            size={16}
            tintColor={iconColor}
            type="monochrome"
          />
        </View>
        <Text className="flex-1 font-sans text-sm leading-relaxed text-foreground">
          {props.view.message}
        </Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: props.view.action.disabled }}
        disabled={props.view.action.disabled}
        onPress={props.view.action.run}
        className="mt-3 self-start rounded-full border border-warning-border px-4 py-2 active:opacity-70"
      >
        <Text
          className={cn(
            "text-xs font-ryco-bold",
            props.view.action.disabled ? "text-foreground-muted" : "text-warning",
          )}
        >
          {props.view.action.label}
        </Text>
      </Pressable>
    </View>
  );
}

/** The bounded reason the runtime gives for withholding node actions. */
export function HostedCapabilityNotice(props: { readonly reason: string }) {
  return (
    <View className="mx-5 mt-3 rounded-2xl border border-border bg-card px-4 py-3">
      <Text className="font-sans text-xs leading-relaxed text-foreground-muted">
        {props.reason}
      </Text>
    </View>
  );
}
