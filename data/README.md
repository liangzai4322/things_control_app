# Small World Data Files

This directory contains the two data source files for the 小世界 (Small World) feature.

## Files

| File | Feature | Chinese Name |
|---|---|---|
| `pavilion.json` | Treasure Pavilion reward pool | 珍宝阁 · 因果台 |
| `tower.json` | Tower of God-Devouring challenge pool | 弑神塔 · 天劫台 |

---

## pavilion.json — Reward Vault Schema

Top-level structure:
{
  "treasure_vault": [ <LevelObject>, ... ]   // Array of 8 reward levels
}

### LevelObject

| Field              | Type            | Description |
|--------------------|-----------------|-------------|
| level              | integer (1–8)   | Reward tier. 1 = rarest/hardest to unlock; 8 = most accessible. |
| level_name         | string          | Display name of this tier (e.g., "混沌至宝·封印层"). |
| level_description  | string          | Narrative description of this tier's emotional tone and unlock context. Shown in the floor info popover. |
| items              | array           | List of reward items at this level. |

### RewardItemObject (items[])

| Field          | Type            | Description |
|----------------|-----------------|-------------|
| id             | string          | Unique ID, format: L{level}_{index} (e.g., L1_001). |
| title          | string          | Display title of the reward. Shown as the result card title after spinning. |
| types          | array<string>   | Experiential category tags. Rendered as #tag in the result card. |
| narrative_line | string / null   | Named story arc this reward belongs to, or null if standalone. |
| triangle       | object          | Cost/effort ratings: { money: 1–5, time: 1–5, energy: 1–5 }. |
| description    | string          | Full narrative description of the reward activity. Shown as the result card body. |

### triangle object

| Sub-field | Type          | Description |
|-----------|---------------|-------------|
| money     | integer (1–5) | Financial cost. 1=minimal, 5=significant. |
| time      | integer (1–5) | Time investment. 1=minutes, 5=days. |
| energy    | integer (1–5) | Physical/mental energy. 1=passive, 5=demanding. |

---

## tower.json — Challenge Tower Schema

Top-level structure:
{
  "treasure_vault": [ <FloorObject>, ... ]   // Array of 8 floors
}

### FloorObject

| Field             | Type            | Description |
|-------------------|-----------------|-------------|
| floor             | integer (1–8)   | Floor number. 1 = hardest/top; 8 = easiest/bottom. |
| floor_name        | string          | Display name shown on the tower building and floor header. |
| floor_desc        | string          | Flavor/narrative description. Shown as the body of the floor info popover. |
| difficulty        | string          | Human-readable difficulty label. Shown as the subtitle of the floor info popover. |
| total_tasks       | integer         | Total task count on this floor. Should equal tasks.length. |
| tasks             | array           | List of challenge tasks on this floor. |
| dimension_summary | object          | Count of tasks per life dimension. Keys are dimension names, values are integers. |

### TaskObject (tasks[])

| Field       | Type          | Description |
|-------------|---------------|-------------|
| id          | string        | Unique ID, format: F{floor}-{dim_code}-{index} (e.g., F8-HP-01). |
| name        | string        | Short display name of the task. Shown as the result card title after spinning. |
| dimension   | string        | Life dimension this task belongs to (one of 8 fixed values, see below). |
| desc        | string        | Full description of what the user must do. Shown as the result card body. |
| tags        | array<string> | Behavioral/effort tags. Rendered as #tag in the result card. |
| reward_tier | integer       | Matches the floor number. Indicates which pavilion reward level this task unlocks. |

### Dimension values (8 fixed strings)

- 健康与体魄 (Health & Physical Fitness)
- 事业与职业 (Career & Work)
- 财务与理财 (Finance & Wealth)
- 家庭与情感 (Family & Relationships)
- 人际与社会 (Social & Interpersonal)
- 成长与学习 (Growth & Learning)
- 生活品质与环境 (Quality of Life & Environment)
- 精神与心理 (Mind & Psychology)

---

## Cross-File Relationship

A task completed on tower floor N unlocks one reward redemption from pavilion level N.

tower.json                        pavilion.json
──────────────────                ─────────────────────
FloorObject (floor: 5)            LevelObject (level: 5)
  └─ TaskObject                     └─ RewardItemObject[]
       reward_tier: 5  ──────────►       (user picks one to redeem)

---

## Narrative Arcs (珍宝阁 only)

Four story arcs run through pavilion rewards. A reward's narrative_line field indicates its arc position:

| Arc Name        | Theme                              | Entry (level 4) | Endpoint (level 1–2) |
|-----------------|------------------------------------|-----------------|----------------------|
| 身体边界线       | Pushing physical limits            | ·入口            | ·终点                |
| 向内凝视线       | Introspection & self-awareness     | ·入口            | ·终点                |
| 闯入陌生世界线   | Entering unfamiliar environments   | ·入口            | ·终点                |
| 关系深度线       | Deepening meaningful relationships | ·入口            | ·终点                |
