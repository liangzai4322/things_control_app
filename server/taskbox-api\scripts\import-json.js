const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const root = path.resolve(__dirname, '..');
const sourceDir = process.argv[2] || path.join(root, 'seed');
const dbPath = process.env.TASKBOX_DB_PATH || path.join(root, 'data', 'taskbox.sqlite');
const now = () => new Date().toISOString();
const json = (value) => JSON.stringify(value ?? null);
const bool = (value) => (value ? 1 : 0);
const readJson = (name) => JSON.parse(fs.readFileSync(path.join(sourceDir, name), 'utf8'));

const db = new Database(dbPath);
db.pragma('foreign_keys = ON');
db.exec(fs.readFileSync(path.join(root, 'schema.sql'), 'utf8'));

const upsertMeta = db.prepare(`
  INSERT INTO app_meta (key, value_json, updated_at)
  VALUES (@key, @value_json, @updated_at)
  ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at
`);

const upsertBox = db.prepare(`
  INSERT INTO boxes (id, name, color, icon, sort_order, is_default, description, created_at, updated_at, raw_json)
  VALUES (@id, @name, @color, @icon, @sort_order, @is_default, @description, @created_at, @updated_at, @raw_json)
  ON CONFLICT(id) DO UPDATE SET
    name=excluded.name, color=excluded.color, icon=excluded.icon, sort_order=excluded.sort_order,
    is_default=excluded.is_default, description=excluded.description, created_at=excluded.created_at,
    updated_at=excluded.updated_at, raw_json=excluded.raw_json
`);

const upsertTask = db.prepare(`
  INSERT INTO tasks (
    id, box_id, content, is_completed, sort_order, priority, weight, points_value, progress,
    due_date, deleted, deleted_at, note, sync_key, completed_at, created_at, updated_at, raw_json
  )
  VALUES (
    @id, @box_id, @content, @is_completed, @sort_order, @priority, @weight, @points_value, @progress,
    @due_date, @deleted, @deleted_at, @note, @sync_key, @completed_at, @created_at, @updated_at, @raw_json
  )
  ON CONFLICT(id) DO UPDATE SET
    box_id=excluded.box_id, content=excluded.content, is_completed=excluded.is_completed,
    sort_order=excluded.sort_order, priority=excluded.priority, weight=excluded.weight,
    points_value=excluded.points_value, progress=excluded.progress, due_date=excluded.due_date,
    deleted=excluded.deleted, deleted_at=excluded.deleted_at, note=excluded.note,
    sync_key=excluded.sync_key, completed_at=excluded.completed_at, created_at=excluded.created_at,
    updated_at=excluded.updated_at, raw_json=excluded.raw_json
`);

const upsertAccount = db.prepare(`
  INSERT INTO points_account (id, title, unit, raw_json, updated_at)
  VALUES ('default', @title, @unit, @raw_json, @updated_at)
  ON CONFLICT(id) DO UPDATE SET title=excluded.title, unit=excluded.unit, raw_json=excluded.raw_json, updated_at=excluded.updated_at
`);

const upsertRules = db.prepare(`
  INSERT INTO points_rules (
    id, default_task_points, point_presets_json, priority_defaults_json, box_color_defaults_json,
    milestone_bonuses_json, raw_json, updated_at
  )
  VALUES (
    'default', @default_task_points, @point_presets_json, @priority_defaults_json, @box_color_defaults_json,
    @milestone_bonuses_json, @raw_json, @updated_at
  )
  ON CONFLICT(id) DO UPDATE SET
    default_task_points=excluded.default_task_points, point_presets_json=excluded.point_presets_json,
    priority_defaults_json=excluded.priority_defaults_json, box_color_defaults_json=excluded.box_color_defaults_json,
    milestone_bonuses_json=excluded.milestone_bonuses_json, raw_json=excluded.raw_json, updated_at=excluded.updated_at
`);

const upsertReward = db.prepare(`
  INSERT INTO points_rewards (id, title, description, cost, category, icon, active, raw_json, updated_at)
  VALUES (@id, @title, @description, @cost, @category, @icon, @active, @raw_json, @updated_at)
  ON CONFLICT(id) DO UPDATE SET
    title=excluded.title, description=excluded.description, cost=excluded.cost, category=excluded.category,
    icon=excluded.icon, active=excluded.active, raw_json=excluded.raw_json, updated_at=excluded.updated_at
`);

const upsertTransaction = db.prepare(`
  INSERT INTO points_transactions (id, bucket, source_type, source_key, title, note, delta, created_at, status, reversed_at, raw_json, updated_at)
  VALUES (@id, @bucket, @source_type, @source_key, @title, @note, @delta, @created_at, @status, @reversed_at, @raw_json, @updated_at)
  ON CONFLICT(id) DO UPDATE SET
    bucket=excluded.bucket, source_type=excluded.source_type, source_key=excluded.source_key, title=excluded.title,
    note=excluded.note, delta=excluded.delta, created_at=excluded.created_at, status=excluded.status,
    reversed_at=excluded.reversed_at, raw_json=excluded.raw_json, updated_at=excluded.updated_at
`);

const upsertFloor = db.prepare(`
  INSERT INTO sw_floors (realm, floor_id, name, description, difficulty, total_count, dimension_summary_json, raw_json, updated_at)
  VALUES (@realm, @floor_id, @name, @description, @difficulty, @total_count, @dimension_summary_json, @raw_json, @updated_at)
  ON CONFLICT(realm, floor_id) DO UPDATE SET
    name=excluded.name, description=excluded.description, difficulty=excluded.difficulty,
    total_count=excluded.total_count, dimension_summary_json=excluded.dimension_summary_json,
    raw_json=excluded.raw_json, updated_at=excluded.updated_at
`);

const upsertSwItem = db.prepare(`
  INSERT INTO sw_items (
    realm, floor_id, item_id, title, description, tags_json, types_json, narrative_line, triangle_json,
    dimension, difficulty, reward_tier, priority, progress, is_completed, completed_at, sort_order, raw_json, updated_at
  )
  VALUES (
    @realm, @floor_id, @item_id, @title, @description, @tags_json, @types_json, @narrative_line, @triangle_json,
    @dimension, @difficulty, @reward_tier, @priority, @progress, @is_completed, @completed_at, @sort_order, @raw_json, @updated_at
  )
  ON CONFLICT(realm, item_id) DO UPDATE SET
    floor_id=excluded.floor_id, title=excluded.title, description=excluded.description, tags_json=excluded.tags_json,
    types_json=excluded.types_json, narrative_line=excluded.narrative_line, triangle_json=excluded.triangle_json,
    dimension=excluded.dimension, difficulty=excluded.difficulty, reward_tier=excluded.reward_tier,
    priority=excluded.priority, progress=excluded.progress, is_completed=excluded.is_completed,
    completed_at=excluded.completed_at, sort_order=excluded.sort_order, raw_json=excluded.raw_json, updated_at=excluded.updated_at
`);

function importTaskbox() {
  const data = readJson('taskbox-backup.json');
  const cleanSettings = { ...(data.settings || {}), deepseekApiKey: '', cloudToken: '', githubToken: '', flomoWebhook: '' };
  upsertMeta.run({ key: 'taskbox_settings', value_json: json(cleanSettings), updated_at: now() });
  upsertMeta.run({ key: 'taskbox_meta', value_json: json(data.meta || {}), updated_at: now() });
  for (const box of data.boxes || []) {
    upsertBox.run({
      id: box.id,
      name: box.name || '',
      color: box.color || null,
      icon: box.icon || null,
      sort_order: Number(box.sortOrder ?? box.sort_order ?? 0),
      is_default: bool(box.isDefault),
      description: box.description || null,
      created_at: box.createdAt || null,
      updated_at: box.updatedAt || data.meta?.updatedAt || now(),
      raw_json: json(box),
    });
  }
  for (const task of data.tasks || []) {
    upsertTask.run({
      id: task.id,
      box_id: task.boxId || null,
      content: task.content || '',
      is_completed: bool(task.isCompleted),
      sort_order: Number(task.sortOrder ?? 0),
      priority: Number(task.priority ?? 2),
      weight: Number(task.weight ?? 1),
      points_value: task.pointsValue === null || task.pointsValue === undefined ? null : Number(task.pointsValue),
      progress: Number(task.progress ?? 0),
      due_date: task.dueDate || null,
      deleted: bool(task.deleted),
      deleted_at: task.deletedAt || null,
      note: task.note || null,
      sync_key: task.syncKey || null,
      completed_at: task.completedAt || null,
      created_at: task.createdAt || null,
      updated_at: task.updatedAt || data.meta?.updatedAt || now(),
      raw_json: json(task),
    });
  }
}

function importPoints() {
  const data = readJson('mock-points.json');
  upsertAccount.run({ title: data.account?.title || null, unit: data.account?.unit || null, raw_json: json(data.account || {}), updated_at: now() });
  const rules = data.rules || {};
  upsertRules.run({
    default_task_points: Number(rules.defaultTaskPoints ?? 5),
    point_presets_json: json(rules.pointPresets || []),
    priority_defaults_json: json(rules.priorityDefaults || {}),
    box_color_defaults_json: json(rules.boxColorDefaults || {}),
    milestone_bonuses_json: json(rules.milestoneBonuses || []),
    raw_json: json(rules),
    updated_at: now(),
  });
  upsertMeta.run({ key: 'points_meta', value_json: json(data.meta || {}), updated_at: now() });
  for (const reward of data.rewards || []) {
    upsertReward.run({
      id: reward.id,
      title: reward.title || '',
      description: reward.description || null,
      cost: Number(reward.cost ?? 0),
      category: reward.category || null,
      icon: reward.icon || null,
      active: reward.active === false ? 0 : 1,
      raw_json: json(reward),
      updated_at: now(),
    });
  }
  for (const tx of data.transactions || []) {
    upsertTransaction.run({
      id: tx.id,
      bucket: tx.bucket || (Number(tx.delta || 0) >= 0 ? 'earn' : 'spend'),
      source_type: tx.sourceType || null,
      source_key: tx.sourceKey || null,
      title: tx.title || '',
      note: tx.note || null,
      delta: Number(tx.delta ?? 0),
      created_at: tx.createdAt || now(),
      status: tx.status || 'active',
      reversed_at: tx.reversedAt || null,
      raw_json: json(tx),
      updated_at: now(),
    });
  }
}

function importSmallWorld(name, realm) {
  const data = readJson(name);
  const floors = data.treasure_vault || data.floors || data.tower || [];
  for (const floor of floors) {
    const isPavilion = realm === 'pavilion';
    const floorId = Number(isPavilion ? floor.level : floor.floor);
    const items = isPavilion ? (floor.items || []) : (floor.tasks || []);
    const floorRaw = { ...floor };
    delete floorRaw.items;
    delete floorRaw.tasks;
    upsertFloor.run({
      realm,
      floor_id: floorId,
      name: isPavilion ? floor.level_name : floor.floor_name,
      description: isPavilion ? floor.level_description : floor.floor_desc,
      difficulty: isPavilion ? null : (floor.difficulty || null),
      total_count: Number(floor.total_tasks ?? floor.tasks_count ?? items.length),
      dimension_summary_json: json(floor.dimension_summary || null),
      raw_json: json(floorRaw),
      updated_at: now(),
    });
    items.forEach((item, index) => {
      upsertSwItem.run({
        realm,
        floor_id: floorId,
        item_id: item.id || `${realm}-${floorId}-${index + 1}`,
        title: isPavilion ? (item.title || '') : (item.name || ''),
        description: isPavilion ? (item.description || '') : (item.desc || item.description || ''),
        tags_json: json(item.tags || []),
        types_json: json(item.types || []),
        narrative_line: item.narrative_line || null,
        triangle_json: json(item.triangle || null),
        dimension: item.dimension || null,
        difficulty: item.difficulty || null,
        reward_tier: item.reward_tier === undefined ? null : Number(item.reward_tier),
        priority: item.priority || null,
        progress: Number(item.progress ?? 0),
        is_completed: bool(item.isCompleted),
        completed_at: item.completedAt || null,
        sort_order: index,
        raw_json: json(item),
        updated_at: now(),
      });
    });
  }
}

const tx = db.transaction(() => {
  importTaskbox();
  importPoints();
  importSmallWorld('pavilion.json', 'pavilion');
  importSmallWorld('tower.json', 'tower');
});

tx();

const counts = {
  boxes: db.prepare('SELECT COUNT(*) AS n FROM boxes').get().n,
  tasks: db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n,
  rewards: db.prepare('SELECT COUNT(*) AS n FROM points_rewards').get().n,
  transactions: db.prepare('SELECT COUNT(*) AS n FROM points_transactions').get().n,
  floors: db.prepare('SELECT COUNT(*) AS n FROM sw_floors').get().n,
  swItems: db.prepare('SELECT COUNT(*) AS n FROM sw_items').get().n,
};
db.close();

console.log(JSON.stringify({ ok: true, dbPath, sourceDir, counts }));
