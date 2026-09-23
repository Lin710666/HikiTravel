"""用户画像输入模型（对应需求文档「模块1：用户意图识别与信息采集」）。

这是整个系统的输入层数据结构，由意图识别 Skill 从对话/表单中提取。
前端有同名 TypeScript 接口与之对齐，保证前后端字段一致。
"""
from typing import Any, List, Literal, Optional

from pydantic import BaseModel, Field, model_validator


class Travelers(BaseModel):
    """同行人构成：决定行程松紧度与无障碍需求。"""

    # 默认 0 表示「用户没有填」，由 Orchestrator 显式校验并提示，
    # 不再用隐藏默认值（如默认 1 人）替用户做决定。
    adults: int = Field(default=0, ge=0, description="成人人数")
    children: int = Field(default=0, ge=0, description="儿童人数（0 表示无）")
    elderly: int = Field(default=0, ge=0, description="老人人数（0 表示无）")

    @property
    def total(self) -> int:
        """同行总人数。"""
        return self.adults + self.children + self.elderly


class UserPreference(BaseModel):
    """用户画像输入模型。

    覆盖需求文档要求的全部采集维度：
    基础信息 / 画像特征 / 预算偏好 / 禁忌避雷 / 时间约束。
    """

    # ---- 基础信息 ----
    travelers: Travelers = Field(default_factory=Travelers, description="出游人数构成")
    # 天数 / 预算默认 0 = 未填写，由 Orchestrator 校验并提示用户补充，
    # 不使用「默认 1 天 / 默认 1000 元」这类静默参数（会悄悄改变规划结果）。
    duration_days: int = Field(default=0, ge=0, le=30, description="游玩天数（0 表示未填写）")
    destination: str = Field(default="", description="目的地城市（规划的目标城市，必填）")
    # None 表示「用户没有填写」：不静默替他选一种交通方式（会直接影响预算里的往返大交通）
    transportation: Optional[Literal["自驾", "高铁", "飞机", "本地"]] = Field(
        default=None, description="往返交通方式（None 表示未填写）"
    )

    # ---- 画像特征 ----
    preferences: List[str] = Field(
        default_factory=list,
        description="兴趣导向：人文历史 / 自然风光 / 美食 / 娱乐",
    )
    must_visit: List[str] = Field(
        default_factory=list,
        description="特别想去的景点（规划中必须包含，如：雷峰塔、西湖）",
    )
    # None 表示「用户没有填写」：由规划时结合同行人判断，不静默套用某个节奏
    pace: Optional[Literal["悠闲", "适中", "特种兵"]] = Field(
        default=None, description="游玩节奏（None 表示未填写）"
    )

    # ---- 预算与偏好 ----
    budget: float = Field(default=0, ge=0, description="总预算（元，0 表示未填写）")
    # ---- 禁忌与避雷 ----
    dietary_restrictions: List[str] = Field(
        default_factory=list, description="饮食禁忌：过敏 / 清真 / 素食 / 无海鲜 等"
    )
    avoidances: List[str] = Field(
        default_factory=list, description="极其讨厌的项目：爬山 / 排队 / 网红打卡 等"
    )

    # ---- 时间约束 ----
    start_date: str = Field(default="", description="出行起始日期 YYYY-MM-DD")
    departure_time: str = Field(default="09:00", description="每天期望出发时间 HH:MM")
    return_hotel_time: str = Field(default="21:00", description="每天期望回酒店时间 HH:MM")

    @model_validator(mode="before")
    @classmethod
    def _tolerate_blank_choices(cls, data: Any) -> Any:
        """大模型可能把"用户没提到"的枚举字段填成空字符串或自造词。

        这类值统一归一为 None（未填写），由下游明确提示或按说明处理，
        而不是直接抛校验错误让用户重来一遍；也不是随便挑一个值糊过去。
        """
        if not isinstance(data, dict):
            return data
        allowed_map = {
            "pace": {"悠闲", "适中", "特种兵"},
            "transportation": {"自驾", "高铁", "飞机", "本地"},
        }
        cleaned = dict(data)
        for field, allowed in allowed_map.items():
            value = cleaned.get(field)
            if value is None or value == "" or value == []:
                cleaned[field] = None
            elif isinstance(value, str) and value not in allowed:
                cleaned[field] = None
        return cleaned
