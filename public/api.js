/** Thin fetch wrappers. Every call returns {ok, status, data}. */
export async function api(method, path, body, token) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers['authorization'] = `Bearer ${token}`;
  const res = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  const text = await res.text();
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { ok: res.ok, status: res.status, data };
}
