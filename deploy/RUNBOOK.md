# 内部试用上线与恢复手册

当前版本面向单公司内部试用。影刀执行仍为 Mock；不要把 Mock 成功记录当作真实店铺执行结果。

---

## 一、上线前检查清单

1. **轮换密钥**（见「五、密钥轮换清单」）：AI Key、`JWT_SECRET`、`RPA_CALLBACK_TOKEN` 等全部在服务商/本机重新生成。
2. 从 `.env.example` 创建 `.env`：设置随机密钥、`CORS_ORIGIN=https://<你的域名>`、`ENABLE_HSTS=true`、`TRUST_PROXY=1`，保持 `ALLOW_REGISTRATION=false`、`SEED_DEFAULT_USERS=false`、`SEED_DEMO_DATA=false`。
3. 仓库泄露扫描（应为 0 发现）：`npm run scan-secrets`
4. 依赖与安全审计：`npm ci`、`npm test`、`npm audit --omit=dev --registry=https://registry.npmjs.org`
5. 配置校验与构建：`docker compose config --quiet`、`docker compose build`
6. AI 连通性自检（轮换后必做）：`npm run check-ai`（生图加 `-- --image`）
7. 备份与演练：`npm run backup`（SQLite）或 `npm run drill:pg`（Postgres），并按下方恢复流程完成一次演练。

## 二、首次创建管理员

仅空数据库执行一次：设置至少 12 位 `ADMIN_PASSWORD`，临时 `SEED_DEFAULT_USERS=true`，启动确认可登录后**立即改回 `false` 并重启**。已有数据库不要重复执行。

## 三、域名与 HTTPS

1. 域名解析到服务器公网 IP。
2. 安装证书（Let's Encrypt）：
   - `sudo apt install certbot python3-certbot-nginx`
   - `sudo certbot --nginx -d ai.example.com`（自动申请并注入证书）
   - 续期：`sudo certbot renew --dry-run`（默认已装定时任务）
3. 反向代理：参考 `deploy/nginx.conf.example`（80→443 跳转、TLSv1.2/1.3、HSTS、上传 60m、代理到 `127.0.0.1:3200`）。
4. 应用侧：`.env` 设 `TRUST_PROXY=1`（真实 IP）、`CORS_ORIGIN=https://ai.example.com`、`ENABLE_HSTS=true`（应用层再下发 HSTS）。
5. 验证：`curl -I https://ai.example.com/api/health` 应为 200 且含 `Strict-Transport-Security`；HTTP 应 301 跳 HTTPS。

## 四、启动与冒烟

`docker compose up -d` 后检查：

- `docker compose ps` 全部 healthy；`GET /api/health/ready` 的 `checks.db.ok=true`（Redis 启用时 `redis.ok=true`）。
- 管理员可登录（启用 2FA 后需动态码）；普通成员看不到未授权店铺。
- 创建五类报表各一份，金额、日期、店铺范围与 ROI 正确。
- `.exe` 上传返回 400；无签名 `/uploads/...` 返回 403。
- 对话与生图各执行一次，确认实际 provider 与费用符合预期（`/api/usage/stats`）。
- 超管后台：租户开通/停用/配额/用量与代登录正常。

## 五、密钥轮换清单

| 密钥 | 位置 | 轮换方式 |
|---|---|---|
| `JWT_SECRET` | 服务商无 | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `RPA_CALLBACK_TOKEN` | 服务商无 | `node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"` |
| `AI_API_KEY` | DeepSeek 控制台 | 控制台吊销旧 Key → 新建 → 写入 `.env` |
| `AI_IMAGE_API_KEY` | 火山方舟控制台 | 同上 |
| `RPA_APP_SECRET` | 影刀开放平台 | 重置应用密钥 |
| `SMTP_PASS` / `S3_SECRET_KEY` / `PG_PASSWORD` | 各自控制台/服务 | 重置后更新 `.env` |

- 轮换后执行 `npm run check-ai` 验证；再执行 `npm run scan-secrets` 确认仓库无残留。
- 生产建议用 `*_FILE`（Docker/K8s secrets）而非明文 `.env`，例如 `JWT_SECRET_FILE=/run/secrets/jwt_secret`。

## 六、备份

- SQLite：`npm run backup`（`VACUUM INTO` 一致性快照 + 上传/报表 + SHA-256 清单）。
- Postgres：`DB_DRIVER=postgres DATABASE_URL=... npm run backup`（`pg_dump --format=custom`）。
- 异地：设置 `OFFSITE_BACKUP_DIR` 后，备份完成会复制一份到该目录；请指向服务器之外的加密存储。
- 数据库与文件必须作为**同一份备份**保存。

## 七、恢复演练

### SQLite
1. `docker compose down`
2. `node scripts/restore.js <备份目录> <全新恢复目录>`（目标目录必须不存在，脚本校验文件与库完整性）
3. 用恢复目录中的 `data/`、`uploads/` 替换到新部署目录，保留原目录作为回滚副本。
4. 启动并完成「四、冒烟」；确认无误后再清理旧副本。

### Postgres
1. `node scripts/restore-pg.js <备份目录> <DATABASE_URL>`（`pg_restore --clean`，请对可恢复库执行）
2. 重启应用并完成冒烟。

### 异机演练
1. 在另一台机器安装 postgresql-client / Node，准备空目录。
2. 从异地备份目录取回最近一次备份。
3. 按上面「SQLite / Postgres」步骤恢复并冒烟；记录耗时与结果。
4. 演练通过前不要删除任何备份。

## 八、回滚

停止当前容器，恢复上一个镜像版本及配套完整数据备份，再启动并检查健康接口、登录、授权店铺与报表下载。**不要把新版本写入后的数据库直接交给旧版本运行。**
