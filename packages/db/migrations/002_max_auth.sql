CREATE TABLE IF NOT EXISTS max_users (
  max_user_id TEXT PRIMARY KEY,
  first_name TEXT,
  last_name TEXT,
  username TEXT,
  language_code TEXT,
  photo_url TEXT,
  raw JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_chat_id TEXT,
  bot_active BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS companies_owner_max_user_unique
  ON companies(owner_max_user_id)
  WHERE owner_max_user_id IS NOT NULL;

ALTER TABLE companies ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
