---
name: Goal Decomposition Tree Architecture
description: 目標逆算ツリー(後ろ向き連鎖)による汎用タスクプランナーの設計仕様。クラフトのみならず採掘・討伐・農業・エンチャント・ボス討伐など全工程を対象とする。
type: project
---

ユーザーが提案したアーキテクチャの仮仕様書を作成済み。

**仕様書パス**: `docs/proposed/ARCH-GOAL-DECOMP-TREE.md`

**Why:** 現状の`material_resolver.js`はバニラクラフトレシピの深さ1逆算のみ。非クラフト手順（採掘ツール要件・mob討伐・農業・経験値・エンチャント）はLLMマクロ依存で不安定。全工程を事前に完全な依存ツリーへ展開し葉から実行する汎用エンジンが必要。

**How to apply:** 将来の実装タスクを受けた際はこの仕様書を参照し、Phase 1（コア基盤）→Phase 2（非クラフト手順）→Phase 3（Forge対応）の順で実装する。現状の`_craftPath`/`preCrafts`挿入パターンはTaskExecutorに置き換えられる予定。

**核心構造**:
- `TaskNode`: type/target/quantity/layer/children/status/constraints/alternates
- `DecompTree`: DAG（重複ノード統合）、チェックポイント保存
- `AcquisitionDB`: `data/acquisition_db.json`（非クラフト取得方法）
- `MetaGoal`: `data/meta_goals.json`（抽象目標の工程定義）
- 新アクション: `plan_and_execute` → `AgentManager` → `TaskPlanner` → `TaskExecutor`
