# Resolume MCP Server — Project Context

## 概要
Resolume Arena/Avenue VJ ソフトウェアを Claude などの LLM から自然言語で操作するための MCP サーバー。

## アーキテクチャ

```
LLM (Claude) <--stdio--> MCP Server (Node.js) <--HTTP--> Resolume Web Server
```

Resolume の Web Server は Preferences > Web Server で有効化可能。デフォルトで `http://127.0.0.1:8080` を listen。

## ディレクトリ構成

```
resolume-mcp-server/
├── src/
│   ├── index.ts                    # stdio エントリポイント
│   ├── config.ts                   # 環境変数からの設定ロード
│   ├── resolume/
│   │   ├── client.ts               # 高レベルファサード (validation, summary)
│   │   ├── rest.ts                 # 型付き REST クライアント (fetch + abort)
│   │   └── types.ts                # Zod スキーマ + TS 型
│   ├── tools/
│   │   ├── types.ts                # ToolDefinition + ToolResult 型
│   │   ├── index.ts                # 全ツール集約 (型消去)
│   │   ├── composition/get-composition.ts
│   │   ├── clip/{trigger,select,get-thumbnail}.ts
│   │   └── layer/{set-opacity,clear-layer}.ts
│   ├── server/
│   │   └── registerTools.ts        # SDK サーバーへのツール登録 + エラー整形
│   └── errors/
│       └── types.ts                # ResolumeError tagged union + マッパー
└── tests are colocated as *.test.ts next to source
```

## 設計原則

### 1. ハンドラ → ファサード → REST の3層分離
- ツールハンドラは `ResolumeClient` ファサードのメソッドだけ呼ぶ。生 fetch は触らない。
- `ResolumeClient` が Zod パース + 1-based インデックス検証を担当。
- `ResolumeRestClient` は HTTP 実装の詳細(タイムアウト, abort, content-type)を吸収。

### 2. エラーは LLM が自己修復可能な形に
- `ResolumeApiError` の `detail` は tagged union で `kind` を持つ。
- 各 kind は `hint` フィールドに次にすべきことを書く。
- `mapHttpError(path, status, body)` と `mapNetworkError(path, err)` で正規化。
- ツール側では throw → `safeHandle` が JSON で `isError: true` 付き結果に変換。

### 3. 破壊的操作は明示確認
- `clear_layer` のような破壊的ツールは `confirm: true` 引数必須。
- Boolean を受けるだけでなく、説明欄で「ユーザーが明示的にクリアを指示したときだけ true」と LLM に教える。

### 4. ツール命名規則
- 全ツール `resolume_` プレフィックス。他 MCP との衝突回避。
- 単数の `verb_object` 形式: `resolume_trigger_clip`, `resolume_set_layer_opacity`。
- 引数は 1-based のレイヤー/クリップインデックス(Resolume UI に合わせる)。

## テスト戦略

- **境界モック**: `fetch` を `vi.fn` で差し替えて HTTP I/O を切る。実 Resolume なしでテスト可。
- **ツールテスト**: `ResolumeClient` を vi mock したコンテキストでハンドラ単体検証。
- **登録テスト**: `server.tool` を fake してツールが正しく登録されることを確認。
- **カバレッジ**: vitest の v8 provider で 80% 閾値強制(branches/functions/lines/statements)。

## 開発フロー

```bash
npm install            # 依存導入
npm run build          # tsc コンパイル
npm test               # テスト一発実行
npm run test:watch     # ファイル変更で再実行
npm run test:coverage  # 閾値チェック付きカバレッジ
npm run dev            # tsc --watch
```

ローカル動作確認:
1. Resolume Arena/Avenue を起動
2. Preferences > Web Server > Enable Webserver & REST API を ON
3. `npm run build && npm start` で stdio サーバー起動
4. Claude Desktop の `claude_desktop_config.json` で `command: node, args: ["<repo>/build/index.js"]` を追加

## 既知の Resolume API のクセ(参考)

- 非 ASCII クリップ名で REST API が壊れるエンドポイントがある(将来 v0.2 でツール側で警告検出予定)
- `POST` 系の一部はレスポンスを返さないことがある → 楽観的成功扱い + タイムアウト設計
- `/api/v1/product` は 7.x 後期で追加。古いバージョンでは 404 → `null` で吸収

## 参考リンク

- 公式 REST API ドキュメント: https://resolume.com/support/en/restapi
- OpenAPI ドキュメント: http://localhost:8080/api/v1 (Resolume 起動中のみ)
- WebSocket API: https://resolume.com/support/en/websocket-api
- Bitfocus Companion module(動作リファレンス): https://github.com/bitfocus/companion-module-resolume-arena
