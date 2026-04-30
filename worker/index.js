/**
 * PassQR Studio — Cloudflare Worker
 * Proxies PassQR API, sends iotPush on pass creation, cleans up expired passes.
 *
 * Secrets (set via: wrangler secret put <NAME>):
 *   PASSQR_API_KEY     — Your PassQR API key
 *   PASSQR_TEMPLATE_ID — Default template ID
 *   IOTPUSH_TOPIC      — iotPush topic (default: Claude)
 */

const PASSQR_BASE = 'https://api.passqr.com/v1';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function passqrHeaders(env) {
  return { Authorization: `Bearer ${env.PASSQR_API_KEY}`, 'Content-Type': 'application/json' };
}

async function notifyIotPush(env, title, message) {
  const topic = env.IOTPUSH_TOPIC || 'Claude';
  try {
    await fetch(`https://iotpush.com/${topic}`, {
      method: 'POST',
      headers: { Title: title, Priority: 'normal', Tags: 'wallet,pass' },
      body: message,
    });
  } catch (e) { console.error('iotPush failed:', e.message); }
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, '');
    try {
      // POST /api/passes — create pass (24h expiry)
      if (path === '/api/passes' && request.method === 'POST') {
        const body = await request.json();
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        const res = await fetch(`${PASSQR_BASE}/passes`, {
          method: 'POST',
          headers: passqrHeaders(env),
          body: JSON.stringify({ template_id: body.template_id || env.PASSQR_TEMPLATE_ID, holder_name: body.holder_name, holder_email: body.holder_email, expires_at: expiresAt, data: body.data || {} }),
        });
        const pass = await res.json();
        if (!res.ok) return json({ error: pass }, res.status);
        await notifyIotPush(env, '🎫 New Demo Pass Created', `Holder: ${body.holder_name} <${body.holder_email}>\nCode: ${pass.code}\nExpires: ${new Date(expiresAt).toUTCString()}\nLink: ${pass.public_url}`);
        return json(pass);
      }
      // PATCH /api/passes/:id
      if (path.startsWith('/api/passes/') && request.method === 'PATCH') {
        const id = path.split('/')[3];
        const body = await request.json();
        const res = await fetch(`${PASSQR_BASE}/passes/${id}`, { method: 'PATCH', headers: passqrHeaders(env), body: JSON.stringify(body) });
        return json(await res.json(), res.status);
      }
      // DELETE /api/passes/:id
      if (path.startsWith('/api/passes/') && request.method === 'DELETE') {
        const id = path.split('/')[3];
        const res = await fetch(`${PASSQR_BASE}/passes/${id}`, { method: 'DELETE', headers: passqrHeaders(env) });
        return json({ deleted: res.ok }, res.status);
      }
      // POST /api/notify
      if (path === '/api/notify' && request.method === 'POST') {
        const { pass_id, message, title } = await request.json();
        const res = await fetch(`${PASSQR_BASE}/passes/${pass_id}/messages`, { method: 'POST', headers: passqrHeaders(env), body: JSON.stringify({ message, title }) });
        return json(await res.json(), res.status);
      }
      // PATCH /api/template
      if (path === '/api/template' && request.method === 'PATCH') {
        const body = await request.json();
        const templateId = body.template_id || env.PASSQR_TEMPLATE_ID;
        const res = await fetch(`${PASSQR_BASE}/templates/${templateId}`, { method: 'PATCH', headers: passqrHeaders(env), body: JSON.stringify(body.updates) });
        return json(await res.json(), res.status);
      }
      // GET /api/template
      if (path === '/api/template' && request.method === 'GET') {
        const templateId = url.searchParams.get('id') || env.PASSQR_TEMPLATE_ID;
        const res = await fetch(`${PASSQR_BASE}/templates/${templateId}`, { headers: passqrHeaders(env) });
        return json(await res.json(), res.status);
      }
      return json({ error: 'Not found' }, 404);
    } catch (err) {
      console.error(err);
      return json({ error: err.message }, 500);
    }
  },

  // Cron: hourly cleanup of expired passes
  async scheduled(event, env) {
    console.log('Cron: cleaning up expired passes...');
    try {
      const res = await fetch(`${PASSQR_BASE}/passes?status=expired&limit=100`, { headers: passqrHeaders(env) });
      if (!res.ok) return;
      const { passes = [] } = await res.json();
      let deleted = 0;
      for (const pass of passes) {
        const del = await fetch(`${PASSQR_BASE}/passes/${pass.id}`, { method: 'DELETE', headers: passqrHeaders(env) });
        if (del.ok) deleted++;
      }
      if (deleted > 0) await notifyIotPush(env, '\uD83D\uDDD1\uFE0F PassQR Cleanup', `Deleted ${deleted} expired pass${deleted !== 1 ? 'es' : ''}.`);
    } catch (e) { console.error('Cron error:', e.message); }
  },
};