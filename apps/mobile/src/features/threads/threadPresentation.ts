export interface ThreadMessagePresentation {
  readonly bubbleClassName: string;
  readonly textClassName: string;
}

export interface ThreadCalloutPresentation {
  readonly containerClassName: string;
  readonly labelClassName: string;
}

export function threadMessagePresentation(role: "user" | "assistant"): ThreadMessagePresentation {
  if (role === "user") {
    return {
      bubbleClassName: "bg-user-bubble",
      textClassName: "text-user-bubble-foreground",
    };
  }
  return {
    bubbleClassName: "border border-border bg-card",
    textClassName: "text-foreground",
  };
}

export function proposedPlanPresentation(): ThreadCalloutPresentation {
  return {
    containerClassName: "bg-plan-bg",
    labelClassName: "text-plan",
  };
}
