-- ADR 0137 §11: a person's own AI for the right hand may be the plan their own computer is signed in to (no account),
-- as any agent's owner may use. deploy-safe: existing rows keep their account. The previous version never writes a row
-- without one, and would read one as a plan with no computer (no AI) until the person picks again.
ALTER TABLE "right_hand_brains" ALTER COLUMN "brain_account_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "right_hand_brains" ADD COLUMN "machine_id" uuid;--> statement-breakpoint
ALTER TABLE "right_hand_brains" ADD CONSTRAINT "right_hand_brains_org_id_machine_id_machines_org_id_id_fk" FOREIGN KEY ("org_id","machine_id") REFERENCES "public"."machines"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "right_hand_brains" ADD CONSTRAINT "right_hand_brains_account_or_machine" CHECK ("right_hand_brains"."brain_account_id" is not null or "right_hand_brains"."machine_id" is not null);