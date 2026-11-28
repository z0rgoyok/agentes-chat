import { type Executor, rowsOf, sql } from "@agenteschat/db";
import { inChannelRun } from "./run-scope";

/**
 * A run a person asked in a regular channel's main timeline posts its first words there ("Vou levantar os números
 * agora."); everything it posts after them goes in the thread under that message (ADR 0261). From the post on, the
 * message is the run's thread root and the run answers under it (`reply_in_thread`, ADR 0214), so its later messages,
 * cards, files and live events land there by `replyThreadOf`. The message keeps who asked (`meta.turnThread.askedBy`,
 * read by `askedBy`): their next messages in the main timeline still reach the run. They follow the thread, so its
 * replies count as unread for them. DMs, task, file and code conversations, threads, long work and background runs are
 * never moved. Returns whether it moved.
 */
export async function openTurnThread(tx: Executor, runId: string, messageId: string): Promise<boolean> {
  const rows = rowsOf<{ asker: string }>(
    await tx.execute(sql`with moved as (
        update agent_runs r set thread_root_id = m.id, reply_in_thread = true, updated_at = now()
        from messages m, messages q, channels c
        where r.id = ${runId}::uuid and r.status in ('queued', 'running') and r.work_id is null and not r.background
          and ${inChannelRun(sql`r`)}
          and m.org_id = r.org_id and m.id = ${messageId}::uuid
          and m.channel_id = r.channel_id and m.thread_id is null
          and q.org_id = r.org_id and q.id = r.trigger_message_id and q.author_type = 'person'
          and c.id = r.channel_id and c.kind = 'channel'
        returning r.org_id, r.channel_id, q.author_user_id as asker
      ), marked as (
        update messages mm set meta = mm.meta || jsonb_build_object('turnThread', jsonb_build_object('askedBy', mv.asker))
        from moved mv
        where mm.org_id = mv.org_id and mm.id = ${messageId}::uuid
        returning mm.id
      ), followed as (
        insert into thread_follows (org_id, channel_id, root_message_id, user_id, following)
        select org_id, channel_id, ${messageId}::uuid, asker, true from moved
        on conflict do nothing
        returning user_id
      )
      select asker from moved`),
  );
  return rows.length > 0;
}

/**
 * A run that moved under its first message and posted nothing more there goes back to answering in the main timeline
 * when it ends: a run whose one message was its answer ends as it always did, so Continuar, a retry or a hand-on from
 * it is placed in the main timeline. Returns whether it went back.
 */
export async function closeEmptyTurnThread(tx: Executor, runId: string): Promise<boolean> {
  const rows = rowsOf<{ id: string }>(
    await tx.execute(sql`update agent_runs r set thread_root_id = r.trigger_message_id, reply_in_thread = false,
        updated_at = now()
      where r.id = ${runId}::uuid and r.reply_in_thread and r.thread_root_id <> r.trigger_message_id
        and exists (select 1 from messages root where root.org_id = r.org_id and root.id = r.thread_root_id
          and root.meta ? 'turnThread')
        and not exists (select 1 from messages t where t.org_id = r.org_id and t.channel_id = r.channel_id
          and t.thread_id = r.thread_root_id)
      returning r.id`),
  );
  return rows.length > 0;
}
