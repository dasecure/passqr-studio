/**
 * PassQR Studio — Cloudflare Worker
 *
 * Secrets:
 *   PASSQR_API_KEY        — pqr_live_...
 *   PASSQR_TEMPLATE_ID    — template UUID
 *   IOTPUSH_TOPIC         — e.g. "claude"
 *   IOTPUSH_API_KEY       — iotPush topic key
 *   SUPABASE_URL          — https://gyllfnsnniuqaarsulsk.supabase.co
 *   SUPABASE_SERVICE_KEY  — Supabase service_role key
 *   PASSQR_BUSINESS_ID    — e1965c7a-e0fc-4f65-a6ff-652bea2e2173
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

// ── Supabase image upload ────────────────────────────────────────────────────
// Accepts base64 data URI, uploads to Supabase Storage, updates template record
async function uploadTemplateImage(env, templateId, imageType, dataUri) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY secrets are required for image uploads');
  }

  const businessId = env.PASSQR_BUSINESS_ID;
  if (!businessId) throw new Error('PASSQR_BUSINESS_ID secret is required for image uploads');

  // Parse base64 data URI  →  data:image/png;base64,iVBOR...
  const match = dataUri.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) throw new Error('Invalid image data URI');
  const [, mimeType, base64Data] = match;

  // Decode base64 to binary
  const binaryStr = atob(base64Data);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);

  const ext = mimeType.split('/')[1]?.replace('jpeg','jpg') || 'png';
  const timestamp = Date.now();
  const filePath = `${businessId}/${templateId}/${imageType}_${timestamp}.${ext}`;

  // Upload to Supabase Storage
  const uploadRes = await fetch(
    `${env.SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${filePath}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        'Content-Type': mimeType,
        'x-upsert': 'true',
      },
      body: bytes,
    }
  );

  if (!uploadRes.ok) {
    const err = await uploadRes.text();
    throw new Error(`Storage upload failed: ${err}`);
  }

  // Build public URL
  const publicUrl = `${env.SUPABASE_URL}/storage/v1/object/public/${STORAGE_BUCKET}/${filePath}`;

  // Update template record in Supabase (PostgREST)
  const fieldMap = { logo: 'logo_url', icon: 'icon_url', strip: 'strip_url' };
  const field = fieldMap[imageType];
  if (!field) throw new Error(`Unknown image type: ${imageType}`);

  const updateRes = await fetch(
    `${env.SUPABASE_URL}/rest/v1/templates?id=eq.${templateId}`,
    {
      method: 'PATCH',
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ [field]: publicUrl }),
    }
  );

  if (!updateRes.ok) {
    const err = await updateRes.text();
    throw new Error(`Template DB update failed: ${err}`);
  }

  return { url: publicUrl, type: imageType, field };
}

// ────────────────────────────────────────────────────────────────────────────
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
        if (!res.ok) {
          console.error('PassQR create error:', JSON.stringify(payload));
          return json({ error: errMsg(payload) }, res.status);
        }

        const pass   = payload.data ?? payload;
        const urls   = walletUrls(pass.code);
        const result = { ...pass, ...urls, wallet: urls };

        await notifyIotPush(env, '🎫 New Demo Pass Created',
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
      if (path === '/api/notify' && request.method === 'POST') {
        const { pass_id, message, title } = await request.json();
        const res = await fetch(`${PASSQR_BASE}/passes/${pass_id}/messages`, {
          method: 'POST', headers: passqrHeaders(env),
          body: JSON.stringify({ message, title }),
        });
        const d = await res.json();
        if (!res.ok) return json({ error: errMsg(d) }, res.status);
        return json(d);
      }

      // POST /api/template/image — upload logo/icon/strip to Supabase Storage
      // Body: { template_id?, type: "logo"|"icon"|"strip", data: "data:image/...;base64,..." }
      if (path === '/api/template/image' && request.method === 'POST') {
        const body       = await request.json();
        const templateId = body.template_id || env.PASSQR_TEMPLATE_ID;
        const imageType  = body.type;   // "logo" | "icon" | "strip"
        const dataUri    = body.data;   // base64 data URI

        if (!['logo','icon','strip'].includes(imageType)) {
          return json({ error: 'type must be logo, icon, or strip' }, 400);
        }
        if (!dataUri?.startsWith('data:image/')) {
          return json({ error: 'data must be a base64 image data URI' }, 400);
        }

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
        await notifyIotPush(env, '🗑️ PassQR Cleanup',
          `Deleted ${deleted} expired pass${deleted !== 1 ? 'es' : ''}.`);
      }
    } catch (e) { console.error('Cron error:', e.message); }
  },
};
