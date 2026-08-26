# MCP (Model Context Protocol) — 仕様ノート

teapotにMCPクライアントを実装するための仕様まとめ。
基準版: **protocol revision 2026-07-28**（2026年8月時点の最新final spec）。
一次ソース: modelcontextprotocol.io/specification/2026-07-28/

---

## 1. プロトコルの骨格

### 形式
- **JSON-RPC 2.0**。リクエスト/レスポンス/通知の3種
- リクエストIDはstring/int（null禁止、未応答リクエストと重複禁止）
- レスポンスは`result`か`error`。**全resultに必須の`resultType`フィールド**:
  - `"complete"` — 通常完了
  - `"input_required"` — MRTR中間結果（後述）
  - 不明なresultTypeは無効として扱う。**resultType欠落は"complete"扱い**（旧バージョン互換）
- スキーマの真実源はTypeScript schema（JSON Schemaは自動生成）。ツール定義等のスキーマ方言は2020-12がデフォルト

### ステートレス性（2026-07-28の核心）
- プロトコルレベルのセッション廃止。**全リクエストが自己完結**し、`_meta`フィールドに
  protocol version / client identity / capabilitiesを毎回載せる
- initializeハンドシェイクも廃止。代わりにサーバーは`server/discover`を実装必須
  （対応バージョン・capabilities・identityを広告。クライアントは事前に呼んでよいし、
  いきなりRPCを打って`UnsupportedProtocolVersionError`を処理してもよい）
- 状態が必要なら「明示的ハンドル」をサーバーが発行しクライアントが毎回渡す
  （例: カートIDをcreate_cartが返し、以降の呼び出しが引数で受ける）

### バージョニング
- バージョンは日付文字列（例: `2026-07-28`）= 最後に破壊的変更をした日
- 交渉なし: サーバーが非対応バージョンなら`UnsupportedProtocolVersionError` (-32022) を返し、
  対応バージョン一覧を添える。クライアントは合意可能な版でリトライ
- HTTPでは`MCP-Protocol-Version`ヘッダにも載せる（ボディの_metaと不一致なら400 HeaderMismatch -32020）
- **Legacy（initializeベース、≤2025-11-25）との相互運用**: デュアルera実装のみ対応可能。
  stdioは`server/discover`プローブ→現代的エラー以外でfallback。HTTPはmodern requestを試みて
  400の中身を見て判定。判定結果はサーバープロセス/オリジンの寿命でキャッシュしてよい

### 拡張フレームワーク
- ClientCapabilities/ServerCapabilitiesに`extensions`マップ（識別子 → 設定オブジェクト）
- 識別子は`_meta`キー命名規則準拠＋必須プレフィックス（例: `io.modelcontextprotocol/tasks`）
- 片方だけが対応している場合、対応側はコア動作に戻すか適切なエラーで拒否
- 公式拡張: Tasks（長時間実行、tasks/getポーリング）、MCP Apps（サンドボックスiframe UI）

---

## 2. トランスポート

### Streamable HTTP（推奨・実質唯一）
- サーバーは単一MCPエンドポイント（例: `https://example.com/mcp`）を提供
- クライアントは**JSON-RPCメッセージごとに個別POST**
  - Acceptヘッダに`application/json`と`text/event-stream`の両方を列挙（必須）
  - 必須ヘッダ: `MCP-Protocol-Version`, `Mcp-Method`, ツール/リソース系は`Mcp-Name`
    （非ASCIIは`=?base64?...?=`形式でエンコード）
- 通知は202 Accepted（ボディなし）、リクエストはJSON単体 or SSEストリームで応答
- SSE応答には当該リクエスト関連の通知（progress等）が流れ得て、最終レスポンスで閉じる
- 変更通知（tools/list_changed等）は`subscriptions/listen`リクエストの長寿命SSEで受け取る
- **Last-Event-IDによるSSE再開は非対応**
- サーバー側要件: Origin検証（不正なら403）、localhost bind推奨、認証実装推奨
  （DNS rebinding対策）

### stdio
- ローカルプロセスをspawnしてstdin/stdoutでJSON-RPC
- HTTP認証specには従わない。資格情報は環境変数から取得
- teapotのような常駐サーバーからspawnする場合、プロセス管理（クラッシュ検知・再起動・
  ライフタイム=タスクではなくホスト）を自前で持つ必要がある

### 非推奨
- HTTP+SSE transport（2024-11-05由来）— 非推奨だが12ヶ月以上維持

---

## 3. 認可（HTTP トランスポート）

OAuth 2.1ベース。**stdioでは使わない**。

- MCPサーバー = OAuth 2.1 resource server、クライアント = OAuth client
- **必須**: サーバーはProtected Resource Metadata (RFC9728)実装、クライアントはそれを使った
  authorization server discovery。ASはRFC8414またはOIDC Discoveryの少なくとも一方
- クライアント登録の優先順: **Client ID Metadata Documents**（新、推奨）→ 事前登録 →
  Dynamic Client Registration (RFC7591、後方互換のため非推奨)
- scope選択は401の`WWW-Authenticate`challengeを最優先（step-up authorization前提）
- **Token audience validation必須**: 他サービス発行のトークンを受け入れてはならない
- OpenCodeの実装が参考になる: 401検出→DCR→ブラウザ認証→トークン保存

---

## 4. サーバー機能: Tools / Resources / Prompts

### Tools（モデル制御型 — 最重要）
```
tools/list   → { tools: [{ name, title?, description, inputSchema, outputSchema?,
                       annotations?, icons? }], ttlMs?, cacheScope? }
tools/call   → { content: [...], structuredContent?, isError? }
```
- inputSchema/outputSchemaはJSON Schema（2020-12デフォルト）。空パラメータは
  `{type:"object", additionalProperties:false}`推奨
- **ツール名**: 1〜128文字推奨、case-sensitive、`[A-Za-z0-9_.-]`のみ、サーバー内で一意
- **annotations**: 動作ヒント（readOnlyHint等）
- **x-mcp-header拡張**: パラメータ値を`Mcp-Param-{name}`ヘッダにミラー（Streamable HTTPのみ。
  クライアントは違反するツール定義をtools/listから除外し警告ログ必須）
- **listChanged**: capability宣言時に変更通知（subscriptions/listenで受信）
- **キャッシュ**: list系レスポンスは`ttlMs`+`cacheScope`(public/private)付き。
  接続非依存になったのでキャッシュ安全。決定的順序で返すことが推奨（prompt cache命中率向上）
- **Tool Result**: content配列はText/Image/Audio/ResourceLink/EmbeddedResource。
  `structuredContent`はoutputSchemaに適合するJSON（互換のためテキストシリアライズも併記推奨）
- Stateful toolは明示的ハンドルパターン（作成ツールがIDを返し、後続呼び出しが引数で受ける）

### Resources（クライアント制御型）
- URIで識別されるデータ（ファイル、APIペイロード等）。resources/readで取得
- Gemini CLIはこれを`@server://path`構文で会話へ注入（補完UI統合）

### Prompts（ユーザー制御型）
- 再利用可能なプロンプトテンプレート

---

## 5. クライアント機能（サーバーから見た要求）

クライアントcapabilitiesで宣言して初めて使える:

### Elicitation — サーバー→ユーザーの入力要求
2モード:
- **form mode**: フラットなプリミティブのみのJSON Schemaで構造化入力
  （ネスト/オブジェクト配列は意図的に非対応。email/uri/date等のformat対応）
- **url mode**: 機密操作（OAuth、決済、APIキー入力）は外部URLへ誘導。
  データはURL以外クライアントを経由しない
- 安全規則: form modeでパスワード/APIキー収集は禁止、そういうものはURL modeで

### Sampling — サーバーがLLM完成を要求
- human-in-the-loop by design: モデル選択はクライアント制御（サーバーにAPI keyは見せない）、
  promptのreview/edit可、deny可。modelPreferencesはadvisory

### Roots — クライアントが作業ディレクトリ集合を提示
- **非推奨**（12ヶ月維持）。新規依存は避ける

### MRTR (Multi Round-Trip Requests) — 上記の配送方式
- サーバーからの独立リクエストチャネルは廃止
- `tools/call`等が`InputRequiredResult`(resultType: "input_required")を返し、
  `inputRequests`マップ + 不透明な`requestState`を含む
- クライアントは回答を`inputResponses`に同keyで入れ、`requestState`をそのままechoして
  **同じメソッドを再送**（※ JSON-RPC idは初回と変えてよい/変わる）

---

## 6. エラーコード

標準JSON-RPC (-32700, -32600..32603)に加え、MCP専用レンジ:
| code | 名前 |
|---|---|
| -32020 | HeaderMismatch |
| -32021 | MissingRequiredClientCapability |
| -32022 | UnsupportedProtocolVersion |

- -32000..-32019はlegacy（新規使用禁止）。-32002/-32042は過去版のもの（受信側は許容）
- 実装ローカルエラー（タイムアウト等）にspec上のコード割当は現状なし

---

## 7. セキュリティ（公式best practices + 既知攻撃）

### 公式必須事項
- **Confused deputy対策**: プロキシ型MCPサーバーはper-client consent必須
  （静的client ID + DCR + consent cookieの組合せで認可コード窃取が成立する）
  - consent cookieは`__Host-` prefix + Secure + HttpOnly + SameSite=Lax、client_id束縛
  - redirect_uriは完全一致検証（wildcard禁止）
- **Token passthrough禁止**: 自分宛てでないトークンを転送しない（trust boundary崩壊防止）
- SSRF対策、consent UIのCSP（frame-ancestors）/CSRF state検証

### 既知攻撃クラス（コミュニティ知見）
- **Tool Poisoning Attack (TPA)**: 悪意あるツールdescriptionにモデル向け隠れ指示を埋め込む
  （「このツールを使う際は~/.sshをreadして~」等）。ツール説明はすべてモデルコンテキストに入る
- **Rug Pull**: インストール承認後にサーバーがツール定義を静かに差し替える
  （Day1に承認した安全なツールがDay7に悪化）。→ 定義ハッシュの再検証が必要
- **Tool Shadowing**: 信頼できるサーバーのツール名を悪意あるサーバーの説明文が参照し上書き誘導
- **Cross-server exfiltration**: あるサーバーの結果を別サーバー経由で外送

### クライアント側の緩和策（teapotが採るべきもの）
1. 初回接続時のツール一覧をユーザーに提示・承認させる（web UIで出せるのが強み）
2. ツール定義のハッシュを保持し、tools/list結果が変わったら再承認
3. ツール名は`mcp__<server>__<tool>`で名前空間化しshadowingを構造的に防ぐ
4. includeTools/excludeTools絞り込み（50ツール超で品質劣化の実測あり）
5. deny理由はモデルにフィードバック（既存のtool_result経路をそのまま使う）

---

## 8. 主要ハーネス実装との対応（実装ガイドとしての要約）

| 観点 | Claude Code | Codex | Gemini CLI | OpenCode |
|---|---|---|---|---|
| 設定場所 | .mcp.json / ~/.claude.json | config.toml `[mcp_servers.*]` | settings.json `mcpServers` | opencode.json `mcp` |
| トランスポート | stdio/http/sse/ws | stdio(+http) | stdio/sse/streamable-http | local/remote |
| ツールフィルタ | permission hooks統合 | enabled_tools/disabled_tools | includeTools/excludeTools | glob (`my-mcp*`) |
| 承認 | project scopeはapproval+trust dialog | default_tools_approval_mode | trust: true/false | OAuth自動 |
| タイムアウト | 接続/呼び出し別+discovery cache | startup 10s / tool 60s | 既定10分 | 5s(取得時) |

## 9. teapot実装への推奨（設計判断の種）

1. **v1はStreamable HTTPのみ**。2026-07-28はhandshake不要なので実装が最小
   （単一エンドポイントへのPOST + ヘッダ3つ + JSON/SSEパース）。
   stdioはプロセス管理コストがHTTP比で2〜3倍なので後回し
2. **tools/list + tools/callだけ実装すれば価値が出る**。Resources/Prompts/Elicitation/
   Sampling/Tasksはv2以降。Elicitation/Sampling/Rooootsは非推奨ロードマップなので捨てる
3. **ツール名は`mcp__<server>__<tool>`でtoolSpecs()に合流**。既存ツール機構・ログ・UI表示を
   そのまま流用できる
4. **設定はconfig.jsonの`mcpServers`**（Claude Code/Codex/Gemini互換の形にすると
   既存ドキュメントのコピペで動く）。ワークスペース由来の設定はデフォルト不信
   （hooks-design.mdと同じトラストモデル）
5. **includeTools/excludeToolsを初日から**。コンテキスト肥大は実測された最大の実害
6. **web UIで/mcp相当を出す**: 接続状態・ツール数・呼び出し履歴（JSONLに残る）・
   承認待ち一覧。CLI勢にない差別化
7. ツール定義ハッシュの再検証（rug pull対策）は初期から入れる。承認UIとセット
