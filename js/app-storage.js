const EXACT_REFRESH_KEYS = new Set([
  'taskbox_data',
  'taskbox_points_cache',
  'taskbox_hq_cache_v1',
  'taskbox_api_sync_state_v1',
  'taskbox_mission_os_v1',
  'taskbox_mission_sync_v1',
  'taskbox_health_energy_os_v1',
  'taskbox_health_energy_protocol_v1',
  'taskbox_time_attention_os_v1',
]);

const REFRESH_KEY_PREFIXES = [
  'taskbox_api_mutation_outbox_v1',
  'taskbox_api_mutation_dead_letters_v1',
];

export function isTaskboxRefreshStorageKey(key = '') {
  return EXACT_REFRESH_KEYS.has(key)
    || REFRESH_KEY_PREFIXES.some((prefix) => key === prefix || key.startsWith(`${prefix}:`));
}

export function createStorageRefreshScheduler({
  delay = 80,
  invalidate = () => {},
  refresh = () => {},
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let timer = null;
  let shouldInvalidate = false;

  return (key) => {
    if (!isTaskboxRefreshStorageKey(key)) return false;
    shouldInvalidate ||= key === 'taskbox_data';
    if (timer !== null) clearTimer(timer);
    timer = setTimer(() => {
      timer = null;
      if (shouldInvalidate) invalidate();
      shouldInvalidate = false;
      refresh();
    }, delay);
    return true;
  };
}
