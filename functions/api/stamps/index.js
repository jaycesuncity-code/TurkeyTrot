import { json, bad, readBody, listStamps, bump } from '../../../lib/util.js';

export async function onRequestGet({ env }) {
  return json({ stamps: await listStamps(env.DB) });
}

// POST /api/stamps {id, elapsed_ms, created_at}
// id is a client-generated UUID, so retries are idempotent (INSERT OR IGNORE).
export async function onRequestPost({ env, request }) {
  const b = await readBody(request);
  const id = String(b.id || '').trim();
  const elapsed = Math.round(Number(b.elapsed_ms));
  if (!id || id.length > 64) return bad('Missing or invalid stamp id');
  if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > 24 * 3600 * 1000) return bad('Invalid elapsed_ms');
  let createdAt = Math.round(Number(b.created_at));
  if (!Number.isFinite(createdAt) || createdAt <= 0) createdAt = Date.now();
  const ins = await env.DB
    .prepare('INSERT OR IGNORE INTO finish_stamps (id, elapsed_ms, runner_id, created_at) VALUES (?1, ?2, NULL, ?3)')
    .bind(id, elapsed, createdAt)
    .run();
  if (ins.meta.changes) await bump(env.DB).run();
  const stamp = await env.DB.prepare('SELECT id, elapsed_ms, runner_id, created_at FROM finish_stamps WHERE id = ?1').bind(id).first();
  return json({ stamp });
}
