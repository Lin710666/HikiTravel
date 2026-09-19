"""FastAPI 应用入口。

本地部署两种模式：
- 开发：uvicorn app.main:app --reload（前端由 Vite 单独启动，走代理）
- 生产：前端构建到 frontend/dist，配置 STATIC_DIR 后由 FastAPI 静态托管
"""
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .config import settings
from .routers.api import router

app = FastAPI(
    title="文旅智能辅助 - 个性化可交互旅游规划系统",
    version="0.1.0",
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


# 生产环境：托管前端构建产物；开发环境：返回引导信息
if settings.static_dir and Path(settings.static_dir).is_dir():
    app.mount("/", StaticFiles(directory=settings.static_dir, html=True), name="static")
else:

    @app.get("/")
    def root():
        return {
            "name": "文旅智能辅助 - 个性化可交互旅游规划系统",
            "docs": "/docs",
            "health": "/api/health",
        }
