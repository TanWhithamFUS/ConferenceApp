FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production DB_PATH=/data/app.db PORT=3000
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
VOLUME /data
EXPOSE 3000
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
