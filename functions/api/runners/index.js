import { json, bad, readBody, listRunners, cleanAge, cleanName, cleanBib, isUniqueError, bump } from '../../../lib/util.js';

export async function onRequestGet({ env }) {
  return json({ runners: await listRunners(env.DB) });
}

// POST /api/runners {first_name, last_name, age_group, bib?}
// POST /api/runners {runners: [ ...same shape... ]}   (bulk add)
// Bibs get a random unused 5-digit number (10000-99999) when not given.
export async function onRequestPost({ env, request }) {
  const db = env.DB;
  const b = await readBody(request);
  const input = Array.isArray(b.runners) ? b.runners : [b];
  if (!input.length) return bad('No runners given');
  if (input.length > 500) return bad('Too many runners at once');
  const now = Date.now();
  const stmts = [];
  const used = new Set((await db.prepare('SELECT bib FROM runners WHERE bib IS NOT NULL').all()).results.map((x) => x.bib));
  for (const r of input) { const v = cleanBib(r.bib); if (v) used.add(v); }
  const randomBib = () => {
    for (let i = 0; i < 1000; i++) {
      const n = 10000 + Math.floor(Math.random() * 90000);
      if (!used.has(n)) { used.add(n); return n; }
    }
    throw new Error('Could not find a free bib number');
  };
  for (const r of input) {
    const first = cleanName(r.first_name);
    const last = cleanName(r.last_name).charAt(0).toUpperCase();
    const age = cleanAge(r.age_group);
    const bib = cleanBib(r.bib);
    if (!first) return bad('Every runner needs a first name');
    if (!age) return bad(`Age group for ${first} must be youngster or unc`);
    if (bib === undefined) return bad(`Invalid bib number for ${first}`);
    stmts.push(
      db
        .prepare('INSERT INTO runners (bib, first_name, last_name, age_group, created_at) VALUES (?1, ?2, ?3, ?4, ?5)')
        .bind(bib === null ? randomBib() : bib, first, last, age, now)
    );
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
