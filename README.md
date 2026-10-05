# Microsoft Entra ID SAML認証テンプレート — React / Next.js / Expo

React + TypeScript、Node.js + TypeScript、Microsoft Entra IDの最小SSOサンプルです。BackendをSAML Service Provider (SP) とし、認証済みユーザーをCookieセッションで管理します。共通SQLite DBでユーザー・部署・アプリ別権限を管理し、Expo版も含みます。JWT、OIDC、Entraグループからの権限同期は含みません。

## 構成と認証フロー

```text
Browser / React :5173
  → GET /auth/login (Vite proxy → Backend :3000)
  → SAML AuthnRequest / HTTP Redirect → Entra ID (IdP)
  → Entra IDで認証 (MFA・Conditional AccessはEntra側で管理)
  → POST :3000/auth/saml/callback (ACS)
  → BackendでResponseとAssertionの署名・各条件を検証
  → 303 GET /auth/complete (ブラウザの元セッションと照合)
  → セッションIDを再生成 / HttpOnly Cookie発行
  → Reactへ戻る → GET /api/me → ユーザー表示
```

フロントエンドはSAML XMLを処理しません。RelayStateは5分・一回限りの乱数で、サーバー側のログイン要求とブラウザのセッションに紐付けます。任意のリダイレクト先として利用しません。ACSのクロスサイトPOSTではSameSite=Lax Cookieが届かないため、検証後にBackendのGETへリダイレクトし、そこで元のCookieと照合してログインを確定します。IdP initiated SSOやポータルの「テスト」から直接送る応答は受け付けません。必ずアプリのログインボタンから開始してください。

### ライブラリ選定

`@node-saml/node-saml` 5.1系を採用しています。Passportとは独立してSPを実装でき、署名、Audience、時刻、InResponseToの検証とSP Metadata生成を備える、保守中のNode-SAMLプロジェクトです。Entra固有の署名設定はMicrosoftの公式手順に従います。依存バージョンはpackage-lock.jsonで固定しています。

- [Node-SAML公式リポジトリ・オプション](https://github.com/node-saml/node-saml)
- [Microsoft: SAML署名オプション](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/certificate-signing-options)

## ローカル環境構築

Node.js 20.16以上 (最新のサポート中LTS推奨)、npm、Entraテナント、Enterprise Applicationを設定できる管理者とテストユーザーが必要です。テストにはOpenSSLも必要です。

プロジェクトルートで実行します。

```bash
npm install
cp backend/.env.example backend/.env
mkdir -p backend/certs
openssl rand -hex 32
```

最後の出力を`SESSION_SECRET`へ設定します。次のEntra手順で取得する証明書を`backend/certs/entra.cer`へ保存し、`backend/.env`のテナント固有値を置き換えてください。証明書、.env、秘密鍵はGit管理対象外です。実際のテナント設定は同梱していません。

## Entra ID設定

1. [Microsoft Entra管理センター](https://entra.microsoft.com/)で **Entra ID → Enterprise applications → New application → Create your own application** を開き、ギャラリーにないアプリとして作成します。画面の名称は言語等で異なる場合があります。
2. **Single sign-on → SAML** を選択します。OAuthのApp registrationsではなくEnterprise ApplicationのSAML設定を使用します。
3. **Basic SAML Configuration** に以下を入力します。

| 項目 | localhostサンプル値 | 実装上の設定 |
|---|---|---|
| Identifier / Entity ID | `http://localhost:3000/saml/metadata` | `SAML_ISSUER` (SP) |
| Reply URL / ACS | `http://localhost:3000/auth/saml/callback` | `SAML_CALLBACK_URL` |
| Sign-on URL | ローカル検証では空欄 | 省略可能。アプリのログインボタンから開始 |

末尾スラッシュ、ポート、http/httpsを含め完全一致させます。React/Expo用とNext.js用の応答URLを両方残します。`SAML_ISSUER`は**SPの識別子**であり、IdPのIssuerとは別です。

4. **Attributes & Claims** で次を確認します。

| Claim | Entra属性の例 | 注意 |
|---|---|---|
| `http://schemas.microsoft.com/identity/claims/objectidentifier` | `user.objectid` | Object ID。画面と`/api/me`の`user.objectId`に表示 |
| Unique User Identifier / NameID | `user.userprincipalname` | 安定した識別子を選択。Emailとは限りません |
| `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress` | `user.mail` | 未設定のユーザーも存在します |
| `http://schemas.microsoft.com/identity/claims/displayname` | `user.displayname` | カスタムClaim `displayName`も対応 |

UIはname/email欠落時に「Claim未設定」と表示します。`name` URI、`email` Claimもフォールバックとして使用し、NameIDをEmailとみなしません。独自Claim名を使う場合は`backend/src/validation.ts`のマッピングを変更してください。

5. **SAML Certificates / SAML Signing Certificate → Edit** で、**Signing Option = Sign SAML response and assertion**、**Signing Algorithm = SHA-256** にします。両方の署名が必須です。暗号化Assertionはこのサンプルでは対応しないため、Token encryptionを構成しないでください。AuthnRequestの署名必須設定もこの最小サンプルでは使用しません。
6. **Certificate (Base64)** をダウンロードし`backend/certs/entra.cer`へ保存します。`-----BEGIN CERTIFICATE-----`で始まるテキスト形式を使用してください。Certificate (Raw)のバイナリ形式は使いません。
7. **Set up [アプリ名]** の **Login URL** を`SAML_ENTRY_POINT`、**Microsoft Entra Identifier**を`SAML_IDP_ISSUER`へそのままコピーします。IdP Identifierは通常`https://sts.windows.net/<tenant-id>/`で、末尾`/`も含めます。
8. **Users and groups** でテストユーザーを割り当てます。割り当てが必要な設定のとき、未割り当てユーザーはログインできません。

### Metadata / Certificate取得

EntraのSAML設定ページには **App Federation Metadata URL** および **Federation Metadata XML** の取得項目があります。Metadataの`EntityDescriptor/@entityID`がIdP Issuer、HTTP-Redirect用`SingleSignOnService/@Location`がログイン先、署名用`KeyDescriptor`内のX509Certificateが信頼する証明書です。本サンプルは管理者が取得した値とBase64証明書を明示設定し、`SAML_METADATA_URL` を設定すると、Metadata URLから証明書を自動取得・更新します。詳細は「Entra証明書の自動取得」を参照してください。

SP Metadataは起動後の`http://localhost:3000/saml/metadata`から取得できます。こちらは**アプリが返すSP設定**で、EntraのIdP Metadataとは別です。

証明書はEntraの管理画面など信頼できる経路で取得してください。自己署名のSAML証明書は信頼する鍵を明示指定して検証します。OSの公開CA検証とは別です。期限切れの証明書は起動時に拒否します。更新時は新しい証明書へ差し替えてBackendを再起動してください。

- [Microsoft: SAML SSO設定](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/add-application-portal-setup-sso)
- [Microsoft: 証明書の取得・更新](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/tutorial-manage-certificates-for-federated-single-sign-on)

### localhost HTTPが保存できない場合

EntraのReply URL設定でHTTP localhostが受け付けられるかを実際の管理画面で確認してください。拒否された場合、検証を緩めず、信頼済み証明書を使うHTTPSリバースプロキシまたは開発用HTTPS URLを利用します。FrontendとBackendを同一HTTPS Originに公開し、`/api`、`/auth`、`/saml`をBackendへ、その他をFrontendへ転送してください。Entity ID、ACS、Sign-on URLと.envを公開URLへ揃え、`COOKIE_SECURE=true`にします。信頼できるプロキシ1段の構成のみ`TRUST_PROXY=true`にしてください。HTTPSトンネルや証明書の自動セットアップは同梱しません。

## .env設定

| 変数 | 用途 |
|---|---|
| `PORT` | Backend待受ポート、既定3000 |
| `FRONTEND_URL` | 固定リダイレクト先とログアウトOrigin。ローカルは`http://localhost:5173` |
| `SAML_ENTRY_POINT` | Entra Login URL (HTTPS) |
| `SAML_ISSUER` | SP Entity ID。EntraのIdentifierと一致 |
| `SAML_IDP_ISSUER` | Entra Identifier。応答Issuerの期待値 |
| `SAML_CALLBACK_URL` | ACS URL。パスは`/auth/saml/callback` |
| `SAML_CERT_PATH` | Base64/PEM証明書のパス。backendを起動する作業ディレクトリ基準 |
| `SAML_CERT` | パスの代わりにPEMを環境変数で渡す場合。改行または`\n`に対応 |
| `SESSION_SECRET` | 暗号学的乱数。32文字以上 |
| `COOKIE_SECURE` | HTTP localhostはfalse、HTTPSはtrue |
| `TRUST_PROXY` | 信頼できる1段のリバースプロキシ使用時のみtrue |

.envはBackendの作業ディレクトリから読みます。npm workspace起動では`backend/`になるため上記手順の配置で動きます。ポート変更時は`frontend/vite.config.ts`のproxy先とEntra設定も変更します。

## 起動・動作確認

両方まとめて起動:

```bash
npm run dev
```

別ターミナルで起動する場合:

```bash
npm run dev -w backend
npm run dev -w frontend
```

1. `http://localhost:5173`を開きます。`127.0.0.1`とlocalhostを混在させないでください。
2. ログイン前は`GET /api/me`が`{"authenticated":false,"user":null}`を返します。
3. 「Entra IDでログイン」を押し、割り当て済みユーザーでMicrosoftの認証を完了します。
4. アプリへ戻り、Login Success、Name、Email、NameID、Object IDを確認します。Object IDが「Claim未設定」の場合は、Entraの属性とクレームに上記のobjectidentifier Claimを追加し、再ログインしてください。
5. ページを再読み込みしてもセッションが維持されることを確認します。
6. ログアウト後は未認証画面へ戻り、`/api/me`が未認証になることを確認します。

ログアウトは**このアプリのセッション破棄**です。Entra IDや他アプリのセッションは終了しません。再ログイン時にEntraの既存セッションで認証が完了することがあります。Single Logoutは未実装です。

### Endpoint

| Method | URL | 内容 |
|---|---|---|
| GET | `/auth/login` | AuthnRequestを生成しEntraへRedirect |
| POST | `/auth/saml/callback` | ACS。SAML検証 |
| GET | `/auth/complete` | 元ブラウザ照合・セッションID再生成 |
| GET | `/api/me` | セッションのユーザー情報 |
| POST | `/auth/logout` | 設定したFrontend Originを検証してセッション破棄 |
| GET | `/saml/metadata` | SP Metadata XML |

ローカルではVite proxy経由でAPIを同一Originにし、Cookieを共有します。localhostのCookieはポートでは分離されません。公開時も同一Originを前提にしてください。CORSの全許可は行いません。

## 検証・ビルド

```bash
npm test
npm run build
```

テストは一時的なRSA証明書を生成し、実際のXML署名を持つ応答をローカルHTTPサーバーへPOSTします。署名検証をスタブ化しません。成功、Cookie属性、セッションID更新、別ブラウザからの確定拒否、再利用拒否、Issuer/Audience/Destination/Recipient/InResponseTo/期限/NotBefore不一致、署名改ざん、ログアウトOrigin検証を確認します。Entraへの通信は行いません。

`npm run start -w backend`はビルド済みBackendを起動します。Frontendの`dist/`は静的ホスティングと同一Originのプロキシ設定が必要です。Vite開発サーバーを本番配信に使用しないでください。

## セキュリティと運用上の範囲

- ResponseとAssertion両方の署名を設定したIdP証明書で検証し、Issuer、Audience、有効期限、NotBefore、InResponseToを検証します。署名検証後にDestinationとRecipientも完全一致で追加検証します。
- リクエストは5分で失効し、一回限りです。同じログイン要求の同時処理を拒否します。IdP initiated応答を受け付けません。
- セッション確定時にIDを再生成し、HttpOnly / SameSite=Laxを使用します。HTTP localhostではSecure=falseが必要で、HTTPSではSecure=trueを必須にしています。
- 成功・失敗の段階だけをログへ出し、SAML XML、Cookie、Session ID、Token、Secret、個人情報をログに出しません。`NODE_DEBUG=saml`などライブラリの詳細デバッグを本番で有効にしないでください。
- ログイン処理中の状態とexpress-sessionのMemoryStoreはプロセス内にあり、再起動で消えます。1プロセスのlocalhostサンプル用です。セッションは無操作1時間・ログインから最大8時間、保留ログインは5分、最大1000件です。
- 本番公開には共有セッションストア、分散環境での一回限りトランザクション管理、レート制限、証明書ローテーション、HTTPS配信、プロキシの信頼設定、監視が必要です。

## トラブルシューティング

| 症状 | 確認すること |
|---|---|
| Backendが起動しない | 必須.env、32文字以上のSecret、Base64証明書パスと期限。例のテナントIDを実値へ変更 |
| `AADSTS50011` | Entra Reply URLとSAML_CALLBACK_URLの完全一致 |
| Microsoft側でアクセス拒否 | ユーザー割り当て、管理者設定、Conditional Access、Entraサインインログ |
| 認証後にエラー | 両方の署名設定、正しいアプリの有効証明書、IdP Issuer、Entity ID、ACS、端末の時刻 |
| ポータルのテストで拒否 | アプリのボタンから開始。InResponseToが必要 |
| 5分以上かかると失敗 | ログイン要求の期限切れ。アプリからやり直す |
| 認証成功後に未認証 | localhostと127.0.0.1混在、Cookieブロック、HTTPSのSecure設定、プロキシ設定、再起動 |
| Name / EmailがClaim未設定 | Entra Claim名とユーザーのmail/displayname属性を確認 |
| ログアウト403 | FRONTEND_URLとブラウザOriginの一致。UIから実行 |
| 再ログインで認証画面を省略 | Entraセッションが残っているため。アプリのログアウトはローカルのみ |

実際のEntra認証の確認には、利用者のテナント設定と対話ログインが必要です。署名付きローカルテストの成功と実Entra接続の成功は別々に確認してください。

## React Native / Expo版

`mobile/`にiOS / Android向けサンプルを追加しています。システムブラウザで既存SAML認証を行い、60秒・一回限りのコードを端末の秘密値で交換してアプリ用セッションを取得します。Webと同じObject IDを表示します。

セットアップとHTTPS・Deep Linkの説明は[mobile/README.md](mobile/README.md)を参照してください。モバイルの依存関係はWeb workspaceとは別にインストールします。

```bash
npm install --prefix mobile
cp mobile/.env.example mobile/.env
npm run mobile:ios
```

追加API: `POST /auth/mobile/start`、`POST /auth/mobile/exchange`、`GET /api/mobile/me`、`POST /auth/mobile/logout`。カスタムscheme認証はExpo GoではなくDevelopment Buildで実行します。


## Web / Expo共通ユーザーDB

DBファイルは `backend/data/shared.sqlite` です。Backend起動時にマイグレーションを実行します。`DATABASE_PATH`でパスを変更できます (Backend作業ディレクトリからの相対パス)。DBとWAL/SHMはGit管理対象外です。

認証済みSAMLのtenantid Claimを検証済みIssuerのテナントと照合し、`tenant_id + object_id` の一意制約で内部ユーザーUUIDへ紐付けます。WebとExpoの両方で同じ組み合わせなら同じ内部IDになります。NameID / Emailが変更されても内部IDを維持します。Object IDまたはTenant IDが欠落する認証はDB登録せず拒否します。初回ログインでユーザーのみ登録し、部署・ロールは未付与です。異なるテナントの同じ人物は別ユーザーとして扱います。

| テーブル | 内容 |
|---|---|
| users | 内部ユーザーID、表示名、Email、有効/無効 |
| external_identities | Tenant ID + Object ID、内部ユーザーID、NameID |
| departments / user_departments | テナント別部署と所属 (複数所属可) |
| applications | web-a / web-b / mobile |
| roles / role_permissions | アプリ別ロールと許可操作 |
| user_roles | ユーザーごとのアプリ別ロール |
| schema_migrations | スキーマの適用履歴 |

Web版2つのアプリIDとして`web-a`と`web-b`、Expo用に`mobile`を登録済みです。Next.js版がweb-bを使用します。React/ExpoはExpress API、Next.jsは自身のサーバー処理で共通DBを使用し、端末やブラウザからDBへ直接接続しません。

### 初期化・部署・権限の設定

以下はプロジェクトルートから実行します。初期化は既存DBを消去しません。

```bash
npm run db -w backend -- init
npm run db -w backend -- users
```

DB追加後はWeb / Expoから再ログインしてください。`/api/me`、`/api/mobile/me`と画面に共通User ID、Tenant ID、部署、全アプリのロールが表示されます。画面に表示された内部User IDを以下の`USER_ID`へ指定します。

```bash
npm run db -w backend -- department USER_ID TENANT_ID ENG "開発部"
npm run db -w backend -- grant USER_ID web-a editor
npm run db -w backend -- grant USER_ID web-b viewer
npm run db -w backend -- grant USER_ID mobile viewer
npm run db -w backend -- revoke USER_ID web-a editor
npm run db -w backend -- unassign-department USER_ID DEPARTMENT_ID
npm run db -w backend -- disable USER_ID
npm run db -w backend -- enable USER_ID
```

部署は指定ユーザーと同じテナントにのみ割り当てられます。管理CLIは信頼するローカル管理者向けです。管理画面は下記の管理APIを利用します。

| ロール | 許可操作 |
|---|---|
| viewer | content:read |
| editor | content:read、content:write |
| admin | content:read、content:write、users:manage |

初回ログイン成功と、業務アプリの利用許可は別です。未付与ユーザーは自身のプロフィールを表示できますが、保護したアクセス確認APIでは403になります。

- Web: `GET /api/apps/web-a/access` (Cookie認証)
- Expo: `GET /api/mobile/apps/mobile/access` (Bearerセッション認証)

未認証は401、対象アプリのcontent:read権限がなければ403、許可されればそのアプリのpermissionsを返します。ユーザー無効化・ロール取り消しは、既存セッションでも次のAPI呼び出しに反映されます。Webはページ再読み込み、Expoは「ログイン状態を再確認」で表示を更新できます。今後追加する業務APIは操作ごとにDBのpermissionsをチェックしてください。業務コンテンツの編集APIはまだ実装していません。

SQLiteはこのMacのローカル検証向けです。複数サーバーから利用する本番構成ではPostgreSQL等へ移行します。DBをネットワーク共有フォルダへ置く構成は想定していません。ユーザー・部署・権限はBackend再起動後も残りますが、認証セッションとモバイルコードは引き続きプロセス内です。

SQLiteはbetter-sqlite3を使い、外部キー、一意制約、トランザクション、WALを有効化しています。[ライブラリ公式資料](https://github.com/WiseLibs/better-sqlite3)。Nodeのメジャーバージョンを切り替えた場合、ネイティブ依存の再インストールまたは `npm rebuild better-sqlite3` が必要になることがあります。


## ユーザー管理画面

Webでログイン後「ユーザー管理画面へ」、または `/admin` を開きます。初回ログイン済みのユーザーを検索し、部署（複数所属可）・アプリ別ロール・有効/無効を保存できます。部署作成と直近100件の変更履歴もあります。氏名・Email・NameIDはEntraのログイン情報から更新し、この画面では編集しません。

最初の共通管理者は、信頼するローカル管理者が内部User IDを指定して登録します。一般ユーザーや初回ログインユーザーには自動付与しません。

```bash
npm run db -w backend -- users
npm run db -w backend -- common-admin USER_ID
```

共通管理者は同じテナントのユーザー・部署・全アプリのロールを管理できます。アプリの `admin` ロールはそのアプリのロールのみ変更でき、共通管理者とは別です。共通管理者は画面から無効化できません。管理者権限の追加はローカルCLIのみです。

管理APIはWeb Cookie認証・毎回のDB権限確認・同一テナント制限を行います。更新はOriginとセッション固有のCSRFトークンを確認し、DB変更と変更履歴を同じトランザクションで保存します。無効化はWeb/Expoの既存セッションにも次のAPIアクセスから反映されます。ログインプロフィール画面自体は権限未付与でも閲覧できます。

API: `GET /api/admin/context`、`GET /api/admin/users?q=&offset=`（50件ずつ）、`PUT /api/admin/users/:id`、`POST /api/admin/departments`、`GET /api/admin/audit`。schema version 3への移行は既存ユーザー・部署・権限を保持して起動時に適用します。

## 協力会社ユーザーのGraph招待

`backend/.env` に `GRAPH_TENANT_ID`、`GRAPH_CLIENT_ID`、`GRAPH_CLIENT_SECRET`、`GRAPH_TARGET_SERVICE_PRINCIPAL_ID` を設定してBackendを再起動します。Graph用アプリにはアプリケーション権限 `User.Invite.All`、`AppRoleAssignment.ReadWrite.All`、`Application.Read.All` と管理者同意が必要です。秘密情報はBackendのみで保持し、応答やログへ出しません。

共通管理者の管理画面に「協力会社ユーザーを招待」が表示されます。「Graph接続を確認」は認証と対象アプリの読み取りのみです。招待・割り当ての書き込み権限や招待ポリシーは実際の実行時に確認されます。メール・氏名・所属会社を入力し、確認画面で送信するとGraphが招待メールを送信し、設定したSAMLアプリへ割り当てます。対象はBackend設定で固定し、画面から任意のアプリIDやEntraロールを指定できません。

対象アプリに有効なユーザーロールがある場合は `GRAPH_TARGET_APP_ROLE_ID` も設定します。これはEntraのログイン割り当て用ロールで、共通DBのviewer/editor/adminとは別です。招待完了だけでは業務アプリ権限は付与しません。相手がWeb/Expoから初回ログインすると通常のユーザー一覧に登録され、部署・ロールを設定できます。所属会社は現在招待履歴に記録するだけで、データの会社別アクセス制限にはまだ使用しません。

招待履歴は永続DBに保存し、同一テナント・同一メールへの二重送信を拒否します。割り当てのみ失敗した場合は一覧の「割り当てを再試行」でメールを再送せず復旧できます。ネットワーク切断などで招待送信の成否が不明、またはプロセス停止で処理中のままの場合はEntra側を確認してください。メール送信は外部の処理なのでDBと完全に同時確定はできません。自動再送は行いません。招待承諾状況をGraphで定期同期する機能は未実装で、一覧の「初回ログイン済み」は共通DBへのログイン登録を基に表示します。

`GRAPH_INVITE_REDIRECT_URL` は招待承諾後のHTTPS案内ページです。既定は `https://myapps.microsoft.com/`。実機からlocalhostにはアクセスできないため、配布時には到達可能な案内ページを設定してください。Graph設定変更はBackend再起動が必要です。

公式API: [招待](https://learn.microsoft.com/en-us/graph/api/invitation-post?view=graph-rest-1.0)、[アプリ割り当て](https://learn.microsoft.com/en-us/graph/api/serviceprincipal-post-approleassignedto?view=graph-rest-1.0)。

## Next.js版（Web App B）

`npm run next:dev` で http://localhost:3100 を起動できます。Next.js内でSSR・SAML認証・APIを実行し、React/Expoと共通のDBユーザーを利用します。Entraの既存SAMLアプリへ応答URL `http://localhost:3100/auth/callback` の追加が必要です。詳細は [next-web/README.md](next-web/README.md)。

## 統合手順書

ここまでの設定・操作・トラブル対処は [Entra・SAML導入手順書](docs/Entra-SAML導入手順書.md) にまとめています。


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


## 本番利用と公開範囲

このリポジトリは導入・検証用テンプレートです。本番向けのセキュリティ監査済み製品ではありません。実際のテナント設定、ユーザーDB、秘密鍵、Graphクライアントシークレットは同梱しません。各 `.env.example` から環境設定を作成してください。

- ExpressのCookieセッション、SAMLトランザクション、モバイルトークンはメモリ保存です。再起動で失効し、複数インスタンス間で共有されません。本番では永続化・共有ストアを設計してください。
- 共通SQLite DBは同一ホストでの検証向けです。別ホストの複数アプリで利用する場合は、共通DBサーバーまたはユーザー管理APIへ移行してください。
- 本番のTLS終端、リバースプロキシ、レート制限、監査ログ保全、バックアップ、依存更新は配備環境に合わせて整備してください。Backendのサンプル起動はlocalhostにバインドします。
- 証明書自動取得のキャッシュは永続化し、取得失敗の警告と証明書期限を監視してください。Entra側の証明書作成・有効化は管理者の作業です。
- Graph連携は任意です。招待メール送信やアプリ割り当ては実テナントへの操作となるため、検証テナントで確認してから使用してください。

認証設定・秘密情報はコミットしないでください。Gitの除外設定は、過去にコミットされた情報を削除するものではありません。

依存パッケージの監査結果と既知の制約は [SECURITY.md](SECURITY.md) を参照してください。
