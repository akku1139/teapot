# teapot 🫖

**複数のAIコーディングエージェントを、ブラウザから常駐・並列運用する軽量ハーネス**

> 5分で試す → [クイックスタート](#-クイックスタート) · 詳細は[リファレンス](#-リファレンス)へ

---

## 🚀 クイックスタート

### 1. インストール

Node.js **24以上**が必要です。

```sh
npm install -g teapot-coding-agent
```

### 2. 設定ファイルを書く

```sh
mkdir -p ~/.config/teapot-coding-agent
nano ~/.config/teapot-coding-agent/config.json
```

**最小構成**(OpenRouterの例 — 他プロバイダは下の表へ):

```json
{
  "providers": {
    "openrouter": {
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKey": "sk-or-あなたのキー",
      "model": "anthropic/claude-sonnet-4"
    }
  },
  "defaultProvider": "openrouter",
  "agents": [
    { "id": "main", "workspace": "/home/you/my-project" }
  ]
}
```

雛形をコピーして編集してもOK:
[`teapot.config.example.json`](teapot.config.example.json)

### 3. 起動

```sh
teapot
```

→ **http://localhost:7788** を開くだけ。

### 4. 使う

- 左パネルの `#main` をクリック
- 下の入力欄に日本語で指示(例: 「このバグを直してテストも通して」)
- エージェントがファイル読み書き・bash実行・テストを自走します

| 操作 | 方法 |
|---|---|
| ターミナル | `t` |
| 右パネル(ゴール/進捗/runtime) | `d` |
| コマンド一覧 | 入力欄で `/` |
| エージェント中断 | `Esc` |

---

## 🤔 これは何?

1行でいうと: **「OpenAI互換APIを使って、複数の自律コーディングAIをブラウザから常駐運用するサーバー」**

```text
├─ agent: android  ── ~/projects/android-app
├─ agent: kernel   ── ~/projects/kernel
└─ agent: web      ── ~/projects/film-sims-web
```

各エージェントは独立したワークスペースを持ち、Discord風UIのチャンネルとして並列稼働します。Claude CodeやCodex CLIのラッパーではなく、**teapot自身がエージェントループ(read_file / edit_file / apply_patch / bash / read_url / メモリ / スキル)を実装**しています。

### どんな時に使う?

- 「このリポジトリのバグを全部潰してテスト通るまで直して」のような**長時間自走タスク**
- プロジェクトごとに**別モデル**を使い分け(重い作業はSonnet、レビューはローカルQwen等)
- 進捗・ゴール・タスクを**ブラウザで監視**しながら別作業をする

### 既存ツールとの違い

| | teapot | Claude Code等のCLI |
|---|---|---|
| 形態 | 常駐サーバー+Web UI | 対話型CLI |
| 複数エージェント | ✅ 同時並列 | 基本1セッション |
| モデル混在 | ✅ エージェント毎に指定 | 固定 |
| 長時間継続 | ✅ JSONLログから自動復元 | セッション切替時の手順が必要 |
| 定期タスク(cron) | ✅ 15秒tick | ❌ |

---

## 🔧 主な機能

<details>
<summary><b>ゴール & 自律ループ</b>(クリックで展開)</summary>

ゴールを設定すると auto-continue がラウンド終了後も継続判断し、完了報告(`finish`)にはオプションで**検証契約+独立監査**を挟めます:

```text
ゴール: 「認証モジュールにアカウント削除機能を追加」
verify: 「npm test が全件通る / READMEにエンドポイント追記」
         ↓ finish時
独立監査 → approved なら done / changes-required ならギャップを指摘して再開
```

</details>

<details>
<summary><b>サブエージェント</b></summary>

`@persona タスク` のメンションでサブエージェントをspawn。親の会話をfork参照できるのでプレフィックスキャッシュが温かいまま。`wait_children` で子の完了を待機し、完了レポートが親のタイムラインに届きます。ネスト上限は `maxSpawnDepth`(既定3)。

</details>

<details>
<summary><b>メモリ / タスクリスト / スキル</b></summary>

- **memory.md** — エージェントの永続メモ(set_memory / get_memory)
- **todo.md** — オペレーターと共有するチェックリスト。項目単位の更新APIあり
- **skills** — 定型手順のプレイブック。グローバル(`~/.config/teapot-coding-agent/skills/`)またはワークスペース単位で保存され、ワークスペース版が優先

</details>

<details>
<summary><b>定期タスク(cron)</b></summary>

```json
{ "tasks": [{ "id": "nightly", "agent": "main",
              "schedule": "0 3 * * *", "prompt": "git statusとテスト結果を確認して報告" }] }
```

</details>

<details>
<summary><b>統合ターミナル</b></summary>

`t` でエージェントのワークスペース内に対話シェル(xterm.js over WebSocket)。PTYはutil-linux `script` 経由(無ければplain pipe)。ネイティブ依存ゼロ。

</details>

<details>
<summary><b>ファイルツリー & プレビュー/編集</b></summary>

右パネルの 🗂 files からワークスペースを閲覧。コードはshikiシンタックスハイライト、`.md` はレンダープレビュー、画像/動画/音声はインライン再生、テキストはその場で編集して保存(競合時は409で検知)。

</details>

<details>
<summary><b>コンテキスト管理</b></summary>

トークン予算(既定: ウィンドウの75%、未指定時96k)を超えると古いターンをLLM要約で圧縮。ゴール/メモリ/スキルは別ファイル保持なので、サーバー再起動や翌日の再開でも文脈が生きます。

</details>

---

## ⚠️ セキュリティ(読んでください)

エージェントは `bash` とファイル書き換えを持つため、`rm` や `npm install` も実行できます。

- **専用Linuxユーザーでの運用を想定**しています
- 渡す前に `git commit` しておくのが安全
- workspace外へのファイル操作は制限されます(safeJoin)
- 既定ではlocalhostのみlisten。LAN公開する場合は **必ず** `--host 0.0.0.0` と同時に `TEAPOT_API_TOKEN`(またはconfigの `password`)を設定

```sh
TEAPOT_API_TOKEN=mysecret teapot --host 0.0.0.0 --port 7788
```

---

<a id="-リファレンス"></a>
## 📖 リファレンス

<details>
<summary><b>設定リファレンス</b></summary>

| キー | 既定 | 説明 |
|---|---|---|
| `port` | 7788 | listenポート(env `TEAPOT_PORT`, CLI `--port/-p`) |
| `host` | 127.0.0.1 | bind アドレス(env `TEAPOT_HOST`, CLI `--host`; `0.0.0.0`=LAN公開) |
| `dataDir` | `~/.local/share/teapot-coding-agent` | セッションログ等(env `TEAPOT_DATA_DIR`) |
| `providers.<name>` | — | `{ baseUrl, apiKey, model? }` のOpenAI互換エンドポイント |
| `defaultProvider` | — | agent未指定時のプロバイダ |
| `agents[].id` | 必須 | URLキー兼表示名 |
| `agents[].workspace` | 必須 | 作業ディレクトリ |
| `agents[].provider` / `model` | 既定値 | エージェント個別の上書き |
| `agents[].contextWindowTokens` | 自動推定 | モデルのコンテキスト窓(UIゲージ・compact派生に使用) |
| `agents[].readOnly` | false | trueで書き込み系ツールを封印 |
| `agents[].autoContinue` | true | ラウンド後にゴールへ継続 |
| `contextTokenBudget` | 派生 | compact開始閾値(k単位ではない生トークン数). null/未設定=75%派生を推奨 |
| `maxSpawnDepth` | 3 | サブエージェントのネスト上限 |
| `password` | — | API認証(env `TEAPOT_API_TOKEN` が優先) |
| `tasks[]` | — | cronタスク `{ id, agent, schedule, prompt }` |

設定の探索順: CLI引数 → `$TEAPOT_CONFIG` → `~/.config/teapot-coding-agent/config.json` → `./teapot.config.json`

</details>

<details>
<summary><b>複数プロバイダの併用</b></summary>

```jsonc
{
  "providers": {
    "openrouter": { "baseUrl": "https://openrouter.ai/api/v1", "apiKey": "sk-or-..." },
    "local":      { "baseUrl": "http://localhost:8080/v1", "apiKey": "llama.cpp" }
  },
  "defaultProvider": "openrouter",
  "agents": [
    { "id": "coder",    "workspace": "~/proj", "model": "anthropic/claude-sonnet-4" },
    { "id": "reviewer", "workspace": "~/proj", "provider": "local" }
  ]
}
```

OpenAI互換なら何でもOK: OpenRouter / OpenAI / Ollama / vLLM / llama.cpp。
OpenRouter宛にはアプリ帰属ヘッダ(`HTTP-Referer` 等)を自動付与。

モデルのコンテキスト窓は起動時に `/v1/models` から自動推定され、runtimeパネルの使用率ゲージとcompact派生に反映されます(手動上書きも可)。

</details>

<details>
<summary><b>HTTP API</b></summary>

```
GET  /api/agents                        一覧
POST /api/agents                        作成 { workspace, id?, provider?, model?, start? }
GET  /api/agents/:id/events?limit=300   イベント( ?before=<id> で上方ページング )
GET  /api/agents/:id/branches           ブランチ一覧
GET  /api/agents/:id/file?path=         テキスト取得
PUT  /api/agents/:id/file?path=         保存 { content, baseContent? } (競合は409)
GET  /api/agents/:id/raw?path=          メディア生データ
GET  /api/agents/:id/tree               ファイルツリー
POST /api/agents/:id/prompt             送信 { text, start? } → { promptId }
POST /api/agents/:id/prompt/cancel      取り消し { promptId } (送達済みは409)
POST /api/agents/:id/goal               { text?, status?, verify? }
POST /api/agents/:id/start|stop|fork|load
DELETE /api/agents/:id                  削除(ログは保持)
GET  /api/metrics                       RSS / heap / loadavg
WS   /api/ws                            全イベントのライブ配信
```

全APIは任意のBearer認証対象です。

</details>

<details>
<summary><b>セッションログ(JSONL)形式</b></summary>

人間が `cat`/`jq` で読める追記-onlyのJSONLです:

```jsonl
{"v":1,"id":"e1","type":"prompt","data":{"source":"user","text":"..."}}
{"v":1,"id":"e2","type":"tool_call","data":{"callId":"…","name":"bash","argsRaw":"…"}}
{"v":1,"id":"e3","type":"tool_result","data":{"callId":"…","ok":true,"durationMs":117}}
{"v":1,"id":"e4","type":"message","data":{"role":"assistant","content":"…"}}
```

各イベントは `parent` で前イベントに連結され、フォークは分岐点を共有します。
`sessions/<agent>-<uuid>/goal.md` `memory.md` `todo.md` も同ディレクトリに保存。

</details>

<details>
<summary><b>開発(リポジトリから)</b></summary>

```sh
pnpm install
pnpm dev            # TSをネイティブ実行
pnpm dev-web        # Vite HMR(別terminal)
pnpm test           # node --test
pnpm build          # tsc + vite build → dist/ + public/
```

構成: `src/master.ts`(起動・cron・config) / `src/agent/`(ループ・ツール) /
`src/server/api.ts`(Hono REST+WS) / `frontend/`(SolidJS) / `test/`(node:test)

</details>

---

## License

AGPL-3.0-or-later — [LICENSE](LICENSE)
