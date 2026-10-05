# React Native / Expo SAMLサンプル

既存BackendのSAML検証を利用するiOS / Androidアプリです。Web版と同じユーザー情報 (Name、Email、NameID、Object ID) を表示します。ユーザー・部署・アプリ別権限はBackendの共通SQLite DBで管理します。

## 認証フロー

```text
Expo: 秘密のverifierとstateを端末で生成
 → POST /auth/mobile/start: SHA-256(verifier)とstateを登録
 → System Browserで /auth/login?mobile=<一回限りのticket>
 → Entra ID → Backend ACS (Web版と同じ署名・条件検証)
 → /auth/complete: ログインを開始したブラウザCookieと照合
 → samlsample://auth/callback?code=<60秒・一回限り>&state=...
 → Expoでstate確認
 → POST /auth/mobile/exchange: code + verifier
 → ランダムなアプリ用sessionTokenをSecureStoreへ保存
 → GET /api/mobile/me: Authorization: Bearer <sessionToken>
```

SAML Responseを端末へ渡しません。Deep Linkにはセッショントークンを含めません。verifierはDeep Linkに含まず、コード交換時に照合します。方式はPKCEと同じ秘密値の照合を採用していますが、OAuth/OIDCの実装ではなく、このサンプルの独自コード交換APIです。JWTも使用しません。

コードは60秒、一回限り。モバイルセッションは無操作1時間・ログインから最大8時間で失効し、Backendではトークンのハッシュのみ保持します。Web Cookieとモバイルセッションは別で、モバイルのログアウトはWebやEntraセッションを終了しません。プロセス再起動でモバイルセッションも消えます。

## セットアップ

Expo SDK 57、Node.js 22.13以上 (Node 24.3以上推奨)、iOSはXcode、AndroidはAndroid StudioとSDKが必要です。

ルートのWeb用workspaceとモバイルの依存関係は分離しています。モバイルは別途インストールします。

```bash
npm install --prefix mobile
cp mobile/.env.example mobile/.env
```

`mobile/.env` の `EXPO_PUBLIC_BACKEND_URL` にBackendのOriginを指定してください。公開環境変数なので秘密情報を含めないでください。

### iOS Simulator

同じMac上のBackendなら `http://localhost:3000` を指定できます。BackendとFrontendを既存の手順で起動し、プロジェクトルートから以下を実行します。

```bash
npm run mobile:ios
```

初回は専用Development Buildを作成しSimulatorへインストールします。以降、インストール済みの開発アプリを利用するときは以下でMetroを起動します。

```bash
npm run mobile
```

### Android / iPhone実機

端末のlocalhostはMacのBackendではありません。端末から到達できる**HTTPS Backend URL**を用意してください。本サンプルはAndroidや実機用にHTTP/証明書検証を緩める設定を追加しません。iOSのlocalhost例外はSimulator用途です。

HTTPSリバースプロキシ等の公開OriginでFrontendとBackendを配信し、EntraのReply URL、Backendの`SAML_CALLBACK_URL`、必要に応じて`SAML_ISSUER`、`FRONTEND_URL`を揃え、`COOKIE_SECURE=true`へ変更します。固定のACSをEntraへ登録すれば、Webとモバイルで同じEnterprise Applicationを利用できます。

```dotenv
# mobile/.env の例
EXPO_PUBLIC_BACKEND_URL=https://your-dev-host.example
```

```bash
npm run mobile:android
```

Backendのlocalhost待受は、同じMac上のHTTPSリバースプロキシから到達できます。直接LANへ公開する設定は同梱しません。iPhone実機へのビルドはXcodeの署名・端末設定が別途必要です。

## Deep Link / Entra設定

`app.json`のschemeは`samlsample`、Backendの固定戻り先は`samlsample://auth/callback`です。任意の戻り先は受け付けません。schemeを変更する場合はBackendとアプリの両方を変更し、Development Buildを再作成してください。

**EntraのReply URLにはsamlsample://を登録しません。** EntraはBackendのHTTPS ACS (Simulatorの既存localhost構成ならHTTP ACS) に応答し、Backendが認証後にアプリへコードを渡します。

カスタムschemeを利用するため、この認証フローはExpo GoではなくDevelopment Buildで実行してください。[Expo: Deep Linkの説明](https://docs.expo.dev/linking/into-other-apps/)、[ブラウザ認証API](https://docs.expo.dev/versions/latest/sdk/webbrowser/)、[SecureStore](https://docs.expo.dev/versions/latest/sdk/securestore/)

## 確認方法

1. 「Entra IDでログイン」を押す。
2. システムブラウザでMicrosoft認証を完了する。
3. アプリへ戻り、Name / Email / NameID / Object IDを確認する。
4. アプリを再起動して「ログイン状態を再確認」を押す。SecureStoreに保存したセッションで再取得する。
5. ログアウトし、未認証になることを確認する。

認証失敗時はブラウザにWebのエラー画面が表示されるため、ブラウザを閉じてアプリから再試行してください。認証中にアプリを終了するとverifierが失われるため、ログインをやり直してください。

## 検証

```bash
npm --prefix mobile run typecheck
npm test
npm run build
```

Backendの署名付き統合テストにはモバイルの一連の認証、別ブラウザからの確定拒否、verifier不一致、コード再利用拒否、モバイルセッション失効操作が含まれます。実機・Simulator上の認証は利用者の環境で確認してください。

本番化ではUniversal Links / App Links、共有セッションストア、レート制限、コード・トランザクションの分散環境での一回限り管理、アプリ固有の部署・権限チェックを追加してください。DBの設定と管理CLIはルートREADMEの「Web / Expo共通ユーザーDB」を参照してください。

## 今回の検証結果と制限

Node 24で型チェックとiOS / Android両方のMetro/Hermesバンドル生成を確認しました。Backendの署名付きWeb・モバイル統合テストも成功しています。このMacのiOS Simulatorでは利用者がビルド・インストール後、社内ユーザーおよび招待した協力会社ユーザーでEntraログインを確認済みです。Android・iPhone実機での対話ログインは未確認です。

最新安定版SDK 57へ揃え、互換更新を適用しましたが、npm auditはExpo / React Nativeの間接依存に23件 (high 16、moderate 7) を報告しています。Metro等の開発・ビルドツールを含みます。自動修正がExpo 44へのダウングレードなど互換性を壊す変更を提案するため、forceは適用していません。本番化時に依存更新と影響範囲の再確認が必要です。

### 「Refreshing…」が何度も表示される場合

これは開発時のFast Refresh表示です。ソース保存時の表示は正常です。`metro.config.js`ではネイティブビルド出力、dist、Expoの生成ログを監視対象から除外しています。設定変更後はMetroのターミナルをCtrl+Cで停止し、次のコマンドでキャッシュをクリアして再起動します (ネイティブアプリの再ビルドは不要)。

```bash
npm --prefix mobile start -- --clear
```

何も編集していない間も続く場合は、SimulatorのCmd+DからFast Refreshを一時的に無効にして切り分け、Metroのターミナル出力を確認してください。

### Node.jsのバージョン警告

起動スクリプトは対応版のNode 22.13以上または24.3以上を使用します。PATH上のNodeが古い場合、このMacではCodexに付属する対応Nodeを検出してExpoとビルド子プロセスに使用します。グローバルNodeは変更しません。Codexのランタイムがない環境では、Node.jsを対応LTSへ更新してください。

### 別アカウントでログイン

「別のアカウントでログイン」で現在のアプリセッションを終了し、iOSでは `preferEphemeralSession` を指定した認証画面を開きます。既存ブラウザのSSO情報を共有しないセッションを要求しますが、対応はブラウザ依存です。Androidに同じ効果を保証するものではありません。


## セッション期限（2026年10月4日更新）

React・Next.js・Expoは、認証済みAPIアクセスから無操作1時間、ログインから最大8時間で終了します。Next.jsはSSRでの認証済みページアクセスも延長対象です。画面のクリック・入力だけでは延長しません。通知の定期確認は延長せず、残り5分以内で警告します。バックグラウンドやスリープ中は通知が遅れる場合があります。

React／Next.jsは「セッションを延長」、Expoは「ログイン状態を再確認」で延長できます。最大8時間は延長できません。期限切れでは作業内容を控えて再ログインしてください。入力内容の自動保存は今回の変更に含みません。新しい期限情報のない旧セッションは無効になるため、変更後は一度再ログインしてください。
