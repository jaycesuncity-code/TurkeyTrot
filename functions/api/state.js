import { json, getRace, listRunners, listStamps } from '../../lib/util.js';

// GET /api/state?rev=N
// Always returns the race state (with its change counter "rev") and server_time_ms.
// Runners and finish stamps are included only when rev differs from N (or N is missing),
// so a phone that is up to date gets a tiny response.
export async function onRequestGet({ env, request }) {
  const have = new URL(request.url).searchParams.get('rev');
  const race = await getRace(env.DB);
  const out = { race };
  if (have === null || Number(have) !== race.rev) {
    const [runners, stamps] = await Promise.all([listRunners(env.DB), listStamps(env.DB)]);
    out.runners = runners;
    out.stamps = stamps;
  }
  out.server_time_ms = Date.now();
  return json(out);
}
