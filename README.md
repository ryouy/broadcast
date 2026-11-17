# Broadcast

GitHub Releases と RSS/Atom の新着を検知して、X と Instagram に投稿する個人用の Cloudflare Workers アプリです。

**現在: 初期MVP（検証環境デプロイ済み）。投稿はすべて承認待ちから始まり、無断で自動公開しません。**

**ステージングURL:** https://broadcast.ryouy.workers.dev/

Cloudflare WorkerとD1 `broadcast-db` は作成済みです。管理用・SNS用Secretは未設定のため管理APIはロック状態です。Cloudflare Cronは15分ごとに動作しますが、監視ソースは未登録です。

## できること
- GitHub Webhook の署名検証とリリース検知
- RSS/Atom 新着検知（15分間隔・初回過去記事スキップ）
- D1を使ったソース・イベント・SNS別投稿キュー
- トークンで保護したAPIと最小管理画面
- Xテキスト投稿とInstagram画像投稿のAPI実装
- 送信不明時に再送を止める重複投稿配慮

## 技術
TypeScript / Cloudflare Workers / D1 / Cron Triggers / Cloudflare CLI (`cf`) / Vitest

## 開発
```bash
npm install
npm run check
npm test
npm run dev
```

CloudflareのWorker・D1作成、マイグレーション、Cron、初回デプロイは完了しています。管理用・SNS用Secret設定とWebhook登録、実投稿の検証は未実施です。

**設定方法・未対応事項: [docs/SETUP.md](docs/SETUP.md)**

## 安全な初期状態
- ソースは初期状態でゼロ
- 全投稿は `pending_review`
- 管理トークン未設定時はAPIを拒否
- SNSトークン未設定時は投稿できない
- 不確実な送信結果は自動リトライしない

License: Not specified.
