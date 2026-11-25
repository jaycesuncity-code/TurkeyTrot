import { json, bad, readBody, cleanAge, cleanName, cleanBib, isUniqueError, bump } from '../../../lib/util.js';

// PATCH /api/runners/:id {first_name?, last_name?, age_group?, bib?}
export async function onRequestPatch({ env, params, request }) {
  const db = env.DB;
  const id = Number(params.id);
  const b = await readBody(request);
  const sets = [];
  const vals = [];
  if ('first_name' in b) {
    const v = cleanName(b.first_name);
    if (!v) return bad('First name is required');
    sets.push('first_name = ?');
    vals.push(v);
  }
  if ('last_name' in b) {
    sets.push('last_name = ?');
    vals.push(cleanName(b.last_name));
  }
  if ('age_group' in b) {
    const v = cleanAge(b.age_group);
    if (!v) return bad('Age group must be youngster or unc');
    sets.push('age_group = ?');
    vals.push(v);
  }
  if ('bib' in b) {
    const v = cleanBib(b.bib);
    if (v === undefined) return bad('Invalid bib number');
    sets.push('bib = ?');
    vals.push(v);
  }
  if (!sets.length) return bad('Nothing to update');
  vals.push(id);
  try {
    const res = await db.prepare(`UPDATE runners SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
    if (!res.meta.changes) return bad('Runner not found', 404);
    await bump(db).run();
  } catch (err) {
    if (isUniqueError(err)) return bad('That bib number is already taken', 409);
    throw err;
  }
  return json({ ok: true });
}

// DELETE /api/runners/:id  (frees their finish stamp back to the unassigned queue)
export async function onRequestDelete({ env, params }) {
  const db = env.DB;
  const id = Number(params.id);
  await db.batch([
    db.prepare('UPDATE finish_stamps SET runner_id = NULL WHERE runner_id = ?1').bind(id),
    db.prepare('DELETE FROM runners WHERE id = ?1').bind(id),
    bump(db),
  ]);
  return json({ ok: true });
}
