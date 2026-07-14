ALTER TABLE "refresh_token_sessions"
ADD COLUMN "token_family" TEXT,
ADD COLUMN "last_used_at" TIMESTAMP(3),
ADD COLUMN "replaced_by_session_id" TEXT,
ADD COLUMN "user_agent" TEXT,
ADD COLUMN "ip_hash" TEXT;

UPDATE "refresh_token_sessions"
SET
  "token_family" = "id",
  "last_used_at" = "created_at"
WHERE "token_family" IS NULL OR "last_used_at" IS NULL;

ALTER TABLE "refresh_token_sessions"
ALTER COLUMN "token_family" SET NOT NULL,
ALTER COLUMN "last_used_at" SET NOT NULL,
ALTER COLUMN "last_used_at" SET DEFAULT CURRENT_TIMESTAMP;

CREATE UNIQUE INDEX "refresh_token_sessions_replaced_by_session_id_key" ON "refresh_token_sessions"("replaced_by_session_id");
CREATE INDEX "refresh_token_sessions_token_family_idx" ON "refresh_token_sessions"("token_family");
CREATE INDEX "refresh_token_sessions_expires_at_idx" ON "refresh_token_sessions"("expires_at");
CREATE INDEX "refresh_token_sessions_revoked_at_idx" ON "refresh_token_sessions"("revoked_at");

ALTER TABLE "refresh_token_sessions"
ADD CONSTRAINT "refresh_token_sessions_replaced_by_session_id_fkey"
FOREIGN KEY ("replaced_by_session_id") REFERENCES "refresh_token_sessions"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
