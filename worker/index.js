/**
 * PassQR Studio — Cloudflare Worker
 * Proxies PassQR API, sends iotPush on pass creation, cleans up expired passes.
 *
 * Secrets:
 *   PASSQR_API_KEY     — pqr_live_...
 *   PASSQR_TEMPLATE_ID — template UUID
 *   IOTPUSH_TOPIC      — e.g. "claude"
 *   IOTPUSH_API_KEY    — iotPush topic API key
 */

const PASSQR_BASE = 'https://www.passqr.com/api/v1';
const PASSQR_WEB  = 'https://www.passqr.com';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function passqrHeaders(env) {
  return {
    Authorization: `Bearer ${env.PASSQR_API_KEY}`,
    'Content-Type': 'application/json',
    'User-Agent': 'passqr-studio/1.0',
  };
}

// Build wallet URLs from pass code (API does not return these)
function walletUrls(code) {
  return {
    apple:  `${PASSQR_WEB}/api/wallet/apple?code=${code}`,
    google: `${PASSQR_WEB}/api/wallet/google?code=${code}`,
    public: `${PASSQR_WEB}/p/${code}`,
  };
}

async function notifyIotPush(env, title, message) {
  const topic  = env.IOTPUSH_TOPIC   || 'claude';
  const apiKey = env.IOTPUSH_API_KEY || '';
  const headers = { Title: title, Priority: 'normal', Tags: 'wallet,pass' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  try {
    const res = await fetch(`https://www.iotpush.com/api/push/${topic}`, {
      method: 'POST', headers, body: message,
    });
    if (!res.ok) console.error('iotPush error:', res.status, await res.text());
  } catch (e) { console.error('iotPush failed:', e.message); }
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const url  = new URL(request.url);
    const path = url.pathname.replace(/\/$/, '');

    try {
      // POST /api/passes
      if (path === '/api/passes' && request.method === 'POST') {
        const body      = await request.json();
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

        const res = await fetch(`${PASSQR_BASE}/passes`, {
          method: 'POST',
          headers: passqrHeaders(env),
          body: JSON.stringify({
            template_id:  body.template_id || env.PASSQR_TEMPLATE_ID,
            holder_name:  body.holder_name,
            holder_email: body.holder_email,
            expires_at:   expiresAt,
            data:         body.data || {},
          }),
        });

        const payload = await res.json();
        if (!res.ok) return json({ error: payload }, res.status);

        const pass   = payload.data ?? payload;
        const urls   = walletUrls(pass.code);

        // Augment pass with wallet URLs before returning
        const result = { ...pass, ...urls, wallet: urls };

        await notifyIotPush(env, '🎫 New Demo Pass Created',
          `Holder: ${body.holder_name} <${body.holder_email}>\nCode: ${pass.code}\nExpires: ${new Date(expiresAt).toUTCString()}\nLink: ${urls.public}`);

        return json(result);
      }

      // PATCH /api/passes/:id
      if (path.startsWith('/api/passes/') && request.method === 'PATCH') {
        const id   = path.split('/')[3];
        const body = await request.json();
        const res  = await fetch(`${PASSQR_BASE}/passes/${id}`, {
          method: 'PATCH', headers: passqrHeaders(env), body: JSON.stringify(body),
        });
        const p = await res.json();
        return json(p.data ?? p, res.status);
      }

      // DELETE /api/passes/:id
      if (path.startsWith('/api/passes/') && request.method === 'DELETE') {
        const id  = path.split('/')[3];
        const res = await fetch(`${PASSQR_BASE}/passes/${id}`, {
          method: 'DELETE', headers: passqrHeaders(env),
        });
        return json({ deleted: res.ok }, res.status);
      }

      // POST /api/notify
      if (path === '/api/notify' && request.method === 'POST') {
        const { pass_id, message, title } = await request.json();
        const res = await fetch(`${PASSQR_BASE}/passes/${pass_id}/messages`, {
          method: 'POST', headers: passqrHeaders(env),
          body: JSON.stringify({ message, title }),
        });
        const d = await res.json();
        return json(d, res.status);
      }

      // PATCH /api/template
      if (path === '/api/template' && request.method === 'PATCH') {
        const body       = await request.json();
        const templateId = body.template_id || env.PASSQR_TEMPLATE_ID;
        const res        = await fetch(`${PASSQR_BASE}/templates/${templateId}`, {
          method: 'PATCH', headers: passqrHeaders(env),
          body: JSON.stringify(body.updates),
        });
        const d = await res.json();
        return json(d, res.status);
      }

      return json({ error: 'Not found' }, 404);

    } catch (err) {
      console.error(err);
      return json({ error: err.message }, 500);
    }
  },

  async scheduled(event, env) {
    try {
      const res = await fetch(`${PASSQR_BASE}/passes?status=expired&limit=100`, {
        headers: passqrHeaders(env),
      });
      if (!res.ok) return;
      const payload = await res.json();
      const passes  = payload.data ?? [];
      let deleted   = 0;
      for (const pass of passes) {
        const del = await fetch(`${PASSQR_BASE}/passes/${pass.id}`, {
          method: 'DELETE', headers: passqrHeaders(env),
        });
        if (del.ok) deleted++;
      }
      if (deleted > 0) {
        await notifyIotPush(env, '🗑️ PassQR Cleanup',
          `Deleted ${deleted} expired pass${deleted !== 1 ? 'es' : ''}.`);
      }
    } catch (e) { console.error('Cron error:', e.message); }
  },
};
