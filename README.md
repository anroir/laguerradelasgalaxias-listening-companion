# Listening Session

Static, mobile-first live listening-session site using GitHub + Supabase + Vercel.

## What is included

- Editorial intro page
- Grid of covers; future tracks are locked
- Track pages with Previous / Grid / Inicio / Next navigation
- Database-level RLS: future tracks are not returned to public clients
- Admin login and controls
- Start / Previous / Next / Jump / End session
- Supabase Realtime for session changes
- Supabase Realtime Presence for live listener count
- ES / EN language toggle
- Intro + track likes and named comments
- Spotify playlist link (no Spotify player on individual tracks)
- Linktree on intro, grid, end and every 10th track
- Large “Gracias” end screen

## 1. Supabase

1. Create a Supabase project.
2. Open SQL Editor.
3. Run `supabase.sql` in full.
4. Go to Authentication > Users and create the admin email/password.
5. Copy the user's UUID.
6. In SQL Editor run:

```sql
insert into public.admins(user_id) values ('YOUR-AUTH-USER-UUID');
```

7. Add your tracks in Table Editor > `tracks`, or use SQL imports. Positions must be 1,2,3... with no gaps.

Recommended track fields:
- `position`
- `artist_es`, `artist_en`
- `title_es`, `title_en`
- `album_es`, `album_en`
- `editorial_es`, `editorial_en`
- `label`, `year`
- `cover_url`

The cover URL should be a stable, publicly accessible square image. Supabase Storage is recommended for long-term reliability.

Edit `session_state` row `slug=main` for the intro:
- `intro_title_es`, `intro_title_en`
- `intro_text_es`, `intro_text_en`
- `intro_cover_url`

## 2. Local configuration

Copy:

`config.example.js` → `config.js`

Fill in:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SPOTIFY_PLAYLIST_URL`
- `LINKTREE_URL`

Only use the public Supabase `anon` key in the browser. NEVER put the service-role key in this project.

## 3. Test locally

Because browser security can interfere with local files, use a tiny local web server. If Python is installed:

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000/`.

Admin: `http://localhost:8000/admin.html`

## 4. GitHub

Create a new repository and upload all project files except `config.js`.

If you use Git from Terminal:

```bash
git init
git add .
git commit -m "Initial listening session"
git branch -M main
git remote add origin YOUR_GITHUB_REPOSITORY_URL
git push -u origin main
```

## 5. Vercel

Import the GitHub repository into Vercel. No build command is required.

The site is static HTML/CSS/JS. `config.js` is intentionally ignored by Git, so for Vercel you have two options:

### Option A — easiest
Upload `config.js` to the GitHub repository manually only if you are comfortable with the fact that the Supabase anon key is public. The anon key is designed to be public; RLS is the security layer. Never upload the service-role key.

### Option B — recommended
Create `config.js` in the Vercel deployment through your repository or change the app to read public environment values at build time. For this static no-build version, Option A is simpler.

## 6. First session

1. Open `/admin.html`.
2. Sign in.
3. Press `Start`.
4. Audience members can only query tracks up to the current position.
5. `Next` reveals the next track.
6. `Previous` moves the current position backwards.
7. `Jump` lets the admin move directly to any track.
8. `End session` changes the database state to `finished`; all tracks become public.

## 7. Important security note

The frontend does not merely hide future tracks. Supabase Row Level Security prevents public SELECT queries from returning tracks whose position is ahead of the current session position.

The admin is protected by Supabase Auth plus the `admins` table.

## 8. Listener count

The displayed listener count is concurrent online presence for the session, not total visitors. It is supplied by Supabase Realtime Presence and is intentionally not stored as a permanent counter.

## 9. Before publishing

Test with two devices/incognito windows:

- audience cannot see track 4 before the admin reaches track 4
- opening `#/track/4` directly does not bypass the lock
- Next updates both windows
- Previous works
- End session unlocks everything
- comments require a name
- likes work once per browser/client
- listener count changes when a window opens/closes
- language switch works
- Spotify playlist and Linktree URLs are correct

## 10. Adding a new session later

This first version uses the `main` session slug. The database schema already stores a slug, so it can be extended later to support multiple archived sessions without redesigning the track model.
