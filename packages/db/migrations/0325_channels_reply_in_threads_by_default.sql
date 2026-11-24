ALTER TABLE "channels" ALTER COLUMN "reply_in_threads" SET DEFAULT true;--> statement-breakpoint
UPDATE "channels" SET "reply_in_threads" = true WHERE "kind" = 'channel' AND NOT "reply_in_threads";
