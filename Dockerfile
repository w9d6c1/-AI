FROM node:24-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV TZ=Asia/Shanghai

# 依赖层（利用缓存）
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# 应用代码
COPY . .

# 运行目录与权限（非 root 运行）
RUN mkdir -p data uploads data/reports && chown -R node:node /app
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
