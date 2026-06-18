---
groupPath: 部署指南
relation: Docker 部署
keywords: [Docker, 部署, 容器化]
exportedAt: "2026-06-18T06:41:53.336Z"
---
# Docker 部署指南

使用 Docker Compose 一键部署整套服务。

## 前置条件

- Docker >= 24.0
- Docker Compose >= 2.20
- 最低 4GB 内存

## 快速启动

```bash
git clone https://example.com/app.git
cd app
cp .env.example .env
docker compose up -d
```

## 服务组件

| 服务 | 端口 | 说明 |
|------|------|------|
| api   | 8080 | 后端 API |
| web   | 3000 | 前端应用 |
| redis | 6379 | 缓存层 |
| pg    | 5432 | PostgreSQL |
