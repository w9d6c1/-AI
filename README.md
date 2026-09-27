# 国内电商 AI 内部试用平台

覆盖经营洞察、AI 能力、自动化执行、多店铺管理和团队成长。当前版本按**单公司内部试用**部署：管理员管理全部店铺，普通成员只能读取获授权的店铺；真实 RPA 尚未接入。

## 功能模块

| 板块 | 模块 | 说明 |
|---|---|---|
| 经营洞察 | 数据看板 | 经营指标 + 销售趋势 / 渠道分布 / 推广对比 / 商品排行 |
| 经营洞察 | 竞品分析 | 6 维度评分 + 雷达图对比 + 竞争策略建议 |
| AI 能力 | AI 对话 | 多轮对话、上下文记忆、附件上传，电商知识库问答 |
| AI 能力 | AI 智能体 | 6 大分类 18 个智能体：选款/调研/视觉/推广/内容/财税 |
| AI 能力 | AI 创作 | 文生图、图生图、白底图转场景，批量生成 |
| AI 能力 | 无限画板 | 思维导图节点 + 便签 + 缩放平移，内容云端持久化 |
| 多店铺管理 | 店铺看板 | 50 店总览对比 + 单店钻取 + ROI 趋势 + 空烧预警 |
| 多店铺管理 | 建议审核 | 每店每日 AI 生成建议单 → 人工审核（全部通过/拒绝/逐条） |
| 多店铺管理 | 执行监控 | 审核通过后触发 RPA 执行（改价/关停/加预算）→ 截图留档 |
| 多店铺管理 | 店铺管理 | 店铺 CRUD + 批次分组 + 调价上限 + 状态管理 |
| 自动化 | 数字员工 | 自动化任务调度（可启停/立即执行）、执行日志 |
| 成长 | 学习中心 | 电商课程、章节学习、进度追踪 |

## 技术架构

- **后端**：Node.js + Express，RESTful API，JWT 鉴权（含 role），请求限流
- **数据库**：Node.js `node:sqlite`，数据文件在 `data/`
- **前端**：原生 HTML/CSS/JS 单页应用，ECharts 图表，无需构建
- **AI 接入**：OpenAI 兼容接口（默认火山方舟/豆包，可切 DeepSeek/OpenAI），未配置 Key 时自动降级为内置电商规则引擎
- **RPA 对接**：影刀 OpenAPI 封装，Mock 模式下自动生成测试数据

## 快速启动

```bash
# 1. 安装锁定版本依赖
npm ci

# 2. 配置环境变量（JWT_SECRET 和 RPA_CALLBACK_TOKEN 必填）
cp .env.example .env

# 3. 启动
npm start

# 4. 访问 http://localhost:3200
```

空数据库首次启动时，临时设置 `SEED_DEFAULT_USERS=true` 和至少 12 位的 `ADMIN_PASSWORD`。管理员创建完成后立即恢复 `SEED_DEFAULT_USERS=false`。公开注册默认关闭，其他账号由管理员创建。

已有演示账号时，可运行 `npm run setup-demo`，为 `demo` 初始化数字员工任务并授予现有店铺只读权限。演示账号仍保持普通成员角色，审核、执行、调度和用户管理由管理员完成。

## 多店铺管理使用流程

1. **注册/登录** → 进入平台
2. **多店铺看板** → 点击"触发采集（Mock）"→ 自动生成 20 店的日报和计划数据
3. **建议审核** → 点击"生成建议"→ AI 引擎为每个店铺生成建议单 → 审核通过/拒绝
4. **执行监控** → 审核通过的建议可触发执行（Mock 模式下自动标记成功 + 生成截图 URL）
5. **店铺管理** → 添加/暂停/启用店铺，配置调价上限

> Mock 模式下全链路可跑通，无需真实影刀和 AI API。配置后自动切换真实模式。

## 生产部署

### Docker（推荐）
```bash
cp .env.example .env  # 编辑配置
docker compose up -d --build
```

### PM2 进程守护
```bash
npm install -g pm2
pm2 start server/index.js --name ecom-ai
pm2 save && pm2 startup
```

### Nginx 反向代理
```nginx
server {
    listen 80;
    server_name ai.yourdomain.com;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_read_timeout 120s;
    }
    client_max_body_size 60m;
}
```

## 环境变量说明

| 变量 | 说明 | 默认值 |
|---|---|---|
| `PORT` | 服务端口 | 3000 |
| `JWT_SECRET` | 至少 32 位的随机登录密钥 | 无，必须配置 |
| `AI_API_KEY` | 大模型 API Key | 空（降级规则引擎） |
| `AI_BASE_URL` | AI 接口地址 | 火山方舟 |
| `AI_MODEL` | 对话模型 | doubao-pro-32k |
| `RPA_MOCK_MODE` | RPA Mock 模式 | true |
| `RPA_API_BASE` | 影刀 API 地址 | openapi.yingdao.com |
| `RPA_APP_ID_DAILY_REPORT` | 日报采集应用 ID | 空 |
| `RPA_APP_ID_AD_CAMPAIGNS` | 计划报表应用 ID | 空 |
| `RPA_APP_ID_EXECUTE` | 执行操作应用 ID | 空 |
| `RPA_CALLBACK_TOKEN` | 随机 RPA 回调验证 Token | 无，必须配置 |

## 目录结构

```
ecom-ai-platform/
├── server/
│   ├── index.js          # 服务入口
│   ├── db.js             # 数据库 Schema + 种子数据（含多店铺表）
│   ├── middleware.js     # JWT 鉴权 / 限流 / 错误处理
│   ├── ai.js             # AI 服务层（大模型 + 规则引擎降级）
│   ├── rpa.js            # 影刀 RPA 客户端 + Mock 模式
│   ├── suggestion.js     # AI 建议引擎 + 硬规则兜底
│   └── routes/
│       ├── auth.js       # 认证
│       ├── chat.js       # AI 对话
│       ├── agents.js     # AI 智能体
│       ├── business.js   # 画板/竞品/任务/课程/图片/知识库
│       └── stores.js     # 多店铺管理（店铺/看板/建议/执行/RPA/审计）
├── public/
│   └── index.html        # 前端单页应用（含多店铺管理页面）
├── data/                 # SQLite 数据库（自动生成）
├── uploads/              # 上传文件（自动生成）
├── .env.example
├── Dockerfile
└── docker-compose.yml
```

## 安全说明（上线前必读）

- [ ] 修改 `JWT_SECRET`：`openssl rand -hex 32`
- [ ] 启用 HTTPS
- [ ] 按 [上线与恢复手册](deploy/RUNBOOK.md)完成备份恢复演练
- [ ] 运行 `npm test` 与 `npm audit --omit=dev`

---

## 云端部署：GitHub Pages（前端） + Render（后端）

架构说明：前端为纯静态 SPA（`public/`），由 GitHub Pages 托管在 `https://w9d6c1.github.io/-AI/`；后端 Express API 由 Render 托管；两端跨域通信（JWT Bearer 鉴权）。

### 部署前准备

1. 仓库 `w9d6c1/-AI` 已推送到 GitHub 的 `main` 分支。
2. 后端 `JWT_SECRET` / `RPA_CALLBACK_TOKEN` 等密钥只在平台后台填写，**严禁提交到仓库**（`.env` 已 gitignore）。

### 第一步：Render 部署后端

1. 登录 [Render](https://render.com)，新建 **Blueprint**，关联 `w9d6c1/-AI` 仓库。
2. 自动识别根目录 `render.yaml`，创建两个资源：
   - Web 服务 `ecom-ai-backend`（Docker 运行时，`buildCommand: npm ci`，启动 `node server/index.js`，健康检查 `/api/health`）
   - 托管 PostgreSQL `ecom-ai-db`
3. 环境变量已由 `render.yaml` 预置（`JWT_SECRET` / `RPA_CALLBACK_TOKEN` 由 Render 自动生成随机值；`DATABASE_URL` 自动注入）。
4. **首次建管理员账号**：在 Web 服务 Environment 里临时加 `SEED_DEFAULT_USERS=true` 与至少 12 位 `ADMIN_PASSWORD`，点 "Manual Deploy" 触发一次部署；看到日志创建完成后，改回 `SEED_DEFAULT_USERS=false` 再部署一次。
5. 确认 `CORS_ORIGIN` = `https://w9d6c1.github.io`（`render.yaml` 已预置）。
6. 记下后端的公网地址：`https://ecom-ai-backend.onrender.com`（在 Web 服务页顶部可见）。

### 第二步：GitHub Pages 部署前端

1. 仓库 → **Settings → Pages**，`Source` 选择 **GitHub Actions**。
2. 仓库 → **Settings → Secrets and variables → Actions**，新建仓库 Secret：
   - 名称：`BACKEND_API_URL`
   - 值：`https://ecom-ai-backend.onrender.com`（第一步记下的后端地址，**末尾不要带斜杠**）
3. 推送代码到 `main` 分支，`.github/workflows/deploy.yml` 自动运行：读取 `BACKEND_API_URL` → 生成 `public/js/config.js`（写入 `window.__API_BASE__`）→ 发布到 Pages。
4. 访问 `https://w9d6c1.github.io/-AI/` 验证登录与数据。

### 环境变量清单

**后端（Render，可在 Web 服务 Environment 中查看/覆盖）**

| 变量 | 必填 | 说明 |
|---|---|---|
| `NODE_ENV` | 是 | 固定 `production` |
| `DB_DRIVER` | 是 | 固定 `postgres` |
| `DATABASE_URL` | 是 | 由托管 Postgres 自动注入 |
| `JWT_SECRET` | 是 | 登录密钥，Render 自动生成 |
| `RPA_CALLBACK_TOKEN` | 是 | RPA 回调验证，Render 自动生成 |
| `CORS_ORIGIN` | 是 | 前端域名 `https://w9d6c1.github.io` |
| `TRUST_PROXY` | 是 | `1`（Render 前置代理） |
| `ENABLE_HSTS` | 建议 | `true` |
| `REDIS_REQUIRED` | 建议 | `false`（免费实例无 Redis，走内存降级） |
| `ENABLE_SCHEDULER` | 建议 | `false`（单实例） |
| `QUEUE_ENABLED` | 建议 | `false` |
| `STORAGE_DRIVER` | 建议 | `local`（临时卷，重启丢上传文件） |
| `AI_API_KEY` | 否 | 大模型 Key，不配则降级内置规则引擎 |
| `SEED_DEFAULT_USERS` / `ADMIN_PASSWORD` | 仅首启 | 建管理员账号，用完关闭 |

**前端（GitHub Actions Secret）**

| Secret | 说明 |
|---|---|
| `BACKEND_API_URL` | 后端公网地址，如 `https://ecom-ai-backend.onrender.com` |

### 重点提示

- **CORS**：`CORS_ORIGIN` 必须精确等于 `https://w9d6c1.github.io`（无路径、无尾斜杠）。改域名时两端要同步改。
- **Render 免费实例休眠**：15 分钟无请求会休眠，冷启动约 30~60 秒（首次访问慢属正常）。可外部定时（如 cron / UptimeRobot）每隔几分钟 ping `https://ecom-ai-backend.onrender.com/api/health` 缓解。
- **密钥严禁上传 GitHub**：`JWT_SECRET`、`AI_API_KEY`、`RPA_APP_SECRET` 等只在 Render 后台填写；`BACKEND_API_URL` 是公开地址可用 Secret（但不是机密）。`.env` 已在 `.gitignore`，请勿手动 `git add .env`。
- **数据持久化**：PostgreSQL 数据持久化在托管数据库；但 `STORAGE_DRIVER=local` 的上传文件存于 Render 临时卷，重启/重部署会丢失。生产建议接 S3 兼容对象存储（`STORAGE_DRIVER=s3` + `S3_*`）。
- **免费 Postgres 30 天过期**：Render 免费 Postgres 数据库**创建 30 天后会被删除**。到期前需升级付费或迁移到新库，否则数据丢失（重新部署会自动重建 Schema，但需再次临时开启 `SEED_DEFAULT_USERS` 建管理员）。
- **数据库连接报错排查**：免费实例内部连接默认不需要 SSL，一般直接可用；若日志出现 SSL / 握手错误，在 `DATABASE_URL` 末尾追加 `?sslmode=require` 即可（内部连接不支持 `verify-full`）。
- **首次部署无管理员**：空库首启不会创建账号（`ALLOW_REGISTRATION` 默认关闭）。需在 Render 后台临时加 `SEED_DEFAULT_USERS=true` + 至少 12 位 `ADMIN_PASSWORD`，部署建号后再改回 `false`（该逻辑幂等，已有用户时自动跳过）。
