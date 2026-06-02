# Backlog

`terragrunt-diagram-trace` 的功能紀錄。已完成的留作對照，待辦依類別整理。

## ✅ 已完成

- **引用關係圖**：`dependency` / `dependencies` / `include` / `source` / `read` 五種關係，
  Cytoscape + dagre，聚焦模式（點節點看鄰域、深度可調、Show all）、依類型篩選、主題跟隨。
- **`read_terragrunt_config` 索引**：成為圖/樹一級關係（含同目錄 fallback）。
- **跨檔 locals**：同檔 `local.x = read_terragrunt_config(<檔>)` 的 `${local.x.locals.y}` 可解析。
- **導航**：Cmd+Click / F12（DocumentLink + Definition）、點節點開檔、引用樹、右鍵
  Show Related Modules（聚焦）/ Show Dependency Graph（全圖）。
- **Hover 預覽**：目標摘要 + 該 module 的 outputs / variables。
- **自動補全**：`dependency.<name>.outputs.`、`dependency.`（順勢接 `.outputs.`）、`local.`、
  `local.<x>.locals.`，完全靜態（來自 module 宣告與 `mock_outputs`）。
- **診斷**：語法錯誤即時紅波浪（不需存檔）、未知 output warning、解析失敗時 last-known-good
  保留索引、樹狀 ⚠ + Problems。
- **工程**：vitest 65 測試、CI（型別檢查 + 測試報告 + vsix artifact）、release workflow、
  中英文 README。

## 🔜 待辦

### 解析 / 正確性
- [ ] **include merge** — 展平從父層 root 繼承的 `dependency` / `source` / `locals`，讓
      `dev/eks` 那種「local 繼承自 root」的 dynamic source 也能解析。
- [ ] **斷掉的引用診斷** — `config_path` / `source` / `include` 指到不存在的路徑時報 warning。
- [ ] **stack 支援** — `terragrunt.stack.hcl`（較新的 Terragrunt stacks）。

### 視覺化
- [ ] **循環依賴偵測** — 找出 dependency 環，圖上高亮 + Problems 報警。
- [ ] **圖匯出** — PNG / SVG / Mermaid / Graphviz DOT。
- [ ] **run order 模擬** — 依 dependency/dependencies 算拓樸排序與平行批次，視覺化 `run-all` 階層。
- [ ] **影響分析 / blast radius** — 選一個 unit，反向高亮「改它會影響誰」。
- [ ] **搜尋 / 篩選列** — 依環境（dev/prod）、區域、模組名稱過濾節點。
- [ ] **分組（compound nodes）** — 依目錄/環境把節點摺疊成群組框。

### 編輯體驗
- [ ] **inputs → module variables 補全** — 在 `inputs = { }` 內補該 unit source module 的
      variables（先前 plan 標 best-effort 暫緩）。
- [ ] **CodeLens** — 在 `dependency` 區塊上方顯示「被 N 個 unit 依賴」/ 跳轉。

### 工程 / 發佈
- [ ] **截圖 / GIF** 放進 README（`media/screenshots/`）。
- [ ] **provider 整合測試** — 以 `@vscode/test-electron` 測 hover / completion / 診斷殼層。
- [ ] **發佈** — 打 tag 發 GitHub Release（已備好 workflow）/ VS Code Marketplace / Open VSX。
- [ ] **GitHub repo 描述 + topics** —（`terragrunt` `terraform` `vscode-extension` `hcl`
      `dependency-graph`），手動於 repo 設定。
