import { json, getRace, readBody } from '../../lib/util.js';

// POST /api/reset {scope:'race'} -> clears start/end, all stamps and finish times; keeps runners.
// POST /api/reset {scope:'all'}  -> the above plus deletes every runner.
export async function onRequestPost({ env, request }) {
  const body = await readBody(request);
  const now = Date.now();
  const db = env.DB;
  const stmts = [
    db.prepare(`UPDATE race_state SET start_at_ms = NULL, end_at_ms = NULL, status = 'idle', updated_at = ?1, rev = rev + 1 WHERE id = 1`).bind(now),
    db.prepare('DELETE FROM finish_stamps'),
    db.prepare('UPDATE runners SET finish_ms = NULL, stamp_id = NULL'),
  ];
  if (body.scope === 'all') stmts.push(db.prepare('DELETE FROM runners'));
  await db.batch(stmts);
  return json({ ok: true, race: await getRace(db), server_time_ms: Date.now() });
}
