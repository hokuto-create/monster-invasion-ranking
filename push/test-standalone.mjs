// worker-standalone.js の暗号化・VAPID署名が正しいか検証する（Node 22 で実行）
import { vapidAuth, encryptPayload, b64url, b64urlToBytes } from './worker-standalone.js';

const VAPID_PUBLIC = 'BIg_g551l8PAayLBanmfP2NkeHjp0YTtdQaLmpAAIgQkx5dBeyvNxrwcNnyNG3QHwdfEuH0O9kHufJtw3uVMwek';
const VAPID_PRIVATE = 'ANEEmN6cQ2H91hgfsQUZtjCnpCUFoW9gxwA6QKPmMmM';

function concat(...arrs) {
  let len = 0; for (const a of arrs) len += a.length;
  const out = new Uint8Array(len); let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
async function hmac(keyBytes, dataBytes) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, dataBytes));
}

// ---- 1) ブラウザ購読をシミュレート（UA鍵ペアを生成） ----
const uaKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
const uaPublic = new Uint8Array(await crypto.subtle.exportKey('raw', uaKeys.publicKey));
const authSecret = crypto.getRandomValues(new Uint8Array(16));
const subscription = {
  endpoint: 'https://web.push.apple.com/example-endpoint-123',
  keys: { p256dh: b64url(uaPublic), auth: b64url(authSecret) },
};

// ---- 2) 暗号化 ----
const message = JSON.stringify({ title: 'テスト', body: '6/4(木) メドゥーサ 更新', url: './index.html' });
const body = await encryptPayload(subscription, message);

// ---- 3) UA側として復号（RFC 8188 の逆処理） ----
const salt = body.slice(0, 16);
const idlen = body[20];
const asPublic = body.slice(21, 21 + idlen);
const ciphertext = body.slice(21 + idlen);

const asPubKey = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asPubKey }, uaKeys.privateKey, 256));

const enc = new TextEncoder();
const prkKey = await hmac(authSecret, ecdhSecret);
const keyInfo = concat(enc.encode('WebPush: info\0'), uaPublic, asPublic);
const ikm = (await hmac(prkKey, concat(keyInfo, Uint8Array.of(1)))).slice(0, 32);
const prk = await hmac(salt, ikm);
const cek = (await hmac(prk, concat(enc.encode('Content-Encoding: aes128gcm\0'), Uint8Array.of(1)))).slice(0, 16);
const nonce = (await hmac(prk, concat(enc.encode('Content-Encoding: nonce\0'), Uint8Array.of(1)))).slice(0, 12);

const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['decrypt']);
const recordBuf = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, ciphertext));
const delim = recordBuf[recordBuf.length - 1];
const decrypted = new TextDecoder().decode(recordBuf.slice(0, -1));

console.log('復号結果:', decrypted);
console.log('区切りバイト(0x02期待):', delim);
const encOk = decrypted === message && delim === 2;
console.log('暗号化ラウンドトリップ:', encOk ? 'OK ✅' : 'NG ❌');

// ---- 4) VAPID JWT を検証 ----
const authHeader = await vapidAuth(subscription.endpoint, VAPID_PUBLIC, VAPID_PRIVATE, 'mailto:test@example.com');
const m = authHeader.match(/^vapid t=([^,]+), k=(.+)$/);
const jwt = m[1];
const [h, p, s] = jwt.split('.');
const pub = b64urlToBytes(VAPID_PUBLIC);
const verifyKey = await crypto.subtle.importKey(
  'jwk',
  { kty: 'EC', crv: 'P-256', x: b64url(pub.slice(1, 33)), y: b64url(pub.slice(33, 65)), ext: true },
  { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']
);
const sigBytes = b64urlToBytes(s);
const valid = await crypto.subtle.verify(
  { name: 'ECDSA', hash: 'SHA-256' }, verifyKey, sigBytes, new TextEncoder().encode(h + '.' + p)
);
const payloadObj = JSON.parse(new TextDecoder().decode(b64urlToBytes(p)));
console.log('VAPID payload:', payloadObj);
console.log('VAPID署名検証:', valid ? 'OK ✅' : 'NG ❌');
console.log('aud(エンドポイントoriginと一致):', payloadObj.aud === 'https://web.push.apple.com' ? 'OK ✅' : 'NG ❌');

if (!encOk || !valid) process.exit(1);
console.log('\n全テスト合格 🎉');
