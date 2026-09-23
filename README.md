# 文旅智能辅助场景 · 个性化可交互旅游规划系统

第二届浙江省大学生人工智能竞赛——文旅智能辅助场景（题目编号：JBGS-2026-06）。

面向文旅行业的「智能获客与转化引擎」：为游客生成**全面、可交互、简洁直观**的旅游规划，重构传统文旅「人工服务、固化产品、被动经营」为「智能适配、创新迭代、精准创收」。

## 核心特性

| 模块 | 实现 | 说明 |
|------|------|------|
| 意图识别 | `backend/app/skills/intent_skill.py` | 纯大模型抽取 `UserPreference` 画像，**不用正则/关键词硬编码** |
| 异常拦截 | `backend/app/skills/guard_skill.py` | 检测需求矛盾，**只建议、不擅改**，把选择权交给用户 |
| 数据检索 | `backend/app/skills/retrieve_skill.py` | 高德 API（POI/天气/路线）+ 本地 RAG；**综合分排序**而非只看评分 |
| 规划生成 | `backend/app/skills/planner_skill.py` | 大模型只负责选点（输出很短，生成快）；系统按地理分区→**先定酒店**→以酒店为起点排路线，再插餐、算接驳与预算 |
| 规划体检 | `backend/app/skills/check_skill.py` | 先按真实坐标优化路线 → 再喂回大模型审查（折返、跨城点位、重复、漏排）→ 必要时带反馈重生成一次 |
| 路线优化 | `backend/app/skills/route.py` | 按地理邻近把景点分到每天（不横跨全城）+ 每天总距离 / 折返 / 超长单段检测 + 最近邻重排（纯代码，秒级） |
| 行程地图 | `backend/app/services/static_map.py` | 后端代理高德**静态地图**：真实底图 + 编号标记 + 每日彩色轨迹（用 Web 服务 Key 即可，Key 不出现在浏览器） |
| 综合分打分 | `backend/app/skills/scoring.py` | 推荐排序权重集中配置，便于调参 |
| 协同调度 | `backend/app/orchestrator.py` | 串联五个 Skill；缺关键信息直接提示，**不用静默默认值** |
| 跳转降级 | `frontend/src/hooks/useAppJump.ts` | Scheme → 超时检测 → H5 → 复制口令 完整降级链 |

## 技术栈

- **前端**：React 18 + Vite + TypeScript + Ant Design
- **后端**：Python FastAPI + Pydantic
- **AI**：Ollama 本地推理（**必需**；未接入时系统直接明确提示，不做规则引擎降级）
- **存储**：SQLite（隐私数据本地存储、可导出）
- **部署**：Windows 一键 `.bat`（本地部署）

## 目录结构

```
travelplanner/
├── backend/                # FastAPI 后端
│   ├── app/
│   │   ├── models/         # UserPreference / TravelPlan 数据模型
│   │   ├── skills/         # 五个协同 Skill + 综合分模块 + 统一异常
│   │   ├── services/       # 高德 API / 天气
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
├── backend/scripts/                   # 自检脚本：offline_check.py（离线全链路）/ live_smoke.py（真实接口冒烟）
├── install.bat            # Windows 一键安装部署
└── start.bat              # Windows 一键启动（部署后日常使用）
```

## 快速开始

### 方式一：Windows 一键部署（推荐现场演示）

双击 **`install.bat`**。脚本会自动：

1. **探测运行环境**：按 `py` 启动器 → PATH → 常见安装目录 依次查找 Python 与 Node.js（兼容「装了但没加 PATH」的情况）；
2. **缺啥补啥**：检测不到时，可一键调用 winget 自动安装，或提示手动下载地址；
3. **首次配置**：自动写入内置高德 API Key 到 `backend\.env`（无需手动申请）；
4. **安装依赖 + 构建前端**；
5. **启动服务**，浏览器访问 http://localhost:8000 即可。

之后每次只需双击 **`start.bat`** 一键启动。

### 方式二：本地开发（前后端分离）

**后端**（Python ≥ 3.10，推荐 uv，亦可用 pip）：

```bash
cd backend
cp .env.example .env      # 已内置 AMAP_API_KEY，可直接使用
uv sync                    # 或 pip install -e .
uv run uvicorn app.main:app --reload   # http://localhost:8000
```

**前端**：

```bash
cd frontend
npm install
npm run dev               # http://localhost:5173（已代理 /api 到 8000）
```

**Ollama**（必需：需求解析、规划生成与规划体检都由本地大模型完成；未安装/未启动时
接口会直接返回明确提示，不会用规则引擎凑一份"看起来也行"的规划）：

```bash
ollama pull qwen2.5:7b          # 生成模型
ollama pull nomic-embed-text    # 知识库 embedding 模型
```

其它可调参数见 `backend/.env.example`：`OLLAMA_TIMEOUT`（本地 7B 生成较慢，默认 180 秒）、
`OLLAMA_KEEP_ALIVE`（模型常驻时长，省掉多次调用之间的重新加载）、
`OLLAMA_CHECK_MODEL`（体检单独用哪个模型，留空 = 与规划同款，换小模型可提速）、
`PLAN_MAX_REGENERATE`（规划体检后允许带反馈重新生成的次数，0 = 只体检不重生成）。

**生成耗时实测**（本机 CPU 跑 qwen2.5:7b，3 天行程）：整单约 80 秒，
其中意图解析 0~14 秒、数据检索 0.4~7 秒、规划 15~21 秒、规划体检 48~55 秒。
体检是最耗时的一步（要把整份规划读进去再写结论），但它同时也是可靠性的来源，
因此不提供"关闭体检"的开关——要提速请用 `OLLAMA_CHECK_MODEL` 换更小的模型。

## 行程地图说明

- 地图由后端代理高德**静态地图**接口渲染（`POST /api/map/static`），返回真实底图 + 编号标记
  + 每日彩色轨迹；前端拿到的只是图片，Key 始终留在服务端。
- 用现有的 **Web 服务 Key**（`AMAP_API_KEY`）即可，不需要另申请「Web端(JS API)」Key。
- 高德对静态地图有硬限制（实测：**标记 ≤ 10 组、轨迹 ≤ 4 条**，超了返回 `UNKNOWN_ERROR`），
  所以后端会自动裁剪：优先标注景点与酒店，天数多时把相邻几天合并成一条轨迹。
- 想要**可拖动缩放的交互式地图**，需要另外申请「Web端(JS API)」Key 并配置安全密钥；
  拿到后在 `frontend/.env.local` 里加 `VITE_AMAP_JS_KEY` / `VITE_AMAP_SECURITY_CODE`，
  再让 `MapView` 走 JS API 渲染（当前实现是静态图，取图失败会自动退化为示意图）。

## 数据安全与本地部署

- 数据存储于本地 SQLite（`backend/data/travelplanner.db`），隐私数据不出机。
- AI 推理走本地 Ollama，不把用户数据上传第三方。
- 动态数据（门票价/天气/POI/路线）通过高德 API 实时获取，本地不硬编码。
- 本地 RAG 知识库只存放「慢变」的编辑类知识，可运营维护（改数据库即可扩充）。

## 比赛注意事项

- **代码、文档、演示中不出现任何学校信息**。
- 高德 API Key 已内置，演示前无需手动配置。
- 量化指标见 [docs/量化指标.md](docs/量化指标.md)。
