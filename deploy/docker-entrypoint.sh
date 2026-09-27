#!/bin/sh
# 容器入口：持久卷（Zeabur/Docker volume）通常以 root 属主挂载，
# 这里先以 root 修正数据目录属主，再降权到 node 运行应用，避免 EACCES。
set -e

DATA_DIR="${DATA_DIR:-/app/data}"
UPLOAD_DIR="${UPLOAD_DIR:-/app/uploads}"

mkdir -p "$DATA_DIR" "$UPLOAD_DIR" "$DATA_DIR/reports" "$DATA_DIR/logs"
chown -R node:node "$DATA_DIR" "$UPLOAD_DIR" 2>/dev/null || true

exec su-exec node "$@"
