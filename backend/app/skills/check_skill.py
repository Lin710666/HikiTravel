"""Skill4：规划体检与定向修复。

流程（检查 → 优化 → 再判断 → 必要时重新生成）：
1. **确定性路线体检**：用真实坐标算每天的总移动距离、折返、超长单段——
   这类问题不用问大模型，算就是了；
2. **定向优化**：按最近邻重排每天的景点顺序（从当天起点出发），
   然后用和首次生成同一套逻辑重建时间轴、餐厅、酒店与预算。
   **不调用大模型**，所以是秒级、可复现的；只换顺序，不换景点；
3. **大模型审查**：把最终这版规划喂回大模型，让它判断通盘合理性
   （路径是否合理、点位是否都在目的地、时间与预算是否匹配等）；
4. **带反馈重新生成**：只有在"硬伤"（系统判定的严重问题、优化后仍然存在的
   长距离挪动）还没解决时，才带着这些问题重新生成一版（最多一次）。
   ——如果直接整份作废重排，既慢又不稳定，所以这里只修该修的，且只修一次。

体检结论只报告、不悄悄改；凡是系统自动改过的（路线顺序、重新生成），
都会在结论里明确写出来给用户看。
"""
import json
import re
from typing import Any, List, Optional

from ..llm.client import LLMClient
from ..models.plan import CheckIssue, PlanCheck, TravelPlan
from .base import Skill
from .errors import LLMOutputError, LLMUnavailableError
from .route import day_route_stats, order_nearest
from .scoring import distance_km, has_location

_SYSTEM_PROMPT = """你是一个严格的旅游行程审稿人。下面给你一份已经排好的行程规划，
请逐项审查它是否合理，并只输出一个合法 JSON 对象（不要输出解释文字、不要用代码块）。

输出结构：
{
  "passed": true 或 false,
  "summary": "一句话体检结论",
  "issues": [
    {
      "category": "路径 | 地点 | 重复 | 覆盖 | 时间 | 预算 | 其他",
      "severity": "high | medium | low",
      "message": "问题是什么（说人话，直接指出哪天哪个点）",
      "suggestion": "建议用户怎么处理"
    }
  ]
}

重点审查以下方面，发现问题就要写进 issues：
1. 路径合理性：同一天内的点位是否来回折返、走了冤枉路？是否把相距很远的景点硬塞在同一天？
2. 地点正确性：行程里的景点、餐厅、酒店是否都在用户填写的目的地范围内？有没有明显属于其他城市的地名？
3. 重复：有没有景点被安排在两天里重复出现？餐厅/酒店是否全程重复使用？
4. 覆盖：用户点名"必去"的景点是否全部出现在行程里？
5. 时间：每天时间轴是否连贯、有没有时间重叠、有没有过满（连续 12 小时以上）或过空？
6. 预算：预算分项与行程是否匹配，有没有明显漏项？

补充要求（很重要，避免误报）：
- 只根据上面给出的数据下结论，不要臆测不存在的日期、景点或行程
  （例如行程只有 3 天，就不要提"第 5 天"）。
- 预算分项已经给出：某项金额大于 0 时，不要写"未包含该项费用"。
- 景点顺序已经由系统按真实坐标做过最近邻优化，所以不要凭感觉说"顺序不合理"；
  确实发现点位之间距离过远再指出，并说明具体是哪两个点。
- 距离问题以数据为准：每天已经给出「当日移动距离(公里)」，每段也给了交通方式与耗时。
  只有出现「单段耗时超过 60 分钟」「当天移动距离超过 40 公里」「同一段路线往返两次」
  这三种情况之一时，才提示路线问题；15 分钟以内的步行不要提示。
- 描述问题时引用行程里的具体日期与名称，便于用户核对。
- 同一个问题只写一条，不要换着说法重复列。
- 输出尽量精简：issues 最多 3 条，每条 message 一句话讲清"哪天、哪个点、什么问题"。

只输出 JSON。"""


class CheckSkill(Skill):
    """规划体检与定向修复（路线优化 + 大模型审查 + 一次性重生成）。"""

    name = "check"
    description = "检查路线与合理性、按真实坐标优化顺序，必要时带反馈重新生成一次"

    def __init__(
        self,
        llm: Optional[LLMClient] = None,
        planner: Any = None,
        max_regenerate: int = 1,
        check_model: str = "",
    ):
        self.llm = llm or LLMClient()
        self.planner = planner  # PlannerSkill：用于重建/重新生成
        self.max_regenerate = max_regenerate
        self.check_model = check_model

    def run(self, ctx: dict[str, Any]) -> dict[str, Any]:
        plan: TravelPlan = ctx["plan"]

        # 体检是核心能力，不做"可关闭"开关：大模型不可用就明确报错，而不是悄悄跳过
        if not self.llm.available():
            raise LLMUnavailableError(
                "未接入大模型 API（本地 Ollama 未启动或未安装），无法对规划做合理性体检。"
            )

        # 1) 确定性路线优化 + 只报告优化后仍存在的问题
        issues: List[CheckIssue] = list(ctx.get("plan_issues", []))
        issues += self._optimize_routes(ctx, plan)
        issues += self._route_issues(plan)

        # 2) 硬伤（系统判定 / 路线）未解决 → 带着问题重新生成一次，再体检一遍
        if self.max_regenerate > 0 and self.planner is not None and self._has_high(issues):
            outcome = self._regenerate(ctx, plan, issues)
            if outcome is not None:
                plan, regen_notes = outcome
                issues = list(ctx.get("plan_issues", [])) + regen_notes
                issues += self._route_issues(plan)
                issues.append(
                    CheckIssue(
                        category="其他",
                        severity="low",
                        message="已按上一版体检结论重新生成一版规划。",
                        suggestion="若仍不满意，可补全信息（如往返交通、节奏）后再次生成。",
                    )
                )

        # 3) 大模型审查（审的是最终这一版规划）
        issues += self._llm_review(plan, ctx)

        # 摘要自己生成：大模型的原话可能提到已被事实校验过滤掉的误报，会自相矛盾
        if issues:
            kinds = "、".join(sorted({i.category for i in issues}))
            summary = f"体检发现 {len(issues)} 个需要留意的问题（{kinds}）。"
        else:
            summary = "体检通过：没有发现明显问题。"
        plan.checks = PlanCheck(passed=len(issues) == 0, summary=summary, issues=issues)
        ctx["plan"] = plan
        return ctx

    # ---------------- 确定性路线体检与优化 ----------------
    def _optimize_routes(
        self, ctx: dict[str, Any], plan: TravelPlan
    ) -> List[CheckIssue]:
        """按最近邻重排每天景点顺序并重建规划；返回"改动说明"（没有改动就返回空）。"""
        if self.planner is None:
            return []

        day_orders: List[List] = []
        changed: List[tuple[int, float, float]] = []  # (第几天, 原距离, 优化后距离)
        for i, day in enumerate(plan.daily_plans):
            attractions = [it.poi for it in day.timeline if it.poi.type == "景点"]
            # 当天起点：前一晚住的酒店（第一天没有则用现有顺序的第一个点）
            start = plan.daily_plans[i - 1].hotel if i > 0 else None
            reordered = order_nearest(attractions, start) if len(attractions) > 1 else attractions
            before_km = self._distance_km_of(attractions, start)
            after_km = self._distance_km_of(reordered, start)
            # 只在真的更省路时才换顺序，并用同一个口径记录前后距离
            if [p.name for p in reordered] != [p.name for p in attractions] and after_km < before_km:
                changed.append((i, before_km, after_km))
            else:
                reordered = attractions
            day_orders.append(reordered)

        if not changed:
            return []

        rebuild_issues: List[CheckIssue] = []
        self.planner.rebuild_plan(ctx, plan, rebuild_issues, day_orders)

        details = "；".join(
            f"{plan.daily_plans[i].date} 景点间移动 {before:.0f} → {after:.0f} 公里"
            for i, before, after in changed
        )
        return rebuild_issues + [
            CheckIssue(
                category="路径",
                severity="low",
                message=f"已按真实坐标优化当天景点顺序（{details}）。",
                suggestion="顺序是按高德坐标算的最近邻；想按自己的习惯走，可以手动调整。",
            )
        ]

    @staticmethod
    def _distance_km_of(pois: List, start) -> float:
        """从起点出发走完这些点的总距离（用于判断重排到底有没有更省路）。"""
        from .route import total_distance_km

        return total_distance_km(([start] if start is not None else []) + list(pois))

    @staticmethod
    def _day_points(day) -> List:
        """当天时间轴上的点（景点 + 餐厅），用于算移动距离。"""
        return [it.poi for it in day.timeline]

    def _route_issues(self, plan: TravelPlan) -> List[CheckIssue]:
        """报告优化后仍然存在的路线问题（长距离挪动、折返）。"""
        issues: List[CheckIssue] = []
        for day in plan.daily_plans:
            stats = day_route_stats(self._day_points(day))
            for a, b, km in stats["long_legs"][:2]:
                issues.append(
                    CheckIssue(
                        category="路径",
                        severity="medium",
                        message=f"{day.date} 有一大段移动：{a} → {b} 约 {km:.0f} 公里。",
                        suggestion="这一处离当天其它点很远，建议换到更近的那天，或从景点备选池换成顺路的点。",
                    )
                )
            for a, b, c, extra in stats["backtracks"][:2]:
                issues.append(
                    CheckIssue(
                        category="路径",
                        severity="medium",
                        message=f"{day.date} 的 {a} → {b} → {c} 属于折返，多跑约 {extra:.0f} 公里。",
                        suggestion="调整这三处的先后顺序可以省下这段路。",
                    )
                )
        return issues

    @staticmethod
    def _has_high(issues: List[CheckIssue]) -> bool:
        return any(i.severity == "high" for i in issues)

    # ---------------- 带反馈重新生成（最多一次） ----------------
    def _regenerate(
        self, ctx: dict[str, Any], plan: TravelPlan, issues: List[CheckIssue]
    ) -> Optional[tuple[TravelPlan, List[CheckIssue]]]:
        """把尚未解决的严重问题当反馈，让规划器重新排一版；更差就保留原版。

        返回 (新规划, 新规划上的提示)，返回 None 表示"保留原版"。
        """
        feedback = [i.message for i in issues if i.severity == "high"][:5]
        if not feedback:
            return None
        old_issues = list(ctx.get("plan_issues", []))
        try:
            new_plan, new_issues = self.planner.regenerate(ctx, feedback)
        except (LLMOutputError, LLMUnavailableError):
            # 重新生成失败：保留现有规划，不折腾用户
            ctx["plan"] = plan
            ctx["plan_issues"] = old_issues
            return None

        # 新版也做一次确定性路线优化，两版在同一条件下比较
        notes = self._optimize_routes(ctx, new_plan)
        if self._metric(new_plan, new_issues) < self._metric(plan, old_issues):
            return new_plan, notes

        # 新版没更好：把原版放回去（重新生成只是尝试，不该让结果变差）
        ctx["plan"] = plan
        ctx["plan_issues"] = old_issues
        return None

    def _metric(self, plan: TravelPlan, issues: List[CheckIssue]) -> tuple:
        """比较两版规划好坏的粗略尺子：先看严重问题数，再看总移动距离。"""
        high = sum(1 for i in issues if i.severity == "high")
        total_km = sum(
            day_route_stats(self._day_points(d))["total_km"] for d in plan.daily_plans
        )
        return (high, round(total_km, 1))

    # ---------------- 大模型审查 ----------------
    def _llm_review(
        self, plan: TravelPlan, ctx: dict[str, Any]
    ) -> List[CheckIssue]:
        """把规划喂回大模型，取回问题清单（摘要由系统自己生成，避免与过滤后的问题矛盾）。"""
        pref = ctx["preference"]
        payload = json.dumps(
            {
                # 只给审查真正需要的字段：提示词越短，本地模型出结论越快
                "目的地": pref.destination,
                "必去景点": pref.must_visit,
                "出行人数": pref.travelers.model_dump(),
                "节奏": pref.pace,
                "行程天数（不要提到这个范围以外的第 N 天）": len(plan.daily_plans),
                "日期范围": (
                    f"{plan.daily_plans[0].date} ~ {plan.daily_plans[-1].date}"
                    if plan.daily_plans
                    else ""
                ),
                "住宿晚数": max(len(plan.daily_plans) - 1, 0),
                "预算": {
                    "总预算估算": plan.total_budget_estimate,
                    "分项": plan.budget_breakdown.model_dump(),
                    "用户预算": plan.user_budget,
                },
                "行程": [
                    {
                        "日期": day.date,
                        "天气": day.weather.model_dump(),
                        "当晚酒店": (day.hotel.name if day.hotel else None),
                        "当日移动距离(公里)": day_route_stats(self._day_points(day))["total_km"],
                        "安排": [
                            {
                                "时间": item.time,
                                "类型": item.poi.type,
                                "名称": item.poi.name,
                                "地址": item.poi.description,
                                "下一段交通": (
                                    f"{item.transport_to_next.mode} "
                                    f"{item.transport_to_next.duration}"
                                    if item.transport_to_next
                                    else None
                                ),
                            }
                            for item in day.timeline
                        ],
                    }
                    for day in plan.daily_plans
                ],
            },
            ensure_ascii=False,
        )

        data = self.llm.chat_json(
            _SYSTEM_PROMPT,
            payload,
            options={"temperature": 0.1, "num_predict": 350, "num_ctx": 4096},
            model=self.check_model or None,
        )
        if data is None:
            raise LLMOutputError(
                "规划体检失败：大模型没有返回可解析的 JSON 结果"
                + (f"（{self.llm.last_error}）" if self.llm.last_error else "")
                + "。请重试。"
            )

        raw_issues = data.get("issues")
        if not isinstance(raw_issues, list):
            if data.get("passed") is False:
                return [
                    CheckIssue(
                        category="其他",
                        severity="low",
                        message="规划体检未通过，但大模型没有给出具体问题。",
                        suggestion="建议人工核对一遍行程顺序与距离，或重新生成一次。",
                    )
                ]
            return []

        issues: List[CheckIssue] = []
        for raw in raw_issues:
            if not isinstance(raw, dict) or not raw.get("message"):
                continue
            try:
                issues.append(CheckIssue.model_validate(raw))
            except Exception:
                issues.append(
                    CheckIssue(
                        category="其他",
                        severity="low",
                        message=str(raw.get("message")),
                        suggestion=str(raw.get("suggestion") or ""),
                    )
                )
        return self._drop_contradicted(issues, plan)

    @staticmethod
    def _drop_contradicted(issues: List[CheckIssue], plan: TravelPlan) -> List[CheckIssue]:
        """丢掉与规划事实直接矛盾的问题。

        大模型偶尔会误报（例如住宿费明明有、却说"预算未包含住宿"）。
        这里只做能一眼证实/证伪的事实校验，不一刀切替换模型的判断。
        """
        breakdown = plan.budget_breakdown.model_dump()
        labelled = {
            "住宿": breakdown.get("hotel", 0),
            "门票": breakdown.get("tickets", 0),
            "餐饮": breakdown.get("dining", 0),
            "交通": breakdown.get("transport", 0),
        }
        # 事实一：每个景点出现在几天（用于证伪"景点重复"）
        days_of_name: dict[str, set[str]] = {}
        for day in plan.daily_plans:
            for item in day.timeline:
                if item.poi.type == "景点":
                    days_of_name.setdefault(item.poi.name, set()).add(day.date)
        # 事实二：时间轴里到底有没有重叠
        has_overlap = any(CheckSkill._has_time_overlap(d) for d in plan.daily_plans)
        # 事实三：行程里到底有哪些点（用于证伪"某某没被安排"）
        planned_names = {
            item.poi.name for day in plan.daily_plans for item in day.timeline
        } | {day.hotel.name for day in plan.daily_plans if day.hotel}
        missing_claims = ("未安排", "没有安排", "未被安排", "未出现", "没排", "遗漏")
        # 事实四：行程里各点的真实坐标（用于核对"相距 XX 公里"这类说法）
        located = {
            item.poi.name: item.poi
            for day in plan.daily_plans
            for item in day.timeline
            if has_location(item.poi)
        }
        plan_dates = [day.date for day in plan.daily_plans]

        kept: List[CheckIssue] = []
        for issue in issues:
            text = issue.message
            if issue.category == "预算":
                contradicted = any(
                    label in text
                    and ("未包含" in text or "未计入" in text)
                    and amount > 0
                    for label, amount in labelled.items()
                )
                if contradicted:
                    continue
            if "重叠" in text and not has_overlap:
                continue
            # 说"某个景点重复出现"（不管它归到哪一类），但没有任何景点出现在两天以上 → 矛盾
            has_duplicate = any(len(dates) > 1 for dates in days_of_name.values())
            if not has_duplicate and any(
                k in text for k in ("重复", "再次出现", "两次", "又安排")
            ):
                continue
            # 模型偶尔把 1 公里出头说成"距离较远"：2 公里以内步行/打车都不算问题，
            # 这类轻微夸大直接丢掉（阈值写在这里便于以后调）
            if "公里" in text:
                mentioned = [
                    float(v) for v in re.findall(r"(\d+(?:\.\d+)?)\s*公里", text)
                ]
                if mentioned and max(mentioned) < 2.0:
                    continue
            # 说某个点"没被安排"，但那个点明明就在行程里 → 矛盾
            if any(k in text for k in missing_claims) and any(
                len(name) >= 2 and name in text for name in planned_names
            ):
                continue
            mentioned = [name for name in located if name in text]
            # 说"距离 XX 公里"，但按真实坐标算差得太远 → 矛盾（例如把 3 公里的两点说成 40 公里）
            if "公里" in text and len(mentioned) >= 2:
                real = distance_km(located[mentioned[0]], located[mentioned[1]])
                claimed = [
                    float(v) for v in re.findall(r"(\d+(?:\.\d+)?)\s*公里", text)
                ]
                if real and claimed and max(claimed) > max(real * 3, real + 10):
                    continue
            # 只说"距离较远/过远"但没给数字时，用真实坐标核对：
            # 两个点实际 3 公里以内（打车约十分钟）就属于轻微夸大，丢弃
            if (
                len(mentioned) == 2
                and any(k in text for k in ("较远", "过远", "距离远", "太远", "很远"))
            ):
                real = distance_km(located[mentioned[0]], located[mentioned[1]])
                if real is not None and real <= 3.0:
                    continue
            # 说"某景点被安排在这两天"，但实际没有任何景点出现在两天（且这只是一句判断，不是建议）
            dates_in_text = {d for d in plan_dates if d in text}
            if (
                not has_duplicate
                and mentioned
                and len(dates_in_text) >= 2
                and not any(k in text for k in ("建议", "可以", "不妨", "考虑"))
            ):
                continue
            kept.append(issue)
        return kept

    @staticmethod
    def _has_time_overlap(day) -> bool:
        """当天时间轴是否真的存在重叠（用来证伪模型的"时间重叠"误报）。"""

        def _minutes(value: str) -> Optional[int]:
            try:
                h, m = value.split(":")
                return int(h) * 60 + int(m)
            except (ValueError, AttributeError):
                return None

        spans = []
        for item in day.timeline:
            if "-" not in item.time:
                continue
            start_text, _, end_text = item.time.partition("-")
            start, end = _minutes(start_text), _minutes(end_text)
            if start is None or end is None:
                continue
            spans.append((start, end))
        spans.sort()
        return any(spans[i][1] > spans[i + 1][0] for i in range(len(spans) - 1))
