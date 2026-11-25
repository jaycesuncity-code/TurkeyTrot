import { json, bad, readBody, listRunners, cleanAge, cleanName, cleanBib, isUniqueError, bump } from '../../../lib/util.js';

export async function onRequestGet({ env }) {
  return json({ runners: await listRunners(env.DB) });
}

// POST /api/runners {first_name, last_name, age_group, bib?}
// POST /api/runners {runners: [ ...same shape... ]}   (bulk add)
// Bibs are auto-numbered (highest + 1) when not given.
export async function onRequestPost({ env, request }) {
  const db = env.DB;
  const b = await readBody(request);
  const input = Array.isArray(b.runners) ? b.runners : [b];
  if (!input.length) return bad('No runners given');
  if (input.length > 500) return bad('Too many runners at once');
  const now = Date.now();
  const stmts = [];
  for (const r of input) {
    const first = cleanName(r.first_name);
    const last = cleanName(r.last_name).charAt(0).toUpperCase();
    const age = cleanAge(r.age_group);
    const bib = cleanBib(r.bib);
    if (!first) return bad('Every runner needs a first name');
    if (!age) return bad(`Age group for ${first} must be youngster or unc`);
    if (bib === undefined) return bad(`Invalid bib number for ${first}`);
    if (bib === null) {
      stmts.push(
        db
          .prepare(
            `INSERT INTO runners (bib, first_name, last_name, age_group, created_at)
             VALUES ((SELECT COALESCE(MAX(bib), 0) + 1 FROM runners), ?1, ?2, ?3, ?4)`
          )
          .bind(first, last, age, now)
      );
    } else {
      stmts.push(
        db.prepare('INSERT INTO runners (bib, first_name, last_name, age_group, created_at) VALUES (?1, ?2, ?3, ?4, ?5)').bind(bib, first, last, age, now)
      );
    }
  }
  stmts.push(bump(db));
  try {
    await db.batch(stmts);
  } catch (err) {
    if (isUniqueError(err)) return bad('That bib number is already taken', 409);
    throw err;
  }
  return json({ ok: true, runners: await listRunners(db) });
}
