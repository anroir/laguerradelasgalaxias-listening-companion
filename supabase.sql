-- Listening Session — Supabase setup
-- 1) Run this entire script in Supabase SQL Editor.
-- 2) Create an admin user in Authentication > Users.
-- 3) Insert that user's UUID into public.admins (see bottom).

create extension if not exists pgcrypto;

create table if not exists public.session_state (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  status text not null default 'draft' check (status in ('draft','live','finished')),
  current_position integer not null default 0 check (current_position >= 0),
  title text,
  intro_title_es text,
  intro_title_en text,
  intro_text_es text,
  intro_text_en text,
  intro_cover_url text,
  updated_at timestamptz not null default now()
);

create table if not exists public.tracks (
  id uuid primary key default gen_random_uuid(),
  position integer unique not null check (position > 0),
  artist_es text not null,
  artist_en text,
  title_es text not null,
  title_en text,
  album_es text,
  album_en text,
  editorial_es text,
  editorial_en text,
  label text,
  year integer,
  cover_url text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.likes (
  id uuid primary key default gen_random_uuid(),
  target_type text not null check (target_type in ('intro','track')),
  track_id uuid references public.tracks(id) on delete cascade,
  client_id uuid not null,
  created_at timestamptz not null default now(),
  constraint likes_target_check check ((target_type='intro' and track_id is null) or (target_type='track' and track_id is not null)),
  constraint one_like_per_client unique (target_type, track_id, client_id)
);

create table if not exists public.comments (
  id uuid primary key default gen_random_uuid(),
  target_type text not null check (target_type in ('intro','track')),
  track_id uuid references public.tracks(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 1 and 60),
  body text not null check (char_length(trim(body)) between 1 and 500),
  client_id uuid not null,
  created_at timestamptz not null default now(),
  constraint comments_target_check check ((target_type='intro' and track_id is null) or (target_type='track' and track_id is not null))
);

insert into public.session_state (slug,status,current_position,title,intro_title_es,intro_title_en,intro_text_es,intro_text_en)
values ('main','draft',0,'Listening Session','Título de la sesión','Session title','Texto de introducción.','Introduction text.')
on conflict (slug) do nothing;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public
as $$ select exists(select 1 from public.admins where user_id = auth.uid()); $$;

create or replace function public.current_session() returns public.session_state
language sql stable security definer set search_path = public
as $$ select * from public.session_state where slug='main' limit 1; $$;

alter table public.session_state enable row level security;
alter table public.tracks enable row level security;
alter table public.admins enable row level security;
alter table public.likes enable row level security;
alter table public.comments enable row level security;

-- Public can see session state, but only admins can modify it.
drop policy if exists session_select on public.session_state;
create policy session_select on public.session_state for select using (true);
drop policy if exists session_admin_update on public.session_state;
create policy session_admin_update on public.session_state for update using (public.is_admin()) with check (public.is_admin());

-- Future tracks are blocked at the database level. Finished sessions unlock everything.
drop policy if exists tracks_public_select on public.tracks;
create policy tracks_public_select on public.tracks for select using (
  exists (
    select 1 from public.session_state s
    where s.slug='main' and (s.status='finished' or position <= s.current_position)
  )
  or public.is_admin()
);

drop policy if exists tracks_admin_insert on public.tracks;
create policy tracks_admin_insert on public.tracks for insert with check (public.is_admin());
drop policy if exists tracks_admin_update on public.tracks;
create policy tracks_admin_update on public.tracks for update using (public.is_admin()) with check (public.is_admin());
drop policy if exists tracks_admin_delete on public.tracks;
create policy tracks_admin_delete on public.tracks for delete using (public.is_admin());

-- Admin table is not publicly readable.
drop policy if exists admins_self_select on public.admins;
create policy admins_self_select on public.admins for select using (auth.uid() = user_id or public.is_admin());

-- Likes/comments: anyone may read reactions for unlocked content and insert a reaction/comment.
drop policy if exists likes_select on public.likes;
create policy likes_select on public.likes for select using (
  target_type='intro' or exists(select 1 from public.tracks t join public.session_state s on s.slug='main' where t.id=track_id and (s.status='finished' or t.position <= s.current_position))
);
drop policy if exists likes_insert on public.likes;
create policy likes_insert on public.likes for insert with check (
  target_type='intro' or exists(select 1 from public.tracks t join public.session_state s on s.slug='main' where t.id=track_id and (s.status='finished' or t.position <= s.current_position))
);

drop policy if exists comments_select on public.comments;
create policy comments_select on public.comments for select using (
  target_type='intro' or exists(select 1 from public.tracks t join public.session_state s on s.slug='main' where t.id=track_id and (s.status='finished' or t.position <= s.current_position))
);
drop policy if exists comments_insert on public.comments;
create policy comments_insert on public.comments for insert with check (
  target_type='intro' or exists(select 1 from public.tracks t join public.session_state s on s.slug='main' where t.id=track_id and (s.status='finished' or t.position <= s.current_position))
);

-- Realtime: add tables once. If already present, the DO block safely skips them.
do $$
begin
  begin alter publication supabase_realtime add table public.session_state; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.tracks; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.likes; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.comments; exception when duplicate_object then null; end;
end $$;

-- IMPORTANT: after creating the Auth user, run this with the real UUID:
-- insert into public.admins(user_id) values ('YOUR-AUTH-USER-UUID');

-- Likes: allow each anonymous visitor to toggle their own like.
drop policy if exists likes_delete on public.likes;

-- The original table constraint protects track likes. This partial index also makes
-- the intro like unique per visitor, because PostgreSQL UNIQUE treats NULLs as distinct.
create unique index if not exists likes_intro_one_per_client
  on public.likes (target_type, client_id)
  where target_type='intro';


-- Toggle helpers for anonymous likes. The client_id is generated and kept locally by the browser.
create or replace function public.delete_my_like(p_target_type text, p_track_id uuid, p_client_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.likes
  where target_type=p_target_type
    and client_id=p_client_id
    and ((p_track_id is null and track_id is null) or track_id=p_track_id);
end;
$$;

grant execute on function public.delete_my_like(text, uuid, uuid) to anon, authenticated;

-- Robust anonymous like toggle used by the public site.
-- Run this section too if the database was already created from an earlier version.
drop function if exists public.toggle_my_like(text, uuid, uuid, boolean);
create or replace function public.toggle_my_like(
  p_target_type text,
  p_track_id uuid,
  p_client_id uuid,
  p_like boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
  v_liked boolean := false;
begin
  if p_target_type not in ('intro','track') then
    raise exception 'Invalid target type';
  end if;

  if p_client_id is null then
    raise exception 'Client id is required';
  end if;

  if p_target_type='intro' then
    if p_track_id is not null then
      raise exception 'Invalid intro target';
    end if;
  else
    if p_track_id is null then
      raise exception 'Track id is required';
    end if;
    if not exists (
      select 1
      from public.tracks t
      join public.session_state s on s.slug='main'
      where t.id=p_track_id
        and (s.status='finished' or t.position <= s.current_position)
    ) then
      raise exception 'Track is not currently available';
    end if;
  end if;

  if p_like then
    insert into public.likes(target_type, track_id, client_id)
    values (p_target_type, p_track_id, p_client_id)
    on conflict do nothing;
    v_liked := true;
  else
    delete from public.likes
    where target_type=p_target_type
      and client_id=p_client_id
      and ((p_track_id is null and track_id is null) or track_id=p_track_id);
    v_liked := false;
  end if;

  if p_target_type='intro' then
    select count(*) into v_count from public.likes where target_type='intro';
  else
    select count(*) into v_count from public.likes where target_type='track' and track_id=p_track_id;
  end if;

  return jsonb_build_object('liked',v_liked,'count',v_count);
end;
$$;

grant execute on function public.toggle_my_like(text, uuid, uuid, boolean) to anon, authenticated;
