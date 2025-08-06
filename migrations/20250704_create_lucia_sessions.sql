-- Migration: Lucia Auth session table (Postgres)
CREATE TABLE IF NOT EXISTS user_session (
    id VARCHAR(255) PRIMARY KEY,
    user_id UUID NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Optional: metadata JSONB
    metadata JSONB
);

CREATE INDEX IF NOT EXISTS idx_user_session_user_id ON user_session(user_id); 