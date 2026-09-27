FROM node:24-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV TZ=Asia/Shanghai

# su-exec：入口脚本以 root 修正卷属主后降权到 node 运行
RUN apk add --no-cache su-exec

# 依赖层（利用缓存）
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# 应用代码
COPY . .

# 运行目录与权限
RUN mkdir -p data uploads data/reports && chown -R node:node /app

# 入口脚本：修正持久卷属主后降权运行（非 root 运行应用）
COPY deploy/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server/index.js"]
