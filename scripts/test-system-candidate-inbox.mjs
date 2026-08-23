import assert from 'node:assert/strict';
import fs from 'node:fs';
const shared=fs.readFileSync('js/system-candidate-inbox.js','utf8');
assert.match(shared,/system-candidates\?systemId=/);
assert.match(shared,/status: button\.dataset\.candidateStatus/);
assert.doesNotMatch(shared,/addTask|updateTask|publishMission|approveExperiment|activateRule/);
for (const [file,system] of [['mission-page.js','mission'],['time-attention-page.js','time'],['execution-page.js','execution'],['feedback-page.js','feedback']]) {
  const source=fs.readFileSync(`js/${file}`,'utf8');
  assert.match(source,/system-candidate-inbox\.js/);
  assert.match(source,new RegExp(`mountSystemCandidateInbox\\(app, '${system}'`));
}
const healthSource=fs.readFileSync('js/health-page.js','utf8');
assert.doesNotMatch(healthSource,/mountSystemCandidateInbox/,'health uses the health fact intake as its only manual gate');
assert.match(healthSource,/健康事实待确认/);
console.log('five-system daily candidate inbox tests passed');
