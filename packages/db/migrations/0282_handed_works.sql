ALTER TABLE "agent_works" ADD COLUMN "consultation_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_works" ADD COLUMN "handed_thread_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_works" ADD CONSTRAINT "agent_works_consultation_id_agent_consultations_id_fk" FOREIGN KEY ("consultation_id") REFERENCES "public"."agent_consultations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_works_consultation_id_index" ON "agent_works" USING btree ("consultation_id") WHERE "agent_works"."consultation_id" is not null;