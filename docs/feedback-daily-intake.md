# 反馈系统日省输入消费者

实施状态：本地已实现、未接入页面、未部署（2026-09-03）。

## 已验证合同

- 反馈系统只读取 `GET /v1/system-candidates?systemId=feedback&reviewDate=&status=&limit=` 返回的 `intakes`。
- 当前唯一允许的合同版本是 `2026-09-03.1`，schema 版本是 `1`。
- 每个可处理输入向 `POST /v1/system-candidates/:intakeId/receipt` 回传 `{ status, idempotencyKey, projection }`；无效、不兼容或过期输入回传 `ignored` 和稳定错误码。
- 相同 intake revision 生成完全相同的回执键和回执正文；新 revision 生成新的回执键。已有 `processed` 或 `ignored` 回执的输入不重复消费。
- HQ 最小投影只包含 `windowSummary`、`deviationCount`、`pendingApprovalCount`、`currentExperimentRef`、`currentRuleRef`、`evidenceCoverage` 和 `inputGaps`。

实现入口是 `js/feedback-daily-intake.js`，专项测试在 `scripts/test-feedback-model.mjs`。

## 数据与授权边界

- 发布、沟通、报价、成交、交付、回款和反馈分别记录；任何一个结果都不能推断下一个结果。
- 正数结果缺少该指标自身的证据引用时，投影必须报告 `missing_independent_evidence`。
- 输入偏差一律降级为 `candidate_unvalidated`；实验与规则一律降级为 `proposed`。
- 输入携带的批准人、批准时间和实施授权不会被继承。消费者不批准或启动实验，不激活规则，不创建 TaskBox 任务，也不改写目标系统。
- 消费过程不写入反馈本地 store。共享输入记录和回执是当前传输事实；后续如需把候选导入反馈领域模型，必须另行定义幂等副作用和用户授权边界。

## 尚未实施

- 未替换反馈页面上的旧候选收件箱，也未在页面加载时自动运行消费者。当前仓库服务器仍只有旧候选接口，没有本合同要求的 receipt 路由；在上游路由正式落地并完成兼容性验证前不得接线。
- 未修改 API 服务、数据库 schema、HQ、日省或其他系统。
- 未部署生产，未提交或推送代码。
