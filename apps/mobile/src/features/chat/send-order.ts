import type { Message } from "@agenteschat/client";
import { upsertMessage } from "@agenteschat/client/lib/timeline";

/**
 * My copies waiting behind a message going out before them (`waiting`: their `clientId`s in the order they were sent),
 * dated right after it. That message is dated as it goes (its copy is written again then), and copies on their way sort
 * by their dates, after everything the server has: it moved under the ones waiting behind it until they went too.
 */
export function datedBehind(
  list: Message[] | undefined,
  ahead: Pick<Message, "createdAt">,
  waiting: readonly string[],
): Message[] | undefined {
  const at = Date.parse(ahead.createdAt);
  const order = new Map(waiting.map((id, i) => [id, i]));
  let next = list;
  for (const m of list ?? []) {
    const i = m.local && m.clientId ? order.get(m.clientId) : undefined;
    if (i !== undefined) next = upsertMessage(next, { ...m, createdAt: new Date(at + 1 + i).toISOString() });
  }
  return next;
}
