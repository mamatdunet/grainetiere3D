// Saves what the administrator has cleaned by hand (see src/cleanup.js). Visitors read the file directly from Blob.
// The site password in middleware.js only opens the viewer: writing here takes ADMIN_PASSWORD.
import { put } from '@vercel/blob';

const COOKIE = 'grainetiere_admin';
const MONTH = 30 * 24 * 3600;
const FILE = process.env.NETTOYAGE_FILE ?? 'abbaye/nettoyage.json';
const MAX_CELLS = 2_000_000;

async function tokenFor(password) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`grainetiere3d-admin:${password}`));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function same(a, b) {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

const answer = (status, headers = {}) => new Response(null, { status, headers: { 'cache-control': 'no-store', ...headers } });

async function isAdmin(request, password) {
  const cookies = request.headers.get('cookie') ?? '';
  const held = cookies.split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  return Boolean(held) && same(held, await tokenFor(password));
}

const validCells = (list) => Array.isArray(list) && list.length <= MAX_CELLS && list.every((cell) => Number.isInteger(cell) && cell >= 0);

export async function GET(request) {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) return answer(503);
  return answer(await isAdmin(request, password) ? 204 : 401);
}

export async function POST(request) {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) return answer(503);
  const body = await request.json().catch(() => null);
  if (!body) return answer(400);
  if (typeof body.password === 'string') {
    if (!same(body.password, password)) return answer(401);
    return answer(204, { 'set-cookie': `${COOKIE}=${await tokenFor(password)}; Max-Age=${MONTH}; Path=/api; HttpOnly; Secure; SameSite=Strict` });
  }
  if (!await isAdmin(request, password)) return answer(401);
  if (!validCells(body.added) || !validCells(body.restored)) return answer(400);
  await put(FILE, JSON.stringify({ added: body.added, restored: body.restored }), {
    access: 'public',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/json',
    cacheControlMaxAge: 60,
  });
  return answer(204);
}
