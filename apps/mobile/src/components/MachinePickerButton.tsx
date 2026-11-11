import type { EnvironmentId } from "@ryco/contracts";
import * as Haptics from "expo-haptics";
import { useCallback, useEffect, useRef, useState } from "react";
import { AccessibilityInfo, BackHandler, Pressable, useColorScheme, View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  FadeIn,
  FadeOut,
  LayoutAnimationConfig,
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withTiming,
} from "react-native-reanimated";

import {
  ALL_MACHINES_SYMBOL,
  buildMachinePickerModel,
  DEFAULT_MACHINE_PICKER_TITLE,
  type MachinePickerEnvironment,
  type MachinePickerModel,
  type MachinePickerRow,
  type MachineTone,
} from "../features/home/machinePickerModel";
import { useMachinePickerFacts } from "../features/home/useMachinePickerFacts";
import { appMotion } from "../lib/motion";
import { useThemeColor } from "../lib/useThemeColor";
import { type AppSymbolName, SymbolView } from "./AppSymbol";
import { MachineAvatar, RING_PULSE_WIDTH, TONE_COLOR } from "./MachineAvatar";
import { AppText as Text } from "./AppText";
import { OverlayPortal } from "./OverlayPortal";

// The approved mockup's numbers ("Machine picker", "Icon + name"): a 30 pt
// machine avatar with a status ring and dot, a popover that drops from the top
// left with an overshooting scale and fade, and rows that stagger in.

const PALETTE = {
  dark: {
    avatar: "rgba(255,255,255,0.08)",
    icon: "#f2f2f4",
    pressed: "rgba(255,255,255,0.06)",
    popoverShadow: "0px 18px 50px rgba(0,0,0,0.6)",
    rowPressed: "rgba(255,255,255,0.07)",
    divider: "rgba(255,255,255,0.08)",
    muted: "#8e8e98",
    chevron: "#999999",
    check: "#ffffff",
    manage: "#8ab4ff",
  },
  light: {
    avatar: "rgba(0,0,0,0.06)",
    icon: "#262626",
    pressed: "rgba(0,0,0,0.05)",
    popoverShadow: "0px 18px 50px rgba(0,0,0,0.18)",
    rowPressed: "rgba(0,0,0,0.05)",
    divider: "rgba(0,0,0,0.08)",
    muted: "#8e8e93",
    chevron: "#8e8e93",
    check: "#262626",
    manage: "#1567a0",
  },
} as const;
type Palette = (typeof PALETTE)[keyof typeof PALETTE];

const AVATAR_SIZE = 30;
const ROW_AVATAR_SIZE = 34;
const STACK_AVATAR_SIZE = 24;
const STACK_OVERLAP = 8;
const POPOVER_WIDTH = 290;
const POPOVER_GAP = 4;
const POPOVER_INSET_X = -2;
const SCREEN_MARGIN = 12;

const DROP = { duration: 260, easing: Easing.bezier(0.2, 0.9, 0.25, 1.15) };
const CSS_EASE = Easing.bezier(0.25, 0.1, 0.25, 1);
const ROW_IN = { duration: 300, easing: CSS_EASE };
const ROW_STAGGER_MS = 35;
const FACE_FADE_MS = 300;
/** Room around the clipped avatar slot for the ring and its pulse. */
const SLOT_BLEED = RING_PULSE_WIDTH;

/** Fades in while dropping 4 pt into place, as the mockup's `rowIn`. */
function slideIn(delayMs: number) {
  return () => {
    "worklet";
    return {
      initialValues: { opacity: 0, transform: [{ translateY: -4 }] },
      animations: {
        opacity: withDelay(delayMs, withTiming(1, ROW_IN)),
        transform: [{ translateY: withDelay(delayMs, withTiming(0, ROW_IN)) }],
      },
    };
  };
}
const NAME_ENTERING = slideIn(0);

function usePalette(): Palette {
  return useColorScheme() === "light" ? PALETTE.light : PALETTE.dark;
}

function stackWidth(count: number): number {
  return count === 0 ? AVATAR_SIZE : count * STACK_AVATAR_SIZE - (count - 1) * STACK_OVERLAP;
}

/** The avatar part of the button: one machine, or the online machines stacked. */
function FaceAvatar(props: { readonly face: MachinePickerModel["face"] }) {
  const { face } = props;
  if (face.kind === "machine") {
    return (
      <MachineAvatar symbol={face.machine.symbol} tone={face.machine.tone} size={AVATAR_SIZE} dot />
    );
  }
  if (face.stack.length === 0) {
    return <MachineAvatar symbol={ALL_MACHINES_SYMBOL} tone="offline" size={AVATAR_SIZE} />;
  }
  return (
    <View className="flex-row" style={{ paddingTop: (AVATAR_SIZE - STACK_AVATAR_SIZE) / 2 }}>
      {face.stack.map((machine, index) => (
        <View
          key={machine.environmentId}
          style={index === 0 ? undefined : { marginLeft: -STACK_OVERLAP }}
        >
          <MachineAvatar
            symbol={machine.symbol}
            tone={machine.tone}
            size={STACK_AVATAR_SIZE}
            iconSize={13}
            rim
          />
        </View>
      ))}
    </View>
  );
}

function FaceText(props: { readonly face: MachinePickerModel["face"]; readonly palette: Palette }) {
  const { face, palette } = props;
  const title = face.kind === "machine" ? face.machine.label : "All machines";
  const status = face.kind === "machine" ? face.machine.status : `${face.onlineCount} online`;
  const statusColor =
    face.kind === "machine" && face.machine.tone !== "connected"
      ? TONE_COLOR[face.machine.tone]
      : palette.muted;
  return (
    <>
      <Text
        className="font-ryco-bold text-[15px] leading-[18px] text-foreground"
        numberOfLines={1}
        style={{ maxWidth: 130 }}
      >
        {title}
      </Text>
      <Text className="text-[11px] leading-[13px]" style={{ color: statusColor }} numberOfLines={1}>
        {status}
      </Text>
    </>
  );
}

type Frame = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

function PopoverRow(props: {
  readonly index: number;
  readonly animate: boolean;
  readonly palette: Palette;
  readonly selected: boolean;
  readonly accessibilityLabel: string;
  readonly onPress: () => void;
  readonly avatar: React.ReactNode;
  readonly title: string;
  readonly detail?: React.ReactNode;
  readonly titleColor?: string;
  readonly titleWeight?: "bold" | "medium";
}) {
  const { palette } = props;
  return (
    <Animated.View entering={props.animate ? slideIn(props.index * ROW_STAGGER_MS) : undefined}>
      <Pressable
        accessibilityRole="menuitem"
        accessibilityLabel={props.accessibilityLabel}
        accessibilityState={{ selected: props.selected }}
        onPress={props.onPress}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: 11,
          paddingVertical: 9,
          paddingHorizontal: 10,
          borderRadius: 12,
          backgroundColor: pressed ? palette.rowPressed : "transparent",
        })}
      >
        <View style={{ width: ROW_AVATAR_SIZE, alignItems: "center" }}>{props.avatar}</View>
        <View className="min-w-0 flex-1">
          <Text
            numberOfLines={1}
            className={
              props.titleWeight === "medium"
                ? "font-ryco-medium text-[14.5px] leading-[19px]"
                : "font-ryco-bold text-[14.5px] leading-[19px]"
            }
            style={props.titleColor === undefined ? undefined : { color: props.titleColor }}
          >
            {props.title}
          </Text>
          {props.detail}
        </View>
        {props.selected ? (
          <SymbolView
            name="checkmark"
            size={15}
            weight="semibold"
            tintColor={palette.check}
            type="monochrome"
          />
        ) : null}
      </Pressable>
    </Animated.View>
  );
}

function RowDetail(props: {
  readonly palette: Palette;
  readonly tone?: MachineTone;
  readonly text: string;
}) {
  return (
    <View className="flex-row items-center" style={{ gap: 5 }}>
      {props.tone === undefined ? null : (
        <View
          style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: TONE_COLOR[props.tone] }}
        />
      )}
      <Text
        numberOfLines={1}
        className="shrink text-[12px] leading-[16px]"
        style={{ color: props.palette.muted }}
      >
        {props.text}
      </Text>
    </View>
  );
}

/** The machine picker at a tab's top left: narrows the list, or opens Machines. */
export function MachinePickerButton(props: {
  readonly environments: ReadonlyArray<MachinePickerEnvironment>;
  readonly selected: EnvironmentId | null;
  readonly onSelect: (environmentId: EnvironmentId | null) => void;
  readonly onManage: () => void;
  /** Offer "All machines" (the default); a tab that reads one machine at a time leaves it out. */
  readonly allowAll?: boolean;
  /** The popover's heading, naming what the tab shows ("Show tasks from"). */
  readonly title?: string;
}) {
  const palette = usePalette();
  const popoverColor = useThemeColor("--color-popover") as string;
  const reduceMotion = useReducedMotion();
  const factsOf = useMachinePickerFacts();
  const model = buildMachinePickerModel({
    environments: props.environments,
    selected: props.selected,
    factsOf,
    now: Date.now(),
    allowAll: props.allowAll ?? true,
    title: props.title ?? DEFAULT_MACHINE_PICKER_TITLE,
  });

  const buttonRef = useRef<View>(null);
  const overlayRef = useRef<View>(null);
  const titleRef = useRef<View>(null);
  const closingRef = useRef(false);
  const [anchor, setAnchor] = useState<Frame | null>(null);
  const [overlay, setOverlay] = useState<Frame | null>(null);
  const progress = useSharedValue(0);
  const open = anchor !== null;

  const finishClose = useCallback(() => {
    closingRef.current = false;
    setAnchor(null);
    setOverlay(null);
    const button = buttonRef.current;
    if (button) AccessibilityInfo.sendAccessibilityEvent(button, "focus");
  }, []);
  const close = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    progress.set(
      withTiming(0, appMotion.exit, (finished) => {
        if (finished) runOnJS(finishClose)();
      }),
    );
  }, [finishClose, progress]);
  const show = useCallback(() => {
    if (anchor !== null || closingRef.current) return;
    buttonRef.current?.measureInWindow((x, y, width, height) => {
      setAnchor({ x, y, width, height });
    });
  }, [anchor]);

  const placed = anchor !== null && overlay !== null;
  useEffect(() => {
    if (!placed || closingRef.current) return;
    progress.set(withTiming(1, reduceMotion ? { duration: 150, easing: CSS_EASE } : DROP));
    // Move VoiceOver into the menu, at its title.
    const title = titleRef.current;
    if (title) AccessibilityInfo.sendAccessibilityEvent(title, "focus");
  }, [placed, progress, reduceMotion]);
  useEffect(() => () => cancelAnimation(progress), [progress]);
  useEffect(() => {
    if (!open) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      close();
      return true;
    });
    return () => subscription.remove();
  }, [close, open]);

  const popoverStyle = useAnimatedStyle(() => {
    const value = progress.get();
    if (reduceMotion) return { opacity: value };
    return {
      opacity: Math.min(1, value),
      transform: [{ translateY: (1 - value) * -8 }, { scale: 0.85 + 0.15 * value }],
    };
  });

  const choose = (environmentId: EnvironmentId | null) => {
    if (closingRef.current) return;
    void Haptics.selectionAsync().catch(() => undefined);
    close();
    // Without "All machines" the button can show a machine nobody picked yet: picking it saves it.
    // Without "All machines" the button can show a machine nobody picked yet: picking it saves it.
    if (environmentId !== props.selected || props.allowAll === false) props.onSelect(environmentId);
  };
  const manage = () => {
    if (closingRef.current) return;
    close();
    props.onManage();
  };

  const local =
    anchor === null || overlay === null
      ? null
      : { x: anchor.x - overlay.x, y: anchor.y - overlay.y, height: anchor.height };
  const width =
    overlay === null ? POPOVER_WIDTH : Math.min(POPOVER_WIDTH, overlay.width - 2 * SCREEN_MARGIN);
  const left =
    local === null || overlay === null
      ? 0
      : Math.min(
          Math.max(local.x + POPOVER_INSET_X, SCREEN_MARGIN),
          overlay.width - width - SCREEN_MARGIN,
        );
  const face = model.face;
  // The avatar slot glides to the new face's width while the faces cross-fade,
  // so the name slides along instead of jumping over the outgoing stack.
  const faceWidth = face.kind === "machine" ? AVATAR_SIZE : stackWidth(face.stack.length);
  const slotWidth = useSharedValue(faceWidth);
  useEffect(() => {
    slotWidth.set(
      reduceMotion
        ? faceWidth
        : withTiming(faceWidth, { duration: FACE_FADE_MS, easing: CSS_EASE }),
    );
  }, [faceWidth, reduceMotion, slotWidth]);
  const slotStyle = useAnimatedStyle(() => ({ width: slotWidth.get() + 2 * SLOT_BLEED }));
  const animateRows = !reduceMotion;

  return (
    <>
      <Pressable
        ref={buttonRef}
        collapsable={false}
        accessibilityRole="button"
        accessibilityLabel={model.accessibilityLabel}
        accessibilityState={{ expanded: open }}
        onPress={show}
        style={({ pressed }) => ({
          height: 38,
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingLeft: 4,
          paddingRight: 10,
          borderRadius: 999,
          backgroundColor: pressed || open ? palette.pressed : "transparent",
        })}
      >
        <LayoutAnimationConfig skipEntering>
          <Animated.View
            style={[
              {
                height: AVATAR_SIZE + 2 * SLOT_BLEED,
                margin: -SLOT_BLEED,
                overflow: "hidden",
              },
              slotStyle,
            ]}
          >
            <Animated.View
              key={model.faceKey}
              entering={reduceMotion ? undefined : FadeIn.duration(FACE_FADE_MS)}
              exiting={reduceMotion ? undefined : FadeOut.duration(FACE_FADE_MS)}
              style={{ position: "absolute", top: SLOT_BLEED, left: SLOT_BLEED }}
            >
              <FaceAvatar face={face} />
            </Animated.View>
          </Animated.View>
          <Animated.View
            key={model.faceKey}
            entering={reduceMotion ? undefined : NAME_ENTERING}
            className="shrink"
          >
            <FaceText face={face} palette={palette} />
          </Animated.View>
        </LayoutAnimationConfig>
        <SymbolView
          name="chevron.down"
          size={10}
          weight="bold"
          tintColor={palette.chevron}
          type="monochrome"
        />
      </Pressable>
      {anchor === null ? null : (
        <OverlayPortal>
          <View
            ref={overlayRef}
            collapsable={false}
            className="absolute inset-0"
            onLayout={() =>
              overlayRef.current?.measureInWindow((x, y, w, h) =>
                setOverlay({ x, y, width: w, height: h }),
              )
            }
          >
            <Pressable
              accessible={false}
              className="absolute inset-0"
              onPress={close}
              testID="machine-picker-backdrop"
            />
            {local === null ? null : (
              <Animated.View
                accessibilityViewIsModal
                accessibilityRole="menu"
                accessibilityLabel={model.title}
                onAccessibilityEscape={close}
                style={[
                  {
                    position: "absolute",
                    top: local.y + local.height + POPOVER_GAP,
                    left,
                    width,
                    padding: 8,
                    borderRadius: 18,
                    backgroundColor: popoverColor,
                    boxShadow: palette.popoverShadow,
                    transformOrigin: "left top",
                  },
                  popoverStyle,
                ]}
              >
                <View
                  ref={titleRef}
                  accessible
                  accessibilityRole="header"
                  accessibilityLabel={model.title}
                  style={{ paddingTop: 6, paddingBottom: 4, paddingHorizontal: 10 }}
                >
                  <Text className="text-[12px] leading-[16px]" style={{ color: palette.muted }}>
                    {model.title}
                  </Text>
                </View>
                {model.allowAll ? (
                  <PopoverRow
                    index={0}
                    animate={animateRows}
                    palette={palette}
                    selected={model.allSelected}
                    accessibilityLabel={`All machines, ${model.allDetail}`}
                    onPress={() => choose(null)}
                    avatar={
                      <MachineAvatar symbol={ALL_MACHINES_SYMBOL} tone={null} size={AVATAR_SIZE} />
                    }
                    title="All machines"
                    detail={<RowDetail palette={palette} text={model.allDetail} />}
                  />
                ) : null}
                {model.rows.map((row: MachinePickerRow, index) => (
                  <PopoverRow
                    key={row.environmentId}
                    index={index + (model.allowAll ? 1 : 0)}
                    animate={animateRows}
                    palette={palette}
                    selected={row.selected}
                    accessibilityLabel={row.accessibilityLabel}
                    onPress={() => choose(row.environmentId)}
                    avatar={
                      <MachineAvatar
                        symbol={row.symbol}
                        tone={row.tone}
                        size={ROW_AVATAR_SIZE}
                        dot
                      />
                    }
                    title={row.label}
                    detail={<RowDetail palette={palette} tone={row.tone} text={row.detail} />}
                  />
                ))}
                <View
                  style={{
                    height: 1,
                    backgroundColor: palette.divider,
                    marginVertical: 6,
                    marginHorizontal: 8,
                  }}
                />
                <PopoverRow
                  index={model.rows.length + (model.allowAll ? 1 : 0)}
                  animate={animateRows}
                  palette={palette}
                  selected={false}
                  accessibilityLabel="Manage machines"
                  onPress={manage}
                  avatar={
                    <SymbolView
                      name="gearshape"
                      size={15}
                      tintColor={palette.manage}
                      type="monochrome"
                    />
                  }
                  title="Manage machines…"
                  titleColor={palette.manage}
                  titleWeight="medium"
                />
              </Animated.View>
            )}
          </View>
        </OverlayPortal>
      )}
    </>
  );
}
