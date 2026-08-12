import { readExecutionHqPort } from './execution-hq-port.js';
import { readFeedbackHqPort } from './feedback-hq-port.js';
import { readHealthHqPort } from './health-hq-port.js';
import { readMissionHqPort } from './mission-hq-port.js';
import { readTimeAttentionHqPort } from './time-attention-hq-port.js';

export function readFiveSystemHqPorts({ tasks = [], boxes = [], mainlines = [], brief = {}, reviewDate, syncState = {}, now = new Date(), storage = localStorage } = {}) {
  const mission = readMissionHqPort({ mainlines, now, storage });
  const health = readHealthHqPort({ now, storage });
  const time = readTimeAttentionHqPort({ tasks, healthSnapshot: health, date: reviewDate, now, storage });
  const execution = readExecutionHqPort({ tasks, boxes, brief, reviewDate, mainlines, syncState, now });
  const feedback = readFeedbackHqPort({ storage });
  return Object.freeze({ mission, health, time, execution, feedback });
}
