# 目標逆算ツリー (Goal Decomposition Tree) アーキテクチャ仕様書

**ステータス**: 仮仕様（実装前）  
**作成日**: 2026-04-27 / 改訂: 2026-04-27 v0.3  

---

## 0. 根本的設計方針

### 問題の再定義

「LLMがMODを知らない」問題を解決しようとするのが間違いである。
正しい問いは：**「MODの仕様をゲーム自体から直接読み取れないか？」**

Minecraft/Forgeはプロトコルレベルで大量の情報をクライアントに送信している。
LLMに知識を持たせる必要はない——**ゲームが既に知っていることをシステムが学ぶ**。

### 4つの受動的情報源

| 情報源 | 取得できる情報 | 実現性 |
|---|---|---|
| `declare_recipes` パケット | 全MODレシピグラフ（どの素材→何を使って→何が作れる） | 高 |
| `block.harvestTools` / `bot.canDigBlock()` | 任意ブロックに対する適合ツールの正確な判定 | 高（既存） |
| `window_items` + `gui_snapshot.js` | 任意MOD機械のスロット構成の経験的学習 | 高（既存） |
| aux_mod + ブロック状態監視 | マルチブロック構造の観察・記録 | 中 |

---

## 1. 受動的情報収集システム（Passive Knowledge Harvest）

### 1.1 `declare_recipes` パケット傍受

**現状**: `declare_recipes` はバイパスリスト（`restBuffer`）に入っており、パース前にスキップされている（`bot_actuator.js:86`）。しかしパケット自体は**受信されている**。

**解法**: バイパス設定の**前**にrawパケットリスナーを登録し、バイト列を直接解析する。

#### なぜこれでMODレシピが取れるのか

Minecraftの`declare_recipes`パケット構造:
```
VarInt: レシピ数
繰り返し:
  String: レシピタイプ  (例: "create:crushing", "minecraft:crafting_shaped")
  String: レシピID     (例: "create:crushing/iron_ingot")
  Bytes:  タイプ固有データ (バニラは既知形式, MODは不定)
```

**MODのタイプ固有データも内部では必ず `namespace:name` 形式の文字列でアイテムIDを保持する**。
UTF-8バイト列として正規表現でスキャンすれば、レシピ構造を完全に知らなくてもアイテムIDを抽出できる。

```javascript
// src/recipe_harvester.js (新規)
function interceptRecipePacket(client) {
    // bypass設定の前に登録することで raw Buffer として受け取る
    client.on('declare_recipes', (packet) => {
        const raw = packet.data ?? packet; // restBufferモード時はBufferが直接来る
        if (!Buffer.isBuffer(raw)) return;
        
        const text = raw.toString('latin1'); // latin1: バイト値保持, UTF-8エラーなし
        
        // namespace:name パターンを全抽出
        // Minecraft名前空間規則: [a-z0-9_.-]+:[a-z0-9_./\-]+
        const nsIds = [...new Set(
            (text.match(/\b([a-z][a-z0-9_.-]{0,31}):([a-z0-9_./\-]{1,63})\b/g) || [])
            .filter(id => !id.startsWith('minecraft:') || isRelevantVanillaId(id))
        )];
        
        // レシピIDパターン: "namespace:type/output_item" → output は '/' 以降
        const recipeIdPattern = /\b[a-z][a-z0-9_.-]*:[a-z0-9_./\-]+\/([a-z0-9_]+)\b/g;
        const outputHints = [...text.matchAll(recipeIdPattern)]
            .map(m => m[1]); // "/" 以降がoutputのヒント
        
        return { rawIds: nsIds, outputHints };
    });
}
```

#### レシピグラフの構築

```javascript
// 抽出した情報からグラフを構築
function buildRecipeGraph(recipeType, recipeId, rawIds) {
    // レシピIDから出力アイテムを推定
    // 例: "create:crushing/iron_ingot" → output = "iron_ingot"
    const outputHint = recipeId.split('/').pop();
    
    // レシピタイプから必要機械を推定
    const machine = RECIPE_TYPE_TO_MACHINE[recipeType] ?? null;
    
    // 入力候補 = rawIds - outputHint - レシピタイプ - レシピID自体
    const inputs = rawIds.filter(id => 
        !id.includes(recipeId) && 
        id !== recipeType &&
        !EXCLUDED_META_IDS.has(id)
    );
    
    return {
        type: recipeType,
        id: recipeId,
        machine,       // null = 手クラフト or 不明
        inputs,        // 入力アイテムID群（順序・数量は不正確だが存在は正確）
        outputHint,    // 出力アイテム名（推定）
        confidence: calculateConfidence(recipeType, rawIds)
    };
}
```

#### `RECIPE_TYPE_TO_MACHINE` マッピング

```json
{
  "create:crushing":    "create:crushing_wheel",
  "create:mixing":      "create:basin",
  "create:pressing":    "create:mechanical_press",
  "create:compacting":  "create:basin",
  "create:cutting":     "create:mechanical_saw",
  "create:deploying":   "create:deployer",
  "thermal:machine":    "thermal:machine_frame",
  "mekanism:combining": "mekanism:combiner",
  "mekanism:crushing":  "mekanism:crusher",
  "mekanism:smelting":  "mekanism:energized_smelter",
  "immersiveengineering:arc_furnace": "immersiveengineering:arc_furnace",
  "minecraft:smelting":  "minecraft:furnace",
  "minecraft:blasting":  "minecraft:blast_furnace",
  "minecraft:smoking":   "minecraft:smoker",
  "minecraft:stonecutting": "minecraft:stonecutter"
}
```

このマッピングは**シード値（初期値）**であり、ゲームプレイ中に拡張される。
未知レシピタイプに対しては後述の経験的コンテナ学習で補完する。

#### 保存先: `data/learned_recipes.json`

```json
{
  "version": 1,
  "learned_at": "2026-04-27T12:00:00Z",
  "recipes": [
    {
      "id": "create:crushing/iron_ingot",
      "type": "create:crushing",
      "machine": "create:crushing_wheel",
      "inputs": ["minecraft:iron_ore", "minecraft:deepslate_iron_ore"],
      "outputHint": "iron_ingot",
      "confidence": 0.85
    }
  ]
}
```

---

### 1.2 ツール能力のランタイム判定（Tool Capability Runtime Oracle）

**現状の強み**: `tools.js:408` で既に `block.harvestTools[item.type]` を使っている。
Mineflayerはサーバーから受信したブロックレジストリを保持しており、これは**MODブロックも含む**。

**解法**: 計画時のツール推定を**完全に廃止**し、実行時判定に一本化する。

```javascript
// src/task_executor.js でのツール解決フロー

async function resolveToolForBlock(block) {
    // 1. 現在装備しているアイテムで採掘可能か？
    if (bot.canDigBlock(block)) return 'current_tool_ok';
    
    // 2. インベントリを走査して使えるツールを探す
    for (const item of bot.inventory.items()) {
        await bot.equip(item, 'hand');
        if (bot.canDigBlock(block)) return 'found_tool';
    }
    
    // 3. 使えるツールがない → レシピグラフからクラフト可能なツールを探す
    //    block.harvestTools には対応 item.type が格納されている
    //    e.g., harvestTools = { "pickaxe": true } → pickaxe系が必要
    const neededType = Object.keys(block.harvestTools || {})[0]; // "pickaxe", "axe"等
    if (neededType) {
        // 4. インベントリ内の最高ティアのツールを使ってもダメ → ティアアップが必要
        //    → TaskPlannerが "craft_upgrade_tool" ノードを動的挿入
        return { action: 'need_craft', toolType: neededType, block: block.name };
    }
    
    // 5. どのツールでも採掘不可（obsidianにwood pickaxeは掘れないがharvestToolsが正しく設定されていれば上で検出）
    return { action: 'impossible', reason: `No tool can harvest ${block.name}` };
}
```

**パクセルなど複合MODツールへの対応**:
`bot.canDigBlock(block)` はMineflayerがサーバー側のゲームデータをもとに計算する。
MODが正しく `block.harvestTools` を設定していれば `item.type = "pickaxe"` の全アイテム（バニラ・MOD問わず）が対象になる。
パクセルのように複数ツールタイプを持つアイテムはForge capabilities経由で登録されるが、Mineflayerの `item.type` フィールドもこれを反映する（Forgeが `getToolTypes()` を通じてパケットに注入するため）。

---

### 1.3 経験的コンテナ学習（Empirical Container Discovery）

**既存インフラ**: `gui_snapshot.js` が既に任意MOD GUIを読める。`slotRole()` がスロット役割を推定する（`gui_snapshot.js:160`）。

**新規追加**: 未知機械のスロットレイアウトを**自動テストで発見**する。

```javascript
// src/container_learner.js (新規)

async function discoverContainerLayout(windowType, inputItem) {
    // 既学習済みならスキップ
    if (learnedLayouts[windowType]) return learnedLayouts[windowType];
    
    const snapshot = buildSnapshot(bot); // 既存gui_snapshot.js
    const machineSlots = snapshot.slots.filter(s => !s.role.startsWith('player_'));
    
    const inputSlots = [];
    const outputSlots = [];
    
    for (const slot of machineSlots) {
        // アイテムが既に入っているスロットはスキップ（出力候補）
        if (slot.item) { outputSlots.push(slot.index); continue; }
        
        // 各空スロットにアイテムを挿入してみる
        const before = readAllSlots(bot.currentWindow);
        await bot.clickWindow(slot.index, 0, 0); // クリック（アイテムをカーソルに持った状態）
        await sleep(500);
        const after = readAllSlots(bot.currentWindow);
        
        const changed = findChangedSlots(before, after);
        if (changed.filled.length > 0) {
            // 別のスロットが埋まった → そこが出力スロット
            outputSlots.push(...changed.filled);
            inputSlots.push(slot.index);
        }
    }
    
    const layout = { windowType, inputSlots, outputSlots, discoveredAt: Date.now() };
    learnedLayouts[windowType] = layout;
    saveLearnedLayouts(); // data/learned_container_layouts.json
    return layout;
}
```

**対応範囲**: Create Mechanical Press, かまど系全般, 醸造台, エンチャント台, Thermal/Mekanism機械, 未知の全コンテナ型MOD機械。

**対応不可能なもの**: スロットに直接アイテムを置く形式でない機械（エネルギー/液体/ガスのみを扱うもの）。これらは別途aux_mod観察で対応（後述）。

---

### 1.4 aux_mod マルチブロック構造観察

Createのコントラプション、ImmersiveEngineeringの複合機械など、**3D配置が必要な構造物**への対応。

#### aux_mod側の追加実装

```java
// aux_mod/src/main/java/com/forgeaip/auxmod/client/StructureObserver.java (新規)

@Mod.EventBusSubscriber(modid = AuxMod.MODID, bus = Mod.EventBusSubscriber.Bus.FORGE, value = Dist.CLIENT)
public class StructureObserver {
    
    // プレイヤーがブロックを右クリックした際の観察
    @SubscribeEvent
    public static void onRightClick(PlayerInteractEvent.RightClickBlock event) {
        BlockPos pos = event.getPos();
        BlockState state = event.getLevel().getBlockState(pos);
        String blockId = ForgeRegistries.BLOCKS.getKey(state.getBlock()).toString();
        
        // 既知のマルチブロックコントローラーブロックか確認
        if (isKnownMultiblockController(blockId)) {
            captureAndSendStructure(event.getLevel(), pos, blockId);
        }
    }
    
    private static void captureAndSendStructure(Level level, BlockPos center, String controllerBlock) {
        // 5x5x5 範囲のブロック構成を記録
        List<Map<String, Object>> blocks = new ArrayList<>();
        for (int dx = -2; dx <= 2; dx++) {
            for (int dy = -2; dy <= 2; dy++) {
                for (int dz = -2; dz <= 2; dz++) {
                    BlockPos p = center.offset(dx, dy, dz);
                    BlockState bs = level.getBlockState(p);
                    String id = ForgeRegistries.BLOCKS.getKey(bs.getBlock()).toString();
                    if (!id.equals("minecraft:air")) {
                        Map<String, Object> entry = new HashMap<>();
                        entry.put("dx", dx); entry.put("dy", dy); entry.put("dz", dz);
                        entry.put("block", id);
                        entry.put("state", bs.getValues().toString()); // facing等
                        blocks.add(entry);
                    }
                }
            }
        }
        // WebSocket経由でNode.jsに送信
        sendToBot("structure_observed", Map.of("controller", controllerBlock, "blocks", blocks));
    }
}
```

#### Node.js側の受信・保存

```javascript
// 受信した構造データを学習DB に保存
case 'structure_observed':
    const { controller, blocks } = payload;
    learnedStructures[controller] = {
        blocks,
        observedAt: Date.now(),
        source: 'player_observation'
    };
    saveFile('data/learned_structures.json', learnedStructures);
    break;
```

---

## 2. 学習データの階層

ログイン時から順次データが蓄積され、計画精度が向上する。

```
ログイン時 (1回):
  └─ declare_recipes 傍受 → data/learned_recipes.json
  └─ forgeaip_registry.json から known block/item ID

実行中 (随時):
  └─ コンテナ開封時 → data/learned_container_layouts.json
  └─ プレイヤー操作観察 → data/learned_structures.json

蓄積型 (時間とともに精度向上):
  └─ data/taught_procedures.json (ユーザー教示のみ使用)
```

---

## 3. TaskPlanner の改訂（v0.3）

計画時の情報源優先度:

```
1. learned_recipes.json     (declare_recipes から学習した全MODレシピ)
2. procedure_templates.json  (バニラ複雑手順のハードコード)
3. minecraft-data recipes    (バニラクラフト完全DB)
4. acquisition_db.json       (non-craft取得方法 - 小規模)
5. taught_procedures.json    (ユーザー教示)
6. requires_human_teach      (全て失敗時のフォールバック)
```

### 3.1 ツール前提ノードの廃止

v0.2では計画時に `ensure_mining_tool` ノードを挿入していたが、v0.3では廃止する。

```
collect ノード実行時:
  → resolveToolForBlock() を呼ぶ (1.2参照)
  → 適合ツールが見つからない → 動的にサブツリーを挿入
  → ツール取得完了後に collect を再試行

これにより計画時はツール要件を一切考えなくてよい。
plan はシンプルに "collect obsidian" だけを記述する。
```

### 3.2 次元ゲートの自動注入（維持）

v0.2の `injectDimensionGates()` は維持。
`require_dimension` フラグは `learned_recipes.json` のレシピタイプから自動付与できる:

```javascript
// blaze_rod が必要 → blaze は nether にいる → require_dimension: "nether" を自動付与
if (acquisitionDb[item]?.dimension) {
    node.require_dimension = acquisitionDb[item].dimension;
}
```

---

## 4. 解決できる範囲の正直な評価（v0.3）

| MODコンテンツ | 対応可能か | 方法 |
|---|---|---|
| 任意MODのクラフトレシピ | **~85%** | declare_recipes パケット + 正規表現抽出 |
| MODのかまど/精錬系機械 | **~90%** | recipe_type_to_machine + container_learner |
| 任意ブロックのツール要件 | **~95%** | bot.canDigBlock() (ランタイム) |
| MODツールの能力判定 | **~90%** | item.type + canDigBlock (Forge caps経由) |
| Create Pressなどシンプル機械 | **~80%** | container_learner (経験的スロット発見) |
| マルチブロック構造物 | **~60%** | aux_mod structure observer (要プレイヤー操作1回) |
| 電力/動力チェーン設計 | **~20%** | ブロック状態監視 + 部分的構造解析のみ |
| Create コントラプション動的挙動 | **解決困難** | サーバー側計算 → クライアントからは不透明 |
| 完全未知MOD機械（初回） | **50%** | container_learner が自動テスト |

**残る20%**: 電力チェーン・液体系統・動的コントラプション。これらはサーバー側で計算されクライアントには結果のブロック状態しか届かない。現段階では `requires_human_teach` に委ねる。

---

## 5. アーキテクチャ全体図（v0.3）

```
┌──────────────────────────────────────────────────────────────┐
│                  ログイン時の受動的収集                        │
│  declare_recipes(raw) → RecipeHarvester                       │
│                              ↓                                │
│                    learned_recipes.json                       │
└──────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌──────────────────────────────────────────────────────────────┐
│                      TaskPlanner                             │
│  入力: "goal_text", current_inventory                        │
│  参照: learned_recipes > procedure_templates > minecraft-data│
│  出力: DecompTree (ツール前提なし、次元ゲートあり)            │
└──────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌──────────────────────────────────────────────────────────────┐
│                      TaskExecutor                            │
│  collect → resolveToolForBlock() → bot.canDigBlock()         │
│  machine → ContainerLearner.discoverLayout()                 │
│  multiblock → learnedStructures or aux_mod observe           │
│  unknown → requires_human_teach                              │
└──────────────────────────────────────────────────────────────┘
                                │ EXECUTE_ACTION (IPC)
                                ▼
                         bot_actuator.js (既存)
```

---

## 6. 新規ファイル一覧（v0.3）

```
新規作成:
  src/recipe_harvester.js          ← declare_recipes バイト解析
  src/container_learner.js         ← 経験的コンテナスロット発見
  src/task_planner.js              ← GoalMatcher + 逆算ツリー構築
  src/task_executor.js             ← 葉→根実行 + 動的ツール解決
  
  data/learned_recipes.json        ← ログイン時に自動生成・更新
  data/learned_container_layouts.json  ← 実行中に学習
  data/learned_structures.json     ← aux_mod観察から学習
  data/recipe_type_machine_map.json ← recipe_type→機械マッピング (シード+学習)
  data/procedure_templates.json    ← バニラ手順テンプレート（人手管理）
  data/taught_procedures.json      ← ユーザー教示蓄積
  
  aux_mod: StructureObserver.java  ← マルチブロック構造観察

変更:
  src/bot_actuator.js              ← bypass前にRecipeHarvesterを登録
  src/agent_manager.js             ← plan_and_execute アクション
  src/actuator/tools.js            ← ensureToolFor: canDigBlock連携強化
```

---

## 7. 実装フェーズ（v0.3）

### Phase 1: RecipeHarvester + TaskPlanner基盤（最も価値が高い）
- `declare_recipes` パケット傍受・バイト解析
- `learned_recipes.json` の生成
- TaskPlanner: learned_recipes + minecraft-data を参照するGoalMatcher
- バニラエンチャントテーブル作成の end-to-end 動作確認

### Phase 2: TaskExecutor + ランタイムツール解決
- TaskExecutor: 葉→根実行 + 動的サブツリー挿入
- `resolveToolForBlock()` 実装
- `plan_and_execute` アクションをagent_managerに追加

### Phase 3: ContainerLearner
- `gui_snapshot.js` 活用の経験的スロット発見
- `learned_container_layouts.json` 蓄積
- MOD機械への `task_executor` 対応

### Phase 4: aux_mod StructureObserver + TeachDB
- マルチブロック構造観察
- `requires_human_teach` フロー実装
