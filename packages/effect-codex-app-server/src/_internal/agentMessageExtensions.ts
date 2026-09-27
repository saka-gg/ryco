/** Keep newer optional message metadata while the generated baseline stays compatible
 * with older Codex versions. Consumers validate these fields before enabling UI. */
export function preserveAgentMessageExtensions<A>(method: string, raw: unknown, decoded: A): A {
  if (method !== "item/started" && method !== "item/completed") return decoded;
  if (!raw || typeof raw !== "object" || !("item" in raw)) return decoded;
  const item = raw.item;
  if (!item || typeof item !== "object" || !("type" in item) || item.type !== "agentMessage")
    return decoded;
  if (!decoded || typeof decoded !== "object" || !("item" in decoded)) return decoded;
  return {
    ...decoded,
    item: {
      ...(decoded.item as object),
      ...("delivery" in item ? { delivery: item.delivery } : {}),
      ...("questions" in item ? { questions: item.questions } : {}),
    },
  };
}
