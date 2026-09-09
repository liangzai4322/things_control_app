import assert from 'node:assert/strict';
import { buildMissionSyncPayload } from '../js/mission-store.js';
import { publishMissionVersion } from '../js/mission-model.js';

const draft = {
  missionId: 'mission-sync-test', statement: '建立可持续人生系统',
  campaign: { campaignId: 'campaign-sync-test', title: '跑通云端使命闭环', whyNow: '避免浏览器单点故障', successConditions: ['跨设备可读'], exitConditions: ['同步冲突无法审计'], reviewAt: '2026-09-23' },
  portfolio: {}, constraints: [], nonNegotiables: [], notDoing: [],
};
const published = publishMissionVersion({ draft }, [], { sourceAuthority: 'explicit_user', now: new Date('2026-08-23T08:00:00Z') });
const payload = buildMissionSyncPayload(published.store, {});

assert.equal(payload.records.length, 2);
assert.equal(payload.records[0].recordType, 'draft');
assert.equal(payload.records[1].recordType, 'version');
assert.equal(payload.records[1].payload.approval.sourceAuthority, 'explicit_user');
assert.equal(payload.events.length, published.events.length);
assert.equal(payload.records.every((item) => item.expectedRevision === 0), true);

const revised = buildMissionSyncPayload(published.store, {
  'record:mission-sync-test': 3,
  'record:mission-sync-test:v1': 1,
});
assert.equal(revised.records[0].expectedRevision, 3);
assert.equal(revised.records[1].expectedRevision, 1);

console.log('mission sync tests passed');
