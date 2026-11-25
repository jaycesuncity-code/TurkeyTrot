import { json, getRace, readBody } from '../../lib/util.js';

// POST /api/end           -> freezes the clock now (keeps results)
// POST /api/end {resume:true} -> un-ends the race (clock keeps running from the original start)
export async function onRequestPost({ env, request }) {
  const body = await readBody(request);
  const now = Date.now();
  if (body.resume) {
    await env.DB
      .prepare(`UPDATE race_state SET end_at_ms = NULL, status = 'running', updated_at = ?1, rev = rev + 1 WHERE id = 1 AND start_at_ms IS NOT NULL`)
      .bind(now)
      .run();
  } else {
    await env.DB
      .prepare(
        `UPDATE race_state SET end_at_ms = ?1, status = 'ended', updated_at = ?1, rev = rev + 1
          WHERE id = 1 AND start_at_ms IS NOT NULL AND start_at_ms <= ?1 AND end_at_ms IS NULL`
      )
      .bind(now)
      .run();
  }
  return json({ race: await getRace(env.DB), server_time_ms: Date.now() });
}
