# Broadcast

Broadcastは、管理画面でお知らせを作り、XとInstagramへの投稿を管理する個人用アプリです。

**管理画面:** https://broadcast.ryouy.workers.dev/

## 使い方
1. 許可されたGoogleアカウントでログインする。
2. 「投稿を作成」で本文と投稿先（X / Instagram）を選ぶ。Instagramには公開HTTPS画像URLが必要。
3. 「確認待ちに保存」する。**保存だけではSNSへ投稿されません。**
4. 「投稿一覧」で内容を確認し、問題なければ「投稿を承認」する。
5. 承認した投稿はCloudflare Cronから送信される（現状は最大約15分の待ち時間）。

## 機能
- Google OAuthによる管理者認証、許可メールアドレス制限
- 投稿文の作成、投稿先の選択、確認待ち保存、承認・見送り
- SNS別の送信状態・投稿履歴管理
- SNSの認証情報が未設定なら投稿承認を拒否
- 送信結果が曖昧な場合は自動再送せず、二重投稿を防止

**GitHub Releases / RSS / Atomの自動監視とWebhookの受信は廃止しました。**
過去に検証で取り込んだイベント・投稿履歴は、既存のD1データを削除せず残しています。

## SNS連携の現状
X・Instagramの認証情報は別途設定が必要です。連携前でも文章を作って確認待ちに保存できます。Instagramは公開画像URLが必要で、画像の直接アップロードは未対応です。Xへの画像添付も未実装です。

## 技術
TypeScript / Cloudflare Workers / D1 / Cron Triggers / Vitest

## 開発
```bash
npm install
npm run check
npm test
npm run build
```

詳しくは [docs/SETUP.md](docs/SETUP.md) を参照してください。
