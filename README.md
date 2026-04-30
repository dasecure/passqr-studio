# PassQR Studio — Demo Pass Creator

Self-service digital wallet pass creator deployable to **GitHub Pages** + **Cloudflare Worker**.

🔗 **Live:** https://dasecure.github.io/passqr-studio/  
🔗 **Interest form:** https://dasecure.github.io/passqr-studio/interest.html

---

## Files

| File | Purpose |
|---|---|
| `index.html` | Pass creator UI (GitHub Pages) |
| `interest.html` | Lead capture / interest form (GitHub Pages) |
| `worker/index.js` | Cloudflare Worker (API proxy + iotPush + cron cleanup) |
| `worker/wrangler.toml` | Worker config |

---

## GitHub Pages

Settings → Pages → Source: **main branch / root**. Done.

> **CORS note:** Direct browser calls to `api.passqr.com` may be blocked. Deploy the Worker for production use.

---

## Cloudflare Worker

```bash
cd worker
npm install -g wrangler
wrangler login
wrangler deploy

wrangler secret put PASSQR_API_KEY
wrangler secret put PASSQR_TEMPLATE_ID
wrangler secret put IOTPUSH_TOPIC   # e.g. Claude
```

Then paste the Worker URL into ⚙️ Settings → Worker URL.

---

## Interest Form (Supabase)

```sql
create table passqr_interest (
  id           bigint generated always as identity primary key,
  full_name    text not null,
  phone        text not null,
  email        text not null,
  comms_email  boolean default false,
  comms_phone  boolean default false,
  source_url   text,
  created_at   timestamptz default now()
);
alter table passqr_interest enable row level security;
create policy "Anyone can insert" on passqr_interest for insert with check (true);
```

Edit `interest.html` constants or pass URL params:
```
?sb_url=https://xxxx.supabase.co&sb_key=eyJ...
```

No Supabase? Use `?fallback=https://formspree.io/f/YOUR_ID`

---

## iotPush

Every pass creation fires a notification to your configured topic. Subscribe at https://iotpush.com.

- **Via Worker:** set `IOTPUSH_TOPIC` secret (server-side)
- **Direct fallback:** set topic in ⚙️ Settings (client-side)

---

*PassQR Studio v1.0 · April 2026 · dasecure.com*
