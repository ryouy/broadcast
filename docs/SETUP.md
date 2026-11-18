# Broadcast セットアップ

## 概要
Broadcastは管理画面から文章を作成し、XとInstagramへの投稿候補を保存・承認するアプリです。GitHub Releases/RSS/Atomの監視は行いません。

管理画面: https://broadcast.ryouy.workers.dev/

## 認証
Google OAuthのサーバーサイドAuthorization Code + PKCEで管理者ログインします。
Cloudflare Workerに以下の変数を登録します。

| 変数 | 内容 |
| --- | --- |
| `GOOGLE_CLIENT_ID` | Google OAuth WebクライアントID |
| `GOOGLE_CLIENT_SECRET` | Google OAuthクライアントシークレット |
| `SESSION_SECRET` | Cookie署名用ランダム文字列 |
| `ALLOWED_EMAILS` | ログイン許可メールアドレス（カンマ区切り） |

Google Cloud Consoleに登録するリダイレクトURLは
`https://broadcast.ryouy.workers.dev/auth/callback` です。
認証情報が未設定の場合は管理APIを拒否します。

## 投稿手順
1. 管理画面で「投稿を作成」を開く。
2. 本文、画像URL（必要な場合）、X / Instagramの投稿先を指定する。
3. 「確認待ちに保存」を押す。保存だけで外部SNSへ投稿することはありません。
4. 「投稿一覧」で投稿内容を確認し「投稿を承認」すると送信予定になる。
5. Cloudflare Cron（`*/15 * * * *`）で送信予定分を処理する。

Xは文章280文字以内、Instagramは2200文字以内かつ公開HTTPS画像URLが必要です（現在の入力検証）。
Xへの画像アップロード、画像ファイルの直接アップロードは未実装です。

## SNS連携に必要な変数
| 変数 | 内容 |
| --- | --- |
| `X_USER_ACCESS_TOKEN` | Xの投稿権限のあるUser Access Token |
| `INSTAGRAM_ACCESS_TOKEN` | Instagram Content Publishing権限のあるトークン |
| `INSTAGRAM_USER_ID` | InstagramアカウントID |

未登録のSNSへの投稿承認はAPIで拒否します。未連携でも文章の保存・確認は可能です。
曖昧な送信失敗は`unknown`となり、自動的には再送しません。

## 保存データ
D1 `broadcast-db` の既存の`sources`、`events`、`deliveries`テーブルを利用し、手動投稿は無効化された内部ソース`manual-broadcast`に関連付けて保存します。
この内部ソースは外部フィードの取得には使用されません。既存の過去データは削除していません。
過去の`migrations/0001_init.sql`・`0002_monitoring.sql`は既存DBとの互換性のため残しています。

## 開発とデプロイ
```bash
npm install
npm run check
npm test
npm run build
cf deploy
```

GitHub Actionsはテスト・疎通確認用です。GitHubへのコミットは自動的にCloudflareへデプロイされません。
