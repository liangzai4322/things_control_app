import { JsonFileStorage, createMissionDailyIntakeRequest, missionDailyIntakeConfig, runMissionDailyIntake } from '../integrations/mission-system/daily-intake-runner.mjs';

const args = new Set(process.argv.slice(2));
const config = missionDailyIntakeConfig();
const request = createMissionDailyIntakeRequest(config);
const result = await runMissionDailyIntake({
  request, storage: new JsonFileStorage(config.storagePath), lockPath: config.lockPath, healthPath: config.healthPath,
  disabledFiles: config.disabledFiles, probeOnly: args.has('--probe'), requireEmpty: args.has('--require-empty'),
});
console.log(JSON.stringify(result));
