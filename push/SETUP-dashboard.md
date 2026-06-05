# スマホ・ダッシュボードだけでセットアップ（ターミナル不要）

`push/worker-standalone.js` は外部ライブラリ不要の1ファイル版です。Cloudflareのダッシュボード画面に貼り付けるだけで動きます。

> メモしておく値（あとで3か所に入れます）
> - **Worker の URL**（手順Eで分かる）
> - **NOTIFY_SECRET**（手順Dで自分で決める長いランダム文字列）

---

## A. Worker を作る

1. ダッシュボード左メニュー **Workers & Pages** → **Create**（または Create application）
2. **Create Worker** → 名前を `monster-push` などにして **Deploy**
3. 作成後の画面で **Edit code**（コードを編集）を開く
4. エディタの中身を**全部消して**、GitHub上の `push/worker-standalone.js` の中身を**全部コピペ**
   - スマホなら GitHub でファイルを開き「Copy raw file」でコピーすると楽です
5. 右上の **Deploy**（デプロイ）

## B. 購読の保存場所（KV）を作る

1. 左メニュー **Storage & Databases** → **KV**（または Workers & Pages 内の KV）
2. **Create a namespace** → 名前を `SUBSCRIPTIONS` にして作成

## C. Worker に KV を接続する

1. **Workers & Pages** → 作った `monster-push` を開く
2. **Settings** → **Bindings**（または Variables and Bindings）→ **Add** → **KV namespace**
3. Variable name = `SUBSCRIPTIONS` / KV namespace = さっき作った `SUBSCRIPTIONS` を選ぶ → 保存

## D. 変数とシークレットを登録する

同じ **Settings** の **Variables and Secrets**（変数）で以下を追加します。

**ふつうの変数（Text / Plaintext）として:**

| 名前 | 値 |
|---|---|
| `VAPID_PUBLIC_KEY` | `BIg_g551l8PAayLBanmfP2NkeHjp0YTtdQaLmpAAIgQkx5dBeyvNxrwcNnyNG3QHwdfEuH0O9kHufJtw3uVMwek` |
| `VAPID_SUBJECT` | `mailto:t_a_112358@icloud.com` |
| `ALLOWED_ORIGIN` | `*` （あとで本番URLに絞ってもOK） |

**シークレット（Secret / Encrypt を選ぶ）として:**

| 名前 | 値 |
|---|---|
| `VAPID_PRIVATE_KEY` | `（生成したVAPID秘密鍵。非公開・Cloudflareのsecretに登録済み）` |
| `NOTIFY_SECRET` | **自分で決めた長いランダム文字列**（例: 40文字くらい。メモしておく） |

追加したら **Deploy / Save** で反映。

## E. Worker の URL を確認

Worker の画面上部に `https://monster-push.<あなた>.workers.dev` が表示されます。これを**メモ**。

---

## F. サイト側に URL を入れる（GitHub上で編集でOK）

`index.html` の次の部分の `workerUrl: ''` に、手順EのURLを入れます（末尾スラッシュなし）。
GitHubのファイル画面の鉛筆アイコンから直接編集 → Commit でも大丈夫です。

```js
const PUSH_CONFIG = {
  workerUrl: 'https://monster-push.<あなた>.workers.dev',
  vapidPublicKey: 'BIg_g551l8PAayLBanmfP2NkeHjp0YTtdQaLmpAAIgQkx5dBeyvNxrwcNnyNG3QHwdfEuH0O9kHufJtw3uVMwek'
};
```

## G. GitHub の Secret を2つ登録（自動配信用）

リポジトリの **Settings → Secrets and variables → Actions → New repository secret**:

| 名前 | 値 |
|---|---|
| `PUSH_WORKER_URL` | 手順EのURL |
| `NOTIFY_SECRET` | 手順Dで決めたのと**同じ**文字列 |

これで `data.json` が更新されるたびに、購読者へ自動で通知が届きます。

---

## 動作確認

1. サイトを開いて「🔔 更新通知」をタップ → 許可 → 「🔔 通知ON」になればOK
   （iPhoneは先に Safari → 共有 → **ホーム画面に追加** → アイコンから開く）
2. 手動テスト：Worker画面の対象を `/notify` にして、または以下を別端末から:
   - GitHub Actions タブ → `Push notification on update` → **Run workflow** でも手動送信できます
