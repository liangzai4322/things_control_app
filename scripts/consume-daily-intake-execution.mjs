import { createDailyIntakeConsumerFromEnv } from '../integrations/execution-system/daily-intake-consumer.mjs';

const consumer = createDailyIntakeConsumerFromEnv();
const receipts = await consumer.consumeAvailable();
console.log(JSON.stringify({ ok: true, receiptCount: receipts.length, statuses: receipts.map((item) => item.status) }));
