# Terragrunt Diagram & Trace

[![CI](https://github.com/LanZBoY/terragrunt-diagram-trace/actions/workflows/ci.yml/badge.svg)](https://github.com/LanZBoY/terragrunt-diagram-trace/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[English](README.md) | **繁體中文**

一個 VS Code 擴充套件，掃描 Terragrunt 專案、繪製其 **引用關係圖**，並讓你 **直接跳到被引用的檔案**。

> **純靜態分析。** 本擴充從不執行 `terragrunt` / `terraform`，只讀取 `.hcl` 檔，並用 WebAssembly
> HCL parser（[`@cdktf/hcl2json`](https://www.npmjs.com/package/@cdktf/hcl2json)）解析。
> 不呼叫任何 CLI、不碰 state、不 apply 任何東西。

## 畫面截圖

> _截圖 / GIF 放這裡 —— 按 **F5** 開啟 Extension Development Host（載入 `fixtures/sample-infra/`）
> 擷取後放到 `media/screenshots/`。_

| 引用關係圖 | 點擊跳轉 |
| --- | --- |
| _`media/screenshots/graph.png`_ | _`media/screenshots/jump.gif`_ |

## 功能

### 1. 引用關係圖（互動式 webview）
執行 **`Terragrunt: Show Dependency Graph`** 開啟以 Cytoscape 由上而下（dagre）佈局的關係圖，
視覺化五種 Terragrunt 引用關係，每種有不同的邊樣式：

| 邊 | 意義 | 樣式 |
| --- | --- | --- |
| `dependency` | `dependency "x" { config_path = … }` — 資料依賴 + 執行順序 | 藍色實線 |
| `dependencies` | `dependencies { paths = […] }` — 僅執行順序 | 灰色虛線 |
| `include` | `include { path = find_in_parent_folders(…) }` — 設定繼承 | 紫色點線 |
| `source` | `terraform { source = … }` — Terraform module | 綠色實線 |
| `read` | `read_terragrunt_config(…)` — 讀取另一個 config 的值（如 account/region 的 locals） | 黃色虛線 |

未解析 / 遠端的邊（例如 `git::` module source，或由執行期值組成的 `config_path`）會畫成
**紅色虛線**，並指向菱形的「external」節點。

- **聚焦模式** —— **點一下節點** 只顯示它的鄰域（N 跳以內的關係），讓大圖仍可讀。在工具列選擇深度
  （*neighbors / 2 hops / all linked*）；**Show all** 清除聚焦。被聚焦的節點以黃色外框標示。
- **點兩下節點** 開啟其底層檔案（並在樹中顯示）。點兩下遠端 source 節點會在瀏覽器開啟該 module
  的文件/repo。
- **工具列** 也可依類型篩選邊、fit 視圖、重跑佈局。
- 顏色跟隨你目前的 VS Code 主題（亮 / 暗 / 高對比）。

### 2. 快速跳到被引用的檔案
- **Cmd/Ctrl+點擊**（或 hover → 點擊）任何引用即可跳過去：`config_path`、`dependencies` 的
  `paths[]` 項目、`include` 路徑（字面值 **或** `find_in_parent_folders("root.hcl")`——整個呼叫都可
  點），以及 `terraform.source`。**本機** source 會開啟 module 檔；**遠端** source（git / GitHub /
  GitLab / Bitbucket / Terraform Registry）會在瀏覽器開啟其文件/repo。由 `DocumentLinkProvider` 提供。
- `find_in_parent_folders(...)` 呼叫在 **任何出現的位置** 都可點 —— 包含 `locals` 區塊裡的
  `read_terragrunt_config(...)` 內 —— `read_terragrunt_config("…")` 字面值亦同。（導航時也會退而求其次
  做同目錄比對，所以像 `root.hcl` 旁邊的 `region.hcl` 這種同層 config 仍可點，即使 `find_in_parent_folders`
  在真正的 Terragrunt 裡只往上找。）
- 對同樣的字串可用 **F12 / 跳到定義 / Peek**，由 `DefinitionProvider` 提供。
- **在 `.hcl` 檔按右鍵**（編輯器或檔案總管）→ **Show Related Modules in Graph** 開啟聚焦於該檔關係的
  圖，或 **Show Dependency Graph** 開啟整張圖。聚焦檢視也可在引用樹中對某個 unit 按右鍵取得。
- 相對路徑相對於檔案自身目錄解析；dependency 目錄會開啟其 `terragrunt.hcl`；本機 module source 會開啟其
  `main.tf`（或顯示資料夾）。

### 3. 引用樹（Activity Bar）
**Terragrunt Trace** 檢視列出每個 unit，依關係分組（*Dependencies / Run-order / Includes / Source /
Reads config*）。點葉子節點即可跳到目標。遠端 source 顯示 ☁ 圖示；未解析的引用顯示 `?`。

### 4. Hover 與自動補全
- **Hover** 任何引用（`config_path`、`source`、`include` / `read` 路徑）即可預覽目標：它的
  workspace 相對路徑；若是 dependency，還會顯示目標 unit 的 `source`、依賴數，以及其 module 宣告的
  **outputs**。Hover 一個本機 `source` 會列出該 module 的 outputs 與 variables。
- **自動補全**（打 `.`）—— 依情境，且 **完全靜態**（名稱來自 module 的 `output` / `variable` 宣告與
  `mock_outputs`，絕不讀 state）：
  - `dependency.<name>.outputs.` → 該 dependency 指向 module 的 outputs ∪ 它的 `mock_outputs` keys。
  - `dependency.` → 本檔宣告的 dependency 名稱；選一個會插入 `<name>.outputs.` 並重開補全清單，讓你直接
    挑選 output（dependency 引用幾乎都是 `.outputs.<field>`）。
  - `local.` → 本檔的 locals；`local.<x>.locals.` → 透過 `read_terragrunt_config` 讀進 `local.<x>`
    的那個 config 的 locals keys。

## 開始開發

```bash
npm install
npm run compile      # 建置 dist/extension.js + media/graph.js
```

按 **F5**（使用 `.vscode/launch.json`）開啟 Extension Development Host，會載入內建的
`fixtures/sample-infra/` 專案，接著：

- 在 Activity Bar 開啟 **Terragrunt Trace** 檢視，或
- 從命令面板執行 **`Terragrunt: Show Dependency Graph`**，或
- 在任一 `dev/*/terragrunt.hcl` 裡 Cmd/Ctrl+點擊一個路徑。

## 測試

單元 + 整合測試以 [vitest](https://vitest.dev) 執行，針對 `fixtures/sample-infra/` 驗證 parser、
resolver 與圖建構器 —— 仍是 **純靜態分析**，不呼叫 `terragrunt` / `terraform` CLI。

```bash
npm test           # 跑一次
npm run test:watch # watch 模式
npm run coverage   # 文字摘要 + coverage/ 內的 HTML 報告
```

CI（`.github/workflows/ci.yml`）在每次 push / PR 跑型別檢查、測試套件，並打包 VSIX —— 結果會以
**Vitest Report** check 發佈、coverage 上傳為 build artifact。推送版本 tag（`v*`）會建置 VSIX 並透過
`.github/workflows/release.yml` 附到 GitHub Release。

## 可解析的內容

resolver 會靜態求值路徑欄位中常見的 Terragrunt 函式：

- `find_in_parent_folders()` / `find_in_parent_folders("name.hcl")` —— 嚴格往上找，以 workspace
  資料夾為邊界。
- `get_terragrunt_dir()`、`get_original_terragrunt_dir()`、`get_repo_root()`、
  `get_path_to_repo_root()`。
- `get_parent_terragrunt_dir()`、`path_relative_to_include()`、`path_relative_from_include()`
  （best-effort，從解析出的 `include` 推導）。
- `${local.x}` 且其值在同一檔內是字面字串。
- `read_terragrunt_config(...)` 會被索引成一條 **`read`** 關係，指向它讀取的 config（如 `account.hcl`
  / `region.hcl`），在圖與樹中皆可導航。
- `${local.x.locals.y}` 且 `local.x = read_terragrunt_config(<檔>)` **寫在同一檔** —— 會載入那個檔的
  locals，使值能跨檔解析（這正是「由共用 locals 組成的 module source」仍能解析出具體 URL 的原因）。

真正只有執行期才知道的內容（`dependency.x.outputs.y`、`get_env(...)`、`run_cmd(...)`、registry/遠端
module source）會顯示為 **未解析 / 遠端** 節點，而非用猜的。透過 `include` merge 繼承來的 locals
**不會** 被展平，所以來自父層 root config 的 `${local.x}` 仍視為動態。

## 格式錯誤的檔案

每個 `.hcl` 檔獨立解析，所以單一壞檔不會弄壞其餘的圖。真正的 HCL **語法錯誤**（例如未閉合的區塊）會被
*呈現*，而非用猜的：

- **打字當下即時** 標示（不需存檔）—— 出錯的行會有紅波浪，並在 **Problems** 面板列出行/列（當 hcl2json
  有提供時），
- 該 unit 也會出現在 **引用樹** 中，帶 ⚠ 圖示與 tooltip 內的錯誤訊息，
- 當檔案正在編輯、暫時無效時，它會 **保留上次成功解析的索引** —— 導航、hover、補全與它在圖上的關係都還在，
  不會消失，
- 若 `dependency.<name>.outputs.<field>` 的 `<field>` 不是該 module 宣告的 output（也不在 `mock_outputs`
  裡），會給一個 **warning** —— 但僅在 module 能於本機解析時；遠端 / 動態 source 不處理，因為其 outputs
  無法靜態得知，
- 其餘專案照常渲染。

語法正確、但引用為遠端或執行期動態的內容會正常渲染，那些邊畫成未解析（紅色虛線）而非直接捨棄。

## 設定

| 設定 | 預設值 | 說明 |
| --- | --- | --- |
| `terragruntTrace.scan.exclude` | `**/.terragrunt-cache/**`、`**/.terraform/**`、`**/node_modules/**`、`**/.git/**` | 掃描 `.hcl` 檔時要排除的 glob。 |
| `terragruntTrace.rootConfigName` | `terragrunt.hcl` | `find_in_parent_folders()` 不帶參數時預設找的檔名。若你的 root config 慣例是 `root.hcl` 就設成它。 |

## 架構

```
src/
  core/
    parser.ts     用 @cdktf/hcl2json 解析 terragrunt.hcl → 攤平的 refs + locals
    resolve.ts    解析 config_path / paths / include / source → 絕對路徑
    scanner.ts    走訪 workspace，建立 node/edge 圖模型
    model.ts      共用模型型別
  providers/
    navProvider.ts   DocumentLink + Definition（Cmd+Click / F12）
    treeProvider.ts  Activity Bar TreeDataProvider
  webview/
    panel.ts      webview 生命週期 + 訊息傳遞
  shared/graph.ts  extension host 與 webview 共用的型別
media/
  graph.ts        Cytoscape + dagre 繪圖（打包成 graph.js 供 webview 使用）
```

`@cdktf/hcl2json` 刻意 **不打包**（它透過 `__dirname` 載入 WASM blob）；它會以未打包形式隨 VSIX 一起放在
`node_modules`。詳見 `esbuild.js` 與 `.vscodeignore`。

## 限制

- 依賴解析是靜態、best-effort 的；過於動態的路徑會報為未解析，而非用猜的。
- 透過 `include` merge 從父層繼承的 `dependency`/`source` 區塊不會被展平 —— 只顯示每個檔案自己寫的引用。

## 授權

MIT —— 見 [LICENSE](LICENSE)。
