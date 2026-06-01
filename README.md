# SetoriGen

DJイベント後にrekordbox XMLまたは画像からセットリストを取得し、X投稿用/VRChat Prints用に生成するWindowsデスクトップアプリです。

rekordbox XMLからプレイリストを読み込む方法と画像をGemini APIでOCRして曲名・アーティスト名・BPMを読み込む方法に対応しています。生成したPNGは通常の正方形画像、または VRChat Photo Gallery 向けの 1920:1080 画像として書き出せます。

## 主な機能

- rekordbox XML のプレイリスト読み込み
- 画像 OCR によるセトリ読み込み
- Gemini API による OCR 結果の正式曲名・正式アーティスト名確認
- イベント名、開催日、DJ名、メッセージの入力
- 単色、グラデーション、背景画像の選択
- PNG 書き出し
- VRChat Photo Gallery への PNG アップロード

17 曲以上の場合は左右 8 曲ずつ最大 16 曲まで表示し、次の行に `and 12 more tracks...` のような残り曲数付きの省略行を表示して以降の曲は省略されます。

## インストール

- GitHub Releases から Windows 向けの `setorigen.exe` をダウンロードし、任意のフォルダに置いて実行してください。インストーラは使用しません。正式配布物は単体 exe です。
- 現時点では code signing 証明書による署名は行いません。そのため、初回起動時に Windows SmartScreen やセキュリティソフトが未署名アプリとして警告を表示する場合があります。配布元が正しいことを確認してから実行してください。

## アンインストール
- SetoriGenを終了してから、ダウンロードした `setorigen.exe` を削除してください。
- exe を削除しても `%APPDATA%\SetoriGen` 配下の保存データやログは残ります。不要な場合は次のフォルダまたはファイルを削除してください。
  - `%APPDATA%\SetoriGen\gemini_api_key.bin`
  - `%APPDATA%\SetoriGen\vrchat_auth_cookie.bin`
  - `%APPDATA%\SetoriGen\logs\setorigen.log`

## 使い方

1. rekordbox XMLを選択するか、Gemini API Keyを入力して`画像からOCRで読み込み`を実行する。
2. rekordbox XMLを使う場合はプレイリストを選択する。画像OCRを使う場合はGeminiで抽出した曲名・アーティスト名・BPMを読み込む。
3. OCRを使う場合は、抽出後にGeminiで正式曲名・正式アーティスト名の確認を行う。
4. イベント名、開催日、DJ名、任意メッセージを入力する。
5. 単色、グラデーション、背景画像から背景を選ぶ。
6. プレビューを確認する。
7. Exportタブで通常または`1920:1080 VRChat向け`の出力形式を選び、PNG を書き出す。
8. `Photo Galleryへアップロード`を使う場合はVRChatへのログインを行う。

## Gemini API Key

- OCRと正式表記確認には画面で入力したGemini API Keyを使用します。
- Gemini API Keyは既定では保存しません。`この端末に保存` を有効にした場合だけ、WindowsのDPAPIで暗号化して`%APPDATA%\SetoriGen\gemini_api_key.bin`に保存します。
- Gemini APIの利用料金、レート制限・API Keyの管理は利用者自身で確認してください。

## VRChat Photo Gallery アップロード

SetoriGen から直接Print投稿はせず、Photo Galleryへ画像を保存します。
- 保存済みのVRChatログイン状態が有効な場合は、再ログインせずにそのままPhoto Galleryへアップロードできます。
- 保存済み状態が無効な場合は再ログインが必要です。
- `ログイン状態をリセット`で保存済みVRChat認証を破棄できます。

VRChatのpassword・`emailOtp`・認証cookieはアプリ内でログ出力せず、`emailOtp`は保存しません。保存済みVRChat auth cookieはWindowsのDPAPIで暗号化して `%APPDATA%\SetoriGen\vrchat_auth_cookie.bin`に保存します。
VRChatの仕様変更やVRC+加入状態、API利用条件により、アップロードできない場合があります。

## 保存データとログ

SetoriGen が保存するアプリデータは `%APPDATA%\SetoriGen` 配下です。
  - Gemini API Key: `%APPDATA%\SetoriGen\gemini_api_key.bin`
  - VRChat auth cookie: `%APPDATA%\SetoriGen\vrchat_auth_cookie.bin`
  - ログ: `%APPDATA%\SetoriGen\logs\setorigen.log`

Gemini API Keyの保存をやめる場合は`この端末に保存`のチェックを外してください。VRChat auth cookieは`ログイン状態をリセット`で削除できます。ログを削除する場合は、SetoriGenを終了してから`%APPDATA%\SetoriGen\logs\setorigen.log`を削除してください。

問い合わせ時にログを送る場合は、まず内容を確認し、必要なエラー時刻周辺だけを送ってください。ログにはAPI Key、VRChat password、`emailOtp`、auth cookieを意図的に出力しないようにしていますが、ファイル名、HTTP ステータス、外部サービスの応答断片、操作状況が含まれる場合があります。

## 外部通信

SetoriGen は次の外部サービスに通信します。
- Google Gemini API: 画像OCRと正式曲名・正式アーティスト名確認に使用します。
- VRChat API: ログイン状態確認、`emailOtp`検証、Photo Galleryアップロードに使用します。

rekordbox XMLと背景画像はローカルファイルとして読み込みます。

## 技術構成

- Tauri v2
- React
- TypeScript
- Vite
- Canvas PNG rendering

## 開発セットアップ

事前に npm 付き Node.js と Rust toolchain をインストールしてください。

```powershell
npm install
```

## ビルド

```powershell
npm run build
npm run tauri build
```

`npm run tauri build` はTauriの設定に従い、Windows向けの単体exeを`src-tauri/target/release/setorigen.exe` に生成します。

## ライセンス

MIT License
