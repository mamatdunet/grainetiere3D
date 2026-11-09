// Serves the monks' rooms, kept in the private Blob store, to /admin only: it asks for the cookie that
// middleware.js sets once the site password is given. Byte ranges pass through, as the viewer reads nodes that way.
import { get } from '@vercel/blob';

const COOKIE = 'grainetiere_acces';
const PREFIX = 'abbaye/';

async function tokenFor(password) {
  const bytes = new TextEncoder().encode(`grainetiere3d:${password}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function same(a, b) {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

const answer = (status) => new Response(null, { status, headers: { 'cache-control': 'no-store' } });

export async function GET(request) {
  const password = process.env.SITE_PASSWORD;
  if (!password) return answer(503);
  const cookies = request.headers.get('cookie') ?? '';
  const held = cookies.split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  if (!held || !same(held, await tokenFor(password))) return answer(401);

  const path = (new URL(request.url).searchParams.get('path') ?? '').replace(/^\//, '');
  if (!/^[a-z0-9_]+(\/[a-z0-9_]+)*\.[a-z0-9.]+$/.test(path)) return answer(400);
  const range = request.headers.get('range');
  const result = await get(PREFIX + path, {
    access: 'private',
    token: process.env.PRIVE_READ_WRITE_TOKEN,
    headers: range ? { range } : {},
  }).catch(() => null);
  if (!result) return answer(404);

  const headers = { 'cache-control': 'private, max-age=3600', 'accept-ranges': 'bytes' };
  for (const name of ['content-type', 'content-length', 'content-range', 'etag', 'last-modified']) {
    const value = result.headers.get(name);
    if (value) headers[name] = value;
  }
  return new Response(result.stream, { status: headers['content-range'] ? 206 : 200, headers });
}
