# 文旅智能辅助场景 · 个性化可交互旅游规划系统

第二届浙江省大学生人工智能竞赛——文旅智能辅助场景（题目编号：JBGS-2026-06）。

面向文旅行业的「智能获客与转化引擎」：为游客生成**全面、可交互、简洁直观**的旅游规划，重构传统文旅「人工服务、固化产品、被动经营」为「智能适配、创新迭代、精准创收」。

## 核心特性

| 模块 | 实现 | 说明 |
|------|------|------|
| 意图识别 | `backend/app/skills/intent_skill.py` | 对话/表单 → `UserPreference` 画像 |
| 异常拦截 | `backend/app/skills/guard_skill.py` | 检测需求矛盾，**只建议、不擅改**，把选择权交给用户 |
| 数据检索 | `backend/app/skills/retrieve_skill.py` | 高德 API（POI/天气/路线）+ 本地 RAG 知识库 |
| 规划生成 | `backend/app/skills/planner_skill.py` | 时间轴 / 交通接驳 / Plan B / 预算明细 |
| 协同调度 | `backend/app/orchestrator.py` | 串联四层 Skill 流水线 |
| 跳转降级 | `frontend/src/hooks/useAppJump.ts` | Scheme → 超时检测 → H5 → 复制口令 完整降级链 |

## 技术栈

- **前端**：React 18 + Vite + TypeScript + Ant Design
- **后端**：Python FastAPI + Pydantic
- **AI**：Ollama 本地推理（可用则用，不可用自动降级规则引擎）
- **存储**：SQLite（隐私数据本地存储、可导出）
- **部署**：Windows 一键 `.bat` / Docker Compose

## 目录结构

```
travelplanner/
├── backend/                # FastAPI 后端
│   ├── app/
│   │   ├── models/         # UserPreference / TravelPlan 数据模型
│   │   ├── skills/         # 四个协同 Skill
│   │   ├── services/       # 高德 API / 天气 / 酒店
│   │   ├── rag/            # 本地 RAG 知识库（SQLite + 检索）
│   │   ├── llm/            # Ollama 客户端
│   │   ├── orchestrator.py # Skill 协同调度器
│   │   └── main.py         # 应用入口
│   ├── .env.example        # 配置模板
│   └── pyproject.toml      # uv / pip 依赖
├── frontend/               # React 前端
│   └── src/
│       ├── components/     # 表单 / 规划展示 / 地图
│       ├── hooks/useAppJump.ts
│       ├── types/          # 与后端对齐的 TS 类型
│       └── api/client.ts
├── docs/量化指标.md
├── install.bat            # Windows 一键安装部署
├── start.bat              # Windows 一键启动（部署后日常使用）
├── Dockerfile
└── docker-compose.yml
```

## 快速开始

### 方式一：Windows 一键部署（推荐现场演示）

双击 **`install.bat`**。脚本会自动：

1. **探测运行环境**：按 `py` 启动器 → PATH → 常见安装目录 依次查找 Python 与 Node.js（兼容「装了但没加 PATH」的情况）；
2. **缺啥补啥**：检测不到时，可一键调用 winget 自动安装，或提示手动下载地址；
3. **首次配置**：引导填写高德 API Key，写入 `backend\.env`；
4. **安装依赖 + 构建前端**；
5. **启动服务**，浏览器访问 http://localhost:8000 即可。

之后每次只需双击 **`start.bat`** 一键启动。

> 高德密钥免费申请：https://console.amap.com/ （开通「Web 服务」的搜索 / 天气 / 路线 API）。

### 方式二：Docker 一键部署（跨环境复现）

```bash
cp .env.example .env   # 或手动创建 .env，填入 AMAP_API_KEY=xxx
docker compose up -d --build
# 访问 http://localhost:8000
```

> 容器内默认连接宿主机 Ollama（`host.docker.internal:11434`）；也可 `docker compose --profile ollama up -d` 一并启动 Ollama。

### 方式三：本地开发（前后端分离）

**后端**（Python ≥ 3.10，推荐 uv，亦可用 pip）：

```bash
cd backend
cp .env.example .env      # 填写 AMAP_API_KEY
uv sync                    # 或 pip install -e .
uv run uvicorn app.main:app --reload   # http://localhost:8000
```

**前端**：

```bash
cd frontend
npm install
npm run dev               # http://localhost:5173（已代理 /api 到 8000）
```

**Ollama**（可选，不装也能跑——自动降级规则引擎）：

```bash
ollama pull qwen2.5:7b          # 生成模型
ollama pull nomic-embed-text    # 知识库 embedding 模型
```

## 数据安全与本地部署

- 数据存储于本地 SQLite（`backend/data/travelplanner.db`），隐私数据不出机。
- AI 推理走本地 Ollama，不把用户数据上传第三方。
- 动态数据（门票价/天气/POI/路线）通过高德 API 实时获取，本地不硬编码。
- 本地 RAG 知识库只存放「慢变」的编辑类知识，可运营维护（改数据库即可扩充）。

## 比赛注意事项

- **代码、文档、演示中不出现任何学校信息**。
- 演示前务必配置 `AMAP_API_KEY`，否则无实时数据。
- 量化指标见 [docs/量化指标.md](docs/量化指标.md)。
