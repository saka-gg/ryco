import type { Part } from "@opencode-ai/sdk/v2";

type TextPart = Extract<Part, { type: "text" | "reasoning" }>;
const key = (sessionId: string, id: string) => `${sessionId}:${id}`;

/** Active text bodies only. Terminal IDs remain as small replay guards for the session. */
export class OpenCodePartIndex {
  readonly #parts = new Map<string, TextPart>();
  readonly #partsByMessage = new Map<string, Set<string>>();
  readonly #emittedText = new Map<string, string>();
  readonly #terminalParts = new Set<string>();
  readonly #removedMessages = new Set<string>();

  get(partKey: string): TextPart | undefined {
    return this.#parts.get(partKey);
  }

  set(part: Part): boolean {
    if (part.type !== "text" && part.type !== "reasoning") return true;
    const partKey = key(part.sessionID, part.id);
    const messageKey = key(part.sessionID, part.messageID);
    if (this.#terminalParts.has(partKey) || this.#removedMessages.has(messageKey)) return false;
    this.#parts.set(partKey, part);
    let partIds = this.#partsByMessage.get(messageKey);
    if (!partIds) this.#partsByMessage.set(messageKey, (partIds = new Set()));
    partIds.add(partKey);
    return true;
  }

  *forMessage(sessionId: string, messageId: string): Iterable<TextPart> {
    for (const partKey of this.#partsByMessage.get(key(sessionId, messageId)) ?? []) {
      const part = this.#parts.get(partKey);
      if (part) yield part;
    }
  }

  emittedText(partKey: string): string | undefined {
    return this.#emittedText.get(partKey);
  }

  setEmittedText(partKey: string, text: string): void {
    this.#emittedText.set(partKey, text);
  }

  isTerminal(partKey: string): boolean {
    return this.#terminalParts.has(partKey);
  }

  complete(partKey: string): void {
    this.#terminalParts.add(partKey);
    this.#release(partKey);
  }

  #release(partKey: string): void {
    this.#emittedText.delete(partKey);
    const part = this.#parts.get(partKey);
    this.#parts.delete(partKey);
    if (part) {
      const messageKey = key(part.sessionID, part.messageID);
      const partIds = this.#partsByMessage.get(messageKey);
      partIds?.delete(partKey);
      if (partIds?.size === 0) this.#partsByMessage.delete(messageKey);
    }
  }

  releaseMessageBodies(sessionId: string, messageId: string): void {
    for (const partKey of this.#partsByMessage.get(key(sessionId, messageId)) ?? []) {
      this.#release(partKey);
    }
  }

  removeMessage(sessionId: string, messageId: string): void {
    const messageKey = key(sessionId, messageId);
    this.#removedMessages.add(messageKey);
    for (const partKey of this.#partsByMessage.get(messageKey) ?? []) this.complete(partKey);
  }
}
