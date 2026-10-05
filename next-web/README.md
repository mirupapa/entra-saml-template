# Next.jsのみでSAML認証

画面SSR・SAML認証・Cookieセッション・APIをNext.js（Node.js runtime）内で実行します。ExpressへのAPI転送はありません。共通のDB処理とSAML追加検証関数をソースとして共有します。React/Expoのサーバーを停止してもNext.jsは単独で動作します。ユーザー管理は既存の管理画面を使います。

プロジェクトルート:

```bash
npm install
npm run next:dev
```

http://localhost:3100 を開きます。`.env.local` は既存SAML設定を使って準備済みです。再作成時は `.env.example` をコピーしてテナント・証明書を設定してください。環境変数はサーバー側のみで使用します。

## Entra側で必要な変更

既存Enterprise Application「SAML login sample」→ シングルサインオン → 基本的なSAML構成 → 編集 → 応答URLに以下を**追加**します。

```
http://localhost:3100/auth/callback
```

既存の `http://localhost:3000/auth/saml/callback` と識別子を残してください。サインオンURLは空欄のままで構いません。署名はSAML応答とアサーションの両方に署名する既存設定を使います。今のサンプルは同一SAMLアプリを2つのWeb SPエンドポイントで使う構成です。Entra上の割り当ては共通、業務利用は共通DBのweb-a/web-bで別に制御します。別々のEnterprise Applicationに分ける場合はNext.js用の識別子・IdP証明書等へ変更します。

## 確認

- ログイン後、既存React/Expoと同じ内部User IDを表示します。
- 業務アプリIDは `web-b`。管理画面で「Web App B」のviewer/editor/adminを設定してください。
- `/api/me` はプロフィール、`/api/access` はweb-b利用権限を確認します。未認証401、権限未付与403、許可200です。
- ユーザー無効化・ロール変更はSSR/APIで毎回DBを確認して反映します。
- ログアウトはNext.jsのセッションのみ終了します。Microsoft側のSSO状態は残ります。

```bash
npm run next:build
npm run test -w next-web
npm run start -w next-web
```

SAMLの署名・Audience・Issuer・Destination・Recipient・有効期限・InResponseToを確認します。ACSのクロスサイトPOST後にGETを経由してSameSite=Lax Cookieとのブラウザ紐付けを検証し、紐付け完了後にDB登録・セッション発行します。要求IDキャッシュ、認証トランザクション、ハッシュ化した不透明セッショントークンをSQLiteへ保存して、Route Handler間や再起動時も検証状態を共有します。CookieはHttpOnly、HTTPS時Secure、無操作1時間・ログインから最大8時間。ログアウトはOriginを照合します。

SQLiteとNodeネイティブ依存を利用するローカル検証用です。複数ホスト・サーバーレスの本番配置には共有PostgreSQL/Redis等への変更が必要です。HTTPSで配置し、NEXT_APP_URLとEntra応答URLを合わせてください。Duoはこのサンプルに含めていません。


## セッション期限（2026年10月4日更新）

React・Next.js・Expoは、認証済みAPIアクセスから無操作1時間、ログインから最大8時間で終了します。Next.jsはSSRでの認証済みページアクセスも延長対象です。画面のクリック・入力だけでは延長しません。通知の定期確認は延長せず、残り5分以内で警告します。バックグラウンドやスリープ中は通知が遅れる場合があります。

React／Next.jsは「セッションを延長」、Expoは「ログイン状態を再確認」で延長できます。最大8時間は延長できません。期限切れでは作業内容を控えて再ログインしてください。入力内容の自動保存は今回の変更に含みません。新しい期限情報のない旧セッションは無効になるため、変更後は一度再ログインしてください。


## SAML署名証明書の新旧切り替え

BackendとNext.jsは複数のIdP公開証明書を同時に受け入れます。既存の `SAML_CERT_PATH` はそのまま利用できます。更新時は、新しいBase64/PEM証明書をサーバーに配置し、それぞれの環境設定にJSON配列で指定してください（パスは各アプリの実行ディレクトリ基準です）。

```env
SAML_CERT_PATHS=["/app/config/certs/entra.cer","/app/config/certs/entra-next.cer"]
```

`SAML_CERT_PATHS` は `SAML_CERT` / `SAML_CERT_PATH` より優先されます。単一ファイル・`SAML_CERT` に複数のPEM証明書を連結する方法も使えます。秘密鍵は配置しません。

1. Entraで新しい証明書を作成し、まだ非アクティブのままダウンロードする。
2. 新旧を指定してBackend・Next.jsの全インスタンスを再起動し、既存ログインを確認する。
3. Entraで新しい証明書をアクティブにして、React・Next.js・Expoから新規ログインを確認する。
4. 切り替え完了後、古い証明書の指定を外して再起動する。

期限内の証明書だけを署名検証に使用します。古い証明書が期限切れでも、新しい証明書が有効なら認証を継続します。全証明書が期限外の場合は認証を拒否します。不正な証明書ファイルは起動時にエラーになります。

証明書は起動時に読み込み、署名検証のたびに期限を確認します。メタデータからの自動取得は以下の設定で有効化できます。既存のログインセッションは証明書切り替えで失効させませんが、現在のExpressのメモリセッションは再起動で失われます。


## Entra証明書の自動取得

各サーバーの環境変数に `SAML_METADATA_URL` を設定すると自動取得が有効になります。Entraの「SAML証明書」欄の「アプリのフェデレーション メタデータ URL」を使用してください。Graph管理APIではなく、ログイン対象のSAMLアプリのApplication IDが必要です。

```env
SAML_METADATA_URL=https://login.microsoftonline.com/<tenant-id>/federationmetadata/2007-06/federationmetadata.xml?appid=<application-id>
SAML_METADATA_CACHE_PATH=/app/data/entra-metadata.xml
SAML_METADATA_REFRESH_MS=86400000
```

起動時と24時間ごとに取得し、ログイン時にも取得時刻を確認します。サーバーレスでは定期タイマーが停止するため、次の認証時に更新します。取得待ち時間は最大10秒です。テナント・アプリを固定したHTTPS URLのみ許可し、リダイレクト・DTD・異なるissuer・不正な証明書を拒否します。

取得に成功したメタデータの署名用証明書一式を採用し、新旧を両方受け入れます。メタデータから削除された古い鍵は次回成功時に外します。期限外の証明書は使用しません。取得失敗時は直近の設定を維持し、サーバーログに警告を出します。キャッシュを永続ボリュームに置けば再起動後も復旧できます。各インスタンスで取得するため、共有キャッシュファイルは避けてください。

既存の `SAML_CERT_PATH` 等は初回取得失敗時の予備として残せます。有効な予備・キャッシュがなくメタデータ取得も失敗すると認証は拒否されます。証明書更新でのアプリ再起動は不要ですが、URL等の設定変更は再起動が必要です。

Entraで新しい証明書を作成したら、全サーバーの取得成功を確認してからアクティブに切り替えてください。24時間を待つか、再起動で取得を促せます。Entra側の証明書作成・有効化は引き続き管理者が行います。
