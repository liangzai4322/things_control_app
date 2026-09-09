import { spawnSync } from 'node:child_process';
import { DAILY_INTAKE_FAILURE_EVENT_KEY, createDailyIntakeConsumerFromEnv } from '../integrations/execution-system/daily-intake-consumer.mjs';

function notifyFailure(code) {
  return spawnSync(process.env.PYTHON || 'python3', [
    '/Users/ylw/.codex/skills/notification-hub/scripts/notification_client.py', 'send', '--source', 'execution-system',
    '--event-key', DAILY_INTAKE_FAILURE_EVENT_KEY, '--level', 'B', '--title', '日省执行消费者健康检查失败',
    '--body', `执行日省 intake 健康检查失败：${code}。未写入 TaskBox 任务；请检查专用 intake 身份、共享底座与 receipt outbox。`,
  ], { encoding: 'utf8' });
}

try {
  const health = await createDailyIntakeConsumerFromEnv().healthcheck();
  console.log(JSON.stringify(health)); process.exitCode = health.ok ? 0 : 1;
} catch (error) {
  const code = String(error?.code || 'daily_intake_healthcheck_failed').replace(/[^a-z0-9_.-]/gi, '_').slice(0, 120);
  if (code === 'daily_intake_api_disabled') {
    console.log(JSON.stringify({ ok: true, paused: true, reason: code, eventKey: DAILY_INTAKE_FAILURE_EVENT_KEY })); process.exitCode = 0;
  } else {
    notifyFailure(code); console.log(JSON.stringify({ ok: false, error: code, eventKey: DAILY_INTAKE_FAILURE_EVENT_KEY })); process.exitCode = 1;
  }
}
