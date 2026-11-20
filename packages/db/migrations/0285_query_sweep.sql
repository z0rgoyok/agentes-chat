-- IF NOT EXISTS: on a large database an operator may build these first, CONCURRENTLY (messages: per partition, then
-- attached to an ON ONLY parent index), and this migration then leaves them as they are.
CREATE INDEX IF NOT EXISTS "messages_agent_run_id_index" ON "messages" USING btree ("agent_run_id") WHERE "messages"."agent_run_id" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_budget_periods_org_id_period_start_index" ON "agent_budget_periods" USING btree ("org_id","period_start");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_run_steps_tool_call_run_idx" ON "agent_run_steps" USING btree ("run_id","seq") WHERE "agent_run_steps"."kind" = 'tool_call';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_runs_org_id_brain_session_id_index" ON "agent_runs" USING btree ("org_id","brain_session_id") WHERE "agent_runs"."brain_session_id" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_scopes_connection_id_index" ON "agent_scopes" USING btree ("connection_id") WHERE "agent_scopes"."connection_id" is not null;