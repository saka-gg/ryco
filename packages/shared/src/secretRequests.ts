/**
 * The words for secret requests (`ryco_request_secret`, `@ryco/contracts/secret-request`): why an
 * answer or a request was refused, for the card and the agent. The requests themselves are
 * derived in `@ryco/shared/secretRequestState` (`deriveSecretRequests`), which the node's
 * pending input count (`@ryco/shared/threadActivity`) reads too.
 *
 * @module secretRequests
 */
import type { SecretRequestFailureReason } from "@ryco/contracts/secret-request";

const FAILURE_MESSAGES: Record<SecretRequestFailureReason, string> = {
  "not-found": "This request no longer exists.",
  "already-answered": "This request was already answered.",
  busy: "This request is being answered from another device.",
  expired: "This request expired. Ask the agent to request the value again.",
  "empty-value": "Enter a value, or decline.",
  "value-too-long": "That value is too long for a .env file (16 KiB at most).",
  "value-characters": "That value has characters a .env file cannot hold safely.",
  "value-quoting":
    "That value mixes double quotes or backticks with line breaks or single quotes, which a .env file cannot hold safely.",
  "value-expansion":
    "That value has a $ or a backslash, which some dotenv loaders (Vite, Next.js, python-dotenv) change when they read it. Add it to the file yourself, escaped for your loader.",
  "no-checkout": "This thread has no checkout on the node to write the file into.",
  "checkout-changed":
    "This thread's checkout changed since the agent asked, so Ryco will not write there. Ask the agent to request the value again.",
  "unsafe-path":
    "The file must be inside this thread's checkout, without links, not in .git, and not a code file.",
  "name-case":
    "A file with that name in another letter case exists. Ask for the file by its exact name.",
  "not-ignored": "Git does not ignore that file, so Ryco will not write a secret there.",
  tracked:
    "Git tracks a file by that name (in some letter case), so Ryco will not write a secret there.",
  "other-repository":
    "That file belongs to another Git repository inside this checkout, so Ryco will not write a secret there.",
  "not-git":
    "Ryco writes secrets only into a file Git ignores, and this checkout is not a Git repository.",
  "not-regular-file": "That path is not a regular file.",
  "file-too-large": "That file is too large to update.",
  "write-failed": "Could not write the file.",
  "record-failed": "The file was written, but the request could not be updated. Try again.",
};

/** The words for a refusal, for the card and the agent. Fixed per reason: never the value. */
export function secretRequestFailureMessage(reason: SecretRequestFailureReason): string {
  return FAILURE_MESSAGES[reason] ?? "Could not answer the request.";
}
