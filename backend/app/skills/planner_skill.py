"""Skill3：智能规划生成（核心处理层）。

分工（与用户对齐）：
- **大模型只做它擅长的**：从候选池里挑出"这次要去哪些景点"，给出游玩贴士，
  并且保证必去景点一个不漏。不要求它分天、不要求它排时间——"哪天去哪几个"本质是
  几何问题，交给代码算得更准，输出也更短（生成更快）。
- **系统做确定性的部分**：
  1. 按地理邻近把选中的景点聚成「每天一区」（同一天不会横跨全城）；
  2. **先按综合分定当天酒店**（评分 + 离当天/次日活动区的距离），
     再把酒店当起点做最近邻排序 —— 这样路线不折返；
  3. 按作息规则插午餐/晚餐（不早于 8:00 出发、午餐不晚于 14:00、晚餐不早于 17:30）；
  4. 用高德真实路线算接驳、按真实价格算预算。

只走大模型这一条路：大模型不可用直接抛 LLMUnavailableError，不降级、不伪造数据。
"""
import json
import math
from datetime import date, timedelta
from typing import Any, Dict, List, Optional
from uuid import uuid4

from pydantic import BaseModel, Field

from ..llm.client import LLMClient
from ..models.plan import (
    BudgetBreakdown,
    CheckIssue,
    DailyPlan,
    POI,
    TimelineItem,
    TransportToNext,
    TravelPlan,
    Weather,
)
from ..services.amap import AmapClient
from .base import Skill
from .errors import LLMOutputError, LLMUnavailableError
from .route import cluster_into_days, order_nearest
from .scoring import distance_km, has_location, hotel_score, option_score

# 各类 POI 的默认游玩耗时（小时）
DURATION_BY_TYPE: Dict[str, float] = {
    "景点": 2.5, "餐厅": 1.5, "购物": 2.0, "住宿": 0.5, "交通": 0.5,
}

# 节奏 -> 每天建议景点数
PACE_COUNT: Dict[str, int] = {"悠闲": 2, "适中": 3, "特种兵": 4}

# 作息规则（与用户对齐）：除了特种兵，出发不早于 8 点；午餐不晚于 14 点；晚餐不早于 17:30
DAY_START_EARLIEST = "08:00"
DAY_START_EARLIEST_SPECIAL = "07:00"
LUNCH_EARLIEST = "11:30"
LUNCH_LATEST = "14:00"
DINNER_EARLIEST = "17:30"

# 室内景点关键词：雨天 Plan B 与前端「一键换成室内」保持一致
INDOOR_KEYWORDS = (
    "博物馆", "美术馆", "科技馆", "展览馆", "陈列馆", "图书馆",
    "商场", "购物中心", "剧院", "室内",
)

# 步行阈值（公里）：低于该距离直接步行，不再调驾车路线
WALK_THRESHOLD_KM = 1.5

# 往返大交通估算单价（元/人/单程）：仅用于估算，真实票价以用户购票为准
ROUND_TRIP_UNIT = {"高铁": 150.0, "飞机": 500.0, "自驾": 300.0, "本地": 0.0}

_SYSTEM_PROMPT = """你是一个旅游景点挑选助手。请根据用户画像，从候选景点里挑出这次值得去的景点。
只输出一个合法 JSON 对象，不要输出解释文字或代码块。

输出结构：
{
  "summary": "一句话行程摘要",
  "attractions": [
    {"name": "景点名称（必须与候选列表完全一致）", "tips": "该景点的游玩贴士，可留空"}
  ]
}

硬性要求：
1. 只能使用「候选景点」列表里的景点，name 必须完全一致；禁止编造景点名。
2. 「必去景点」必须全部包含，一个都不能漏。
3. 不要重复列出同一个景点。
4. 景点总数量参考「建议总数量」（= 天数 × 每天景点数），不要明显超出。
5. 优先挑彼此距离较近、能顺路串起来的景点，避免把城市两端最远的点都选上。
6. **不要输出每一天的分配、不要输出时间、不要输出餐厅与酒店**——
   系统会按地理位置自动把景点分到每天，并按"先定酒店、再排路线"的方式安排顺序。
7. 如果输入里给了「需要修正的问题（上一版体检结论）」，请针对这些问题重新挑选。

只输出 JSON。"""


class _DraftItem(BaseModel):
    """大模型给出的单个景点。"""

    name: str
    tips: str = ""


class _DraftPlan(BaseModel):
    """大模型给出的第一版规划（扁平景点清单 + 摘要）。"""

    summary: str = ""
    attractions: List[_DraftItem] = Field(default_factory=list)


def _to_minutes(t: str) -> int:
    """'HH:MM' -> 当天已过分钟数。"""
    h, m = map(int, t.split(":"))
    return h * 60 + m


def _from_minutes(total: int) -> str:
    """当天已过分钟数 -> 'HH:MM'（跨过 24 点按次日显示为 00:xx，仅用于兜底显示）。"""
    return f"{total // 60 % 24:02d}:{total % 60:02d}"


def _is_indoor(poi: POI) -> bool:
    """判断景点是否为室内（雨天可替换户外景点）。"""
    return any(k in poi.name for k in INDOOR_KEYWORDS)


def _match_poi(name: str, pool: List[POI]) -> Optional[POI]:
    """把大模型给出的景点名映射回候选池里的真实 POI（含坐标与价格）。"""
    target = (name or "").strip()
    if not target:
        return None
    for poi in pool:
        if poi.name == target:
            return poi
    for poi in pool:
        if target in poi.name or poi.name in target:
            return poi
    return None


def _duplicate_of(name: str, planned: Dict[str, str]) -> Optional[str]:
    """判断该景点是否已经安排过，返回已安排的那个名称。

    除同名外还要拦住"同一处的不同叫法"——高德对同一片景区会返回多个条目，
    例如「雷峰塔」/「雷峰塔景区」、「西湖」/「杭州西湖风景名胜区」。
    """
    target = (name or "").strip()
    for planned_name in planned:
        if planned_name == target:
            return planned_name
        shorter, longer = sorted((planned_name, target), key=len)
        if len(shorter) >= 2 and shorter in longer:
            return planned_name
    return None


class PlannerSkill(Skill):
    """智能规划生成。"""

    name = "planner"
    description = "大模型选点 + 系统按地理分区、先定酒店再排路线，并算接驳与预算"

    def __init__(self, llm: Optional[LLMClient] = None, amap: Optional[AmapClient] = None):
        self.llm = llm or LLMClient()
        self.amap = amap or AmapClient()

    def run(self, ctx: dict[str, Any]) -> dict[str, Any]:
        # 不保底：没有大模型就明确告诉用户，不用规则引擎硬凑一份规划
        if not self.llm.available():
            raise LLMUnavailableError(
                "未接入大模型 API（本地 Ollama 未启动或未安装），无法生成规划。"
                "请先启动大模型服务后重试。"
            )

        issues: List[CheckIssue] = []
        plan = self._generate(ctx, issues)
        ctx["plan"] = plan
        ctx["plan_issues"] = issues  # 交给 CheckSkill 一起汇总提示用户
        return ctx

    # ---------------- 供 CheckSkill 调用的定向修复 ----------------
    def rebuild_plan(
        self,
        ctx: dict[str, Any],
        plan: TravelPlan,
        issues: List[CheckIssue],
        day_orders: Optional[List[List[POI]]] = None,
    ) -> TravelPlan:
        """按给定的每日景点顺序重新组装规划（酒店 / 时间轴 / 餐厅 / 预算）。

        **不调用大模型**：顺序调好后用同一套组装逻辑重算一遍，口径与首次生成一致。
        """
        pref = ctx["preference"]
        dates = [date.fromisoformat(d.date) for d in plan.daily_plans]
        groups = day_orders or [
            [it.poi for it in d.timeline if it.poi.type == "景点"] for d in plan.daily_plans
        ]
        hotels = self._pick_hotels_for_groups(
            ctx.get("hotel_pool") or ctx.get("hotel_options", []), groups, issues
        )
        days = self._assemble_days(ctx, groups, dates, ctx.get("weather", {}), issues, hotels)
        plan.daily_plans = days
        total, breakdown = self._budget(
            pref,
            days,
            sum(
                (it.transport_to_next.cost if it.transport_to_next else 0)
                for d in days
                for it in d.timeline
            ),
        )
        plan.total_budget_estimate = total
        plan.budget_breakdown = breakdown
        return plan

    def regenerate(
        self, ctx: dict[str, Any], feedback: List[str]
    ) -> tuple[TravelPlan, List[CheckIssue]]:
        """带着体检结论重新生成一版规划（由 CheckSkill 控制次数，最多一次）。"""
        issues: List[CheckIssue] = []
        previous = ctx.pop("revision_feedback", None)
        ctx["revision_feedback"] = feedback
        try:
            plan = self._generate(ctx, issues)
        finally:
            if previous is None:
                ctx.pop("revision_feedback", None)
            else:
                ctx["revision_feedback"] = previous
        ctx["plan"] = plan
        ctx["plan_issues"] = issues
        return plan, issues

    # ---------------- 生成主流程 ----------------
    def _generate(self, ctx: dict[str, Any], issues: List[CheckIssue]) -> TravelPlan:
        pref = ctx["preference"]
        draft = self._llm_draft(ctx)
        pool: List[POI] = ctx.get("attractions", [])
        weather_map: Dict[str, Weather] = ctx.get("weather", {})
        must_pois: List[POI] = ctx.get("must_visit_pois", [])
        must_names = {p.name for p in must_pois}

        transport_note = self._note_budget_basis(pref, issues)
        self._note_resolved_region(ctx, issues)
        self._note_schedule_rules(pref, issues)

        start_date = self._resolve_start_date(pref, issues)
        per_day = PACE_COUNT.get(pref.pace, 3)
        days_n = pref.duration_days

        # 1) 选点：映射真实 POI、去重（含同景区别名）、必去保底、按容量补齐或裁剪
        selected = self._select_pois(
            pool, must_pois, draft, per_day, days_n, issues
        )

        # 2) 按地理邻近分区：每天一区，同一天不横跨全城
        groups = cluster_into_days(selected, days_n, per_day, must_names)
        while len(groups) < days_n:  # 景点太少时也要保证天数结构完整
            groups.append([])

        # 3) 先定酒店：每个区按综合分（评分 + 离当天/次日活动区距离）选一家
        hotels = self._pick_hotels_for_groups(
            ctx.get("hotel_pool") or ctx.get("hotel_options", []), groups, issues
        )

        # 4) 组装每天：以酒店为起点排路线 + 插餐 + 真实接驳
        dates = [start_date + timedelta(days=i) for i in range(days_n)]
        days = self._assemble_days(ctx, groups, dates, weather_map, issues, hotels)

        # 5) 门票价缺失如实说明，免得用户以为门票真的免费
        attraction_items = [it.poi for d in days for it in d.timeline if it.poi.type == "景点"]
        if attraction_items and not any(p.price for p in attraction_items):
            issues.append(
                CheckIssue(
                    category="预算",
                    severity="low",
                    message="景点门票价格未能从高德获取到，预算中的门票按 0 元计。",
                    suggestion="门票以景区官方公示为准；可点景点旁的「导航」查看实时票价与购票入口。",
                )
            )

        total, breakdown = self._budget(
            pref,
            days,
            sum(
                (it.transport_to_next.cost if it.transport_to_next else 0)
                for d in days
                for it in d.timeline
            ),
        )
        return TravelPlan(
            plan_id=str(uuid4()),
            summary=draft.summary.strip() or self._default_summary(pref),
            total_budget_estimate=total,
            budget_breakdown=breakdown,
            daily_plans=days,
            dining_options=ctx.get("dining_options", []),
            hotel_options=ctx.get("hotel_options", []),
            attraction_options=ctx.get("attraction_options", []),
            travelers=pref.travelers.total,
            user_budget=pref.budget,
            user_preference=pref,
            transport_note=transport_note,
        )

    # ---------------- 选点 ----------------
    def _select_pois(
        self,
        pool: List[POI],
        must_pois: List[POI],
        draft: _DraftPlan,
        per_day: int,
        days_n: int,
        issues: List[CheckIssue],
    ) -> List[POI]:
        """把大模型给的名字映射成真实 POI，并做去重、必去保底、容量补齐/裁剪。"""
        planned: Dict[str, str] = {}  # 临时结构：记录已选景点，防止重复推荐
        picked: List[POI] = []

        for item in draft.attractions:
            poi = _match_poi(item.name, pool)
            if poi is None:
                issues.append(
                    CheckIssue(
                        category="地点",
                        severity="high",
                        message=f"大模型给出的景点「{item.name}」不在目的地候选景点内，已跳过。",
                        suggestion="该景点可能不在你填写的目的地，或名称不准确；"
                        "可在下方景点备选池里手动替换。",
                    )
                )
                continue
            dup_of = _duplicate_of(poi.name, planned)
            if dup_of:
                detail = (
                    f"「{dup_of}」被重复推荐（{planned[dup_of]}），已只保留一次。"
                    if item.name == dup_of
                    else f"「{item.name}」与已选的「{dup_of}」是同一处或同一片景区，已只保留一次。"
                )
                issues.append(
                    CheckIssue(
                        category="重复",
                        severity="medium",
                        message=detail,
                        suggestion="同一处不必重复安排，已保留先选的那次。",
                    )
                )
                continue
            planned[poi.name] = "模型推荐"
            if item.tips:
                poi.tips = item.tips
            picked.append(poi)

        # 必去景点保底：模型漏了就由系统补进来（确定性补位，不重排整份）
        for must in must_pois:
            if _duplicate_of(must.name, planned):
                continue
            planned[must.name] = "你点名必去"
            picked.insert(0, must)
            issues.append(
                CheckIssue(
                    category="覆盖",
                    severity="medium",
                    message=f"你点名要去的「{must.name}」大模型没有选进来，已按你的要求补上。",
                    suggestion="若该景点提示「未定位坐标」，建议换个更完整的名称重试。",
                )
            )

        # 容量控制：太少了按综合分（候选池顺序）补足，太多了裁掉靠后的非必去景点
        capacity = max(per_day * days_n, len(must_pois))
        if len(picked) < capacity:
            before = len(picked)
            for poi in pool:
                if len(picked) >= capacity:
                    break
                if _duplicate_of(poi.name, {p.name: "" for p in picked}):
                    continue
                planned[poi.name] = "系统按综合分补齐"
                picked.append(poi)
            if len(picked) > before:
                issues.append(
                    CheckIssue(
                        category="覆盖",
                        severity="low",
                        message=f"大模型只选出 {before} 个景点，已按综合分（热度 + 评分 + 顺路）补足到 {len(picked)} 个。",
                        suggestion="补进来的景点可在下方景点备选池里替换成你更想去的。",
                    )
                )
        elif len(picked) > capacity:
            keep, dropped = [], 0
            for poi in picked:
                is_must = poi.name in {m.name for m in must_pois}
                if not is_must and len(keep) >= capacity - len(must_pois):
                    dropped += 1
                    continue
                keep.append(poi)
            picked = keep
            if dropped:
                issues.append(
                    CheckIssue(
                        category="覆盖",
                        severity="low",
                        message=f"大模型选出的景点超过日程容量，已按综合分保留前 {len(picked)} 个（去掉 {dropped} 个）。",
                        suggestion="想都去可以增加天数，或提高节奏强度。",
                    )
                )
        return picked

    # ---------------- 酒店优先 ----------------
    def _pick_hotels_for_groups(
        self, hotel_pool: List[POI], groups: List[List[POI]], issues: List[CheckIssue]
    ) -> List[Optional[POI]]:
        """每个区先定一家酒店：评分 + 离当天活动区 + 离次日活动区。

        最后一晚不需要酒店（当天返程）。候选池为空时如实记录问题，不编造酒店。

        **允许连住同一家**。这里曾经把「前一晚用过的酒店」硬排除掉，
        结果是每晚强制换店：为了"换一家"，第二晚只能退而求其次选更远的。
        实测 99 个住宿夜里，有 8 次是本可以在更近的酒店（近 2~4 公里）里选，
        却只因为它前一夜用过而被迫选远的。
        现实里同一城市连住同一家才是常态，也不用来回搬行李，
        所以直接放开，让评分自己决定要不要换——同一家仍然最优就继续住。
        """
        nights = max(len(groups) - 1, 0)
        hotels: List[Optional[POI]] = []
        for i in range(len(groups)):
            if i >= nights:
                hotels.append(None)
                continue
            if not hotel_pool:
                issues.append(
                    CheckIssue(
                        category="其他",
                        severity="medium",
                        message="没有可用的酒店候选，未安排住宿。",
                        suggestion="可在酒店备选池中手动选择，或换个目的地描述重试。",
                    )
                )
                hotels.append(None)
                continue
            next_group = groups[i + 1] if i + 1 < len(groups) else None
            hotels.append(
                max(hotel_pool, key=lambda h: hotel_score(h, groups[i], next_group))
            )
        return hotels

    # ---------------- 与大模型交互 ----------------
    def _llm_draft(self, ctx: dict[str, Any]) -> _DraftPlan:
        """把精简后的画像、候选景点、天气交给大模型，拿回"要去哪些景点"。"""
        pref = ctx["preference"]
        pool: List[POI] = ctx.get("attractions", [])
        weather: Dict[str, Weather] = ctx.get("weather", {})
        feedback = ctx.get("revision_feedback") or []

        # 只给必要的字段与候选：提示词越短，本地模型出结果越快（延迟主要来自预填充与生成长度）
        candidates = [
            {
                "name": p.name,
                "rating": p.rating,
                "price": p.price,
                "lat": round(p.location.lat, 4),
                "lng": round(p.location.lng, 4),
            }
            for p in pool[:15]
        ]
        per_day = PACE_COUNT.get(pref.pace, 3)
        payload = json.dumps(
            {
                "目的地": pref.destination,
                "天数": pref.duration_days,
                "出行人数": pref.travelers.model_dump(),
                "总预算": pref.budget,
                "兴趣导向": pref.preferences,
                "节奏": pref.pace or "未指定（默认适中）",
                "同行特征": {
                    "携带儿童": pref.travelers.children > 0,
                    "携带老人": pref.travelers.elderly > 0,
                },
                "饮食禁忌": pref.dietary_restrictions,
                "讨厌的项目": pref.avoidances,
                "必去景点（必须全部包含）": pref.must_visit,
                "建议总数量": pref.duration_days * per_day,
                "候选景点": candidates,
                "天气": {d: w.condition for d, w in list(weather.items())[:pref.duration_days]},
                **({"需要修正的问题（上一版体检结论）": feedback} if feedback else {}),
            },
            ensure_ascii=False,
        )
        # 温度调低：这类"按约束挑选"的任务不需要发散，稳定输出更重要
        data = self.llm.chat_json(
            _SYSTEM_PROMPT,
            payload,
            options={"temperature": 0.2, "num_predict": 700, "num_ctx": 4096},
        )
        if data is None:
            raise LLMOutputError(
                "大模型没有返回可解析的规划 JSON"
                + (f"：{self.llm.last_error}" if self.llm.last_error else "")
                + "。请重试。"
            )
        try:
            return _DraftPlan.model_validate(data)
        except Exception as exc:
            raise LLMOutputError(
                f"大模型返回的规划结构不符合约定（{exc}）。请重试。"
            ) from exc

    # ---------------- 系统组装：路线 / 用餐 / 交通 ----------------
    def _assemble_days(
        self,
        ctx: dict[str, Any],
        groups: List[List[POI]],
        dates: List[date],
        weather_map: Dict[str, Weather],
        issues: List[CheckIssue],
        hotels: List[Optional[POI]],
    ) -> List[DailyPlan]:
        pref = ctx["preference"]
        dining_pool: List[POI] = ctx.get("dining_pool") or ctx.get("dining_options", [])
        attraction_options: List[POI] = ctx.get("attraction_options", [])
        rag_tips: List[str] = ctx.get("rag_tips", [])
        must_names = {p.name for p in ctx.get("must_visit_pois", [])}

        used_meals: set = set()
        days: List[DailyPlan] = []
        for i, day_pois in enumerate(groups):
            day_date = dates[i].isoformat()
            # 当天出发点 = 前一晚住的酒店；第一天没有则从第一个景点算起
            start_poi = hotels[i - 1] if i > 0 else None
            night_hotel = hotels[i] if i < len(hotels) else None
            ordered = order_nearest(day_pois, start_poi) if len(day_pois) > 1 else list(day_pois)
            timeline, dropped = self._build_timeline(
                pref, ordered, start_poi, night_hotel, dining_pool, used_meals, must_names,
                day_date, issues,
            )

            weather = weather_map.get(day_date)
            if weather is None:
                weather = Weather(condition="", temp="")
                issues.append(
                    CheckIssue(
                        category="时间",
                        severity="low",
                        message=f"{day_date} 超出天气预报可覆盖范围，当天暂无预报。",
                        suggestion="临近出行前再刷新一次，可拿到更准的天气。",
                    )
                )

            days.append(
                DailyPlan(
                    date=day_date,
                    weather=weather,
                    timeline=timeline,
                    plan_b=self._plan_b(weather, attraction_options, {p.name for p in day_pois}),
                    tips=rag_tips,
                    hotel=night_hotel,
                )
            )
        return days

    def _build_timeline(
        self,
        pref: Any,
        day_pois: List[POI],
        start_poi: Optional[POI],
        night_hotel: Optional[POI],
        dining_pool: List[POI],
        used_meals: set,
        must_names: set,
        day_date: str,
        issues: List[CheckIssue],
    ) -> tuple[List[TimelineItem], List[str]]:
        """把当天景点串成时间轴：酒店出发 → 景点 → 午餐 → 景点 → 晚餐。

        时间规则（与用户对齐）：
        - 出发：非特种兵不早于 8:00，特种兵不早于 7:00；
        - 午餐：在"已经过了 11:30"之后、且还没到 14:00 时安排；
        - 晚餐：不早于 17:30；
        - 超过期望的回酒店时间时，优先砍掉靠后的「非必去景点」，而不是砍掉晚餐。
        """
        if not day_pois:
            return [], []

        earliest = (
            DAY_START_EARLIEST_SPECIAL if pref.pace == "特种兵" else DAY_START_EARLIEST
        )
        day_start = max(_to_minutes(pref.departure_time or "09:00"), _to_minutes(earliest))
        cutoff = _to_minutes(pref.return_hotel_time or "21:00")

        attractions = list(day_pois)
        trimmed: List[str] = []
        while True:
            attempt_meals = set(used_meals)
            timeline, end_min, attempt_meals = self._simulate_day(
                pref, attractions, start_poi, night_hotel, dining_pool, attempt_meals,
                day_start, issues,
            )
            if end_min <= cutoff:
                used_meals.clear()
                used_meals.update(attempt_meals)
                break
            droppable = [i for i, p in enumerate(attractions) if p.name not in must_names]
            if not droppable:
                issues.append(
                    CheckIssue(
                        category="时间",
                        severity="medium",
                        message=f"{day_date} 的安排会超过你期望的 {pref.return_hotel_time or '21:00'} 回酒店时间，"
                        "但当天剩下的都是你点名必去的景点，未做删减。",
                        suggestion="可以把节奏调成「悠闲」、增加天数，或把回酒店时间调晚。",
                    )
                )
                break
            trimmed.append(attractions.pop(droppable[-1]).name)

        if trimmed:
            issues.append(
                CheckIssue(
                    category="时间",
                    severity="medium",
                    message=f"{day_date} 的安排会超过你期望的 {pref.return_hotel_time or '21:00'} 回酒店时间，"
                    "已去掉排在最后的景点：" + "、".join(reversed(trimmed)) + "。",
                    suggestion="想保留这些点，可以增加天数、把节奏调成「悠闲」，或把回酒店时间调晚。",
                )
            )
        return timeline, trimmed

    def _simulate_day(
        self,
        pref: Any,
        attractions: List[POI],
        start_poi: Optional[POI],
        night_hotel: Optional[POI],
        dining_pool: List[POI],
        used_meals: set,
        day_start: int,
        issues: List[CheckIssue],
    ) -> tuple[List[TimelineItem], int, set]:
        """算一天的时间轴，返回 (时间轴, 结束分钟, 用掉的餐厅)。"""
        # 1) 先定顺序：景点 + 午餐 + 晚餐（用直线距离粗估到达时间，避免重复调高德）
        seq: List[POI] = []
        cursor = day_start
        prev_poi: Optional[POI] = start_poi
        lunch_done = False

        for idx, poi in enumerate(attractions):
            # 两个条件任一满足就在这个景点之前安排午餐：
            # 1) 已经到了饭点（11:30 之后）；
            # 2) 这是当天最后一个景点——宁可午饭稍早点，也不能把它排到所有景点之后
            #    （以前就出现过"下午两点多才吃午饭"）。
            is_last = idx == len(attractions) - 1
            if not lunch_done and seq and (
                cursor >= _to_minutes(LUNCH_EARLIEST) or is_last
            ):
                lunch = self._pick_meal(dining_pool, used_meals, prev_poi, poi)
                if lunch is not None:
                    seq.append(lunch)
                    prev_poi = lunch
                lunch_done = True
            seq.append(poi)
            cursor += int(DURATION_BY_TYPE.get(poi.type, 2.0) * 60)
            nxt = attractions[idx + 1] if idx + 1 < len(attractions) else None
            if nxt is not None:
                cursor += self._estimate_travel_minutes(poi, nxt)
            prev_poi = poi

        if not lunch_done:
            # 一整天都在赶路（景点少、路途远）：午餐安排在最后一个景点之后
            lunch = self._pick_meal(dining_pool, used_meals, prev_poi, None)
            if lunch is not None:
                seq.append(lunch)
                prev_poi = lunch

        # 晚餐的"下一站"是当晚要住的酒店：吃完回酒店这段路也要顺，别为了吃饭绕远
        dinner = self._pick_meal(dining_pool, used_meals, prev_poi, night_hotel)
        if dinner is not None:
            seq.append(dinner)

        # 局部优化：按综合分选出来的餐厅可能让整天路线绕远（例如午饭在反方向），
        # 这里逐个餐位试换候选，选"当天总移动距离最短"的那个。
        self._optimize_meals(seq, dining_pool, used_meals)

        if not any(p.type == "餐厅" for p in seq):
            issues.append(
                CheckIssue(
                    category="其他",
                    severity="medium",
                    message="没有可用的餐厅候选，当天未安排用餐。",
                    suggestion="可在餐厅备选池中手动添加，或换个目的地描述重试。",
                )
            )

        # 2) 再按真实接驳算时间轴（这里才调高德路线）
        items: List[TimelineItem] = []
        cursor = day_start
        for idx, poi in enumerate(seq):
            if poi.type == "餐厅":
                earliest_meal = (
                    LUNCH_EARLIEST if not any(i.poi.type == "餐厅" for i in items) else DINNER_EARLIEST
                )
                cursor = max(cursor, _to_minutes(earliest_meal))
                if earliest_meal == LUNCH_EARLIEST and cursor > _to_minutes(LUNCH_LATEST):
                    issues.append(
                        CheckIssue(
                            category="时间",
                            severity="low",
                            message=f"当天午餐安排到了 {_from_minutes(cursor)}（晚于 {LUNCH_LATEST}），"
                            "说明上午的景点或路上耗时较长。",
                            suggestion="可以把节奏调成「悠闲」，或减少当天的景点数量。",
                        )
                    )
            end = cursor + int(DURATION_BY_TYPE.get(poi.type, 2.0) * 60)
            item = TimelineItem(
                time=f"{_from_minutes(cursor)}-{_from_minutes(end)}", poi=poi, tips=poi.tips
            )
            items.append(item)
            cursor = end
            if idx < len(seq) - 1:
                nxt = seq[idx + 1]
                try:
                    leg = self._transport(poi, nxt)
                except Exception as exc:
                    leg = None
                    issues.append(
                        CheckIssue(
                            category="路径",
                            severity="low",
                            message=f"{poi.name} → {nxt.name} 的接驳路线暂时取不到（{exc}）。",
                            suggestion="可到场后用地图实时导航。",
                        )
                    )
                if leg is not None:
                    mode, leg_minutes, cost, leg_km = leg
                    item.transport_to_next = TransportToNext(
                        mode=mode,
                        duration=f"{leg_minutes}分钟",
                        cost=cost,
                        distance_km=leg_km,
                    )
                    cursor += leg_minutes
        return items, cursor, used_meals

    @staticmethod
    def _optimize_meals(seq: List[POI], pool: List[POI], used_meals: set) -> None:
        """在"当天总距离最短"的目标下微调餐厅选择（只动餐厅，不动景点顺序）。"""

        def _total_km(points: List[POI]) -> float:
            legs = [distance_km(points[i], points[i + 1]) for i in range(len(points) - 1)]
            return sum(d for d in legs if d is not None)

        for idx, poi in enumerate(seq):
            if poi.type != "餐厅":
                continue
            best, best_km = poi, _total_km(seq)
            for candidate in pool:
                if candidate.name == poi.name or candidate.name in used_meals:
                    continue
                trial = list(seq)
                trial[idx] = candidate
                km = _total_km(trial)
                if km < best_km - 0.01:
                    best, best_km = candidate, km
            if best is not poi:
                used_meals.discard(poi.name)
                used_meals.add(best.name)
                seq[idx] = best

    @staticmethod
    def _pick_meal(
        pool: List[POI],
        used: set,
        prev_poi: Optional[POI],
        next_poi: Optional[POI],
    ) -> Optional[POI]:
        """按综合分挑餐厅（离前后景点越近、评分越高越优先），全程不重复。"""
        candidates = [p for p in pool if p.name not in used]
        if not candidates:
            return None
        best = max(candidates, key=lambda p: option_score(p, prev_poi, next_poi))
        used.add(best.name)
        return best

    @staticmethod
    def _estimate_travel_minutes(a: POI, b: POI) -> int:
        """粗估两点耗时（只用于决定午餐插在哪，不调用高德）。"""
        d = distance_km(a, b)
        if d is None:
            return 15
        if d < WALK_THRESHOLD_KM:
            return max(int(d / 4.5 * 60) + 5, 5)
        return max(int(d / 20 * 60) + 5, 8)

    def _transport(self, a: POI, b: POI) -> Optional[tuple[str, int, float, float]]:
        """两点间交通：返回 (方式, 分钟, 费用, 公里)；坐标缺失返回 None。"""
        if not (has_location(a) and has_location(b)):
            return None
        dist = distance_km(a, b)
        if dist is not None and dist < WALK_THRESHOLD_KM:
            minutes = max(int(dist / 4.5 * 60) + 5, 5)
            return "步行", minutes, 0.0, round(dist, 2)
        # 长距离走高德真实驾车路线（真实耗时 + 打车费）
        data = self.amap.get_route(
            f"{a.location.lng},{a.location.lat}",
            f"{b.location.lng},{b.location.lat}",
            "driving",
        )
        route = data["route"]
        path = route["paths"][0]
        duration_sec = int(path.get("duration", 0))
        cost = float(route.get("taxi_cost") or 0)  # 打车费在 route.taxi_cost
        # 里程就在同一个响应里，顺手带出去给体检用，不额外发请求
        road_km = round(float(path.get("distance") or 0) / 1000.0, 2)
        return "打车", max(duration_sec // 60, 1), round(cost, 1), road_km

    @staticmethod
    def _plan_b(weather: Weather, attractions: List[POI], used_names: set) -> str:
        """雨天备选方案：替换为当天没排过的室内景点。"""
        if not weather.condition or "雨" not in weather.condition:
            return ""
        indoor = [p.name for p in attractions if _is_indoor(p) and p.name not in used_names]
        if indoor:
            return "今日有雨，可改为室内：" + "、".join(indoor[:3])
        return "今日有雨，建议改为室内博物馆/商场，或调整行程。"

    # ---------------- 说明与预算 ----------------
    def _note_budget_basis(self, pref: Any, issues: List[CheckIssue]) -> str:
        """把预算口径讲清楚：往返交通是估算值，真实机票/高铁票以用户购票为准。

        返回的文案会挂到 plan.transport_note 上，前端直接显示在预算栏里。
        """
        if not pref.transportation:
            note = "未填写往返交通方式，预算未包含往返大交通（机票 / 高铁票等）。"
            issues.append(
                CheckIssue(
                    category="预算",
                    severity="low",
                    message="你没有填写往返交通方式，预算未包含往返大交通。",
                    suggestion="补上往返交通方式（高铁 / 飞机 / 自驾）后重新生成，预算会更准。",
                )
            )
            return note
        people = pref.travelers.total
        unit = ROUND_TRIP_UNIT.get(pref.transportation, 0.0)
        if unit <= 0:
            return ""
        if pref.transportation == "自驾":
            detail = f"自驾按全程约 {unit:.0f} 元估算"
        else:
            detail = f"按「{pref.transportation} {unit:.0f} 元/人/单程 × 2 程 × {people} 人 = {unit * 2 * people:.0f} 元」估算"
        note = (
            f"往返大交通为估算值（{detail}）；"
            "你自己买的机票 / 高铁票价格（折扣、舱位、购票时间不同）可能与此不同，"
            "本预算未包含真实票价差额，以实际购票为准。"
        )
        issues.append(
            CheckIssue(
                category="预算",
                severity="low",
                message=note,
                suggestion="机票 / 高铁票以你的实际购票金额为准。",
            )
        )
        return note

    @staticmethod
    def _note_resolved_region(ctx: dict[str, Any], issues: List[CheckIssue]) -> None:
        """目的地被高德规范化解析时如实告知用户，而不是悄悄换个地方检索。"""
        region = ctx.get("resolved_region") or {}
        original = (region.get("input") or "").strip()
        city = (region.get("city") or "").strip()
        if not original or not city:
            return
        if original in city or city in original:
            return
        issues.append(
            CheckIssue(
                category="地点",
                severity="low",
                message=f"目的地「{original}」已按高德行政区划解析为「{city}」进行检索。",
                suggestion="若解析得不对，换个更明确的写法（例如直接写城市名）再生成一次。",
            )
        )

    @staticmethod
    def _note_schedule_rules(pref: Any, issues: List[CheckIssue]) -> None:
        """出发时间早于节奏下限时如实说明——不悄悄改掉用户填的时间。"""
        raw = (pref.departure_time or "").strip()
        if not raw:
            return
        earliest = DAY_START_EARLIEST_SPECIAL if pref.pace == "特种兵" else DAY_START_EARLIEST
        try:
            requested = _to_minutes(raw)
        except (ValueError, AttributeError):
            return
        if requested < _to_minutes(earliest):
            issues.append(
                CheckIssue(
                    category="时间",
                    severity="low",
                    message=f"你填的出发时间 {raw} 早于「{pref.pace or '适中'}」节奏的建议下限，"
                    f"已按 {earliest} 安排。",
                    suggestion=f"想更早出发，可以把节奏调成「特种兵」（下限 {DAY_START_EARLIEST_SPECIAL}）。",
                )
            )

    @staticmethod
    def _resolve_start_date(pref: Any, issues: List[CheckIssue]) -> date:
        raw = pref.start_date or date.today().isoformat()
        try:
            return date.fromisoformat(raw)
        except ValueError:
            issues.append(
                CheckIssue(
                    category="时间",
                    severity="medium",
                    message=f"出行日期「{raw}」格式无法识别，已按今天开始计算。",
                    suggestion="建议填写 YYYY-MM-DD 格式的出行日期。",
                )
            )
            return date.today()

    @staticmethod
    def _default_summary(pref: Any) -> str:
        tags = "·".join(pref.preferences) if pref.preferences else ""
        return f"{pref.destination}{pref.duration_days}日{pref.pace or '适中'}{tags}游"

    def _budget(self, pref: Any, days: List[DailyPlan], transport_sum: float):
        """预算拆解（估算，价格以实时为准）。

        口径说明（前端编辑后按同一口径实时重算）：
        - 门票：规划中所有景点票价求和（高德未提供票价记 0）
        - 餐饮：按每餐所选餐厅人均 × 出行人数求和（无人均按 60 元/餐/人）
        - 住宿：按每个夜晚所选酒店每晚价 × 房间数求和（未选到酒店按 350 元/晚/间）
        - 交通：景点间接驳 + 往返大交通（估算值，真实票价以购票为准）
        """
        days_n = pref.duration_days
        people = pref.travelers.total
        nights = max(days_n - 1, 0)
        rooms = max(1, math.ceil(people / 2))
        tickets = sum(
            it.poi.price or 0 for d in days for it in d.timeline if it.poi.type == "景点"
        )
        meals = [it.poi for d in days for it in d.timeline if it.poi.type == "餐厅"]
        dining = sum((m.price or 60) for m in meals) * people
        hotel = sum((d.hotel.price if d.hotel else 350) for d in days[:nights]) * rooms
        transport = round(transport_sum + self._round_trip(pref), 1)
        total = round(tickets + dining + hotel + transport, 1)
        breakdown = BudgetBreakdown(
            transport=round(transport, 1), tickets=round(tickets, 1),
            dining=round(dining, 1), hotel=round(hotel, 1),
        )
        return total, breakdown

    @staticmethod
    def _round_trip(pref: Any) -> float:
        """往返大交通估算（未填写交通方式时返回 0，并由体检明确提示用户）。"""
        people = pref.travelers.total
        if pref.transportation == "高铁":
            return 150 * people * 2
        if pref.transportation == "飞机":
            return 500 * people * 2
        if pref.transportation == "自驾":
            return 300
        return 0
