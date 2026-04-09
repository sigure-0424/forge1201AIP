# docker/bot.Dockerfile
# Bot システム (Node.js) 用コンテナ
# ─────────────────────────────────────────────────────────────
# 用途: docker/forge-server/compose.yaml の bot-system サービスで使用。
#       単独で起動する場合は docker build -f docker/bot.Dockerfile . -t forgeaip-bot
# ─────────────────────────────────────────────────────────────

FROM node:22-slim

WORKDIR /app

# 依存関係のみ先にコピーしてキャッシュを活用
COPY package*.json ./
RUN npm ci --omit=dev

# ソースコード一式をコピー
COPY src/       ./src/
COPY tests/     ./tests/
COPY public/    ./public/
COPY data/      ./data/
COPY index.js   ./

# ログ・デバッグ出力先を作成
RUN mkdir -p /app/data /app/results

# WebUI / Debug WS ポート
EXPOSE 3000 3001

CMD ["node", "index.js"]
