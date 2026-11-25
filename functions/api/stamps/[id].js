import { json, bad, readBody, bump } from '../../../lib/util.js';

// PATCH /api/stamps/:id {runner_id}     -> assign (number) or unassign (null)
// PATCH /api/stamps/:id {elapsed_ms}    -> edit the recorded time
export async function onRequestPatch({ env, params, request }) {
  const db = env.DB;
  const id = String(params.id);
  const b = await readBody(request);
  const stamp = await db.prepare('SELECT id, elapsed_ms, runner_id FROM finish_stamps WHERE id = ?1').bind(id).first();
  if (!stamp) return bad('Finish time not found', 404);

  if ('elapsed_ms' in b) {
    const elapsed = Math.round(Number(b.elapsed_ms));
    if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > 24 * 3600 * 1000) return bad('Invalid time');
    await db.batch([
      db.prepare('UPDATE finish_stamps SET elapsed_ms = ?1 WHERE id = ?2').bind(elapsed, id),
      db.prepare('UPDATE runners SET finish_ms = ?1 WHERE stamp_id = ?2').bind(elapsed, id),
      bump(db),
    ]);
    return json({ ok: true });
  }

  if ('runner_id' in b) {
    const stmts = [db.prepare('UPDATE runners SET finish_ms = NULL, stamp_id = NULL WHERE stamp_id = ?1').bind(id)];
    if (b.runner_id === null) {
      stmts.push(db.prepare('UPDATE finish_stamps SET runner_id = NULL WHERE id = ?1').bind(id));
    } else {
      const runnerId = Number(b.runner_id);
      const runner = await db.prepare('SELECT id FROM runners WHERE id = ?1').bind(runnerId).first();
      if (!runner) return bad('Runner not found', 404);
      stmts.push(
        // Free any stamp this runner already had.
        db.prepare('UPDATE finish_stamps SET runner_id = NULL WHERE runner_id = ?1').bind(runnerId),
        db.prepare('UPDATE finish_stamps SET runner_id = ?1 WHERE id = ?2').bind(runnerId, id),
        db.prepare('UPDATE runners SET finish_ms = ?1, stamp_id = ?2 WHERE id = ?3').bind(stamp.elapsed_ms, id, runnerId)
      );
    }
    stmts.push(bump(db));
    await db.batch(stmts);
    return json({ ok: true });
  }

  return bad('Nothing to update');
}

// DELETE /api/stamps/:id (idempotent)
export async function onRequestDelete({ env, params }) {
  const db = env.DB;
  const id = String(params.id);
  await db.batch([
    db.prepare('UPDATE runners SET finish_ms = NULL, stamp_id = NULL WHERE stamp_id = ?1').bind(id),
    db.prepare('DELETE FROM finish_stamps WHERE id = ?1').bind(id),
    bump(db),
  ]);
  return json({ ok: true });
}
