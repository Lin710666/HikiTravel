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
from .skills.output_guard import OutputGuardSkill

logger = logging.getLogger("travelplanner")


#: 明显是国外的地名。命中就拒绝出方案（见 _reject_unusable_origin）。
#: 只列真正的国家 / 国外城市；港澳台是中国的一部分，不在这里。
_FOREIGN_HINTS = (
    "美国", "加拿大", "墨西哥", "巴西", "阿根廷",
    "日本", "韩国", "朝鲜", "蒙古", "印度", "尼泊尔", "斯里兰卡",
    "泰国", "越南", "老挝", "柬埔寨", "缅甸", "马来西亚", "新加坡",
    "印度尼西亚", "菲律宾", "文莱",
    "英国", "法国", "德国", "意大利", "西班牙", "葡萄牙", "荷兰", "比利时",
    "瑞士", "奥地利", "瑞典", "挪威", "丹麦", "芬兰", "冰岛", "爱尔兰",
    "波兰", "捷克", "匈牙利", "希腊", "土耳其", "俄罗斯", "乌克兰",
    "澳大利亚", "新西兰", "埃及", "南非", "摩洛哥", "肯尼亚",
    "以色列", "沙特", "阿联酋", "迪拜", "卡塔尔", "伊朗", "伊拉克",
    "纽约", "洛杉矶", "旧金山", "西雅图", "波士顿", "芝加哥", "华盛顿",
    "拉斯维加斯", "夏威夷", "温哥华", "多伦多", "伦敦", "巴黎", "柏林",
    "慕尼黑", "罗马", "米兰", "马德里", "巴塞罗那", "阿姆斯特丹", "苏黎世",
    "维也纳", "莫斯科", "东京", "大阪", "京都", "北海道", "冲绳",
    "首尔", "釜山", "济州", "曼谷", "清迈", "普吉", "吉隆坡", "雅加达",
    "马尼拉", "河内", "胡志明", "悉尼", "墨尔本", "奥克兰", "开罗",
    "伊斯坦布尔", "雅典",
)


class UnsupportedOriginError(RuntimeError):
    """出发地用不了，直接拒绝生成 —— 不是警告，是不给方案。见 _reject_unusable_origin。"""


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
        # 融合版的输出层质检（硬规则体检，不依赖模型）
        self.output_guard = OutputGuardSkill()

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

        # ★ 表单模式下，画像**一开始就是全的** —— 先做出发地预检，再进 intent。
        #   为什么必须抢在 intent 前面：组员那版 intent_skill 自己就会打高德，
        #   等它跑完才拦就晚了（实测：额度耗尽时返回的是 503「高德接口返回错误」，
        #   用户根本看不出"是出发地填了国外"）。放在这里，拒绝耗时 0.0 秒、零接口调用。
        if preference is not None:
            self._reject_unusable_origin(preference)

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

        # ★ 出发地用不了 → **第一步就拒绝**，连 guard 都不跑。
        #   为什么必须放最前面：组员的 guard_skill 会去打高德，等它跑完才拦就晚了 ——
        #   额度耗尽/网络慢的时候，用户拿到的是 503「高德接口返回错误」这种驴唇不对马嘴的话，
        #   而不是"出发地是国外、重新填"（我第一版放在 guard 之后，实测就是这样）。
        self._reject_unusable_origin(ctx["preference"])
        ctx = self._run_skill(self.guard, ctx)  # 异常拦截（检测矛盾，给出建议，不擅自修改）
        if apply_suggestions_flag:  # 用户明确同意后才应用建议
            apply_suggestions(ctx["preference"], ctx.get("conflicts", []))

        ctx = self._run_skill(self.retrieve, ctx)  # Skill2 多源数据获取与检索
        ctx = self._run_skill(self.planner, ctx)  # Skill3 智能规划生成
        ctx = self._run_skill(self.check, ctx)  # Skill4 规划体检（优化 + 审查）

        # ★ 融合版的输出层质检接着跑一遍。
        #   和上面的 check_skill 不重复：那个是"把规划喂回大模型审查"，
        #   这个是不依赖模型的硬规则体检（超预算 / 门票缺价 / 跨城 / 深夜正餐…），
        #   模型不返回时它也照样跑。
        ctx = self._run_skill(self.output_guard, ctx)

        plan = ctx["plan"]
        conflicts = ctx.get("conflicts", [])
        plan.conflicts = conflicts
        return plan

    @staticmethod
    def _reject_unusable_origin(pref: UserPreference) -> None:
        """出发地确定用不了时，直接抛错拒绝出方案。

        ★ 为什么硬拒绝而不是只给警告：
          以前是"往返大交通记 0 + 一条警告"，方案照样出。后果是用户拿到一份
          **看起来完整的方案和总预算**，而那个总预算其实等于"目的地本地游"的钱
          （实测：纽约→乌鲁木齐 与 乌鲁木齐本地 都是 1103.3 元）—— 因为它按
          "你已经站在那儿了"算门票/餐饮/住宿/打车。往返那 5881 元只是被悄悄抹掉，
          正文里看不出这笔钱其实到不了。那比直接报错更误导。

        只在**出发地非空、且能确定它用不了**时抛：
          · 空出发地是选填的（会有固定值估算 + 口径说明），不拦
          · 高德接口临时抽风也不拦 —— 那会把网络抖动变成"用不了"
          · 不看出行方式：默认值就是「本地」，按它跳过会漏掉"填了国外城市却没选方式"
        """
        # ⚠ 不用从 amap 里 import 词表 —— 旅游后端换成组员那版之后，
        #   amap.py 里没有 _FOREIGN_HINTS，import 会失败、整个检查被静默跳过
        #   （我第一版就这么写的，结果"纽约→乌鲁木齐"照样进了检索）。词表自带。
        origin = str(getattr(pref, "origin", "") or "").strip()
        dest = str(getattr(pref, "destination", "") or "").strip()
        if not origin or not dest:
            return
        if origin == dest or origin in dest or dest in origin:
            return
        hit = next((h for h in _FOREIGN_HINTS if h in origin), "")
        if not hit:
            return
        raise UnsupportedOriginError(
            f"「{origin}」是国外地点，本系统的城际交通只覆盖国内。\n\n"
            "所以这次**没有生成行程** —— 出发地用不了就没法估算往返大交通，"
            "而给一份缺了往返的价格，比直接说清楚更误导。\n\n"
            "可以这样改：\n"
            "· 出发地填国内城市名，例如「杭州」「上海」；\n"
            "· 或者把出发地**留空** —— 那样只算当地花费（门票/餐饮/住宿/市内交通）。"
        )

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


# ---------------------------------------------------------------- 单例
#: 进程内单例。融合层（ui_compat.py / api.py）统一用它拿 ——
#: 每次 new 一个 Orchestrator 都要重建知识库索引，很贵。
_ORCHESTRATOR: Optional["Orchestrator"] = None


def get_orchestrator() -> "Orchestrator":
    """拿进程内的 Orchestrator 单例（没有就建一个）。"""
    global _ORCHESTRATOR
    if _ORCHESTRATOR is None:
        _ORCHESTRATOR = Orchestrator()
    return _ORCHESTRATOR
