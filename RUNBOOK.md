# AgentHub 运行手册

## 前置条件

```bash
# 确保在项目根目录
cd ~/disB/hyh/agentHub

# 确保 docker 权限正常（不需要 sudo）
docker ps
```

## 首次启动 / 环境初始化

```bash
# 1. 构建沙箱镜像（仅首次或 Dockerfile 变更后需要）
docker build -t agenthub-sandbox:latest -f docker/sandbox.Dockerfile .

# 2. 启动数据库服务
docker compose up -d postgres redis

# 3. 数据库迁移（仅首次或 schema 变更后需要）
export $(grep -v '^#' .env | grep -v '^$' | xargs) && cd apps/api && npx prisma migrate dev --name init
```

## 日常启动

终端 1 — 后端（端口 3000）：
```bash
cd ~/disB/hyh/agentHub/apps/api && npx tsx src/index.ts
```

终端 2 — 前端（端口 5173）：
```bash
cd ~/disB/hyh/agentHub/apps/web && npx vite
```

浏览器打开 `http://localhost:5173`

## 停止

```bash
# 后端/前端：各自终端按 Ctrl+C

# 停止数据库服务（保留数据）
docker compose down

# 停止并清除所有数据（慎用）
docker compose down -v

# 清理残留沙箱容器
docker rm -f $(docker ps -aq --filter name=agenthub-sandbox) 2>/dev/null
```

## 强制停止（端口被占用时）

```bash
# 强制释放端口 3000（后端）和 5173（前端）
fuser -k 3000/tcp 2>/dev/null
fuser -k 5173/tcp 2>/dev/null
```

## 重启

```bash
# 停止后端/前端（Ctrl+C）
# 如果 Ctrl+C 后端口仍被占用，执行上面的强制停止
# 然后重新执行"日常启动"中的命令
```

## 完全重置

```bash
# 停止所有服务
docker compose down -v

# 清理沙箱容器和镜像
docker rm -f $(docker ps -aq --filter name=agenthub-sandbox) 2>/dev/null
docker rmi agenthub-sandbox:latest 2>/dev/null

# 清理数据库文件
rm -rf apps/api/prisma/migrations/

# 重新初始化
docker build -t agenthub-sandbox:latest -f docker/sandbox.Dockerfile .
docker compose up -d postgres redis
export $(grep -v '^#' .env | grep -v '^$' | xargs) && cd apps/api && npx prisma migrate dev --name init
```

## 查看运行状态

```bash
# 数据库服务
docker compose ps

# 后端日志（终端 1 可见）

# 活跃沙箱容器（有用户正在对话时存在）
docker ps --filter name=agenthub-sandbox

# 所有沙箱容器（包括已停止的）
docker ps -a --filter name=agenthub-sandbox
```
