"""Skill 协同调度器（Orchestrator）。

串联五个 Skill 形成流水线：
意图识别 → 必要信息校验 → 异常拦截 → 数据检索 → 规划生成 → 规划体检。

设计原则（与用户对齐）：
1. **不做静默默认值**：用户没填的关键信息（目的地 / 天数 / 人数 / 兴趣 / 预算）
   直接提示补充，不替用户拍脑袋决定。例如不再"目的地留空就默认杭州"，
   也不再把 city 参数悄悄换成别的城市——那会让用户拿到别处的景点。
2. 异常拦截（GuardSkill）只产出「建议」不擅自修改画像；
   只有用户明确点击「采纳建议」后才通过 apply_suggestions 应用到画像。
3. **不保底、不伪造**：大模型 / 高德不可用时直接抛错提示用户，
   不降级成另一套口径，也不用编造的数据把流程走完。
"""
import logging
import time
from typing import Any, List, Optional

from .config import settings
from .models.plan import TravelPlan
from .models.preference import UserPreference
from .skills import CheckSkill, GuardSkill, IntentSkill, PlannerSkill, RetrieveSkill
from .skills.errors import MissingRequiredInfoError
from .skills.guard_skill import apply_suggestions

logger = logging.getLogger("travelplanner")


class Orchestrator:
    """多 Skill 协同调度器。"""

    def __init__(self) -> None:
        self.intent = IntentSkill()
        self.guard = GuardSkill()
        self.retrieve = RetrieveSkill()
        self.planner = PlannerSkill()
        # 体检需要调用规划器做「定向优化后的重建」与「带反馈重新生成」
        self.check = CheckSkill(
            planner=self.planner,
            max_regenerate=settings.plan_max_regenerate,
            check_model=settings.ollama_check_model,
        )

    def run(
        self,
        raw_text: Optional[str] = None,
        preference: Optional[UserPreference] = None,
        apply_suggestions_flag: bool = False,
        base: Optional[dict] = None,
    ) -> TravelPlan:
        """执行完整流水线，返回旅游规划。

        Args:
            raw_text: 用户自然语言描述（对话模式）。
            preference: 用户结构化画像（表单模式）。
            apply_suggestions_flag: 是否应用异常拦截给出的建议（用户已明确同意）。
            base: 对话模式下，前端表单已填的部分画像（精确输入，优先级高于对话解析）。
        """
        ctx: dict[str, Any] = {
            "raw_text": raw_text,
            "preference": preference,
        }

        ctx = self._run_skill(self.intent, ctx)  # Skill1 意图识别与信息采集（纯大模型）
        if base is not None:
            # 对话 + 表单并存：先解析对话，再用表单已填字段覆盖（表单更精确，对话补缺）
            ctx["preference"] = self._merge_base(ctx["preference"], base)

        self._require_basic_info(ctx["preference"])  # 缺信息直接提示，不静默补默认值
        return self._pipeline(ctx, apply_suggestions_flag)

    def revise(
        self,
        message: str,
        plan: TravelPlan,
        apply_suggestions_flag: bool = False,
    ) -> TravelPlan:
        """对话式修改已有规划。

        上下文就存在规划本身里（plan.user_preference）：用户在既有画像上提新要求，
        大模型只改要求的字段，其余保持不变，然后重新走一遍检索/规划/体检。
        用户不用重填表单，也不用重新描述一遍需求。
        """
        current = plan.user_preference
        if current is None:
            raise MissingRequiredInfoError(
                "这版规划是旧版本生成的，没有保存当时的画像，无法直接按对话修改。"
                "请重新生成一版规划后再做调整。"
            )
        if not (message or "").strip():
            raise MissingRequiredInfoError("请先写下你想怎么改，例如「预算压到 2500，改成悠闲」")

        digest = self._plan_digest(plan)
        revised = self.intent.apply_revision(current, digest, message.strip())
        self._require_basic_info(revised)
        ctx: dict[str, Any] = {"preference": revised, "raw_text": message}
        return self._pipeline(ctx, apply_suggestions_flag)

    def _pipeline(self, ctx: dict[str, Any], apply_suggestions_flag: bool) -> TravelPlan:
        """执行「异常拦截 → 数据检索 → 规划生成 → 规划体检」这四段（前两段已在调用方完成）。"""
        ctx = self._run_skill(self.guard, ctx)  # 异常拦截（检测矛盾，给出建议，不擅自修改）
        if apply_suggestions_flag:  # 用户明确同意后才应用建议
            apply_suggestions(ctx["preference"], ctx.get("conflicts", []))

        ctx = self._run_skill(self.retrieve, ctx)  # Skill2 多源数据获取与检索
        ctx = self._run_skill(self.planner, ctx)  # Skill3 智能规划生成
        ctx = self._run_skill(self.check, ctx)  # Skill4 规划体检（优化 + 审查）

        plan = ctx["plan"]
        conflicts = ctx.get("conflicts", [])
        plan.conflicts = conflicts
        return plan

    @staticmethod
    def _plan_digest(plan: TravelPlan) -> str:
        """把行程压缩成几行文字，作为"当前安排"提供给大模型参考。"""
        lines: List[str] = []
        for day in plan.daily_plans:
            names = "、".join(item.poi.name for item in day.timeline)
            lines.append(f"{day.date}（{day.weather.condition}）：{names}")
        return "\n".join(lines)

    @staticmethod
    def _run_skill(skill: Any, ctx: dict[str, Any]) -> dict[str, Any]:
        """执行单个 Skill 并记录耗时（便于定位"生成慢在哪一步"）。"""
        started = time.perf_counter()
        try:
            return skill.run(ctx)
        finally:
            logger.info(
                "skill=%s 用时 %.1fs", getattr(skill, "name", "?"), time.perf_counter() - started
            )

    @staticmethod
    def _require_basic_info(pref: UserPreference) -> None:
        """关键信息缺失就直接提示用户补充，不用默认值替用户做决定。"""
        missing: List[str] = []
        if not (pref.destination or "").strip():
            missing.append("目的地（例如「杭州」）")
        if pref.duration_days < 1:
            missing.append("游玩天数")
        if pref.travelers.total < 1:
            missing.append("出行人数（至少 1 人）")
        if not pref.preferences:
            missing.append("兴趣导向（人文历史 / 自然风光 / 美食 / 娱乐 至少选一项）")
        if pref.budget <= 0:
            missing.append("总预算")
        if missing:
            raise MissingRequiredInfoError(
                "还缺少这些信息，请补充后再生成规划：" + "、".join(missing) + "。"
            )

    @staticmethod
    def _merge_base(text_pref: UserPreference, base: dict) -> UserPreference:
        """合并「对话解析结果」与「表单已填画像」：表单字段优先（更精确），对话补缺。

        base 为前端表单的 Partial 画像（仅含用户实际填写的字段），travelers 做子字段合并。
        """
        data = text_pref.model_dump()
        travelers = base.get("travelers")
        if isinstance(travelers, dict):
            data["travelers"].update(travelers)
        for k, v in base.items():
            if k != "travelers":
                data[k] = v
        return UserPreference.model_validate(data)
