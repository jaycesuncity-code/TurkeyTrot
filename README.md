# Turkey Trot 5K race-day app

Race clock, finish stamping, runners, leaderboard and printable bibs for the Sun City Turkey Trot.
Cloudflare Pages + D1 + Pages Functions. Plain HTML/CSS/JS, no build step.

## Layout
- `public/` static site (`index.html` app, `bibs.html` printable bibs, `shared.js` config + icons)
- `functions/api/` API (`state`, `start`, `end`, `reset`, `stamps`, `runners`)
- `lib/util.js` shared API helpers
- `migrations/` D1 schema
- `wrangler.toml` Pages config, including the D1 binding `DB`

## One-time setup (dashboard only, nothing to install)
1. **Database.** D1 database `turkey-trot-db` already exists with both migrations applied.
   To apply a migration by hand: Cloudflare dashboard → Storage & Databases → D1 → `turkey-trot-db` → Console → paste the SQL file → Execute.
2. **Pages project.** Workers & Pages → Create → Pages → Connect to Git → pick this repo.
   Framework preset: None. Build command: (blank). Build output directory: `public`. Save and Deploy.
3. **Binding.** `wrangler.toml` binds the database as `DB` automatically. If the site says
   "Database not bound": Pages project → Settings → Bindings → Add → D1 database → name `DB` → `turkey-trot-db`, then retry the latest deployment.

Every push to `main` redeploys in about a minute.

## How it works
- **Clock.** The server stores only `start_at_ms`. Each device runs the clock itself from that, corrected by the server time returned on each check-in, so every screen matches.
- **Updates.** Each open page asks the server "anything changed?" every 4 seconds. The reply is a few bytes unless something changed (a change counter `rev`), in which case it includes the new data. When someone finishes, every screen shows a "finished!" banner.
- **Hidden start.** Double-tap the clock, then within 1.5 s press and hold for 3 s, then slide "Yes". The race starts 10 s later on the server clock; every screen shows 5-4-3-2-1-GO.
- **Finish stamps** are saved on the phone first and retried until the server has them, so bad signal is fine.

## Things to tweak
- `public/shared.js` → `CONFIG`: password, which actions need it, undo window, check-in interval.
- Age-group icons: `public/assets/icons/youngster.png` and `unc.png`. Replace either file to change it.
