"""FastAPI 应用入口。

本地部署两种模式：
- 开发：uvicorn app.main:app --reload（前端由 Vite 单独启动，走代理）
- 生产：前端构建到 frontend/dist，配置 STATIC_DIR 后由 FastAPI 静态托管
"""
from pathlib import Path

import logging
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.responses import Response

from .config import settings
from .llm.warmup import warmer
from .routers.api import router

# 让 Skill 耗时日志能在控制台看到（定位"生成慢在哪一步"）
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
# httpx 的 INFO 日志会把完整请求 URL（含高德 Key）打出来，这里压掉，避免刷屏与泄露
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)

logger = logging.getLogger("travelplanner.main")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期：启动时在后台预热模型与提示词缓存。

    不阻塞服务启动，预热跑在守护线程里，Ollama 不可用时只记日志。
    目的是把「第一次生成要额外等 60 秒预填充」这笔开销挪到用户点击之前，
    详见 app/llm/warmup.py。
    """
    warmer.start()
    yield


app = FastAPI(
    title="文旅智能辅助 - 个性化可交互旅游规划系统",
    version="0.1.0",
    lifespan=lifespan,
)


# ---------------- 全局异常兜底 ----------------
#
# 已知的领域异常（缺信息 / 大模型不可用 / 目的地认不出来 / 高德失败）在各接口里
# 已经被翻译成带清晰提示的 HTTP 错误（见 routers/api.py 的 _execute）。
# 这里只负责接住**其余所有没预料到的异常**，避免它们变成一句干巴巴的
# 「Internal Server Error」，用户既看不懂，我们也无从排查：
# - 给用户的：一句干净的中文提示 + 一个 8 位问题编号，内部细节一律不外泄
#   （原始异常里可能带着请求地址、配置甚至 Key）；
# - 给我们的：完整堆栈写进日志，用同一个编号就能搜到出问题的那一次请求。
# 编号是"对账凭证"：用户报障时报它，我们日志里一搜即得。


def _problem_id() -> str:
    """一次未预期异常的问题编号（短、可念、便于用户口述）。"""
    return uuid.uuid4().hex[:8]


@app.exception_handler(RequestValidationError)
async def on_request_invalid(request: Request, exc: RequestValidationError) -> JSONResponse:
    """请求体格式不对（字段类型 / 取值不符约定）。

    默认响应里的 detail 是一个结构化的错误数组，前端当成字符串显示会变成乱内容；
    这里统一翻成一句人话，并沿用同一套 {detail, code, trace_id} 结构。
    """
    trace_id = _problem_id()
    logger.warning(
        "请求参数格式不正确 [%s] path=%s 详情=%s",
        trace_id,
        request.url.path,
        exc.errors(),
    )
    return JSONResponse(
        status_code=422,
        content={
            "detail": "提交的内容格式不正确，请检查后重试。",
            "code": "invalid_request",
            "trace_id": trace_id,
        },
    )


@app.exception_handler(Exception)
async def on_unhandled(request: Request, exc: Exception) -> JSONResponse:
    """未预期异常的总兜底：用户看编号，我们看堆栈。"""
    trace_id = _problem_id()
    logger.exception("未处理异常 [%s] path=%s", trace_id, request.url.path)
    return JSONResponse(
        status_code=500,
        content={
            "detail": "服务内部出现异常，请稍后重试。",
            "code": "internal_error",
            "trace_id": trace_id,
        },
    )


# CORS（本地开发前后端分离；生产可收紧来源）
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router)


class CacheControlledStaticFiles(StaticFiles):
    """静态托管：index.html 不缓存、带 hash 的资源长缓存。

    否则会出现"前端明明重新构建了，用户刷新还是旧页面"的经典坑：
    浏览器把旧 index.html 缓存住，里面指向的还是旧 JS。
    """

    async def get_response(self, path: str, scope) -> Response:
        response = await super().get_response(path, scope)
        normalized = path.replace("\\", "/")
        if normalized.endswith(".html") or normalized in (".", ""):
            response.headers["Cache-Control"] = "no-cache, must-revalidate"
        elif normalized.startswith("assets/"):
            # Vite 产物文件名带内容 hash，内容变了文件名就变，可以放心长缓存
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return response


# 生产环境：托管前端构建产物；开发环境：返回引导信息
if settings.static_dir and Path(settings.static_dir).is_dir():
    app.mount(
        "/",
        CacheControlledStaticFiles(directory=settings.static_dir, html=True),
        name="static",
    )
else:

    @app.get("/")
    def root():
        return {
            "name": "文旅智能辅助 - 个性化可交互旅游规划系统",
            "docs": "/docs",
            "health": "/api/health",
        }
