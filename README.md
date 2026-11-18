# Broadcast

GitHub Releases と RSS/Atom の新着を検知して、X と Instagram に投稿する個人用の Cloudflare Workers アプリです。

**現在: 初期MVP（検証環境デプロイ済み）。投稿はすべて承認待ちから始まり、無断で自動公開しません。**

**ステージングURL:** https://broadcast.ryouy.workers.dev/

Cloudflare WorkerとD1 `broadcast-db` は作成済みです。Google OAuthへ完全移行し、許可メールアドレスだけが管理画面にログインできます。旧管理トークン認証は廃止しました。`ryouy/broadcast` は監視対象としてD1に登録済みで、v0.1.0 Releaseの初回表示確認用データを承認待ちで登録しています（初回は手動登録）。v0.1.1は自動検知の検証用に公開しました。Cloudflare Cronは15分ごとに動作し、`ryouy/broadcast` を監視します。

## できること
- GitHub Webhook の署名検証とリリース検知
- GitHub Releases APIの15分間隔監視（Webhookなしでも利用可能）
- RSS/Atom 新着検知（15分間隔・初回過去記事スキップ）
- D1を使ったソース・イベント・SNS別投稿キュー
- Google OAuth・許可メールアドレス制限・署名付きCookieによる管理者認証（旧トークン認証は廃止）
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

CloudflareのWorker・D1作成、マイグレーション、Cron、初回デプロイは完了しています。Google OAuthのClient ID/Secret・許可メールアドレス設定、ログインの確認が完了しています。SNS用Secret設定とWebhook登録、実投稿の検証は未実施です。

**設定方法・未対応事項: [docs/SETUP.md](docs/SETUP.md)**

## 安全な初期状態
- 監視ソースは登録済み（新規環境ではゼロ）
- 全投稿は `pending_review`
- 認証設定が無効／不完全な場合は管理APIを拒否
- SNSトークン未設定時は投稿できない
- 不確実な送信結果は自動リトライしない

License: Not specified.
