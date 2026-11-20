/** Thin fetch wrappers. Every call returns {ok, status, data}. */
export async function api(method, path, body, token) {
  const headers = {};
  if (body != null) headers['content-type'] = 'application/json';
  if (token) headers['authorization'] = `Bearer ${token}`;
  const res = await fetch(path, {
    method,
    headers,
    body: body == null ? undefined : JSON.stringify(body),
  });
  let data = null;
  const text = await res.text();
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { ok: res.ok, status: res.status, data };
}

/**
 * Resolve the best session candidate for a take: the room that linked it,
 * then each joined room. Returns {session, roomId, data} or null. A null
 * session still works for explicitly public demo assets.
 */
export async function sessionForTake(takeId) {
  const candidates = [];
  const mapped = localStorage.getItem(`sg-take-room:${takeId}`);
  if (mapped) candidates.push(mapped);
  for (const rid of JSON.parse(localStorage.getItem('sg-rooms') ?? '[]')) {
    if (!candidates.includes(rid)) candidates.push(rid);
  }
  for (const rid of candidates) {
    const session = localStorage.getItem(`sg-session:${rid}`);
    const { ok, data } = await api('GET', `/api/takes/${takeId}`, null, session);
    if (ok) return { session, roomId: data.take.roomId, take: data.take, me: data.me };
  }
  const { ok, data } = await api('GET', `/api/takes/${takeId}`);
  if (ok) return { session: null, roomId: data.take.roomId, take: data.take, me: null };
  return null;
}
