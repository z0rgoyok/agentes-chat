-- ADR 0237: when a lending computer last carried a lent connection, whoever borrowed ("In use now").
ALTER TABLE "machines" ADD COLUMN "egress_lent_at" timestamp with time zone;
