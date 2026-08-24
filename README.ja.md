# teapot 🫖

**OpenAI互換APIを使って、複数の自律コーディングAIをブラウザから常駐・並列運用する軽量ハーネス**

> 5分で試す → [クイックスタート](#-クイックスタート) · 詳細は[リファレンス](#-リファレンス)

[English README](README.md)

---

## 🚀 クイックスタート

### 1. インストール

Node.js **24以上** が必要です。

```sh
npm install -g teapot-coding-agent
```

### 2. 設定ファイルを書く

```sh
mkdir -p ~/.config/teapot-coding-agent
nano ~/.config/teapot-coding-agent/config.json
```

**最小構成**(OpenRouterの例 — 他プロバイダは[リファレンス](#-リファレンス)へ):

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

雛形をコピーしてもOK: [`teapot.config.example.json`](teapot.config.example.json)

### 3. 起動

```sh
teapot
```

→ **http://localhost:7788** を開くだけ。

### 4. 使う

- 左パネルの `#main` をクリック
- 入力欄に日本語で指示(例: 「このバグを直してテストも通して」)
- エージェントがファイル読み書き・bash実行・テストを自走します

| 操作 | 方法 |
|---|---|
| ターミナル | `t` |
| 右パネル(ゴール/進捗/runtime) | `d` |
| コマンド一覧 | 入力欄で `/` |
| エージェント中断 | `Esc` |

---

## 🤔 これは何?

**「このリポジトリのバグ全部調べて、テスト通るまで直して」のような長時間自走タスクを、プロジェクトごとに並列で走らせるための箱**です。

```text
├─ agent: android  ── ~/projects/android-app
├─ agent: kernel   ── ~/projects/kernel
└─ agent: web      ── ~/projects/film-sims-web
```

各エージェントは独立したワークスペースを持ち、Discord風UIのチャンネルとして動きます。Claude CodeやCodex CLIのラッパーではなく、**teapot自身がエージェントルーループ(read_file / edit_file / apply_patch / bash / read_url / memory / skills)を実装**しています。

### 特徴

| | teapot | Claude Code等のCLI |
|---|---|---|
| 形態 | 常駐サーバー + Web UI | 対話型CLI |
| 複数エージェント | ✅ 同時並列 | 基本1セッション |
| モデル混在 | ✅ エージェント毎に指定 | 固定 |
| 長時間継続 | ✅ JSONLログから自動復元 | 手動でのセッション管理が必要 |
| 定期タスク(cron) | ✅ 15秒tick | ❌ |

エージェントには以下が使えます:

- ファイル読み書き / 複数ファイルへのパッチ適用(apply_patch)
- bash実行(git / build / test)
- Webページ読み取り(read_url)
- Goal(長期目標+自動継続+完了監査) · Memory · Todo · Skills
- サブエージェント spawn(`@persona タスク`)
- 定期タスク(例: 「毎30分 git statusとテストを確認して報告」)

---

## ⚠️ セキュリティ(読んでください)

エージェントは `bash` とファイル書き換え権限を持つため、`rm` や `npm install` も実行できます。

- **専用Linuxユーザーでの運用を想定**しています
- 大事なリポジトリは渡す前に `git commit` しておくのが安全
- workspace外のファイル操作は制限されます(safeJoin)
- 既定ではlocalhost限定listen。LAN公開する場合は **必ず** `--host 0.0.0.0` と同時に `TEAPOT_API_TOKEN`(またはconfigの `password`)を設定:

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
| `host` | 127.0.0.1 | bindアドレス(env `TEAPOT_HOST`, CLI `--host`; `0.0.0.0`=LAN公開) |
| `dataDir` | `~/.local/share/teapot-coding-agent` | セッションログ等(env `TEAPOT_DATA_DIR`) |
| `providers.<name>` | — | `{ baseUrl, apiKey, model? }` のOpenAI互換エンドポイント |
| `defaultProvider` | — | agent未指定時のプロバイダ |
| `agents[].id` | 必須 | URLキー兼表示名 |
| `agents[].workspace` | 必須 | 作業ディレクトリ |
| `agents[].provider` / `model` | 既定値 | エージェント個別の上書き |
| `agents[].contextWindowTokens` | 自動推定 | コンテキスト窓(UIゲージ・compact派生に使用) |
| `agents[].readOnly` | false | trueで書き込み系ツールを封印 |
| `agents[].autoContinue` | true | ラウンド後にゴールへ継続 |
| `contextTokenBudget` | 派生 | compact開始閾値(トークン数)。null/未設定=75%派生を推奨 |
| `maxSpawnDepth` | 3 | サブエージェントのネスト上限 |
| `password` | — | API認証(env `TEAPOT_API_TOKEN` が優先) |
| `tasks[]` | — | cronタスク `{ id, agent, schedule, prompt }` |

設定の探索順: CLI引数 → `$TEAPOT_CONFIG` → `~/.config/teapot-coding-agent/config.json` → `./teapot.config.json`

env上書き: `TEAPOT_PORT` `TEAPOT_API_KEY` `TEAPOT_BASE_URL` `TEAPOT_MODEL` `TEAPOT_CONFIG_DIR` `TEAPOT_DATA_DIR`

</details>

<details>
<summary><b>複数モデルの混在(teapotらしい使い方)</b></summary>

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
openrouter.ai 宛にはアプリ帰属ヘッダを自動付与。

モデルのコンテキスト窓は起動時に `/v1/models` から自動推定され、runtimeパネルの使用率ゲージとcompact派生に反映されます。

</details>

<details>
<summary><b>コンテキスト管理(長時間作業の仕組み)</b></summary>

トークン予算(既定: ウィンドウの75%、不明時96k)を超えると、古いターンをLLM要約で圧縮します。Goal/Memory/Todoは別ファイル保持なので:

```text
1日目: 調査 → 修正 → テスト失敗 → 別アプローチ → サーバー再起動
2日目: 続きから再開
```

という運用ができます。いわば「常駐する開発担当AI」です。

</details>

<details>
<summary><b>HTTP API</b></summary>

```
GET  /api/agents                        一覧
POST /api/agents                        作成 { workspace, id?, provider?, model?, start? }
GET  /api/agents/:id/events?limit=300   イベント( ?before=<id> で上方ページング )
GET  /api/agents/:id/branches           ブランチ一覧
GET  /api/agents/:id/file?path=         テキスト取得
PUT  /api/agents/:id/file?path=         保存 { content, baseContent? } (競合409)
GET  /api/agents/:id/raw?path=          メディア生データ
GET  /api/agents/:id/tree               ファイルツリー
POST /api/agents/:id/prompt             送信 { text, start? } → { promptId }
POST /api/agents/:id/prompt/cancel      取り消し { promptId } (送達済みは409)
POST /api/agents/:id/goal               { text?, status?, verify? }
POST /api/agents/:id/start|stop|fork|load
DELETE /api/agents/:id                  削除(ログ保持)
GET  /api/metrics                       RSS / heap / loadavg
WS   /api/ws                            ライブイベント配信
```

全APIは任意のBearer認証に対応。

</details>

<details>
<summary><b>セッションログ(JSONL)</b></summary>

`cat`/`jq` で読める追記-only JSONL:

```jsonl
{"v":1,"id":"e1","type":"prompt","data":{"source":"user","text":"..."}}
{"v":1,"id":"e2","type":"tool_call","data":{"callId":"…","name":"bash","argsRaw":"…"}}
{"v":1,"id":"e3","type":"tool_result","data":{"callId":"…","ok":true,"durationMs":117}}
{"v":1,"id":"e4","type":"message","data":{"role":"assistant","content":"…"}}
```

各イベントは `parent` で連結、フォークは分岐点を共有。`goal.md` `memory.md` `todo.md` も同ディレクトリに保存されます。

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

構成: `src/master.ts`(起動/cron/config) · `src/agent/`(ループ/ツール) ·
`src/server/api.ts`(Hono REST+WS) · `frontend/`(SolidJS) · `test/`(node:test)

</details>

---

## License

AGPL-3.0-or-later — [LICENSE](LICENSE)
