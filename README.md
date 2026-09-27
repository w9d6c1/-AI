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

## 云端部署：Zeabur 同源部署（前端 + 后端单服务）

架构说明：前端为纯静态 SPA（`public/`），与 Express API 由**同一个 Zeabur 服务**同源托管——后端直接提供 `/`（静态前端）、`/api/**`（接口）与 `/uploads/**`（上传文件）。同源部署**无需 CORS**，`public/js/config.js` 的 `__API_BASE__` 保持空串即可。

数据库使用内置 SQLite（`DB_DRIVER=sqlite`，默认），数据文件、上传文件、报表与日志统一持久化在挂载到 `/data` 的 Zeabur Volume 中。

### 第一步：Zeabur 部署后端（含前端）

1. 登录 [Zeabur](https://zeabur.com)，新建 Project。
2. **Add Service → Git**，授权 GitHub 并选择仓库 `w9d6c1/-AI`、分支 `main`。Zeabur 自动识别根目录 `Dockerfile` 构建（无需额外配置）。
3. 在服务 **Environment Variables** 按下方清单填写环境变量（`JWT_SECRET` / `RPA_CALLBACK_TOKEN` 请用随机值）。
4. 在 **Volumes** 标签点击 **Mount Volume**：Volume ID 填 `data`，Mount Directory 填 `/data`。
   > 挂载会清空该目录原有内容（全新库无影响）；挂载后服务不再支持零停机重启。
5. 在 **Networking / Public Networking** 生成公开域名，得到 `https://<名称>.zeabur.app`。
6. 触发部署，在日志确认服务启动成功。

### 第二步：首次创建管理员

仅空数据库执行一次：临时添加 `SEED_DEFAULT_USERS=true` 和至少 12 位 `ADMIN_PASSWORD`，重新部署；日志出现 `[seed] 已创建管理员` 后，**删除这两个变量并再次部署**（逻辑幂等，已有用户时自动跳过）。

### 第三步：验证

- `GET https://<域名>/api/health` 返回 `{"ok":true}`。
- `GET https://<域名>/api/health/ready` 返回 200，且 `checks.db.ok=true`、`checks.storage.ok=true`。
- 浏览器打开 `https://<域名>/`，使用管理员账号登录。

### 环境变量清单

| 变量 | 必填 | 说明 |
|---|---|---|
| `NODE_ENV` | 是 | 固定 `production` |
| `TZ` | 建议 | `Asia/Shanghai` |
| `DB_DRIVER` | 是 | `sqlite`（默认，无需独立数据库服务） |
| `DATA_DIR` | 是 | `/data`（挂载 Volume 的目录） |
| `UPLOAD_DIR` | 是 | `/data/uploads` |
| `JWT_SECRET` | 是 | 至少 32 位随机串 |
| `RPA_CALLBACK_TOKEN` | 是 | 随机串 |
| `REDIS_REQUIRED` | 建议 | `false`（无 Redis，走内存降级） |
| `QUEUE_ENABLED` | 建议 | `false`（单实例） |
| `ENABLE_SCHEDULER` | 建议 | `false`（关闭定时采集；需要时再评估队列依赖） |
| `STORAGE_DRIVER` | 建议 | `local`（文件存于 `/data/uploads`，已持久化） |
| `RPA_MOCK_MODE` | 建议 | `true` |
| `TRUST_PROXY` | 是 | `1`（平台前置代理） |
| `ENABLE_HSTS` | 建议 | `true` |
| `ALLOW_REGISTRATION` | 建议 | `false` |
| `AI_API_KEY` | 否 | 大模型 Key，不配则降级内置规则引擎 |
| `SEED_DEFAULT_USERS` / `ADMIN_PASSWORD` | 仅首启 | 建管理员账号，用完删除 |

### 重点提示

- **同源无需 CORS**：前端与 API 同域，未设置 `CORS_ORIGIN` 即可；若日后拆分前端，再按需设置。
- **免费版休眠**：Zeabur 免费计划在闲置后自动休眠，下次请求冷启动数秒（首次访问慢属正常）；需要常驻可升级 Dev Plan。
- **持久化**：SQLite 库、上传文件、报表、日志都位于 `/data`，务必挂载 Volume，否则重启丢失。
- **密钥严禁上传 GitHub**：`JWT_SECRET`、`AI_API_KEY` 等只在 Zeabur 后台填写（`.env` 已 gitignore，勿手动 `git add .env`）。
- **首次部署无管理员**：空库首启不创建账号（`ALLOW_REGISTRATION` 默认关闭），按「第二步」临时开启 `SEED_DEFAULT_USERS` 建号。
