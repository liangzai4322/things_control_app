# 五系统 V3 会话 A：Gate 0–3 基线与交接

最后核对：2026-08-11。

> 本文保留会话 A 的 Gate 0–3 冻结基线。B–F 最新交付已由会话 G 于 2026-08-11 完成统一集成和本地最终联合验收；当前状态、Build ID 与回滚说明见 docs/v3-five-system-final-acceptance.md。

## 已验证事实

本地主工作树已完成 V3 会话 A 的 Gate 0–3；没有提交、推送、部署或写生产数据库。

- Gate 0：目标主工作树基线 HEAD 为 `31f0cd580dca91bba4327944a7a901e231b50b72`，只读 P1 源工作树 HEAD 为 `e6ec11acaca3c9d9543d117bc954686b1e44f36c`。主树既有脏修改、CRLF 差异、未跟踪资产和 `*.sync-conflict-*` 副本均保留。
- Gate 1：P1 五系统模型、页面、路由、time/feedback L1、HQ proposal → 批准 → 幂等 promote、日/周/月反馈连续性桥接、P0 存储兼容和组合合同已安全融合。TaskBox 仍是唯一任务与完成事实源。
- Gate 2：HQ 首屏固定显示使命、健康、时间、执行、反馈五个入口；全局导航仍只有参谋部 `#hq` 与盒子 `#home`。
- Gate 3：使命与健康均为 HQ L1 只读。使命只读明确批准的 `activeVersion`；健康只读明确发布到本地协议 outbox 的最小容量/约束快照。

最终本地构建 Build ID 为 `d8378401cd66`，入口为 `assets/app-KKHJDKS4.js`，样式为 `assets/style-3CDOA5OG.css`。

## 公共快照合同

mission、health、time、feedback 的 HQ L1 快照均遵循以下最小外壳：

```json
{
  "snapshotId": "stable-id",
  "systemId": "mission | health | time | feedback",
  "schemaVersion": 1,
  "generatedAt": "ISO-8601 or null",
  "effectiveDate": "YYYY-MM-DD or null",
  "sourceRefs": [],
  "confidence": 0,
  "status": "healthy | attention | alert | unknown | stale",
  "summary": {},
  "constraints": []
}
```

使命 L1 由 `buildMissionHqSnapshot()` 生成：

- 无明确批准的 activeVersion 时为 `unknown`，草稿内容不进入 summary。
- 复查日期过期时为 `stale`；项目组合映射缺失时为 `attention`。
- 草稿只通过 `hasPendingDraft` 暴露“有待审批草稿”，不暴露草稿正文为事实。
- registry 的 `writeMethod` 为空，不直接写 TaskBox。

健康 L1 由 `buildHealthHqSnapshot()` 生成：

- 只读取 `taskbox_health_energy_protocol_v1.latest`，不读取原始 Observation。
- 无快照、来源冲突、关键字段缺失、低置信度为 `unknown`；超过 36 小时为 `stale`。
- summary 只含状态、容量、约束、冲突/缺失计数、来源类型数和下次评估时间。
- 症状、医疗记录、饮食/训练原始细节、穿戴原始数据和诊疗建议不进入 HQ。
- registry 的 `writeMethod` 为空；健康信号不能自动取消或创建任务。

时间 L1 只读消费健康容量和约束，生成 `planningCapacityMinutes`；未知健康状态不会被当成 100% 容量。该读取不修改健康数据、日历或 TaskBox。

## 授权与事实边界

- 使命草稿、AI 建议、V2 candidateLine、反馈导入规则/实验均不是事实。
- 反馈导入的 active 规则/实验一律降级为 `proposed`。
- ICS 只把 busy 事件计入固定占用；transparent 不占容量，cancelled 不进入快照。
- HQ 候选确认不再调用客户端 `addTask()`；它创建 `/hq/proposals`，只有明确批准的日动作才能调用 `/promote`。
- promote 由服务端按 decision 和 task syncKey 幂等；周/月战略提案不创建 TaskBox 任务。
- 使命或健康信号如需进入行动链，只能先形成待审批 HQ proposal。

## 验证结果

自动验证：

- 五项专项：`test:mission / test:health / test:time-attention / test:execution / test:feedback` 全部通过。
- 公共合同：`test:hq-systems / test:p1-integration / test:v3-integration` 全部通过。
- `npm test` 全部通过，包括 P0 同步兼容、日/周/月桥接、API schema、HQ API 与 proposal 状态机。
- `npm run build` 通过，Build ID 为 `d8378401cd66`。

真实浏览器使用独立端口 `4319` 验证：

- `#hq/#mission/#health/#time/#execution/#feedback` 可直接访问并刷新。
- 五个固定入口与五张接入卡均跳到正确 Hash；五系统页面均可返回 `#hq`。
- 1440px 和 390×844 均无页面级横向溢出，页面控制台无 warning/error。
- 使命草稿保存后 HQ 保持 `unknown`；二次明确批准后 HQ 才更新为已发布版本。
- 健康无快照为 `unknown`；发布后只显示容量/约束；冲突来源重新发布后为 `unknown`；测试症状与测试医疗记录未出现在 HQ。
- time 页面显示健康容量只读约束；execution 只读取 TaskBox；feedback 导入授权降级由自动合同覆盖。

## 2026-08-10 基线时未实施与未验证

- 截至该 Gate 0–3 基线，五个系统各自的 V3 B–F 升级文档尚未执行；它们已在 2026-08-11 会话 G 集成，当前状态改见最终验收文档。
- V2 的 1,656 条 candidateLine 仍是候选行，validated_fact 仍不得因本次工作增加；本次未读取 V2 候选写入事实层。
- 本地 Build ID `d8378401cd66` 未部署。生产前端仍以文档记录的 P4 Build ID `1962464071d3` 为准，P4 API/schema 也仍未部署。
- 未做生产认证 `200`、未认证 `401`、CORS `204`、生产 proposal 状态机、systemd active 或新回滚快照验收。
- 历史日省模式真实性、校准实验效果及更深 L2 耦合价值均未验证。

## B–F 启动条件与公共文件所有权

Gate 1、Gate 2、Gate 3 已在本地主工作树通过，因此从公共契约角度允许启动 B–F 独立系统会话。启动仍需用户明确授权，并必须使用独立 worktree。

B–F 不得修改以下公共文件：

- `js/app.js`
- `js/hq-page.js`
- `js/hq-systems.js`
- `css/style.css` 中的共享入口样式
- `scripts/test-v3-integration.mjs`
- `package.json`

每个系统会话只修改自己的 model/store/page/专项测试；需要改变公共契约时输出接口提案，留给后续统一集成会话。

下一位 Agent 可先执行：

```bash
npm run test:v3-integration
npm test
npm run build
npm run preview -- --port 4319
```
