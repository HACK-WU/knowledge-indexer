# Docker 部署指南

使用 Docker Compose 一键部署整套服务。

## 前置条件

- Docker >= 24.0
- Docker Compose >= 2.20
- 最低 4GB 内存

## 快速启动

```bash
# 克隆仓库
git clone https://example.com/app.git
cd app

# 复制环境变量
cp .env.example .env

# 启动服务
docker compose up -d
```

## 服务组件

| 服务 | 端口 | 说明 |
|------|------|------|
| api   | 8080 | 后端 API |
| web   | 3000 | 前端应用 |
| redis | 6379 | 缓存层 |
| pg    | 5432 | PostgreSQL |

## 健康检查

```bash
curl http://localhost:8080/health
```

返回 `{"status":"ok"}` 表示服务正常。
