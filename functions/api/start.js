import { json, getRace } from '../../lib/util.js';

// Start 10s out: phones check in every few seconds, so all of them learn about the
// start before the visible 5-4-3-2-1 begins.
const COUNTDOWN_MS = 10000;

// POST /api/start: starts the race 10 seconds from now, only if it has not started.
export async function onRequestPost({ env }) {
  const now = Date.now();
  const res = await env.DB
    .prepare(
      `UPDATE race_state SET start_at_ms = ?1, end_at_ms = NULL, status = 'running', updated_at = ?2, rev = rev + 1
        WHERE id = 1 AND start_at_ms IS NULL`
    )
    .bind(now + COUNTDOWN_MS, now)
    .run();
  const race = await getRace(env.DB);
  return json({ started: res.meta.changes === 1, race, server_time_ms: Date.now() });
}
