/**
 * The Local Trusted Introduction error, apart from its service so the desktop
 * route can classify failures without loading the E2EE stack.
 */
export type NodeLocalIntroductionErrorCode =
  | "local_introduction_unavailable"
  | "local_introduction_rejected"
  | "local_introduction_conflict"
  | "local_introduction_expired";

export class NodeLocalIntroductionError extends Error {
  readonly code: NodeLocalIntroductionErrorCode;

  constructor(code: NodeLocalIntroductionErrorCode) {
    super("Local Trusted Introduction failed.");
    this.name = "NodeLocalIntroductionError";
    this.code = code;
  }
}
