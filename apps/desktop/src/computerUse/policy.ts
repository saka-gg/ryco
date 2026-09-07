import type {
  ComputerBrowser,
  ComputerUsePolicy,
  ComputerUseRequest,
  ComputerUseActivity,
  ComputerUseResult,
} from "@ryco/contracts";

/** Share browser denial across native app paths and extension routes. */
export function browserForApp(id: string): ComputerBrowser | null {
  if (id.startsWith("browser:")) {
    const browser = id.slice(8);
    return browser === "ryco" || browser === "chrome" || browser === "brave" || browser === "edge"
      ? browser
      : null;
  }
  const leaf = id
    .replaceAll("\\", "/")
    .split("/")
    .pop()
    ?.replace(/\.(app|exe)$/iu, "")
    .toLowerCase();
  if (
    leaf === "google chrome" ||
    leaf === "chrome" ||
    leaf === "google-chrome" ||
    leaf === "google-chrome-stable"
  )
    return "chrome";
  if (leaf === "brave browser" || leaf === "brave" || leaf === "brave-browser") return "brave";
  if (leaf === "microsoft edge" || leaf === "msedge" || leaf === "microsoft-edge") return "edge";
  return null;
}

export const DEFAULT_COMPUTER_POLICY: ComputerUsePolicy = {
  enabled: false,
  foregroundEnabled: false,
  apps: {},
  browsers: [],
};

export interface ComputerOperationContext {
  readonly request: ComputerUseRequest;
  readonly signal: AbortSignal;
  check(): void;
  authorizeApp(id: string, name: string): Promise<void>;
  authorizeForeground(): Promise<void>;
  claim(target: string): void;
  activity(value: Omit<ComputerUseActivity, "threadId">): Promise<void>;
}

export interface ComputerPolicyOptions {
  policy: ComputerUsePolicy;
  consent(input: {
    appId: string;
    name: string;
    foreground: boolean;
    threadId: string;
    signal: AbortSignal;
  }): Promise<"once" | "allow" | "block">;
  persist(policy: ComputerUsePolicy): void;
  activity(activity: ComputerUseActivity | null): void | Promise<void>;
  cancel(): void;
}

/** One owner for local consent, queue fencing, target ownership and emergency stop. */
export class ComputerPolicyController {
  private current: ComputerUsePolicy;
  private generation = 0;
  private readonly running = new Set<AbortController>();
  private readonly stoppedTurns = new Set<string>();
  private readonly seenTurns = new Set<string>();
  private readonly grants = new Set<string>();
  private readonly claims = new Map<string, { turn: string; seen: number }>();
  private tail: Promise<unknown> = Promise.resolve();

  private readonly options: ComputerPolicyOptions;
  constructor(options: ComputerPolicyOptions) {
    this.options = options;
    this.current = options.policy;
  }
  get policy(): ComputerUsePolicy {
    return this.current;
  }

  update(policy: ComputerUsePolicy): void {
    // Persistence must succeed before the new policy becomes visible.
    this.options.persist(policy);
    this.current = policy;
    this.invalidate();
  }

  private invalidate(): void {
    this.generation++;
    for (const turn of this.seenTurns) this.stoppedTurns.add(turn);
    this.seenTurns.clear();
    this.grants.clear();
    this.claims.clear();
    for (const controller of this.running) controller.abort();
    this.options.cancel();
    this.options.activity(null);
  }

  stop(): void {
    this.invalidate();
  }

  async execute(
    request: ComputerUseRequest,
    signal: AbortSignal,
    run: (context: ComputerOperationContext) => Promise<ComputerUseResult>,
  ): Promise<ComputerUseResult> {
    const generation = this.generation;
    const turn = JSON.stringify([request.sessionId, request.turnId]);
    if (this.running.size >= 64)
      throw new Error("Computer-use queue is full. Wait for current work to finish.");
    // Never evict a revocation and accidentally resurrect its active provider turn.
    if (
      !this.seenTurns.has(turn) &&
      !this.stoppedTurns.has(turn) &&
      this.seenTurns.size + this.stoppedTurns.size >= 10_000
    )
      throw new Error("Computer-use session history is full. Restart Ryco before continuing.");
    this.seenTurns.add(turn);
    for (const [target, claim] of this.claims)
      if (Date.now() - claim.seen >= 60_000) this.claims.delete(target);
    const controller = new AbortController();
    const abort = () => {
      controller.abort();
      this.stoppedTurns.add(turn);
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    controller.signal.addEventListener("abort", () => this.stoppedTurns.add(turn), { once: true });
    this.running.add(controller);
    const check = () => {
      if (
        controller.signal.aborted ||
        generation !== this.generation ||
        this.stoppedTurns.has(turn)
      )
        throw new Error("Computer use stopped. Start a new turn to resume.");
      if (!this.current.enabled)
        throw new Error("Computer use is disabled. Enable it in Ryco desktop settings.");
    };
    const ask = async (id: string, name: string, foreground: boolean) => {
      check();
      const key = JSON.stringify([turn, foreground, id]);
      if (this.grants.has(key)) return;
      const decision = await this.options.consent({
        appId: id,
        name,
        foreground,
        threadId: request.threadId,
        signal: controller.signal,
      });
      check();
      if (decision === "block") {
        if (!foreground) {
          const next = { ...this.current, apps: { ...this.current.apps, [id]: "block" as const } };
          this.options.persist(next);
          this.current = next;
        }
        throw new Error(
          foreground ? "Foreground takeover was declined." : "Access to this app was declined.",
        );
      }
      if (decision === "allow" && !foreground) {
        const next = { ...this.current, apps: { ...this.current.apps, [id]: "allow" as const } };
        this.options.persist(next);
        this.current = next;
      }
      this.grants.add(key);
      while (this.grants.size > 2_000) this.grants.delete(this.grants.values().next().value!);
    };
    const context: ComputerOperationContext = {
      request,
      signal: controller.signal,
      check,
      authorizeApp: async (id, name) => {
        check();
        const browser = browserForApp(id);
        if (
          browser &&
          Object.entries(this.current.apps).some(
            ([app, access]) => access === "block" && browserForApp(app) === browser,
          )
        )
          throw new Error(
            "This browser is blocked. Browser and native app controls share the same denial.",
          );
        const access = Object.hasOwn(this.current.apps, id) ? this.current.apps[id] : "ask";
        if (access === "block") throw new Error("Access to this app is blocked in Ryco settings.");
        if (access === "ask") await ask(id, name, false);
        check();
      },
      authorizeForeground: async () => {
        check();
        if (!this.current.foregroundEnabled)
          throw new Error(
            "Foreground takeover is disabled. Background input will not take over your mouse or keyboard.",
          );
        await ask("foreground", "your mouse and keyboard", true);
      },
      claim: (target) => {
        check();
        const existing = this.claims.get(target);
        if (existing && existing.turn !== turn && Date.now() - existing.seen < 60_000)
          throw new Error(
            "Another Ryco turn is using this target. Release it or wait for its lease to expire.",
          );
        if (!existing && this.claims.size >= 2_000)
          throw new Error("Too many active targets. Release targets before continuing.");
        this.claims.set(target, { turn, seen: Date.now() });
      },
      activity: async (value) => {
        check();
        await this.options.activity({ ...value, threadId: request.threadId });
        check();
      },
    };
    const work = this.tail
      .catch(() => undefined)
      .then(async () => {
        check();
        if (request.args.action === "release") {
          for (const [target, claim] of this.claims)
            if (claim.turn === turn) this.claims.delete(target);
          this.options.activity(null);
          return { content: [{ type: "text" as const, text: "Control released." }] };
        }
        const result = await run(context);
        check();
        return result;
      });
    this.tail = work;
    try {
      return await work;
    } finally {
      this.running.delete(controller);
      signal.removeEventListener("abort", abort);
    }
  }
}
