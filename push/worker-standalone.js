// ============================================================
// 魔物襲来ランキング Web Push Worker（外部ライブラリ不要・1ファイル版）
// Cloudflare ダッシュボードにそのままコピペして使えます。
//
// 必要なバインディング（ダッシュボードの Settings で設定）:
//   KV namespace binding: SUBSCRIPTIONS
//   変数(Variables):       VAPID_PUBLIC_KEY, VAPID_SUBJECT, ALLOWED_ORIGIN
//   シークレット(Secret):  VAPID_PRIVATE_KEY, NOTIFY_SECRET
// ============================================================

// ---------- ユーティリティ ----------
function b64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 ? 4 - (s.length % 4) : 0;
  s += '='.repeat(pad);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function concat(...arrs) {
  let len = 0;
  for (const a of arrs) len += a.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
async function hmac(keyBytes, dataBytes) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, dataBytes));
}
async function sha256hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// ---------- VAPID 認証ヘッダ（RFC 8292） ----------
async function vapidAuth(endpoint, vapidPublic, vapidPrivate, subject) {
  const aud = new URL(endpoint).origin;
  const enc = new TextEncoder();
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = b64url(enc.encode(JSON.stringify({ aud, exp: now + 12 * 3600, sub: subject })));
  const signingInput = header + '.' + payload;

  const pub = b64urlToBytes(vapidPublic); // 0x04 || X(32) || Y(32)
  const jwk = {
    kty: 'EC', crv: 'P-256', ext: true,
    x: b64url(pub.slice(1, 33)),
    y: b64url(pub.slice(33, 65)),
    d: vapidPrivate,
  };
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(signingInput)));
  const jwt = signingInput + '.' + b64url(sig);
  return `vapid t=${jwt}, k=${vapidPublic}`;
}

// ---------- ペイロード暗号化（RFC 8291 / aes128gcm） ----------
async function encryptPayload(subscription, plaintextStr) {
  const enc = new TextEncoder();
  const plaintext = enc.encode(plaintextStr);
  const uaPublic = b64urlToBytes(subscription.keys.p256dh); // 65
  const authSecret = b64urlToBytes(subscription.keys.auth); // 16

  const asKeyPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', asKeyPair.publicKey)); // 65
  const uaPubKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaPubKey }, asKeyPair.privateKey, 256));

  const salt = crypto.getRandomValues(new Uint8Array(16));

  // 認証情報と ECDH 秘密を結合
  const prkKey = await hmac(authSecret, ecdhSecret);
  const keyInfo = concat(enc.encode('WebPush: info\0'), uaPublic, asPublic);
  const ikm = (await hmac(prkKey, concat(keyInfo, Uint8Array.of(1)))).slice(0, 32);

  // CEK と nonce を導出
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(enc.encode('Content-Encoding: aes128gcm\0'), Uint8Array.of(1)))).slice(0, 16);
  const nonce = (await hmac(prk, concat(enc.encode('Content-Encoding: nonce\0'), Uint8Array.of(1)))).slice(0, 12);

  // 最終レコード（plaintext || 0x02 区切り）を AES-128-GCM で暗号化
  const record = concat(plaintext, Uint8Array.of(2));
  const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, record));

  // ヘッダ: salt(16) || rs(4) || idlen(1) || as_public(65)
  const rs = 4096;
  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  header[16] = (rs >>> 24) & 0xff;
  header[17] = (rs >>> 16) & 0xff;
  header[18] = (rs >>> 8) & 0xff;
  header[19] = rs & 0xff;
  header[20] = asPublic.length;
  header.set(asPublic, 21);

  return concat(header, ciphertext);
}

async function sendPush(subscription, dataStr, env) {
  const body = await encryptPayload(subscription, dataStr);
  const auth = await vapidAuth(
    subscription.endpoint,
    env.VAPID_PUBLIC_KEY,
    env.VAPID_PRIVATE_KEY,
    env.VAPID_SUBJECT || 'mailto:admin@example.com'
  );
  return fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      'Authorization': auth,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      'TTL': '86400',
      'Urgency': 'normal',
    },
    body,
  });
}

// ---------- HTTP ハンドラ ----------
function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}
function json(data, status, headers) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(env);
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    if (url.pathname === '/subscribe' && request.method === 'POST') {
      const sub = await request.json().catch(() => null);
      if (!sub || !sub.endpoint || !sub.keys) return json({ error: 'invalid subscription' }, 400, cors);
      await env.SUBSCRIPTIONS.put('sub:' + (await sha256hex(sub.endpoint)), JSON.stringify(sub));
      return json({ ok: true }, 200, cors);
    }

    if (url.pathname === '/unsubscribe' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      if (body.endpoint) await env.SUBSCRIPTIONS.delete('sub:' + (await sha256hex(body.endpoint)));
      return json({ ok: true }, 200, cors);
    }

    if (url.pathname === '/notify' && request.method === 'POST') {
      if ((request.headers.get('authorization') || '') !== 'Bearer ' + env.NOTIFY_SECRET) {
        return json({ error: 'unauthorized' }, 401, cors);
      }
      const body = await request.json().catch(() => ({}));
      const dataStr = JSON.stringify({
        title: body.title || '魔物襲来 ランキング',
        body: body.body || 'ランキングが更新されました',
        url: body.url || './index.html',
      });

      let total = 0, sent = 0, removed = 0;
      let cursor;
      do {
        const list = await env.SUBSCRIPTIONS.list({ prefix: 'sub:', cursor });
        cursor = list.list_complete ? undefined : list.cursor;
        for (const key of list.keys) {
          total++;
          const raw = await env.SUBSCRIPTIONS.get(key.name);
          if (!raw) continue;
          try {
            const res = await sendPush(JSON.parse(raw), dataStr, env);
            if (res.status === 404 || res.status === 410) { await env.SUBSCRIPTIONS.delete(key.name); removed++; }
            else if (res.ok) sent++;
          } catch (_) { /* 個別失敗は無視 */ }
        }
      } while (cursor);

      return json({ ok: true, total, sent, removed }, 200, cors);
    }

    return json({ error: 'not found' }, 404, cors);
  },
};

// テスト用に内部関数も公開（ダッシュボードでは未使用・無害）
export { vapidAuth, encryptPayload, b64url, b64urlToBytes };
