import { hostedOnly } from "../hostedHub/hostedOnly";

/**
 * Standard-build stand-in for `./lifecycle` (wired by `src/clientModeSeams.ts`).
 * The installable PWA shell exists only in hosted-hub builds — its service
 * worker is emitted by the hosted build plugin alone — so a standard build has
 * no lifecycle to start. Signatures are pinned to the real module below.
 */
type Hosted = typeof import("./lifecycle");

export const hostedPwaLifecycle: Hosted["hostedPwaLifecycle"] = null;

export const createHostedPwaLifecycle: Hosted["createHostedPwaLifecycle"] = () =>
  hostedOnly("createHostedPwaLifecycle");
