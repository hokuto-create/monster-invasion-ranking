import { buildPushPayload } from '@block65/webcrypto-web-push';

// 購読の保存（/subscribe・/unsubscribe）と Web Push 配信（/notify）を担う Cloudflare Worker。
// 必要なバインディング:
//   - KV namespace: SUBSCRIPTIONS
//   - Secret: VAPID_PRIVATE_KEY, NOTIFY_SECRET
//   - Var:    VAPID_PUBLIC_KEY, VAPID_SUBJECT, ALLOWED_ORIGIN(任意)

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }

    // 購読登録
    if (url.pathname === '/subscribe' && request.method === 'POST') {
      const sub = await request.json().catch(() => null);
      if (!sub || !sub.endpoint) return json({ error: 'invalid subscription' }, 400, cors);
      const id = await sha256(sub.endpoint);
      await env.SUBSCRIPTIONS.put('sub:' + id, JSON.stringify(sub));
      return json({ ok: true }, 200, cors);
    }

    // 購読解除
    if (url.pathname === '/unsubscribe' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      if (body.endpoint) await env.SUBSCRIPTIONS.delete('sub:' + (await sha256(body.endpoint)));
      return json({ ok: true }, 200, cors);
    }

    // 配信（GitHub Actions から呼び出す。NOTIFY_SECRET で認証）
    if (url.pathname === '/notify' && request.method === 'POST') {
      const auth = request.headers.get('authorization') || '';
      if (auth !== 'Bearer ' + env.NOTIFY_SECRET) {
        return json({ error: 'unauthorized' }, 401, cors);
      }
      const body = await request.json().catch(() => ({}));
      const payload = JSON.stringify({
        title: body.title || '魔物襲来 ランキング',
        body: body.body || 'ランキングが更新されました',
        url: body.url || './index.html',
      });

      const vapid = {
        subject: env.VAPID_SUBJECT || 'mailto:admin@example.com',
        publicKey: env.VAPID_PUBLIC_KEY,
        privateKey: env.VAPID_PRIVATE_KEY,
      };

      let sent = 0, removed = 0, total = 0;
      let cursor;
      do {
        const list = await env.SUBSCRIPTIONS.list({ prefix: 'sub:', cursor });
        cursor = list.list_complete ? undefined : list.cursor;
        for (const key of list.keys) {
          total++;
          const raw = await env.SUBSCRIPTIONS.get(key.name);
          if (!raw) continue;
          const sub = JSON.parse(raw);
          try {
            const push = await buildPushPayload(
              { data: payload, options: { ttl: 86400 } },
              sub,
              vapid
            );
            const res = await fetch(sub.endpoint, push);
            if (res.status === 404 || res.status === 410) {
              await env.SUBSCRIPTIONS.delete(key.name);
              removed++;
            } else {
              sent++;
            }
          } catch (_) {
            // 個別失敗は無視して続行
          }
        }
      } while (cursor);

      return json({ ok: true, total, sent, removed }, 200, cors);
    }

    return json({ error: 'not found' }, 404, cors);
  },
};
