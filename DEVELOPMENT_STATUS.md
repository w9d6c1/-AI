# 开发状态（2026-09-21）

当前定位：单公司内部试用版。真实 AI 已接入；影刀 RPA 保持 Mock。

本轮已完成：报表生成与筛选修复、五类报表验证、报表/模板归属控制、店铺授权收口、建议审核与执行管理员限制、上传文件归属与短期签名链接、公开注册默认关闭、会话失效机制、Docker 配置收紧、SQLite 备份恢复工具及自动化回归测试。

阶段 8（已完成）：新增「数据导入 / 数据查询 / 执行对账 / 运行历史 / 用量统计 / 安全中心 / 执行闭环 / 知识库检索 / 报表模板 / 数据保留」前端视图与登录 2FA 输入；核对前端 API 调用与后端注册路由，**零缺口**。视图逻辑从 `index.html` 拆分为 `public/js/stage8-*.js`（core/import/data/reconcile/runs/usage/security/executions/kb/reports/admin，共 11 个），支持多终端一人一文件并行；执行闭环含筛选分页、详情证据、审批/驳回/回滚、单条/批量回填、导出 CSV/Excel；数据保留仅 superadmin 可见；数据看板新增「广告账号 / 平台表现」聚合（按 `account_id` + `platform`）与账号下钻（计划明细 + 日趋势图）；列表通用分页（含跳转页码）；报表模板「套用」联动格式/日期范围/店铺多选。

阶段 9（已完成）：多租户运营——迁移 `0010_stage9_billing` 为 `tenants` 增计费/联系人字段；`quota.js` 增成本配额（`ai_usage` 当月成本，接入智能体/对话/竞品/生图）与用量汇总；超管 API 增 `GET /admin/overview`、`/admin/tenants/:id/usage`、`/admin/tenants/:id/users`，租户 CRUD 扩计费字段；新增超管运营后台 UI（`public/js/stage9-admin.js` + 「平台总览 / 租户运营」视图，仅 superadmin 可见），含新建/编辑/停用、用量进度条、代登录。

上线前置（本轮已处理）：
- `交接文档.md` 已脱敏（移除明文密钥），并轮换 `JWT_SECRET`、`RPA_CALLBACK_TOKEN`。
- 登录页移除「演示账号 demo/123456」提示。
- 已 `git init` 并打 tag `v0.1.0`。
- `AI_API_KEY` / `AI_IMAGE_API_KEY` 已从 `.env` 置空（历史值泄露）。

上线前仍须人工完成：在 DeepSeek / 火山方舟控制台轮换 AI 密钥并写回 `.env`；配置正式域名与 HTTPS；在可用 Docker 守护进程的机器上构建镜像；使用真实店铺数据验证 AI 建议；完成一次异机备份恢复演练。多公司 SaaS 需要单独设计租户隔离，不能直接开放给外部商家。

验证结果：`npm test`（SQLite）127 项，122 通过 / 5 跳过 / 0 失败（含 `test/stage8.test.js` 6 项、`test/stage8-ui.test.js` 5 项、`test/stage8-lists.test.js` 5 项、`test/stage9.test.js` 5 项、看板账号聚合 1 项）；JavaScript 语法检查通过；浏览器冒烟无控制台报错；开发库迁移 `0010_stage9_billing` 已应用；Compose 配置解析与 Docker 镜像构建通过，镜像未包含 `.env` 或本地数据库；备份恢复演练（`npm run drill`）通过。
