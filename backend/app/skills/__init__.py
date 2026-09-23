"""Skill 协同包。

每个 Skill 负责流水线中的一个环节，可独立开发、测试与替换：
- intent_skill    : Skill1 用户意图识别与信息采集（输入层，纯大模型，无正则）
- guard_skill     : 异常拦截（输入层，需求矛盾检测，只建议不擅改）
- retrieve_skill  : Skill2 多源数据获取与检索（数据层，综合分排序）
- planner_skill   : Skill3 智能规划生成（核心处理层，大模型选点 + 系统组装）
- check_skill     : Skill4 规划体检（把第一版规划再喂回大模型审查）

公共约定见 base.py（统一 run(ctx) 接口）与 errors.py（统一异常）。
"""
from .base import Skill
from .check_skill import CheckSkill
from .guard_skill import GuardSkill
from .intent_skill import IntentSkill
from .planner_skill import PlannerSkill
from .retrieve_skill import RetrieveSkill

__all__ = [
    "Skill",
    "IntentSkill",
    "GuardSkill",
    "RetrieveSkill",
    "PlannerSkill",
    "CheckSkill",
]
