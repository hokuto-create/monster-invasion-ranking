# 更新プッシュ通知のセットアップ

`data.json` が更新されたら、購読した端末へ Web Push 通知を送る仕組みです。

```
[ブラウザ/PWA] --購読--> [Cloudflare Worker + KV] <--配信--  [GitHub Actions]
   index.html              push/ (このフォルダ)           .github/workflows/notify.yml
```

- iOS は **ホーム画面に追加した PWA**（iOS 16.4+）でのみ通知を受け取れます。
- Android Chrome 等はブラウザ/インストール済みPWAの両方で受け取れます。

## セットアップ方法は2通り

| 方法 | 手順書 | 向いている人 |
|---|---|---|
| **ダッシュボード操作だけ**（ターミナル不要） | **[SETUP-dashboard.md](./SETUP-dashboard.md)** | スマホ/PCのブラウザだけで完結したい |
| コマンド（`wrangler`） | このファイル（下記） | PCのターミナルが使える |

ダッシュボード方式では `worker-standalone.js`（外部ライブラリ不要の1ファイル版）を貼り付けて使います。
以下はコマンド方式の手順です。

---

## 用意済みの VAPID 鍵

このプロジェクト用に生成済みです（再生成は不要）。

| 種類 | 値 | 置き場所 |
|---|---|---|
| 公開鍵 | `BIg_g551l8PAayLBanmfP2NkeHjp0YTtdQaLmpAAIgQkx5dBeyvNxrwcNnyNG3QHwdfEuH0O9kHufJtw3uVMwek` | `index.html` の `PUSH_CONFIG.vapidPublicKey` / `wrangler.toml` の `VAPID_PUBLIC_KEY`（設定済み） |
| 秘密鍵 | `ANEEmN6cQ2H91hgfsQUZtjCnpCUFoW9gxwA6QKPmMmM` | Cloudflare の **secret** として登録（下記） |

> 秘密鍵はコミットしないでください。すでに知られてしまった場合は再生成して全箇所を差し替えます。

---

## 手順

### 1. Cloudflare Worker をデプロイ

```bash
cd push
npm install
npx wrangler login          # 初回のみ。ブラウザで Cloudflare にログイン

# KV namespace を作成し、出力された id を wrangler.toml の id に貼り付ける
npx wrangler kv namespace create SUBSCRIPTIONS

# secret を登録（プロンプトに値を貼り付け）
npx wrangler secret put VAPID_PRIVATE_KEY    # → ANEEmN6cQ2H91hgfsQUZtjCnpCUFoW9gxwA6QKPmMmM
npx wrangler secret put NOTIFY_SECRET        # → 任意の長いランダム文字列（自分で決める）

# デプロイ
npx wrangler deploy
```

デプロイ後に表示される URL（例 `https://monster-push.<あなた>.workers.dev`）を控えます。

### 2. フロント側に Worker URL を設定

`index.html` の `PUSH_CONFIG.workerUrl` に、上記の Worker URL を設定します（末尾スラッシュなし）。
空のままだと通知ボタンは表示されません。

```js
const PUSH_CONFIG = {
  workerUrl: 'https://monster-push.<あなた>.workers.dev',
  vapidPublicKey: 'BIg_g551l8PAayLBanmfP2NkeHjp0YTtdQaLmpAAIgQkx5dBeyvNxrwcNnyNG3QHwdfEuH0O9kHufJtw3uVMwek'
};
```

`ALLOWED_ORIGIN` を本番URLに絞る場合は `wrangler.toml` を編集して再デプロイしてください。

### 3. GitHub Actions の Secret を登録

リポジトリの **Settings → Secrets and variables → Actions** で以下を追加します。

| 名前 | 値 |
|---|---|
| `PUSH_WORKER_URL` | `https://monster-push.<あなた>.workers.dev` |
| `NOTIFY_SECRET` | 手順1で `NOTIFY_SECRET` に設定したのと同じ文字列 |

これで `data.json` が `main` に push されるたびに `.github/workflows/notify.yml` が走り、購読者へ通知が届きます。

---

## 動作確認

1. デプロイ後、サイトを開いて「🔔 更新通知」をタップ → 許可 → 「🔔 通知ON」になればOK。
2. 手動テスト送信:
   ```bash
   curl -X POST "$WORKER_URL/notify" \
     -H "Authorization: Bearer $NOTIFY_SECRET" \
     -H "Content-Type: application/json" \
     -d '{"title":"テスト","body":"テスト通知です"}'
   ```
   レスポンスの `sent` が購読数と一致していれば成功です。
3. GitHub Actions のタブから `Push notification on update` を **Run workflow**（workflow_dispatch）でも手動実行できます。

## エンドポイント仕様（Worker）

| メソッド | パス | 用途 | 認証 |
|---|---|---|---|
| POST | `/subscribe` | 購読を保存 | なし |
| POST | `/unsubscribe` | 購読を削除（`{endpoint}`） | なし |
| POST | `/notify` | 全購読者へ配信（`{title,body,url}`） | `Authorization: Bearer <NOTIFY_SECRET>` |
