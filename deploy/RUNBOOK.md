# 内部试用上线与恢复手册

当前版本面向单公司内部试用。影刀执行仍为 Mock；不要把 Mock 成功记录当作真实店铺执行结果。

## 上线前

1. 轮换交接文档中出现过的全部 AI Key、`JWT_SECRET` 和 `RPA_CALLBACK_TOKEN`。不要把真实密钥写入文档或镜像。
2. 从 `.env.example` 创建 `.env`，设置随机密钥、实际 HTTPS 域名的 `CORS_ORIGIN`，并保持 `ALLOW_REGISTRATION=false`、`SEED_DEFAULT_USERS=false`、`SEED_DEMO_DATA=false`。
3. 执行 `npm ci`、`npm test`、`npm audit --omit=dev --registry=https://registry.npmjs.org`。
4. 执行 `docker compose config --quiet` 和 `docker compose build`。
5. 执行 `npm run backup`，再按下方恢复流程完成一次演练。

## 首次创建管理员

仅空数据库需要执行一次：设置至少 12 位的 `ADMIN_PASSWORD`，临时把 `SEED_DEFAULT_USERS=true`，启动后确认管理员可登录，然后立即恢复为 `false` 并重新启动。已有数据库不要重复执行。

## 启动与冒烟

执行 `docker compose up -d`，再检查：

- `docker compose ps` 显示 healthy；
- `GET /api/health` 返回 `ok: true`；
- 管理员可登录，普通成员看不到未授权店铺；
- 创建五类报表各一份，金额、日期、店铺范围和 ROI 正确；
- `.exe` 上传返回 400，无签名的 `/uploads/...` 返回 403；
- 对话及生图分别执行一次，确认实际 provider 与调用费用符合预期。

## 备份

`npm run backup` 会用 SQLite `VACUUM INTO` 创建一致性快照，复制上传文件和报表，并生成 SHA-256 清单。默认输出到 `backups/` 下的新目录且拒绝覆盖已有备份。数据库与文件应作为同一份备份保存，并将备份复制到服务器之外的加密存储。

## 恢复演练

1. 停止写入：`docker compose down`。
2. 执行 `node scripts/restore.js <备份目录> <全新的恢复目录>`。目标目录必须不存在，脚本会校验所有文件和数据库完整性。
3. 将恢复目录中的 `data/`、`uploads/` 替换到新的部署目录，保留原生产目录作为回滚副本。
4. 启动新部署并完成上述冒烟检查；确认无误后再清理旧副本。

## 回滚

停止当前容器，恢复上一个镜像版本及与它配套的完整数据备份，再启动并检查健康接口、登录、授权店铺和报表下载。不要把新版本写入后的数据库直接交给旧版本运行。
