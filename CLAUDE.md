# Resolume MCP Server — Project Context

## 概要
Resolume Arena/Avenue VJ ソフトウェアを Claude などの LLM から自然言語で操作するための MCP サーバー。

## アーキテクチャ

```
LLM (Claude) <--stdio--> MCP Server (Node.js) ──HTTP/WS─→ Resolume Web Server (8080)
                                              ──UDP/OSC─→ Resolume OSC IN/OUT (7000/7001)
```

Resolume の Web Server は Preferences > Web Server で有効化可能。デフォルトで `http://127.0.0.1:8080` を listen。
OSC は Preferences > OSC で有効化。MCP は OSC IN port (default 7000) に送信、OSC OUT port (default 7001) を listen。

## ディレクトリ構成

```
resolume-mcp-server/
├── src/
│   ├── index.ts                    # stdio エントリポイント
│   ├── config.ts                   # 環境変数からの設定ロード
│   ├── resolume/
│   │   ├── client.ts               # 高レベルファサード (validation, summary)
│   │   ├── rest.ts                 # 型付き REST クライアント (fetch + abort)
│   │   ├── osc-codec.ts            # OSC 1.0 encoder/decoder (deps なし)
│   │   ├── osc-client.ts           # stateless UDP send/query/subscribe/probe
│   │   └── types.ts                # Zod スキーマ + TS 型
│   ├── tools/
│   │   ├── types.ts                # ToolDefinition + ToolResult 型
│   │   ├── index.ts                # 全ツール集約 (型消去)
│   │   ├── composition/get-composition.ts
│   │   ├── clip/{trigger,select,get-thumbnail}.ts
│   │   ├── layer/{set-opacity,clear-layer}.ts
│   │   └── osc/{send,query,subscribe,status}.ts
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

## OSC 補完面 (v0.4)

REST/WS では実装できない or 効率が悪いことを OSC で補う。

- **Wildcard クエリ**: `/composition/layers/*/clips/1/name` 一発で全レイヤーの最初のクリップ名を取れる。REST だと N 回の GET が必要。
- **Real-time playhead push**: `/composition/layers/*/clips/*/transport/position` を OSC OUT で受けると毎フレーム届く(~325 msg/s 実測)。REST はスナップショット限定。time-based VJing の心臓部。
  - ⚠️ transport/position は **clip レベル**(`layers/N/clips/M/transport/position`)。`layers/N/transport/position`(clips抜き)は**存在しない** — 0マッチで silent fail する。
  - 観測される実アドレス(live verified, 4s capture, 2911 msgs): `/composition/layers/N/position`(レイヤー位置), `/composition/layers/N/clips/M/transport/position`(クリップ再生位置), `/composition/selectedclip/transport/position`(選択中クリップ — bonus)
  - OSC `*` ワイルドカードは **セグメント境界限定**(OSC 1.0仕様)。`/a/*/b` は OK だが `/a/*` で `/a/b/c` は NG。
  - **playhead value は正規化 0..1**(REST の `transport.position.value` は ms — 単位が違う)
- **`/composition/tempocontroller/resync` 等のトリガー**: Swagger に載っていない隠しパスがある。`resolume_osc_send` で叩ける。
- **低レイテンシ**: UDP fire-and-forget なので REST より一桁速い。

### OSC でできないこと(全 API 横断で確認済み)

- **FFT / オーディオレベル**: Resolume の音響解析は内部処理で外部公開なし。
- **パラメータ単位の "BPM 同期" トグル**: composition の `clipbeatsnap` (set_beat_snap ツール) と clip 単位の `transport/controls/syncmode` だけが BPM 同期の窓口。

### 実装上の注意

- `osc-client.ts` は完全に stateless。各呼び出しでソケット生成→クローズ。常駐リスナーは持たない(ユーザーが別の OSC ツールを 7001 にバインドしているケースを壊さないため)。
- `resolume_osc_subscribe` は OSC OUT port を排他バインドする → 既に占有されていれば EADDRINUSE。`resolume_osc_status` で先にプローブ可。
- 注意: `/composition/tempocontroller/tempo` への OSC 値送信は **正規化 0..1** 値。BPM の生数値を送ると min..max にスケールされて壊れる(REST と挙動が違う)。Resolume の OSC は ParamRange を 0..1 で扱う規約。

## Skill maintenance

このリポジトリは Claude Code 用 skill (`skills/resolume-mcp-tester/SKILL.md`) を同梱している。skill 内の「Tool catalog」と `(N tools)` カウントは、サーバが公開するツール一覧の **正本コピー** として扱う。

**ルール**: ツールを 1 つ追加・削除・改名するときは、同じコミットで `src/tools/index.ts` と `skills/resolume-mcp-tester/SKILL.md` を両方更新する。skill 側の更新内容:

1. 該当ドメインの bullet list にツール名を追加/削除する(短縮形 `verb_object` でよい — sync スクリプトが `resolume_` プレフィックスを補って照合する)。
2. `(36 tools)` のような件数 callout を新しい数値に更新する。
3. silent-no-op や white-out リスクなど、live test で発見した運用上の落とし穴があれば該当セクション(Recipe / Critical safety rules)に追記する。

**強制機構**: `scripts/check-skill-sync.mjs` が `npm run check:skill-sync` および `prepublishOnly` で走る。コードと skill が乖離していれば exit 1 で publish が止まる。コミット前に手動でも `node scripts/check-skill-sync.mjs` を回しておく。新規 contributor 向けの詳細チェックリストは `CONTRIBUTING.md` を参照。

## 参考リンク

- 公式 REST API ドキュメント: https://resolume.com/support/en/restapi
- OpenAPI ドキュメント: http://localhost:8080/api/v1 (Resolume 起動中のみ)
- WebSocket API: https://resolume.com/support/en/websocket-api
- Bitfocus Companion module(動作リファレンス): https://github.com/bitfocus/companion-module-resolume-arena
