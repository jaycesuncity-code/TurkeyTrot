import { json } from '../../lib/util.js';

export async function onRequest({ env, next }) {
  if (!env.DB) {
    return json({ error: 'Database not bound. Add a D1 binding named DB to this Pages project, then redeploy.' }, 500);
  }
  try {
    return await next();
  } catch (err) {
    return json({ error: String((err && err.message) || err) }, 500);
  }
}
