import assert from 'node:assert/strict';
import { buildCollaborationInbox, systemCollaborationState, summarizePeriodCollaboration } from '../js/hq-collaboration.js';
const systems=[
 {systemId:'health',name:'健康与能量',health:'unknown',accessLevel:'L1',highestSignal:'尚无快照'},
 {systemId:'mission',name:'使命系统',health:'healthy',accessLevel:'L1'},
 {systemId:'time',name:'时间与注意力',health:'stale',accessLevel:'L1',highestSignal:'超过36小时'},
];
assert.equal(systemCollaborationState(systems[0],2).tone,'candidate');
assert.equal(systemCollaborationState(systems[1],0).label,'正式状态正常');
const inbox=buildCollaborationInbox({systems,candidateCounts:{health:2},brief:{},tasks:[]});
assert.ok(inbox.some((x)=>x.id==='health-candidates'));
assert.ok(inbox.some((x)=>x.id==='time-stale'));
assert.ok(!inbox.some((x)=>x.id==='health-empty'));
const period=summarizePeriodCollaboration({systems,periodType:'week'});
assert.equal(period.ready,false);
assert.deepEqual(period.missingSystems,['health','time']);
console.log('hq collaboration tests passed');
