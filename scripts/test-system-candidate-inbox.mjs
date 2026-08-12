import assert from 'node:assert/strict';
import fs from 'node:fs';
const shared=fs.readFileSync('js/system-candidate-inbox.js','utf8');
assert.match(shared,/system-candidates\?systemId=/);
assert.match(shared,/status: button\.dataset\.candidateStatus/);
assert.doesNotMatch(shared,/addTask|updateTask|publishMission|approveExperiment|activateRule/);
for (const [file,system] of [['mission-page.js','mission'],['health-page.js','health'],['time-attention-page.js','time'],['execution-page.js','execution'],['feedback-page.js','feedback']]) {
  const source=fs.readFileSync(`js/${file}`,'utf8');
  assert.match(source,/system-candidate-inbox\.js/);
  assert.match(source,new RegExp(`mountSystemCandidateInbox\\(app, '${system}'`));
}
console.log('five-system daily candidate inbox tests passed');
