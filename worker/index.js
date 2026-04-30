/**
 * PassQR Studio — Cloudflare Worker
 *
 * Required secrets:
 *   PASSQR_API_KEY        — pqr_live_...
 *   PASSQR_TEMPLATE_ID    — de23a11e-a369-4d07-8f72-2df7cb1b0d87
 *   IOTPUSH_TOPIC         — claude
 *   IOTPUSH_API_KEY       — iotPush topic key (optional)
 *
 * Optional secrets (only needed for image upload feature):
 *   SUPABASE_URL          — https://gyllfnsnniuqaarsulsk.supabase.co
 *   SUPABASE_SERVICE_KEY  — Supabase service_role key
 *   PASSQR_BUSINESS_ID    — e1965c7a-e0fc-4f65-a6ff-652bea2e2173
 *
 * Notes:
 *   - /api/notify accepts EITHER pass_uuid (preferred, fast) OR pass_id (code, slower).
 *     The frontend caches the code→uuid mapping in sessionStorage from create_pass
 *     responses, so it sends pass_uuid directly. No Supabase lookup needed for the
 *     common case where the user is notifying a pass they created in this session.
 *   - Image upload still requires the Supabase secrets.
 */

const PASSQR_BASE    = 'https://www.passqr.com/api/v1';
const PASSQR_WEB     = 'https://www.passqr.com';
const STORAGE_BUCKET = 'template-images';

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

function errMsg(payload) {
  if (!payload) return 'Unknown error';
  if (typeof payload === 'string') return payload;
  const e = payload.error ?? payload;
  if (typeof e === 'string') return e;
  if (typeof e === 'object') return e.message ?? e.msg ?? JSON.stringify(e);
  return payload.message ?? JSON.stringify(payload);
}

function passqrHeaders(env) {
  return {
    Authorization: `Bearer ${env.PASSQR_API_KEY}`,
    'Content-Type': 'application/json',
    'User-Agent': 'passqr-studio/1.0',
  };
}

function walletUrls(code) {
  return {
    apple:  `${PASSQR_WEB}/api/wallet/apple?code=${code}`,
    google: `${PASSQR_WEB}/api/wallet/google?code=${code}`,
    public: `${PASSQR_WEB}/p/${code}`,
  };
}

function sbHeaders(env) {
  return {
    apikey: env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
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
    if (!res.ok) console.error('iotPush:', res.status, await res.text());
  } catch (e) { console.error('iotPush failed:', e.message); }
}

// ── Code → UUID resolver ─────────────────────────────────────────────────────
//
// Two strategies, in order of preference:
//   1. Supabase direct query (1 round-trip, instant) — if SUPABASE_URL + SUPABASE_SERVICE_KEY are set.
//   2. PassQR list API (paginates the business's passes, finds the matching code) — fallback when Supabase isn't configured.
//
// Strategy 2 is slower (up to N pages of 100 passes each) but means the notify
// feature doesn't require Supabase secrets. For demos with <100 passes the
// fallback completes in one round-trip.
async function passCodeToUuid(env, code) {
  // Strategy 1: Supabase direct query
  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY) {
    const res = await fetch(
      `${env.SUPABASE_URL}/rest/v1/passes?code=eq.${encodeURIComponent(code)}&select=id&limit=1`,
      { headers: sbHeaders(env) }
    );
    if (res.ok) {
      const rows = await res.json();
      if (Array.isArray(rows) && rows.length) return rows[0].id;
    }
  }

  // Strategy 2: PassQR list API fallback (paginate all passes for this template)
  const templateId = env.PASSQR_TEMPLATE_ID;
  if (!templateId) {
    throw new Error('Cannot resolve pass code: PASSQR_TEMPLATE_ID not set in worker, and Supabase secrets unavailable.');
  }

  const upperCode = code.toUpperCase();
  for (let page = 1; page <= 5; page++) {
    const res = await fetch(
      `${PASSQR_BASE}/passes?template_id=${templateId}&limit=100&page=${page}`,
      { headers: passqrHeaders(env) }
    );
    if (!res.ok) throw new Error(`PassQR list failed: ${res.status}`);
    const payload = await res.json();
    const passes  = Array.isArray(payload.data) ? payload.data : [];
    if (!passes.length) break;

    const match = passes.find(p => (p.code || '').toUpperCase() === upperCode);
    if (match) return match.id;

    // Stop early if we've seen the last page
    if (passes.length < 100) break;
  }

  throw new Error(`Pass not found: ${code}`);
}

async function uploadTemplateImage(env, templateId, imageType, dataUri) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY)
    throw new Error('Image upload requires SUPABASE_URL and SUPABASE_SERVICE_KEY secrets in the Cloudflare Worker.');

  const businessId = env.PASSQR_BUSINESS_ID;
  if (!businessId) throw new Error('Image upload requires PASSQR_BUSINESS_ID secret in the Cloudflare Worker.');

  const match = dataUri.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) throw new Error('Invalid image data URI');
  const [, mimeType, base64Data] = match;

  const binaryStr = atob(base64Data);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);

  const ext = mimeType.split('/')[1]?.replace('jpeg','jpg') || 'png';
  const filePath = `${businessId}/${templateId}/${imageType}_${Date.now()}.${ext}`;

  const uploadRes = await fetch(
    `${env.SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${filePath}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`, 'Content-Type': mimeType, 'x-upsert': 'true' },
      body: bytes,
    }
  );
  if (!uploadRes.ok) throw new Error(`Storage upload failed: ${await uploadRes.text()}`);

  const publicUrl = `${env.SUPABASE_URL}/storage/v1/object/public/${STORAGE_BUCKET}/${filePath}`;

  const fieldMap = { logo: 'logo_url', icon: 'icon_url', strip: 'strip_url' };
  const field = fieldMap[imageType];
  if (!field) throw new Error(`Unknown image type: ${imageType}`);

  const updateRes = await fetch(
    `${env.SUPABASE_URL}/rest/v1/templates?id=eq.${templateId}`,
    { method: 'PATCH', headers: { ...sbHeaders(env), Prefer: 'return=minimal' }, body: JSON.stringify({ [field]: publicUrl }) }
  );
  if (!updateRes.ok) throw new Error(`Template update failed: ${await updateRes.text()}`);

  return { url: publicUrl, type: imageType, field };
}

// ────────────────────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const url  = new URL(request.url);
    const path = url.pathname.replace(/\/$/, '');

    try {

      // POST /api/passes — create pass
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
        if (!res.ok) {
          console.error('PassQR create error:', JSON.stringify(payload));
          return json({ error: errMsg(payload) }, res.status);
        }

        const pass   = payload.data ?? payload;
        const urls   = walletUrls(pass.code);
        const result = { ...pass, ...urls, wallet: urls };

        await notifyIotPush(env, '\uD83C\uDFAB New Demo Pass Created',
          `Holder: ${body.holder_name} <${body.holder_email}>\nCode: ${pass.code}\nLink: ${urls.public}`);

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
        if (!res.ok) return json({ error: errMsg(p) }, res.status);
        return json(p.data ?? p);
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
      // Body: { pass_uuid?, pass_id?, title?, message }
      //   - pass_uuid is preferred (instant). The frontend caches code→uuid in sessionStorage.
      //   - pass_id (PASS-XXXXXXXX) works as fallback — resolved via Supabase or PassQR list API.
      if (path === '/api/notify' && request.method === 'POST') {
        const { pass_uuid, pass_id, message, title } = await request.json();
        if (!pass_uuid && !pass_id) return json({ error: 'pass_uuid or pass_id is required' }, 400);
        if (!message) return json({ error: 'message is required' }, 400);

        // Use the UUID directly if provided, otherwise resolve from code.
        const passUuid = pass_uuid || await passCodeToUuid(env, pass_id);

        // Fire APNs push via v1 API
        const res = await fetch(`${PASSQR_BASE}/passes/${passUuid}/push`, {
          method: 'POST',
          headers: passqrHeaders(env),
        });

        const text = await res.text();
        let d;
        try { d = JSON.parse(text); } catch { d = { raw: text }; }

        if (!res.ok) {
          if (res.status === 402) {
            return json({
              error: 'Pro plan required',
              message: 'Push notifications to Apple Wallet require a PassQR Pro plan.',
              upgrade: 'https://passqr.com/dashboard/billing',
            }, 402);
          }
          return json({ error: errMsg(d) }, res.status);
        }

        return json({ success: true, ...d, message_sent: message, title_sent: title });
      }

      // POST /api/template/image — Supabase secrets required
      if (path === '/api/template/image' && request.method === 'POST') {
        const body       = await request.json();
        const templateId = body.template_id || env.PASSQR_TEMPLATE_ID;
        const imageType  = body.type;
        const dataUri    = body.data;

        if (!['logo','icon','strip'].includes(imageType))
          return json({ error: 'type must be logo, icon, or strip' }, 400);
        if (!dataUri?.startsWith('data:image/'))
          return json({ error: 'data must be a base64 image data URI' }, 400);

        const result = await uploadTemplateImage(env, templateId, imageType, dataUri);
        return json({ success: true, ...result });
      }

      return json({ error: 'Not found' }, 404);

    } catch (err) {
      console.error('Worker error:', err);
      return json({ error: err.message ?? String(err) }, 500);
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
        await notifyIotPush(env, '\uD83D\uDDD1\uFE0F PassQR Cleanup',
          `Deleted ${deleted} expired pass${deleted !== 1 ? 'es' : ''}.`);
      }
    } catch (e) { console.error('Cron error:', e.message); }
  },
};
