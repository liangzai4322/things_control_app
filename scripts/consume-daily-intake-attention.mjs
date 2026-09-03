import path from 'node:path';
import { attentionRunnerHealth, runAttentionIntakeCycle } from '../integrations/attention-system/daily-intake-runner.mjs';

const credentialFile = process.env.CREDENTIALS_DIRECTORY ? path.join(process.env.CREDENTIALS_DIRECTORY, 'attention.token') : undefined;
const options = {
  endpoint: process.env.DAILY_INTAKE_API_ENDPOINT || undefined,
  tokenFile: process.env.DAILY_INTAKE_TOKEN_FILE || credentialFile,
  disableFile: process.env.DAILY_INTAKE_DISABLE_FILE || undefined,
  stateFile: process.env.ATTENTION_INTAKE_STATE_FILE || undefined,
};
Object.keys(options).forEach((key) => options[key] === undefined && delete options[key]);
const healthOnly = process.argv.includes('--health');
const result = healthOnly ? attentionRunnerHealth(options) : await runAttentionIntakeCycle(options);
console.log(JSON.stringify(result));
if (!healthOnly && !result.ok) process.exitCode = 1;
