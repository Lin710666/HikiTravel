"""API 路由：对话/表单生成规划、健康检查、历史计划。

异常处理原则（与用户对齐）：不静默降级、不伪造数据，
把"哪里出了问题、用户该怎么处理"如实返回给前端。
- 信息缺失 / 目的地认不出来 → 400，提示用户补充或确认
- 未接入大模型 API → 503，提示用户启动模型服务
- 大模型输出不可解析 → 502，提示用户重试
- 未配置高德密钥 / 网络异常 → 503
"""
from typing import Any, Dict, List, Literal, Optional

import base64

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import store
from ..config import settings
from ..models.plan import TravelPlan
from ..models.preference import UserPreference
from ..orchestrator import Orchestrator
from ..services.amap import AmapDestinationError, AmapError
from ..services.static_map import build_legend, build_static_map_params
from ..skills.errors import (
    LLMOutputError,
    LLMUnavailableError,
    MissingRequiredInfoError,
    SkillError,
)

router = APIRouter(prefix="/api")
orchestrator = Orchestrator()


class ChatRequest(BaseModel):
    """对话模式请求。"""

    message: str
    apply_suggestions: bool = False  # 用户是否已同意采纳异常拦截建议
    preference: Optional[Dict[str, Any]] = None  # 表单已填的部分画像（作为底，覆盖对话模糊解析）


class PlanRequest(BaseModel):
    """表单模式请求。"""

    preference: UserPreference
    apply_suggestions: bool = False


class ReviseRequest(BaseModel):
    """对话式修改规划请求：带上要修改的那版规划即可（画像就存在规划里）。"""

    message: str
    plan: TravelPlan
    apply_suggestions: bool = False


class MapRequest(BaseModel):
    """地图请求：把当前规划发过来，后端代理取高德静态地图。"""

    plan: TravelPlan


class PlaceTip(BaseModel):
    """目的地输入提示的一个候选。"""

    name: str
    district: str  # 省市区全路径，如「福建省福州市平潭县」
    adcode: str
    kind: Literal["行政区", "地点"]  # 行政区（省/市/区县）还是区内某个地点
    lat: Optional[float] = None
    lng: Optional[float] = None


class MapConfig(BaseModel):
    """前端交互地图（高德 JS API）的运行时配置。"""

    enabled: bool
    key: str = ""
    security_code: str = ""


def _execute(call) -> TravelPlan:
    """统一把 Skill 层异常翻译成带清晰提示的 HTTP 错误。"""
    try:
        return call()
    except MissingRequiredInfoError as exc:
        # 用户没填关键信息 / 目的地为空：直接告诉他补什么，不用默认值糊过去
        raise HTTPException(status_code=400, detail=str(exc))
    except AmapDestinationError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except LLMUnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except LLMOutputError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    except AmapError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except SkillError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


def _run_plan(raw_text=None, preference=None, apply_suggestions=False, base=None) -> TravelPlan:
    return _execute(
        lambda: orchestrator.run(
            raw_text=raw_text,
            preference=preference,
            apply_suggestions_flag=apply_suggestions,
            base=base,
        )
    )


@router.post("/chat", response_model=TravelPlan)
def chat(req: ChatRequest) -> TravelPlan:
    """对话式生成规划（可携带表单已填画像作为底，弥补对话解析的模糊性）。"""
    plan = _run_plan(
        raw_text=req.message,
        apply_suggestions=req.apply_suggestions,
        base=req.preference,
    )
    store.save_plan(plan.model_dump())
    return plan


@router.post("/plan", response_model=TravelPlan)
def make_plan(req: PlanRequest) -> TravelPlan:
    """表单式生成规划。"""
    plan = _run_plan(preference=req.preference, apply_suggestions=req.apply_suggestions)
    store.save_plan(plan.model_dump())
    return plan


@router.post("/plan/revise", response_model=TravelPlan)
def revise_plan(req: ReviseRequest) -> TravelPlan:
    """对话式修改规划：在已有画像上应用新要求（"预算压到 2500""第二天换成室内"）。

    画像随规划一起保存（plan.user_preference），所以可以直接改，不需要用户重填表单。
    """
    plan = _execute(
        lambda: orchestrator.revise(
            message=req.message,
            plan=req.plan,
            apply_suggestions_flag=req.apply_suggestions,
        )
    )
    store.save_plan(plan.model_dump())
    return plan


@router.post("/map/static")
def static_map(req: MapRequest) -> Dict[str, Any]:
    """返回高德静态地图（真实底图 + 编号标记 + 每日彩色轨迹）与对应图例。

    为什么走后端：静态地图接口需要 Key，浏览器直接调会把 Key 暴露出去。
    这里由后端带 Key 取图，转成 data URL 返回，前端只拿到图片本身。
    """
    try:
        params = build_static_map_params(req.plan)
        # 复用检索 Skill 的高德客户端：共享限流，避免并发触发额度限制
        image = orchestrator.retrieve.amap.static_map(**params)
    except AmapError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {
        "image": "data:image/png;base64," + base64.b64encode(image).decode("ascii"),
        "legend": build_legend(req.plan),
        "zoom": params["zoom"],
        "center": params["center"],
    }


@router.get("/map/config", response_model=MapConfig)
def map_config() -> MapConfig:
    """交互地图的前端配置。

    为什么由接口下发、而不是打进前端产物：
    1. 换 Key 或安全密钥不用重新构建前端；
    2. 没配置时前端立刻知道，直接退回静态地图，不会开天窗。

    安全说明（重要）：JS API 的 Key 按设计**必然出现在浏览器里**，
    安全密钥同理，藏不住也没必要藏。真正的防滥用手段是在高德控制台
    给该 Key 配「安全域名白名单」——只允许我们自己的域名调用。
    不配白名单的话，任何人抄走 Key 都能刷额度，这是藏密钥挡不住的。
    """
    enabled = bool(settings.amap_js_key and settings.amap_security_code)
    return MapConfig(
        enabled=enabled,
        key=settings.amap_js_key if enabled else "",
        security_code=settings.amap_security_code if enabled else "",
    )


@router.get("/places/autocomplete", response_model=List[PlaceTip])
def autocomplete_places(q: str, city: str = "", limit: int = 8) -> List[PlaceTip]:
    """目的地输入提示（下拉候选）。

    为什么走后端代理：高德 Key 一旦落到浏览器就等于公开，谁都能拿去刷额度。

    为什么用实时候选而不是「固定下拉列表」：行政区划本身会调整，
    硬编码的列表迟早过期；而且用户的目的地粒度常常不是行政区
    （平潭岛 / 洱海 / 中山陵景区），固定城市列表覆盖不到。

    每条候选都带 adcode——用户点选后前端会把 adcode 一起提交，
    后端直接按主键解析，连「平潭县 / 平潭镇」这种同名歧义都不存在了。
    """
    try:
        tips = orchestrator.retrieve.amap.input_tips(q, city)
    except AmapError as exc:
        raise HTTPException(status_code=503, detail=str(exc))

    capped = max(1, min(limit, 20))
    result: List[PlaceTip] = []
    for tip in tips[:capped]:
        name = tip.get("name") if isinstance(tip.get("name"), str) else ""
        if not name:
            continue

        district = tip.get("district") if isinstance(tip.get("district"), str) else ""
        adcode = tip.get("adcode") if isinstance(tip.get("adcode"), str) else ""

        lat: Optional[float] = None
        lng: Optional[float] = None
        location = tip.get("location") if isinstance(tip.get("location"), str) else ""
        if "," in location:
            lng_text, _, lat_text = location.partition(",")
            try:
                lng, lat = float(lng_text), float(lat_text)
            except ValueError:
                lat = lng = None

        result.append(
            PlaceTip(
                name=name,
                district=district or name,
                adcode=adcode,
                # 判定「这条候选本身是行政区，还是辖区内的某个地点」：
                # 行政区一定有 adcode，且区划路径以它自己的名字结尾
                # （平潭县 → 福建省福州市平潭县）；地点则不是（平潭站）。
                # 只判结尾不够：景区类候选有时 district 就等于名字但没有 adcode，
                # 例如「鼓浪屿」，那样会被误标成行政区。
                kind="行政区" if adcode and district.endswith(name) else "地点",
                lat=lat,
                lng=lng,
            )
        )
    return result


@router.get("/health")
def health() -> Dict[str, Any]:
    """健康检查：返回 Ollama / 高德密钥配置状态。"""
    return {
        "status": "ok",
        "ollama_available": orchestrator.planner.llm.available(),
        "amap_configured": bool(orchestrator.retrieve.amap.key),
    }


@router.get("/plans")
def plans() -> List[Dict[str, Any]]:
    """历史规划列表。"""
    return store.list_plans()


@router.get("/plans/{plan_id}")
def get_plan(plan_id: str) -> Dict[str, Any]:
    """按 ID 读取规划（供导出/分享）。"""
    plan = store.get_plan(plan_id)
    if not plan:
        raise HTTPException(status_code=404, detail="计划不存在")
    return plan


@router.post("/plans/save", response_model=Dict[str, Any])
def save_edited_plan(payload: Dict[str, Any]) -> Dict[str, Any]:
    """保存（覆盖）一条规划：供用户编辑后持久化，下次可从历史计划打开。"""
    store.save_plan(payload)
    return {"ok": True, "plan_id": payload.get("plan_id")}
