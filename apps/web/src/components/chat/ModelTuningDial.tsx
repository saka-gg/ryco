import type {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderOptionDescriptor,
  ServerProviderModel,
} from "@ryco/contracts";
import { buildProviderOptionSelectionsFromDescriptors } from "@ryco/shared/model";
import { BrainIcon, ChevronRightIcon, RotateCcwIcon, ZapIcon } from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";

import { getProviderModelCapabilities } from "../../providerModels";
import { cn } from "~/lib/utils";
import { isReducedMotionEffective } from "~/themes/appearancePreferences";
import { useModelPickerTuningBridge } from "./modelPickerTuningBridge";
import {
  getTuningScale,
  reasoningTone,
  resetTuningDescriptors,
  resolveModelTuning,
  stepTuningScale,
  type ModelTuning,
  type TuningStop,
} from "./modelTuning.logic";
import { RollingText, useTravelDirection } from "./RollingText";
import { applyDescriptorSelection, replaceDescriptorCurrentValue } from "./traitsMenuLogic";
import {
  useProviderOptionsUpdater,
  type ProviderOptions,
  type ProviderOptionsPersistence,
} from "./useProviderOptionsUpdater";

/** Half the thumb: the track insets its travel by this so the thumb never overhangs. */
const THUMB_RADIUS_PX = 15;

const ULTRATHINK_PREFIX_PATTERN = /^Ultrathink:\s*/i;

export interface ModelTuningDialProps {
  tuning: ModelTuning;
  disabled?: boolean;
  onSelectEffort: (value: string) => void;
  onSetThinking: (enabled: boolean) => void;
  onSetFastMode: (enabled: boolean) => void;
  onSelectContextWindow: (value: string) => void;
  onReset: () => void;
}

/**
 * The model picker's footer: reasoning effort (or thinking) as a snapping dial,
 * fast mode, context window and a reset, all for the active model.
 */
export const ModelTuningDial = memo(function ModelTuningDial(props: ModelTuningDialProps) {
  const { tuning } = props;
  const bridge = useModelPickerTuningBridge();
  const scale = getTuningScale(tuning);
  const disabled = props.disabled ?? false;
  const effortLocked = scale?.kind === "effort" && tuning.ultrathinkInBodyText;
  const scaleDisabled = disabled || effortLocked;
  const stop = scale ? scale.stops[scale.index] : undefined;
  const tone =
    scale?.kind === "thinking" ? (stop?.id === "on" ? "thinking" : "off") : reasoningTone(stop?.id);
  const isFastOn = tuning.fastMode?.currentValue === true;

  const { onSelectEffort, onSetThinking } = props;
  const commitStop = useCallback(
    (index: number) => {
      if (!scale || scaleDisabled) return;
      const target = scale.stops[index];
      if (!target || index === scale.index) return;
      if (scale.kind === "effort") onSelectEffort(target.id);
      else onSetThinking(target.id === "on");
    },
    [onSelectEffort, onSetThinking, scale, scaleDisabled],
  );

  // ←/→ in the picker's search field step the dial.
  useEffect(() => {
    if (!bridge) return;
    bridge.registerStepper((delta) => {
      if (!scale || scaleDisabled) return false;
      const next = stepTuningScale(scale, delta);
      if (next !== null) commitStop(next);
      return true;
    });
    return () => bridge.registerStepper(null);
  }, [bridge, commitStop, scale, scaleDisabled]);

  // Reshape smoothly when the active model brings a different set of controls.
  const rootRef = useRef<HTMLDivElement>(null);
  const shapeKey = [
    scale?.kind ?? "none",
    scale?.stops.length ?? 0,
    tuning.fastMode ? "fast" : "",
    tuning.contextWindow?.options.map((option) => option.id).join(",") ?? "",
    tuning.thinking ? "thinking" : "",
  ].join("|");
  useAnimatedHeight(rootRef, shapeKey);

  const [fastBurst, setFastBurst] = useState(0);
  const [resetSpin, setResetSpin] = useState(0);
  const modelLabel = bridge?.activeModelLabel ?? null;
  const direction = useTravelDirection(scale?.index ?? 0);

  return (
    <div
      ref={rootRef}
      className="model-dial overflow-clip px-3 pt-2 pb-2.5"
      data-reasoning-tone={tone}
      data-slot="model-tuning-dial"
    >
      <div className="flex h-7 items-center gap-1">
        {tuning.fastMode ? (
          <button
            type="button"
            aria-label="Fast mode"
            aria-pressed={isFastOn}
            title={isFastOn ? "Fast mode on" : "Fast mode off"}
            disabled={disabled}
            className={cn(
              "relative grid size-7 shrink-0 place-items-center rounded-md outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
              isFastOn
                ? "text-(--fast-mode-tone)"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
            onClick={() => {
              if (!isFastOn) setFastBurst((count) => count + 1);
              props.onSetFastMode(!isFastOn);
            }}
          >
            <ZapIcon
              aria-hidden="true"
              key={`bolt-${fastBurst}`}
              className={cn(
                "size-4",
                isFastOn && "fill-current",
                fastBurst > 0 && "model-dial-pop",
              )}
            />
            {fastBurst > 0 && isFastOn ? (
              <span key={`burst-${fastBurst}`} aria-hidden="true" className="model-dial-burst" />
            ) : null}
          </button>
        ) : null}

        <div className="flex min-w-0 flex-1 items-center gap-1.5 pl-0.5">
          {stop ? (
            <RollingText
              text={stop.label}
              direction={direction}
              className="shrink-0 font-semibold text-(--reasoning-tone) text-sm leading-5 transition-colors"
              {...(tone === "ultracode" ? { itemClassName: "reasoning-tone-shimmer" } : {})}
            />
          ) : null}
          {modelLabel ? (
            <button
              type="button"
              aria-label={`Show ${modelLabel} in the list`}
              title="Show in list"
              className="inline-flex min-w-0 items-center gap-0.5 rounded px-0.5 text-muted-foreground text-xs outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => bridge?.revealActiveModel()}
            >
              <span className="truncate">{modelLabel}</span>
              <ChevronRightIcon aria-hidden="true" className="size-3 shrink-0 opacity-70" />
            </button>
          ) : null}
        </div>

        {tuning.contextWindow ? (
          <DialSegmented
            label="Context window"
            value={
              typeof tuning.contextWindow.currentValue === "string"
                ? tuning.contextWindow.currentValue
                : (tuning.contextWindow.options.find((option) => option.isDefault)?.id ?? "")
            }
            options={tuning.contextWindow.options}
            disabled={disabled}
            onChange={props.onSelectContextWindow}
          />
        ) : null}
        {tuning.thinking && scale?.kind === "effort" ? (
          <button
            type="button"
            aria-label="Thinking"
            aria-pressed={tuning.thinking.currentValue === true}
            title={tuning.thinking.currentValue === true ? "Thinking on" : "Thinking off"}
            disabled={disabled}
            className={cn(
              "grid size-7 shrink-0 place-items-center rounded-md outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
              tuning.thinking.currentValue === true
                ? "bg-sky-500/15 text-sky-700 dark:text-sky-300"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
            onClick={() => props.onSetThinking(tuning.thinking?.currentValue !== true)}
          >
            <BrainIcon aria-hidden="true" className="size-4" />
          </button>
        ) : null}
        <button
          type="button"
          aria-label="Reset to model defaults"
          title="Reset to model defaults"
          disabled={disabled || tuning.isDefault}
          className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-30"
          onClick={() => {
            setResetSpin((count) => count + 1);
            props.onReset();
          }}
        >
          <RotateCcwIcon
            aria-hidden="true"
            key={resetSpin}
            className={cn("size-4", resetSpin > 0 && "model-dial-spin")}
          />
        </button>
      </div>

      {scale && scale.stops.length > 1 ? (
        <DialTrack
          stops={scale.stops}
          index={scale.index}
          tone={tone}
          kind={scale.kind}
          disabled={scaleDisabled}
          onCommit={commitStop}
        />
      ) : null}

      {effortLocked ? (
        <p className="mt-1 text-muted-foreground text-[11px]">
          Your prompt contains “ultrathink”. Remove it to change effort.
        </p>
      ) : null}
    </div>
  );
});

const DialTrack = memo(function DialTrack(props: {
  stops: ReadonlyArray<TuningStop>;
  index: number;
  tone: string;
  kind: "effort" | "thinking";
  disabled: boolean;
  onCommit: (index: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const fillRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const committedRef = useRef(props.index);
  const [dragging, setDragging] = useState(false);
  const count = props.stops.length;
  const position = count > 1 ? props.index / (count - 1) : 0;
  const [initialPosition] = useState(position);

  // The thumb's position is driven imperatively so a drag can follow the
  // pointer between stops without React snapping it back on every commit.
  useLayoutEffect(() => {
    committedRef.current = props.index;
    if (!draggingRef.current)
      trackRef.current?.style.setProperty("--model-dial-t", String(position));
  }, [position, props.index]);

  const positionFromPointer = (clientX: number): number => {
    const track = trackRef.current;
    if (!track) return position;
    const rect = track.getBoundingClientRect();
    const span = rect.width - 2 * THUMB_RADIUS_PX;
    return span > 0 ? Math.min(1, Math.max(0, (clientX - rect.left - THUMB_RADIUS_PX) / span)) : 0;
  };

  const commitFromPosition = (t: number) => {
    const next = Math.round(t * (count - 1));
    if (next !== committedRef.current) {
      committedRef.current = next;
      props.onCommit(next);
    }
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (props.disabled || event.button !== 0) return;
    event.preventDefault();
    const track = event.currentTarget;
    track.focus({ preventScroll: true });
    track.setPointerCapture(event.pointerId);
    draggingRef.current = true;
    setDragging(true);
    const t = positionFromPointer(event.clientX);
    track.style.setProperty("--model-dial-t", String(t));
    commitFromPosition(t);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    const t = positionFromPointer(event.clientX);
    event.currentTarget.style.setProperty("--model-dial-t", String(t));
    commitFromPosition(t);
  };

  const endDrag = () => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setDragging(false);
    const snapped = count > 1 ? committedRef.current / (count - 1) : 0;
    trackRef.current?.style.setProperty("--model-dial-t", String(snapped));
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (props.disabled) return;
    const step =
      event.key === "ArrowLeft" || event.key === "ArrowDown"
        ? -1
        : event.key === "ArrowRight" || event.key === "ArrowUp"
          ? 1
          : 0;
    let next: number | null = null;
    if (step !== 0) next = Math.min(count - 1, Math.max(0, props.index + step));
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = count - 1;
    if (next === null) return;
    event.preventDefault();
    event.stopPropagation();
    if (next !== props.index) props.onCommit(next);
  };

  const label = props.stops[props.index]?.label ?? "";
  return (
    <div
      ref={trackRef}
      role="slider"
      tabIndex={props.disabled ? -1 : 0}
      aria-label={props.kind === "effort" ? "Reasoning effort" : "Thinking"}
      aria-valuemin={0}
      aria-valuemax={count - 1}
      aria-valuenow={props.index}
      aria-valuetext={label}
      aria-disabled={props.disabled || undefined}
      data-dragging={dragging || undefined}
      title="Drag, or use ← → to adjust"
      className="model-dial-track mt-2"
      style={{ "--model-dial-t": initialPosition } as CSSProperties}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onKeyDown={handleKeyDown}
    >
      <div ref={fillRef} className="model-dial-fill">
        <DialSparks active={props.tone === "ultracode"} fillRef={fillRef} />
      </div>
      {props.stops.map((stop, index) => (
        <span
          key={stop.id}
          aria-hidden="true"
          className="model-dial-notch"
          data-lit={index <= props.index || undefined}
          style={{ "--model-dial-i": count > 1 ? index / (count - 1) : 0 } as CSSProperties}
        />
      ))}
      <span aria-hidden="true" className="model-dial-thumb" />
    </div>
  );
});

interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  r: number;
}

/** Drifting sparks inside the Ultracode fill; idle (and absent) under reduced motion. */
function DialSparks(props: { active: boolean; fillRef: RefObject<HTMLDivElement | null> }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    const fill = props.fillRef.current;
    const track = fill?.parentElement;
    const context = canvas?.getContext("2d");
    if (!props.active || !canvas || !fill || !track || !context || isReducedMotionEffective()) {
      return;
    }
    const pixelRatio = Math.min(2, window.devicePixelRatio || 1);
    const sparks: Spark[] = [];
    let frame = 0;
    let last = performance.now();
    const draw = (now: number) => {
      const dt = Math.min(50, now - last) / 16.67;
      last = now;
      const width = track.clientWidth;
      const height = track.clientHeight;
      if (canvas.width !== Math.round(width * pixelRatio)) {
        canvas.width = Math.round(width * pixelRatio);
        canvas.height = Math.round(height * pixelRatio);
        canvas.style.width = `${width}px`;
      }
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      context.clearRect(0, 0, width, height);
      const fillWidth = fill.clientWidth;
      if (sparks.length < Math.min(34, fillWidth / 7) && Math.random() < 0.6) {
        sparks.push({
          x: 5 + Math.random() * Math.max(8, fillWidth - 34),
          y: height * (0.2 + Math.random() * 0.6),
          vx: 0.2 + Math.random() * 0.55,
          vy: (Math.random() - 0.5) * 0.1,
          life: 0,
          max: 45 + Math.random() * 70,
          r: 0.55 + Math.random() * 0.95,
        });
      }
      context.fillStyle = "#ffffff";
      for (let index = sparks.length - 1; index >= 0; index -= 1) {
        const spark = sparks[index]!;
        spark.life += dt;
        spark.x += spark.vx * dt;
        spark.y += spark.vy * dt;
        if (spark.life > spark.max || spark.x > fillWidth - 16) {
          sparks.splice(index, 1);
          continue;
        }
        const alpha = Math.sin((Math.PI * spark.life) / spark.max);
        context.globalAlpha = alpha * 0.95;
        context.beginPath();
        context.arc(spark.x, spark.y, spark.r, 0, Math.PI * 2);
        context.fill();
        if (spark.r > 1.25) {
          context.globalAlpha = alpha * 0.45;
          context.fillRect(spark.x - spark.r * 2.6, spark.y - 0.35, spark.r * 5.2, 0.7);
          context.fillRect(spark.x - 0.35, spark.y - spark.r * 2.6, 0.7, spark.r * 5.2);
        }
      }
      context.globalAlpha = 1;
      frame = window.requestAnimationFrame(draw);
    };
    frame = window.requestAnimationFrame(draw);
    return () => {
      window.cancelAnimationFrame(frame);
      context.clearRect(0, 0, canvas.width, canvas.height);
    };
  }, [props.active, props.fillRef]);
  return <canvas ref={canvasRef} aria-hidden="true" className="model-dial-sparks" />;
}

/** Two-to-few option switch with a sliding indicator (context window). */
function DialSegmented(props: {
  label: string;
  value: string;
  options: ReadonlyArray<{ id: string; label: string }>;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const buttonsRef = useRef(new Map<string, HTMLButtonElement>());
  const indicatorRef = useRef<HTMLSpanElement>(null);
  const placedRef = useRef(false);
  const { options, value } = props;
  useLayoutEffect(() => {
    // Re-measure when the option set changes too: widths shift with labels.
    const button = options.some((option) => option.id === value)
      ? buttonsRef.current.get(value)
      : undefined;
    const indicator = indicatorRef.current;
    if (!button || !indicator) return;
    const instant = !placedRef.current;
    if (instant) indicator.style.transition = "none";
    indicator.style.width = `${button.offsetWidth}px`;
    indicator.style.transform = `translateX(${button.offsetLeft}px)`;
    if (instant) {
      void indicator.offsetWidth;
      indicator.style.transition = "";
      placedRef.current = true;
    }
  }, [options, value]);

  const select = (index: number) => {
    const option = props.options[index];
    if (!option || props.disabled) return;
    if (option.id !== props.value) props.onChange(option.id);
    buttonsRef.current.get(option.id)?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label={props.label}
      className="relative inline-flex rounded-md bg-foreground/6 p-0.5"
      onKeyDown={(event) => {
        const current = props.options.findIndex((option) => option.id === props.value);
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          event.stopPropagation();
          select(current + (event.key === "ArrowLeft" ? -1 : 1));
        }
      }}
    >
      <span
        ref={indicatorRef}
        aria-hidden="true"
        className="absolute inset-y-0.5 left-0 rounded-[5px] bg-background shadow-xs ring-1 ring-border transition-[transform,width] duration-(--app-motion-duration-stack) ease-(--app-motion-spring-snappy) dark:bg-white/12"
      />
      {props.options.map((option) => {
        const checked = option.id === props.value;
        return (
          <button
            key={option.id}
            ref={(element) => {
              if (element) buttonsRef.current.set(option.id, element);
              else buttonsRef.current.delete(option.id);
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            disabled={props.disabled}
            className={cn(
              "relative z-10 h-5 rounded-[5px] px-2 font-medium text-[11px] tabular-nums outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
              checked ? "text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => select(props.options.indexOf(option))}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** Animates an element's height across changes of `key` (not on mount). */
function useAnimatedHeight(ref: RefObject<HTMLElement | null>, key: string) {
  const heightRef = useRef<number | null>(null);
  const keyRef = useRef(key);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const next = element.getBoundingClientRect().height;
    const previous = heightRef.current;
    const changed = keyRef.current !== key;
    heightRef.current = next;
    keyRef.current = key;
    if (!changed || previous === null || Math.abs(previous - next) < 1) return;
    if (isReducedMotionEffective()) return;
    element.animate([{ height: `${previous}px` }, { height: `${next}px` }], {
      duration: 300,
      easing: "cubic-bezier(0.22, 1, 0.36, 1)",
    });
  });
}

export type ComposerModelTuningProps = {
  provider: ProviderDriverKind;
  instanceId?: ProviderInstanceId;
  models: ReadonlyArray<ServerProviderModel>;
  model: string;
  prompt: string;
  onPromptChange: (prompt: string) => void;
  modelOptions: ProviderOptions | null | undefined;
  /** Gated by the composer's read-only mutation capability. */
  disabled?: boolean;
} & ProviderOptionsPersistence;

/** The dial wired to the composer draft: persistence, ultrathink prompt handling, reset. */
export const ComposerModelTuning = memo(function ComposerModelTuning(
  props: ComposerModelTuningProps,
) {
  const disabled = props.disabled ?? false;
  const updateOptions = useProviderOptionsUpdater(props);
  const caps = getProviderModelCapabilities(props.models, props.model, props.provider);
  const tuning = resolveModelTuning({ caps, selections: props.modelOptions, prompt: props.prompt });
  if (!tuning) return null;

  const onChangeDescriptors = (next: ReadonlyArray<ProviderOptionDescriptor>) => {
    updateOptions(buildProviderOptionSelectionsFromDescriptors(next));
  };
  const setBoolean = (descriptorId: string | undefined, value: boolean) => {
    if (!descriptorId || disabled) return;
    onChangeDescriptors(replaceDescriptorCurrentValue(tuning.descriptors, descriptorId, value));
  };

  return (
    <ModelTuningDial
      tuning={tuning}
      disabled={disabled}
      onSelectEffort={(value) => {
        if (!tuning.effort || disabled) return;
        applyDescriptorSelection({
          descriptors: tuning.descriptors,
          descriptor: tuning.effort,
          value,
          prompt: props.prompt,
          primarySelectDescriptorId: tuning.primarySelectDescriptorId,
          ultrathinkInBodyText: tuning.ultrathinkInBodyText,
          ultrathinkPromptControlled: tuning.ultrathinkPromptControlled,
          onChangeDescriptors,
          onPromptChange: props.onPromptChange,
        });
      }}
      onSetThinking={(enabled) => setBoolean(tuning.thinking?.id, enabled)}
      onSetFastMode={(enabled) => setBoolean(tuning.fastMode?.id, enabled)}
      onSelectContextWindow={(value) => {
        if (!tuning.contextWindow || disabled) return;
        onChangeDescriptors(
          replaceDescriptorCurrentValue(tuning.descriptors, tuning.contextWindow.id, value),
        );
      }}
      onReset={() => {
        if (disabled) return;
        if (tuning.ultrathinkPromptControlled && !tuning.ultrathinkInBodyText) {
          props.onPromptChange(props.prompt.replace(ULTRATHINK_PREFIX_PATTERN, ""));
        }
        onChangeDescriptors(resetTuningDescriptors({ caps, descriptors: tuning.descriptors }));
      }}
    />
  );
});
