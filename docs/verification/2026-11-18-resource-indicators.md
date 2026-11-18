# 検証メモ：Keycloak の RFC 8707（Resource Indicators）を有効にした場合との差

- 検証日：2026-11-18
- Keycloak：26.8.2（`quay.io/keycloak/keycloak:26.8.2@sha256:c68e286cacd87b942ac1939a0a1481461109d6acd3a57dc496969a319a76bbf0`）。フラグなし・フラグありの両方で、このダイジェストのイメージを使った（実行中コンテナの `.Image` が同じ `sha256:c68e286c…` であることを確認）。
- 起動方法：`start-dev`。フラグありは `--features=resource-indicators` を足しただけ（`compose.resource-indicators.yaml`）。
- nightly へのフォールバックは不要だった（26.8.2 がフラグを受け付けた）。
- 試した MCP サーバー：このリポジトリの `itsm-mcp`（`http://localhost:3000/mcp`、`aud` に自分の URL が入っていれば受け入れる）。

## 結論（先に）

1. 26.8.2 は `--features=resource-indicators` を受け付ける。起動ログに `Experimental features enabled: resource-indicators:v1` と出る。
2. フラグありだと、`resource` を付けたトークンの `aud` はその値だけになる（`account` も、スコープ由来の別の宛先も消える）。
3. フラグなしでは `resource` は無視される。エラーにもならず、`aud` も変わらない。クライアントやリソースサーバーの設定が揃っていても同じ（対照実験 B）。
4. 回避策（スコープごとに Audience マッパー）は、宛先を1つに縛れない。2つの宛先を持つスコープを使うと `aud` に両方が入り、3000 の MCP サーバーはそのトークンを受け入れる。フラグありで `resource` を付けると 1 つに縛れる。
5. 公式ガイドと食い違う点が1つあった：未知の `resource` は、認可エンドポイントでは拒否されず（ログイン画面が出て、コードが発行される）、トークンエンドポイントで `invalid_target` になる。

## 手順

```sh
# フラグなし
docker compose up -d --build --wait
./keycloak/setup-resource-indicators.sh shared-scope          # shared:read だけ
node scripts/probe-resource-indicators.ts "flag-off A"
./keycloak/setup-resource-indicators.sh resource-indicators   # 対照 B（リソースサーバー設定あり・フラグなし）
node scripts/probe-resource-indicators.ts "flag-off B"
docker compose down -v

# フラグあり
docker compose -f compose.yaml -f compose.resource-indicators.yaml up -d --build --wait
COMPOSE_FILES="-f compose.yaml -f compose.resource-indicators.yaml" ./keycloak/setup-resource-indicators.sh
node scripts/probe-resource-indicators.ts "flag-on"
docker compose -f compose.yaml -f compose.resource-indicators.yaml down -v
```

`scripts/*.ts` は Node 24.13 が型を取り除いてそのまま実行する（`node scripts/….ts`）。tsx は入っていないし、足していない。`tsconfig.test.json` に `scripts` を含め、`allowImportingTsExtensions` を足した（`./authcode.ts` の import を型検査に通すため）。

### 設定（公式ガイドのとおり）

`keycloak/setup-resource-indicators.sh` が kcadm で、起動中のスタックにだけ足す（コミットする realm の書き出しには入れない）。

- リソースサーバーのクライアントを2つ：`itsm-mcp-resource`（`resource_url` = `http://localhost:3000/mcp`）、`other-mcp-resource`（`resource_url` = `http://localhost:3001/mcp`）。属性名は `resource_url`、クライアントの種類は機密クライアント（フローはすべて無効）。ガイドは種類を指定していない。
- `claude-code`（と ROPC 用の `lab-tester`）に、Audience マッパーを2つ（Included Client Audience → 上の2クライアント）。
- Task 6 Step 4 用に、任意スコープ `shared:read`（Audience マッパー2つ。`http://localhost:3000/mcp` と `http://localhost:3001/mcp`）。これだけはフラグなしの検証（実験 A）にも要るので、`shared-scope` として分けてある。

### 実験の種類

- A：フラグなし。realm はコミットしたもの＋`shared:read`。
- B：対照。フラグなしのまま、リソースサーバーのクライアントと Audience マッパーも足した。
- C：フラグあり。B と同じ設定。

## 期待と実際

`aud` の並びは実行のたびに変わる（集合として扱う）。「MCP」は、そのトークンで 3000 の `tools/list` を POST した HTTP ステータス。

| プローブ                                                | 期待（フラグあり）              | 実際（フラグあり C）                                                                                       | 実際（フラグなし A）                              |
| ------------------------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| 0. `resource` なし（`itsm:read`）                       | 縛られない                      | `aud` = 4 件（`itsm-mcp-resource`、`other-mcp-resource`、`http://localhost:3000/mcp`、`account`）。MCP 200 | `aud` = `[3000, account]`。MCP 200                |
| 1. `resource=3000`（認可・トークンとも）                | `aud` が 3000 だけ              | `aud` = `"http://localhost:3000/mcp"`（文字列1つ）。MCP 200                                                | `aud` = `[3000, account]`（変化なし）。MCP 200    |
| 2a. 認可に未知の `resource`、トークンに `resource` なし | `invalid_target`                | HTTP 400 `invalid_target`（トークン段階。下の注を参照）                                                    | トークン発行。MCP 200（無視）                     |
| 2b. トークンだけ未知の `resource`                       | 拒否                            | HTTP 400 `invalid_target`（`not matching the original request`）                                           | トークン発行（無視）                              |
| 2c. 認可・トークンとも未知の `resource`                 | `invalid_target`                | HTTP 400 `invalid_target`（`invalid, missing, unknown, or malformed`）                                     | トークン発行（無視）                              |
| 3. 認可 3000・トークン 3001                             | 拒否                            | HTTP 400 `invalid_target`（`not matching the original request`）                                           | トークン発行。`aud` は変わらず（無視）            |
| 4. `resource=3001`（`itsm:read`）                       | `aud` が 3001 だけ。3000 は 401 | `aud` = `"http://localhost:3001/mcp"`。MCP **401**                                                         | `aud` = `[3000, account]`（3001 は無視）。MCP 200 |
| 5a. `shared:read`、`resource` なし                      | 両方入る                        | `aud` = 5 件（3000・3001 の URL と2つのクライアント ID と `account`）。MCP 200                             | `aud` = `[3001, 3000, account]`。MCP 200          |
| 5b. `shared:read`、`resource=3001`                      | `aud` が 3001 だけ。3000 は 401 | `aud` = `"http://localhost:3001/mcp"`。MCP **401**                                                         | `aud` = `[3001, 3000, account]`（無視）。MCP 200  |

- 注（2a）：ガイドは「認可要求でも拒否される」と書く。実際は、認可エンドポイントが未知の `resource` でもログイン画面（HTTP 200）を返し、ログイン後にコードを発行した。拒否はトークンエンドポイントで起きた。2a のトークン要求には `resource` が無かったので、この行だけでは「未知」と「欠落」のどちらで落ちたか分けられない。そこで 2c と、下の curl で確かめた。
- 認可エンドポイントの確認（フラグあり。`resource` 以外は同じ認可要求）：
  - `resource=http://localhost:9999/mcp`（未知）→ `HTTP/1.1 200 OK`（ログイン画面）
  - `resource=http://localhost:3000/mcp`（既知）→ `HTTP/1.1 200 OK`（ログイン画面）
- 対照 B（フラグなし・設定あり）：9 件すべてでトークンが発行され、`resource` の値に関係なく `aud` は同じ（`[3000, itsm-mcp-resource, other-mcp-resource, account]`、5a・5b は 3001 の URL も加わる）。MCP は全部 200。つまり、リソースサーバーのクライアントがあってもフラグがなければ `resource` は見られない。副作用として、Audience マッパー（Included Client Audience）はフラグなしでもクライアント ID を `aud` に足す。

## 回避策の弱点（Step 4）

- フラグなし、`shared:read`（5a）：`aud` に 3000 と 3001 の両方が入り、3000 の MCP サーバーがそのトークンを受け入れた（200）。回避策（スコープ＋Audience マッパー）では、宛先を1つに縛れない。2つ以上の宛先に使える広いスコープを作れば、それを持つトークンは両方で通る。
- フラグあり、`shared:read` に `resource=3001`（5b）：`aud` は 3001 だけになり、3000 の MCP サーバーは 401 を返した。期待どおり。
- 3000 の MCP サーバーは `shared:read` をツールの権限に数えない。確かめたのは認証が通るか（401 かどうか）だけ。

## 想定外だったこと

1. 未知の `resource` が認可エンドポイントで拒否されない（上の注）。ガイドの記述と違う。早く失敗しない分、ユーザーがログインしてから初めてエラーになる。
2. フラグありでも、`resource` を送らないクライアントは縛られない。`aud` は、クライアント ID・スコープ由来の URL・`account` の混ざった複数値になる（プローブ 0・5a）。このリポジトリの MCP サーバーは `aud` に自分の URL があれば受け入れるので、スコープ由来のマッパーを残していると、`resource` なしでも通る。リソース指定だけで縛る構成にするなら、スコープ側の Audience マッパーを外す必要がある。外した構成は試していない。
3. フラグありで `resource` を付けると、`aud` は配列ではなく文字列1つになる。`itsm-mcp` は問題なく受け入れた。
4. フラグありで `resource` を付けると、`account` も消える。
5. Audience マッパー（Included Client Audience）の有無が結果にどう効くかは試していない。ガイドは「RP に付ける」と書いているので、そのとおりに付けた。外した場合に `aud` がどうなるかは未確認。

## 仕様との対応

- MCP 認可 2025-11-25：
  - 「Resource Parameter Implementation」：クライアントは RFC 8707 の `resource` を、認可要求とトークン要求の両方に必ず付ける（MUST）。認可サーバーが対応しているかにかかわらず送る（MUST）。
  - 「Token Handling」と「Access Token Privilege Restriction」：MCP サーバーは、トークンが自分宛てに発行されたことを検証し（MUST）、`aud` に自分が含まれないトークンを拒否する（MUST）。
  - 「Token Audience Binding and Validation」：RFC 8707 は、認可サーバーが対応していれば、トークンを宛先に縛る。
- MCP 認可 2026-07-28：上の3点は同じ要求のまま（「Resource Parameter Implementation」「Token Handling」）。セキュリティ上の考慮事項は別ページ（`authorization/security-considerations`）に分かれた（このメモでは読んでいない）。
- RFC 8707 2節：`resource` を認可要求とトークン要求に付ける。認可サーバーは `invalid_target` で拒否できる。このメモの観察は、2025-11-25 で想定している挙動（フラグありなら `aud` が `resource` に縛られる）と合う。
- Keycloak 公式ガイド（https://www.keycloak.org/securing-apps/mcp-authz-server）：`resource-indicators` は experimental。リソースサーバーのクライアントの `resource_url` 属性、RP の Audience マッパー（Included Client Audience）、未知の `resource` は `invalid_target`、トークン要求の `resource` は認可要求と一致が必要、`aud` は `resource` の値だけ、と書かれている。観察はすべて合うが、「認可要求でも未知の `resource` を拒否する」だけが合わなかった。

## 上流に Issue を出す価値

- 小さな Issue 1件の価値はある。ただし出す前に、最新の nightly で同じになるか確かめる（このメモでは 26.8.2 しか見ていない）。内容は「未知の `resource` が認可エンドポイントで拒否されない」ことだけに絞る。重大ではなく、ガイドとの食い違いとして出す。`aud` の挙動そのものは、バグではなく設計どおり。
- 下書き（英語。投稿していない）は末尾。

## 既存の Issue・PR との関係

- keycloak/keycloak #14355「Resource Indicators for OAuth 2.0 (RFC 8707)」：open、マイルストーン 27.0（2026-11-18 に `gh` で確認。最終更新 2026-11-13）。この検証は、その初期の実装（experimental）が 26.8.2 で動くことの確認にあたる。
- PR #46763「Initial experimental support for Resource Indicators」：2026-03-17 にマージ済み（`gh` で確認）。26.8.2 に入っているのは、この PR の内容だと考えられる（26.8.2 のリリースノートで PR 番号を照合してはいない）。
- 27.0 で experimental が外れるかは分からない。外れたら、このメモの手順（フラグなし）で `resource` が効くようになる可能性があるので、再検証する。

## 26.8.2 での状態（設計メモ 5 節の「要確認」に入れる1行）

2026-11-18・Keycloak 26.8.2：RFC 8707 は `--features=resource-indicators`（experimental）で動き（`resource` 付きで `aud` がその値だけ、未知・不一致は `invalid_target`。ただし未知の値は認可ではなくトークンで拒否）、フラグなしでは `resource` を無視する。CIMD は `--features=cimd` を受け付け、起動ログに experimental と出る（`Experimental features enabled: cimd:v1`。動作は未検証）。

## 生の出力

### フラグなし（実験 A）

```text
=== probe-resource-indicators: flag-off A (shared:read only; no resource-server clients) (2026-11-18T00:58:47.989Z) ===

--- 0. no resource (baseline)
request: scope=itsm:read auth resource=- token resource=-
result: HTTP 200 token issued
claims: {"iss":"http://localhost:8080/realms/itsm-lab","azp":"claude-code","aud":["http://localhost:3000/mcp","account"],"scope":"profile itsm:read email"}
MCP http://localhost:3000/mcp tools/list: HTTP 200

--- 1. resource=3000 on both requests
request: scope=itsm:read auth resource=http://localhost:3000/mcp token resource=http://localhost:3000/mcp
result: HTTP 200 token issued
claims: {"iss":"http://localhost:8080/realms/itsm-lab","azp":"claude-code","aud":["http://localhost:3000/mcp","account"],"scope":"profile itsm:read email"}
MCP http://localhost:3000/mcp tools/list: HTTP 200

--- 2a. unknown resource on the authorization request
request: scope=itsm:read auth resource=http://localhost:9999/mcp token resource=-
result: HTTP 200 token issued
claims: {"iss":"http://localhost:8080/realms/itsm-lab","azp":"claude-code","aud":["http://localhost:3000/mcp","account"],"scope":"profile itsm:read email"}
MCP http://localhost:3000/mcp tools/list: HTTP 200

--- 2b. unknown resource on the token request only
request: scope=itsm:read auth resource=http://localhost:3000/mcp token resource=http://localhost:9999/mcp
result: HTTP 200 token issued
claims: {"iss":"http://localhost:8080/realms/itsm-lab","azp":"claude-code","aud":["http://localhost:3000/mcp","account"],"scope":"profile itsm:read email"}
MCP http://localhost:3000/mcp tools/list: HTTP 200

--- 2c. unknown resource on both requests
request: scope=itsm:read auth resource=http://localhost:9999/mcp token resource=http://localhost:9999/mcp
result: HTTP 200 token issued
claims: {"iss":"http://localhost:8080/realms/itsm-lab","azp":"claude-code","aud":["http://localhost:3000/mcp","account"],"scope":"profile itsm:read email"}
MCP http://localhost:3000/mcp tools/list: HTTP 200

--- 3. resource differs: authorization=3000, token=3001
request: scope=itsm:read auth resource=http://localhost:3000/mcp token resource=http://localhost:3001/mcp
result: HTTP 200 token issued
claims: {"iss":"http://localhost:8080/realms/itsm-lab","azp":"claude-code","aud":["http://localhost:3000/mcp","account"],"scope":"profile itsm:read email"}
MCP http://localhost:3000/mcp tools/list: HTTP 200

--- 4. resource=3001 with scope itsm:read (is the resource honoured or ignored?)
request: scope=itsm:read auth resource=http://localhost:3001/mcp token resource=http://localhost:3001/mcp
result: HTTP 200 token issued
claims: {"iss":"http://localhost:8080/realms/itsm-lab","azp":"claude-code","aud":["http://localhost:3000/mcp","account"],"scope":"profile itsm:read email"}
MCP http://localhost:3000/mcp tools/list: HTTP 200

--- 5a. shared:read, no resource
request: scope=shared:read auth resource=- token resource=-
result: HTTP 200 token issued
claims: {"iss":"http://localhost:8080/realms/itsm-lab","azp":"claude-code","aud":["http://localhost:3001/mcp","http://localhost:3000/mcp","account"],"scope":"profile shared:read email"}
MCP http://localhost:3000/mcp tools/list: HTTP 200

--- 5b. shared:read, resource=3001
request: scope=shared:read auth resource=http://localhost:3001/mcp token resource=http://localhost:3001/mcp
result: HTTP 200 token issued
claims: {"iss":"http://localhost:8080/realms/itsm-lab","azp":"claude-code","aud":["http://localhost:3001/mcp","http://localhost:3000/mcp","account"],"scope":"profile shared:read email"}
MCP http://localhost:3000/mcp tools/list: HTTP 200
```

### フラグあり（実験 C）

```text
=== probe-resource-indicators: flag-on (resource-indicators, full setup) (2026-11-18T00:58:00.882Z) ===

--- 0. no resource (baseline)
request: scope=itsm:read auth resource=- token resource=-
result: HTTP 200 token issued
claims: {"iss":"http://localhost:8080/realms/itsm-lab","azp":"claude-code","aud":["itsm-mcp-resource","http://localhost:3000/mcp","other-mcp-resource","account"],"scope":"profile itsm:read email"}
MCP http://localhost:3000/mcp tools/list: HTTP 200

--- 1. resource=3000 on both requests
request: scope=itsm:read auth resource=http://localhost:3000/mcp token resource=http://localhost:3000/mcp
result: HTTP 200 token issued
claims: {"iss":"http://localhost:8080/realms/itsm-lab","azp":"claude-code","aud":"http://localhost:3000/mcp","scope":"profile itsm:read email"}
MCP http://localhost:3000/mcp tools/list: HTTP 200

--- 2a. unknown resource on the authorization request
request: scope=itsm:read auth resource=http://localhost:9999/mcp token resource=-
result: HTTP 400 {"error":"invalid_target","error_description":"The requested resource is invalid, missing, unknown, or malformed."}

--- 2b. unknown resource on the token request only
request: scope=itsm:read auth resource=http://localhost:3000/mcp token resource=http://localhost:9999/mcp
result: HTTP 400 {"error":"invalid_target","error_description":"The requested resource is not matching the original request."}

--- 2c. unknown resource on both requests
request: scope=itsm:read auth resource=http://localhost:9999/mcp token resource=http://localhost:9999/mcp
result: HTTP 400 {"error":"invalid_target","error_description":"The requested resource is invalid, missing, unknown, or malformed."}

--- 3. resource differs: authorization=3000, token=3001
request: scope=itsm:read auth resource=http://localhost:3000/mcp token resource=http://localhost:3001/mcp
result: HTTP 400 {"error":"invalid_target","error_description":"The requested resource is not matching the original request."}

--- 4. resource=3001 with scope itsm:read (is the resource honoured or ignored?)
request: scope=itsm:read auth resource=http://localhost:3001/mcp token resource=http://localhost:3001/mcp
result: HTTP 200 token issued
claims: {"iss":"http://localhost:8080/realms/itsm-lab","azp":"claude-code","aud":"http://localhost:3001/mcp","scope":"profile itsm:read email"}
MCP http://localhost:3000/mcp tools/list: HTTP 401

--- 5a. shared:read, no resource
request: scope=shared:read auth resource=- token resource=-
result: HTTP 200 token issued
claims: {"iss":"http://localhost:8080/realms/itsm-lab","azp":"claude-code","aud":["http://localhost:3000/mcp","itsm-mcp-resource","http://localhost:3001/mcp","other-mcp-resource","account"],"scope":"shared:read profile email"}
MCP http://localhost:3000/mcp tools/list: HTTP 200

--- 5b. shared:read, resource=3001
request: scope=shared:read auth resource=http://localhost:3001/mcp token resource=http://localhost:3001/mcp
result: HTTP 200 token issued
claims: {"iss":"http://localhost:8080/realms/itsm-lab","azp":"claude-code","aud":"http://localhost:3001/mcp","scope":"shared:read profile email"}
MCP http://localhost:3000/mcp tools/list: HTTP 401
```

### 対照 B（フラグなし・リソースサーバー設定あり）

`aud` の一覧だけ抜粋（全文は `node scripts/probe-resource-indicators.ts` で再現できる）。

```text
=== probe-resource-indicators: flag-off B (control: full setup present, flag off) (2026-11-18T00:58:52.034Z) ===
--- 0. no resource (baseline)
claims: {"iss":"http://localhost:8080/realms/itsm-lab","azp":"claude-code","aud":["http://localhost:3000/mcp","itsm-mcp-resource","other-mcp-resource","account"],"scope":"profile itsm:read email"}
MCP http://localhost:3000/mcp tools/list: HTTP 200
--- 1. resource=3000 on both requests
claims: {"iss":"http://localhost:8080/realms/itsm-lab","azp":"claude-code","aud":["http://localhost:3000/mcp","itsm-mcp-resource","other-mcp-resource","account"],"scope":"profile itsm:read email"}
MCP http://localhost:3000/mcp tools/list: HTTP 200
--- 2a. unknown resource on the authorization request
claims: {"iss":"http://localhost:8080/realms/itsm-lab","azp":"claude-code","aud":["http://localhost:3000/mcp","itsm-mcp-resource","other-mcp-resource","account"],"scope":"profile itsm:read email"}
MCP http://localhost:3000/mcp tools/list: HTTP 200
--- 2b. unknown resource on the token request only
claims: {"iss":"http://localhost:8080/realms/itsm-lab","azp":"claude-code","aud":["http://localhost:3000/mcp","itsm-mcp-resource","other-mcp-resource","account"],"scope":"profile itsm:read email"}
MCP http://localhost:3000/mcp tools/list: HTTP 200
--- 2c. unknown resource on both requests
claims: {"iss":"http://localhost:8080/realms/itsm-lab","azp":"claude-code","aud":["http://localhost:3000/mcp","itsm-mcp-resource","other-mcp-resource","account"],"scope":"profile itsm:read email"}
MCP http://localhost:3000/mcp tools/list: HTTP 200
--- 3. resource differs: authorization=3000, token=3001
claims: {"iss":"http://localhost:8080/realms/itsm-lab","azp":"claude-code","aud":["http://localhost:3000/mcp","itsm-mcp-resource","other-mcp-resource","account"],"scope":"profile itsm:read email"}
MCP http://localhost:3000/mcp tools/list: HTTP 200
--- 4. resource=3001 with scope itsm:read (is the resource honoured or ignored?)
claims: {"iss":"http://localhost:8080/realms/itsm-lab","azp":"claude-code","aud":["http://localhost:3000/mcp","itsm-mcp-resource","other-mcp-resource","account"],"scope":"profile itsm:read email"}
MCP http://localhost:3000/mcp tools/list: HTTP 200
--- 5a. shared:read, no resource
claims: {"iss":"http://localhost:8080/realms/itsm-lab","azp":"claude-code","aud":["http://localhost:3001/mcp","http://localhost:3000/mcp","itsm-mcp-resource","other-mcp-resource","account"],"scope":"profile shared:read email"}
MCP http://localhost:3000/mcp tools/list: HTTP 200
--- 5b. shared:read, resource=3001
claims: {"iss":"http://localhost:8080/realms/itsm-lab","azp":"claude-code","aud":["http://localhost:3001/mcp","http://localhost:3000/mcp","itsm-mcp-resource","other-mcp-resource","account"],"scope":"profile shared:read email"}
MCP http://localhost:3000/mcp tools/list: HTTP 200
```

## 上流 Issue の下書き（英語。未投稿）

> Title: resource-indicators: unknown `resource` is not rejected at the authorization endpoint (only at the token endpoint)
>
> **Environment**: Keycloak 26.8.2 (`quay.io/keycloak/keycloak:26.8.2@sha256:c68e286cacd87b942ac1939a0a1481461109d6acd3a57dc496969a319a76bbf0`), `start-dev --features=resource-indicators`. Not yet re-checked on nightly (do this before filing).
>
> **Setup**: realm with two clients carrying a `resource_url` attribute (`http://localhost:3000/mcp`, `http://localhost:3001/mcp`) and a public client `claude-code` (Authorization Code + PKCE S256) with Audience mappers ("Included Client Audience") for both, as in the MCP authorization server guide.
>
> **Steps**
>
> 1. `GET /realms/<realm>/protocol/openid-connect/auth?client_id=claude-code&response_type=code&redirect_uri=…&scope=…&code_challenge=…&code_challenge_method=S256&resource=http://localhost:9999/mcp` (a URL that is not any client's `resource_url`).
> 2. Log in; the code is issued.
> 3. Exchange the code with the same `resource` on the token endpoint.
>
> **Expected** (per the guide: "if the `resource` value isn't configured as a resource URI … Keycloak rejects the request with `invalid_target`", for authorization and token requests): the authorization request fails with `invalid_target`.
>
> **Actual**: the authorization endpoint returns HTTP 200 (login page) for the unknown `resource`, identical to a known one, and issues a code after login. Only the token request fails: HTTP 400 `{"error":"invalid_target","error_description":"The requested resource is invalid, missing, unknown, or malformed."}`.
>
> **Impact**: a client that sends a mistyped resource only finds out after the user has logged in and consented. Failing at the authorization endpoint (RFC 8707 §2 allows `invalid_target`) would give early feedback.
>
> **Context**: this is related to #14355 / #46763 (experimental support). Happy to test a fix or send a PR if the behaviour is unintended.
