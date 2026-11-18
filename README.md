# Broadcast

Broadcastは、管理画面でお知らせを作り、XとInstagramへの投稿を管理する個人用アプリです。

**管理画面:** https://broadcast.ryouy.workers.dev/

## 使い方
1. 許可されたGoogleアカウントでログインする。
2. 「投稿を作成」で本文と投稿先（X / Instagram）を選ぶ。画像は投稿画面から選択できます（GitHubの書き込み認証を設定後）。
3. 「確認待ちに保存」する。**保存だけではSNSへ投稿されません。**
4. 「投稿一覧」で内容を確認し、問題なければ「投稿を承認」する。
5. 承認した投稿はCloudflare Cronから送信される（現状は最大約15分の待ち時間）。

## 機能
- Google OAuthによる管理者認証、許可メールアドレス制限
- 投稿文の作成、投稿先の選択、確認待ち保存、承認・見送り
- SNS別の送信状態・投稿履歴管理
- JPEG・PNG・WebP画像の選択・プレビュー・GitHubアップロード（8MB以内、認証設定後）
- SNSの認証情報が未設定なら投稿承認を拒否
- 送信結果が曖昧な場合は自動再送せず、二重投稿を防止


## GitHubへの画像保存

画像は公開リポジトリ `ryouy/broadcast` の専用ブランチ `broadcast-images` に保存します。画像の保存先は `media/` ディレクトリで、ソースコード用の `main` ブランチやCIには画像コミットが混ざりません。

投稿画面で画像を選択 → プレビュー → 保存すると、サーバーがGitHub Contents APIでファイルを作成し、`raw.githubusercontent.com` のURLを投稿へ登録します。画像URLは**一般公開**されるので、非公開にしたい画像をアップロードしないでください。

**有効化に必要な設定（未完了）:** GitHubで `ryouy/broadcast` に対する **Contents: Read and write** 権限のFine-grained personal access tokenを発行し、Cloudflare Worker `broadcast` のSecret `GITHUB_MEDIA_TOKEN` に登録してください。トークンをチャットやGitHubのコードに書かないでください。設定後、画像選択が使えるようになります。

Xへの画像添付は現時点で未対応です。Instagramへの実投稿はSNS認証情報の設定と検証が別途必要です。
