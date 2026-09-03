import assert from 'node:assert/strict';
import { buildCollaborationInbox, systemCollaborationState, summarizePeriodCollaboration } from '../js/hq-collaboration.js';
import { buildSystemReceiptProjection, normalizeSystemReceipt, selectSystemReceipts } from '../js/hq-system-receipts.js';
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
const transportReceipt=normalizeSystemReceipt({id:'receipt-1',intakeId:'intake-1',systemId:'health',reviewDate:'2026-09-03',updatedAt:'2026-09-03T01:00:00Z',status:'processed',freshness:{status:'fresh'},revision:2,projection:{riskLevel:'watch',needsUserInput:true,inputGaps:['sleepHours'],factRefs:['health:fact:1'],candidateBody:'must-not-leak'},data:{secret:'must-not-leak'}},{syncState:{status:'online'}});
assert.equal(transportReceipt.receiptId,'receipt-1');
assert.equal(transportReceipt.intakeRef,'intake-1');
assert.equal(transportReceipt.effectiveDate,'2026-09-03');
assert.equal(transportReceipt.freshness,'fresh');
assert.deepEqual(transportReceipt.inputGaps,['sleepHours']);
assert.ok(!Object.hasOwn(transportReceipt,'projection'));
assert.ok(!Object.hasOwn(transportReceipt,'data'));
const selected=selectSystemReceipts({receipts:[
 {id:'same',systemId:'health',reviewDate:'2026-09-03',revision:1},
 {id:'same',systemId:'health',reviewDate:'2026-09-03',revision:2},
 {id:'other',systemId:'mission',reviewDate:'2026-09-02',revision:9},
]},'2026-09-03');
assert.equal(selected.length,1);
assert.equal(selected[0].revision,2);
const projection=buildSystemReceiptProjection({reviewDate:'2026-09-03',receipts:[transportReceipt]});
assert.ok(projection.groups.do.some((item)=>item.systemId==='health'));
console.log('hq collaboration tests passed');
