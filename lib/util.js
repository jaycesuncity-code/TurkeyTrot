// Shared helpers for the Pages Functions API.
export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export function bad(message, status = 400) {
  return json({ error: message }, status);
}

export async function readBody(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

export async function getRace(db) {
  const row = await db
    .prepare('SELECT start_at_ms, end_at_ms, status, updated_at, rev FROM race_state WHERE id = 1')
    .first();
  return row || { start_at_ms: null, end_at_ms: null, status: 'idle', updated_at: 0, rev: 0 };
}

export async function listRunners(db) {
  const { results } = await db
    .prepare(
      `SELECT r.id, r.bib, r.first_name, r.last_name, r.age_group, r.finish_ms, r.stamp_id, r.created_at,
              s.created_at AS stamp_created_at
         FROM runners r LEFT JOIN finish_stamps s ON s.id = r.stamp_id
        ORDER BY r.bib IS NULL, r.bib, r.id`
    )
    .all();
  return results;
}

export async function listStamps(db) {
  const { results } = await db
    .prepare('SELECT id, elapsed_ms, runner_id, created_at FROM finish_stamps ORDER BY created_at DESC, id')
    .all();
  return results;
}

export function cleanAge(value) {
  const v = String(value ?? '').toLowerCase().trim();
  if (v === 'unc') return 'unc';
  if (v === 'youngster') return 'youngster';
  return null;
}

export function cleanName(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, 60);
}

export function cleanBib(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 99999) return undefined; // undefined = invalid
  return n;
}

export function isUniqueError(err) {
  return /UNIQUE/i.test(String(err && err.message));
}

// Bump the change counter so clients know to re-download data.
export function bump(db) {
  return db.prepare('UPDATE race_state SET rev = rev + 1 WHERE id = 1');
}
