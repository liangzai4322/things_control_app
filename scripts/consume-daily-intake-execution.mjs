import { spawnSync } from 'node:child_process';
import { DAILY_INTAKE_FAILURE_EVENT_KEY, createDailyIntakeConsumerFromEnv, dailyIntakeReviewDate } from '../integrations/execution-system/daily-intake-consumer.mjs';

function notifyFailure(code) {
  const client = '/Users/ylw/.codex/skills/notification-hub/scripts/notification_client.py';
  const body = `执行日省 intake 消费者失败：${code}。未写入 TaskBox 任务；请检查专用 intake 身份、共享底座与 receipt outbox。`;
  return spawnSync(process.env.PYTHON || 'python3', [client, 'send', '--source', 'execution-system', '--event-key', DAILY_INTAKE_FAILURE_EVENT_KEY, '--level', 'B', '--title', '日省执行消费者需要处理', '--body', body], { encoding: 'utf8' });
}

try {
  const summary = await createDailyIntakeConsumerFromEnv().run({ reviewDate: process.env.DAILY_INTAKE_REVIEW_DATE || dailyIntakeReviewDate(), limit: Number(process.env.DAILY_INTAKE_LIMIT || 20) });
  console.log(JSON.stringify({ ok: !summary.authBlocked && !summary.deadLetters, ...summary }));
  if (summary.paused) process.exitCode = 0;
  if (summary.authBlocked || summary.deadLetters) {
    notifyFailure(summary.authBlocked ? 'daily_intake_auth_blocked' : 'daily_intake_dead_letter'); process.exitCode = 1;
  }
} catch (error) {
  const code = String(error?.code || 'daily_intake_runner_failed').replace(/[^a-z0-9_.-]/gi, '_').slice(0, 120);
  if (code === 'daily_intake_api_disabled') {
    console.log(JSON.stringify({ ok: true, paused: true, reason: code, eventKey: DAILY_INTAKE_FAILURE_EVENT_KEY })); process.exitCode = 0;
  } else {
  notifyFailure(code); console.log(JSON.stringify({ ok: false, error: code, eventKey: DAILY_INTAKE_FAILURE_EVENT_KEY })); process.exitCode = 1;
  }
}
