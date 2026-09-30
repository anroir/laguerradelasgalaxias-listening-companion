-- Add configurable intro countdown fields to the existing session_state table.
alter table public.session_state
  add column if not exists countdown_enabled boolean not null default false,
  add column if not exists countdown_target_at timestamptz;

-- No additional RLS policy is needed: session_state is already publicly readable
-- and admin-only for updates.
