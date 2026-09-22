# 配置变更回放台（Config Change Replay Station）

一个本地运行的 Web 小工具：为**命名资源**提交**带版本号的配置变更事件**，系统按资源把事件串成时间线、自动检测**版本冲突**，支持**可视化回放**配置演变过程，并可按资源筛选、把当前筛选结果**导出为 JSON**。

技术栈：Python Flask + SQLite + 原生 HTML/CSS/JS（无前端构建步骤）。

## 功能

- **提交变更事件**：资源名、版本号、提交人、变更说明、JSON 配置片段
- **版本冲突检测**（按资源、按提交顺序）：
  - `版本重复` — 同一资源的同一版本号被提交多次
  - `版本回退` — 版本号小于等于该资源已出现的最大版本
  - `版本跳变` — 版本号比当前最大版本高出 2 及以上（中间版本缺失）
- **可视化回放**：时间线逐节点回放，实时展示该步应用后的**累计配置状态**（深合并）与**本步变更**，冲突节点红色标记；支持播放/暂停/拖拽进度
- **筛选与导出**：按资源筛选事件；一键把当前筛选结果导出为 JSON 文件
- **演示数据**：启动时自动初始化数据库，空库时写入含冲突的示例数据（可关闭）

## 快速开始

### 方式一：Docker Compose（推荐）

```bash
docker compose up --build
```

访问 <http://localhost:8000>。数据持久化在命名卷 `replay-data` 中。

### 方式二：本地 Python

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python app.py
```

访问 <http://localhost:8000>。数据库文件默认在 `./data/replay.db`。

### 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `8000` | 监听端口 |
| `DB_PATH` | `./data/replay.db`（容器内 `/app/data/replay.db`） | SQLite 文件路径 |
| `SEED_DEMO` | `1` | 空库时是否写入示例数据，`0` 关闭 |

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查 |
| GET | `/api/resources` | 资源列表及统计（事件数 / 冲突数 / 最大版本） |
| GET | `/api/events?resource=<name>` | 事件列表（可选按资源过滤），每个事件带 `conflicts` 数组 |
| POST | `/api/events` | 提交事件，Body：`{"resource","version","author","message","payload"}` |
| GET | `/api/export?resource=<name>` | 把当前筛选结果导出为 JSON 文件下载 |
| POST | `/api/seed` | 清空并重新写入示例数据 |
| POST | `/api/reset` | 清空全部事件 |

提交事件示例：

```bash
curl -X POST http://localhost:8000/api/events \
  -H 'Content-Type: application/json' \
  -d '{"resource":"payment-service","version":8,"author":"alice",
       "message":"调高超时","payload":{"env":{"TIMEOUT":"8s"}}}'
```

导出示例：

```bash
curl -OJ 'http://localhost:8000/api/export?resource=payment-service'
```

## 回放逻辑说明

回放针对**单个资源**：事件按提交时间排序，从空配置 `{}` 开始，每一步把该事件的
`payload`（JSON 对象）**深合并**进累计状态。时间线上红色节点即冲突事件，点击任意
节点或用播放控制条可逐步查看每一次变更后的配置全貌。

## 项目结构

```
├── app.py                 # Flask 后端：API、冲突检测、启动时初始化 DB
├── templates/index.html   # 单页界面
├── static/app.js          # 前端逻辑（回放、筛选、导出）
├── static/style.css       # 样式
├── requirements.txt
├── Dockerfile
├── docker-compose.yml
└── README.md
```
