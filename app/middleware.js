// Password page in front of /admin, the only view that shows the monks' rooms (the password lives in the
// SITE_PASSWORD env var). The rest of the site is public. It protects the viewer only: the point files in
// Blob stay readable by whoever has their address, the rooms' files included.
const COOKIE = 'grainetiere_acces';
const MONTH = 30 * 24 * 3600;

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

function page(status, message) {
  const notice = message ? `<p role="alert">${message}</p>` : '';
  return new Response(`<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Abbaye de la Grainetière</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; box-sizing: border-box;
    background: #0d0c0a; color: #f1ebdf; font: 16px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
  form { width: 100%; max-width: 340px; display: grid; gap: 12px; }
  h1 { margin: 0; font: 500 28px/1.2 Georgia, "Times New Roman", serif; }
  label { display: grid; gap: 4px; color: #b5ac9c; }
  input { min-height: 44px; padding: 8px; font: inherit; color: inherit; background: #1b1814;
    border: 1px solid rgba(241, 235, 223, .3); border-radius: 6px; }
  button { min-height: 44px; font: inherit; color: #17130c; background: #d9b779; border: 0; border-radius: 6px; cursor: pointer; }
  p { margin: 0; color: #e8a38f; }
</style></head>
<body><form method="post">
  <h1>Abbaye de la Grainetière</h1>
  <label>Mot de passe <input type="password" name="password" autocomplete="current-password" required autofocus></label>
  ${notice}
  <button>Entrer</button>
</form></body></html>`, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' },
  });
}

export const config = { matcher: ['/admin', '/admin/:path*'] };

export default async function middleware(request) {
  const password = process.env.SITE_PASSWORD;
  if (!password) return page(503, 'Accès indisponible pour le moment.');
  const expected = await tokenFor(password);
  const cookies = request.headers.get('cookie') ?? '';
  const held = cookies.split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  if (held && same(held, expected)) return new Response(null, { headers: { 'x-middleware-next': '1' } });

  if (request.method === 'POST') {
    const form = await request.formData().catch(() => null);
    if (same(String(form?.get('password') ?? ''), password)) {
      const url = new URL(request.url);
      return new Response(null, {
        status: 303,
        headers: {
          location: url.pathname + url.search,
          'set-cookie': `${COOKIE}=${expected}; Max-Age=${MONTH}; Path=/; HttpOnly; Secure; SameSite=Lax`,
        },
      });
    }
    return page(401, 'Mot de passe incorrect.');
  }
  return page(401);
}
