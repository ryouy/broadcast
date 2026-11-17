# Broadcast — セットアップ

## 現在の機能
- GitHub `release.published` を署名検証して受信し、登録したリポジトリのイベントのみD1に保存
- RSS/Atomを15分間隔で確認。最初の読み込みでは過去記事を投稿しない
- X / Instagram 向けの投稿を独立したキューに登録
- 管理トークンで投稿を承認またはスキップ
- 承認したジョブのみCronから投稿を試行。初期状態は公開しない
- 送信結果が不明なら `unknown` に留め、自動再送を避ける

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
Cloudflare CLIでD1を作成し、`migrations/0001_init.sql` を適用してください（詳細コマンドはインストールした `cf` の `cf --help` / `cf cli search "d1 migrations"` で確認）。本番にマイグレーションを適用するまでAPIは動作しません。

### Secrets
Cloudflare Workers側に次のSecretを設定。値をGitHubへコミットしないこと。

| 変数 | 必須 | 内容 |
| --- | --- | --- |
| `ADMIN_TOKEN` | 必須 | 長いランダムな管理用文字列 |
| `GITHUB_WEBHOOK_SECRET` | GitHub利用時 | GitHub webhookの共通署名鍵 |
| `X_USER_ACCESS_TOKEN` | X投稿時 | user contextのWrite権限を持つOAuth2アクセストークン |
| `INSTAGRAM_ACCESS_TOKEN` | IG投稿時 | Instagram LoginのContent Publishing権限を持つトークン |
| `INSTAGRAM_USER_ID` | IG投稿時 | 対象InstagramプロアカウントのID |

`cf deploy` 後、Workerの公開URLを開いて管理トークンを入力します。管理画面は静的HTMLとして公開されるため、トークンを知らない第三者が管理APIを使うことはできません。ただし本番ではCloudflare Accessによる画面全体の制限を推奨します。WebhookのパスはAccessの対象外にしてください。

### GitHub Webhook
監視したいGitHubリポジトリの `Settings > Webhooks` で以下を指定。

- Payload URL: `https://<worker-host>/webhooks/github`
- Content type: `application/json`
- Secret: `GITHUB_WEBHOOK_SECRET` と同じ値
- Events: `Releases` のみ

管理画面で同じ `https://github.com/owner/repo` をソース登録します。

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
