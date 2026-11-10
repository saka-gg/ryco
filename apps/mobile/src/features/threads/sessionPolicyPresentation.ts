import type { AgentTokenMode, ProviderInteractionMode, RuntimeMode } from "@ryco/contracts";
// Type-only, so this module stays free of any React Native runtime import and
// remains loadable in the node test env (program status §1.1).
import type { SFSymbol } from "expo-symbols";

// Mobile mirror of apps/web/src/components/chat/sessionPolicyPresentation.ts.
//
// The strings are copied verbatim so the two clients name the same setting the
// same way. It is a copy rather than an import because the web module's `icon`
// field is a `lucide-react` component, which cannot render on React Native —
// here the icon is an SF Symbol name instead. Everything else must stay in sync;
// if the web labels change, change them here too.
//
// This table has TWO callers: the thread control rail and the New Task screen.
// New Task previously shipped its own vocabulary ("Ask" / "Auto edit"), which
// collided with the interaction-mode value also called "Ask". One table, one
// set of words.

export type SessionPolicyTone = "default" | "caution";

export interface SessionPolicyOptionPresentation {
  /** Full name, shown on a segment inside the sheet. */
  readonly label: string;
  /** Short name, shown on the collapsed rail pill. */
  readonly triggerLabel: string;
  readonly description: string;
  /** SF Symbol name. Every one used here is also in `ANDROID_ICON_BY_SF_SYMBOL`. */
  readonly icon: SFSymbol;
  readonly tone: SessionPolicyTone;
}

/**
 * The one runtime mode that removes every prompt before a command runs. It
 * carries a warning treatment wherever it is offered.
 *
 * It is also `DEFAULT_RUNTIME_MODE` in `@ryco/contracts`, which is exactly why
 * the treatment matters: the most permissive setting is the one a new task
 * starts in, and until now mobile rendered it as plain selected text.
 */
export const CAUTION_RUNTIME_MODE: RuntimeMode = "full-access";

export const runtimeModeConfig: Readonly<Record<RuntimeMode, SessionPolicyOptionPresentation>> = {
  "approval-required": {
    label: "Supervised",
    triggerLabel: "Supervised",
    description: "Ask before commands and file changes.",
    icon: "lock",
    tone: "default",
  },
  "auto-accept-edits": {
    label: "Auto-accept edits",
    triggerLabel: "Auto-accept",
    description: "Auto-approve edits, ask before other actions.",
    icon: "square.and.pencil",
    tone: "default",
  },
  auto: {
    label: "Auto",
    triggerLabel: "Auto",
    description: "Routine actions proceed without you; risky ones still ask.",
    icon: "checkmark.shield",
    tone: "default",
  },
  "full-access": {
    label: "Full access",
    triggerLabel: "Full access",
    description: "Allow commands and edits without prompts.",
    icon: "lock.open",
    tone: "caution",
  },
};

export const interactionModeConfig: Readonly<
  Record<ProviderInteractionMode, SessionPolicyOptionPresentation>
> = {
  default: {
    label: "Build",
    triggerLabel: "Build",
    description: "Make changes and run commands.",
    icon: "hammer",
    tone: "default",
  },
  plan: {
    label: "Plan",
    triggerLabel: "Plan",
    description: "Chat toward a plan before making changes.",
    icon: "list.clipboard",
    tone: "default",
  },
  ask: {
    label: "Ask",
    triggerLabel: "Ask",
    description: "Read-only — answer questions without editing files.",
    icon: "questionmark.circle",
    tone: "default",
  },
};

/**
 * Mirror of apps/web/src/tokenModePresentation.ts: the token budget the composer's controls set
 * (`thread.token-mode.set`). Same words as the desktop; SF Symbols for the lucide glyphs
 * (circle-off, scale, minimize-2).
 */
export const tokenModeConfig: Readonly<Record<AgentTokenMode, SessionPolicyOptionPresentation>> = {
  off: {
    label: "Off",
    triggerLabel: "Tokens off",
    description: "Do not add Ryco token-efficiency instructions.",
    icon: "circle.slash",
    tone: "default",
  },
  balanced: {
    label: "Balanced",
    triggerLabel: "Balanced",
    description: "Favor concise answers and targeted reads without hiding important detail.",
    icon: "scalemass",
    tone: "default",
  },
  aggressive: {
    label: "Aggressive",
    triggerLabel: "Aggressive",
    description: "Minimize prose and avoid copying large outputs unless needed.",
    icon: "arrow.down.right.and.arrow.up.left",
    tone: "default",
  },
};

// Declaration order is the display order, matching how web derives it with
// Object.keys over the same records. Do not sort.
export const runtimeModeOptions = Object.keys(runtimeModeConfig) as ReadonlyArray<RuntimeMode>;
export const interactionModeOptions = Object.keys(
  interactionModeConfig,
) as ReadonlyArray<ProviderInteractionMode>;
export const tokenModeOptions = Object.keys(tokenModeConfig) as ReadonlyArray<AgentTokenMode>;
