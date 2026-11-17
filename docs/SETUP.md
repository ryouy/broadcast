# Broadcast — セットアップ

## 現在の機能
- GitHub `release.published` を署名検証して受信し、登録したリポジトリのイベントのみD1に保存
- GitHub Releases APIの定期監視（Webhook権限がなくても動作）
- RSS/Atomを15分間隔で確認。最初の読み込みでは過去記事を投稿しない
- X / Instagram 向けの投稿を独立したキューに登録
- Google OAuth（OpenID Connect）でログインし、許可メールアドレスだけが投稿を承認・スキップできる。Google設定前は従来の管理トークンを暫定使用
- 承認したジョブのみCronから投稿を試行。初期状態は公開しない
- 送信結果が不明なら `unknown` に留め、自動再送を避ける

## 現在のCloudflare環境（2026-11-17）
- Worker: `broadcast`
- URL: https://broadcast.ryouy.workers.dev/
- D1: `broadcast-db`（初期SQL適用済み）
- Cron: `*/15 * * * *`（UTC、15分ごと）
- GitHub Releases APIの定期監視と、Google OAuth移行用の認証コードを実装済み。Googleのシークレットを全て登録するとGoogleログイン方式に切り替わります。
- `ryouy/broadcast` は監視ソースとして登録済み。GitHub Release v0.1.0を作成し、初回管理画面表示のためにD1へ一件だけ手動登録済み（自動検知成功の証拠ではありません）。
- **管理者認証の残作業:** Google CloudでOAuthクライアントを作成し、CloudflareにGoogle認証のSecretを登録する（下記参照）。現在の管理トークンは移行が完了するまでは残します。
- SNS認証情報は未設定です。検証中は承認ボタンを押さないでください。
- **注意:** GitHub Actionsはビルド・疎通のCIのみで、自動デプロイはまだ構成していません。GitHubへの追加コミットが自動で公開URLへ反映されるわけではありません。

## 事前準備
Node.js 22.18以降とCloudflare CLI (`cf`) を使用。Cloudflare、X Developer、Meta Developerのアカウントが必要。

```bash
npm install
npm run check
npm test
cf auth login
```

### D1
`cloudflare.config.ts` に `bindings.d1({ name: "broadcast-db" })` を定義。
初期環境は作成・初期SQL適用済みです。新しい環境を作成する場合はCloudflare CLIでD1を作成し、`migrations/0001_init.sql` を適用してください（詳細コマンドはインストールした `cf` の `cf --help` / `cf cli search "d1 migrations"` で確認）。本番にマイグレーションを適用するまでAPIは動作しません。

### Secrets
Cloudflare Workers側に次のSecretを設定。値をGitHubへコミットしないこと。

| 変数 | 必須 | 内容 |
| --- | --- | --- |
| `ADMIN_TOKEN` | Google設定前のみ | 移行用の管理用トークン（Google設定後は使用しません） |
| `GOOGLE_CLIENT_ID` | Google認証時 | OAuth 2.0 ウェブアプリのClient ID |
| `GOOGLE_CLIENT_SECRET` | Google認証時 | OAuth 2.0 ウェブアプリのClient Secret |
| `SESSION_SECRET` | Google認証時 | Cookie署名用のランダム文字列。 `openssl rand -base64 48` 等で生成 |
| `ALLOWED_EMAILS` | Google認証時 | 管理画面へのログインを許すメールアドレスをカンマ区切りで指定 |
| `GITHUB_WEBHOOK_SECRET` | GitHub利用時 | GitHub webhookの共通署名鍵 |
| `X_USER_ACCESS_TOKEN` | X投稿時 | user contextのWrite権限を持つOAuth2アクセストークン |
| `INSTAGRAM_ACCESS_TOKEN` | IG投稿時 | Instagram LoginのContent Publishing権限を持つトークン |
| `INSTAGRAM_USER_ID` | IG投稿時 | 対象InstagramプロアカウントのID |

### Google OAuth 設定（Cloudflare Zero Trustは不要）

1. [Google Cloud Console](https://console.cloud.google.com/auth/overview) でプロジェクトを作成・選択し、Google Auth Platformのブランディングおよび対象ユーザーを設定します。個人用途でアプリを「テスト中」にする場合、**テストユーザー**にも自分のGoogleアカウントを追加してください。
2. **Clients → Create client → Web application** からOAuth 2.0 クライアントを作成します。
3. 承認済みのリダイレクトURI（完全一致）に `https://broadcast.ryouy.workers.dev/auth/callback` を追加します。JavaScriptオリジンは `https://broadcast.ryouy.workers.dev` を指定できます（サーバーサイド認可コード処理自体には必須ではありません）。
4. Cloudflare Dashboard → Workers & Pages → `broadcast` → Settings → Variables and Secrets で、`GOOGLE_CLIENT_ID`・`GOOGLE_CLIENT_SECRET`・`SESSION_SECRET`・`ALLOWED_EMAILS` の**4件すべて**を設定します。Secretや許可リストをGitHubに記載しないでください。
5. 公開画面でGoogleログインが表示され、許可メールアドレスだけがログインできることを確認します。未許可アカウントでも拒否されること、ログアウト後にAPIが401になることを確認してください。
6. Googleでログインできることを確認してから、不要になった `ADMIN_TOKEN` を削除します。

**移行時の仕様:** 4件とも設定されるまでは管理トークン方式を使用します。ただしGoogle関連変数が一部のみ設定された状態では、不完全なOAuth設定として管理APIを503で拒否します。4件とも設定済みなら管理トークンでは入れません。管理APIのPOSTは同一Originのみ許可します。セッションはHttpOnly・Secure・SameSite=Laxの署名付きCookieで8時間有効。OAuthではstate・nonce・PKCE・Google署名のIDトークン・audience・発行者・メール確認を検証します。

Webhookは `/webhooks/github` に従来どおり署名を要求し、Googleログイン不要で受信できます。

### GitHub Webhook
監視したいGitHubリポジトリの `Settings > Webhooks` で以下を指定。

- Payload URL: `https://<worker-host>/webhooks/github`
- Content type: `application/json`
- Secret: `GITHUB_WEBHOOK_SECRET` と同じ値
- Events: `Releases` のみ

管理画面で同じ `https://github.com/owner/repo` をソース登録します。Webhookを設定できない場合もReleases APIを15分ごとにポーリングします。`ryouy/broadcast` は登録済みです。

### RSS
管理画面にRSS/AtomのHTTPS URLを追加。最初の取得は基準点の登録だけで過去記事を一括投稿しません。以後の新着をキューへ登録します。

### 公開
すべての投稿は `pending_review` で生成。管理画面で承認すると `scheduled` になり、Cronで投稿されます。キーがまだなければ `unknown` になり公開されません。

### 制限と今後の課題
- **X画像アップロードは未実装**。画像が付くXジョブは安全にエラー扱いします。
- **Instagram** は外部からアクセスできるHTTPS画像URLが必須です。コンテナ処理が未完了の場合は要確認になります。
- 送信エラーは `unknown` になり自動リトライしません。これは二重投稿防止を優先した暫定設計です。
- RSS HTTP fetchにはサイズ制限を設けていますが、公開RSSの取得にはDNSリバインディングなどに備えた追加のSSRF対策が必要です。信頼できるRSS URLだけ登録してください。
- GitHub Push/PR、画像生成、ジョブ編集、統計、日次件数・API費用の強制上限、メディア用R2、トークン自動更新は未実装です。
- 一般公開・課金運用は行わず、まずは個人の検証環境で利用してください。

## デプロイ
```bash
npm install
npm run check
npm test
cf deploy --dry-run
cf deploy
```
