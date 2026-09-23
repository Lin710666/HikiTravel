"""离线自检脚本：用桩替换大模型与高德，跑通整条 Skill 链。

不联网、不依赖 Ollama，用来验证流水线逻辑：意图抽取 → 规划 → 体检，
包括去重（临时数据结构）、综合分选址、预算计算、问题汇总，
以及"缺关键信息 / 未接入大模型"时是否按预期明确报错。

用法（在 backend 目录下）：
    .venv\\Scripts\\python.exe scripts\\offline_check.py
"""
import json
import logging
import sys
from pathlib import Path

# 允许直接以 `python scripts/offline_check.py` 运行：把 backend 目录加入模块搜索路径
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.stdout.reconfigure(encoding="utf-8")  # 避免 Windows 控制台按 GBK 输出导致中文乱码
logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

from app.models.plan import Weather
from app.orchestrator import Orchestrator
from app.skills.errors import LLMUnavailableError, MissingRequiredInfoError


def attraction(pid, name, lng, lat, rating, photos=0, cost=None, weight=None):
    biz = {"rating": str(rating)}
    if cost is not None:
        biz["cost"] = str(cost)
    item = {
        "id": pid,
        "name": name,
        "location": f"{lng},{lat}",
        "cityname": "杭州市",
        "adname": "西湖区",
        "address": f"{name}地址",
        "biz_ext": biz,
        "photos": [{"title": "p"} for _ in range(photos)],
    }
    if weight:
        item["weight"] = weight
    return item


ATTRACTIONS = [
    attraction("A1", "西湖", 120.150, 30.250, 4.8, photos=8, weight="9.5"),
    attraction("A2", "灵隐寺", 120.100, 30.240, 4.6, photos=5, weight="8.0"),
    attraction("A3", "雷峰塔", 120.152, 30.231, 4.5, photos=3, weight="7.0"),
    attraction("A4", "浙江省博物馆", 120.160, 30.260, 4.7, photos=2),
    attraction("A5", "西溪湿地", 120.060, 30.270, 4.6, photos=4),
    attraction("A6", "河坊街", 120.170, 30.240, 4.4, photos=1),
]

RESTAURANTS = [
    attraction("R1", "楼外楼", 120.148, 30.248, 4.7, cost=180),
    attraction("R2", "外婆家", 120.155, 30.252, 4.6, cost=80),
    attraction("R3", "知味观", 120.168, 30.238, 4.5, cost=60),
    attraction("R4", "绿茶餐厅", 120.098, 30.242, 4.4, cost=70),
    attraction("R5", "新白鹿", 120.062, 30.268, 4.3, cost=55),
]

HOTELS = [
    attraction("H1", "杭州西湖国宾馆", 120.146, 30.246, 4.8),
    attraction("H2", "如家酒店(西湖店)", 120.158, 30.250, 4.4),
    attraction("H3", "西溪民宿", 120.061, 30.271, 4.2),
]


class FakeAmap:
    key = "fake"

    def resolve_region(self, destination, adcode=""):
        return "杭州市", "杭州市"

    def input_tips(self, keywords, city=""):
        return []

    def search_poi(self, keywords=None, city=None, types=None, offset=20, page=1):
        if page > 1:
            return []
        if types:
            return ATTRACTIONS
        if keywords in ("餐厅", "小吃", "本地菜", "特色美食"):
            return RESTAURANTS if keywords == "餐厅" else []
        if keywords in ("酒店",):
            return HOTELS
        return []

    def get_route(self, origin, destination, mode="walking"):
        """模拟驾车路线。

        必须带 distance 字段：体检的「当天里程」和「绕行判定」现在都读它，
        缺了就退回直线距离，离线环境下就测不到新逻辑。
        这里按直线距离的 1.3 倍模拟（低于 1.5 的绕行阈值，不产生误报）。
        """
        import math

        lng1, lat1 = (float(v) for v in origin.split(","))
        lng2, lat2 = (float(v) for v in destination.split(","))
        dx = (lng2 - lng1) * 111.32 * math.cos(math.radians((lat1 + lat2) / 2))
        dy = (lat2 - lat1) * 110.57
        road_m = int(math.hypot(dx, dy) * 1.3 * 1000)
        return {
            "route": {
                "taxi_cost": "22.5",
                "paths": [{"duration": "1500", "distance": str(road_m)}],
            }
        }


class FakeWeather:
    def forecast(self, city, days=7):
        return {
            "2026-09-23": Weather(condition="晴", temp="22-30℃"),
            "2026-09-24": Weather(condition="小雨", temp="21-27℃"),
            "2026-09-25": Weather(condition="阴", temp="20-26℃"),
        }


class FakeRetriever:
    def search(self, query, top_k=3, city=""):
        return [f"贴士：{city}出行建议错峰"]


class FakeLLM:
    """按系统提示词区分调用方：意图抽取 / 规划 / 体检。"""

    def __init__(self, available=True):
        self._available = available
        self.calls = []
        self.last_error = ""

    def available(self):
        return self._available

    def chat_json(self, system, user, options=None, timeout=None, model=None):
        if "结构化助手" in system:
            self.calls.append("intent")
            return {
                "travelers": {"adults": 2, "children": 0, "elderly": 1},
                "destination": "杭州",
                "duration_days": 3,
                "budget": 2000,
                "preferences": ["人文历史", "自然风光"],
                "must_visit": ["雷峰塔"],
                "pace": "特种兵",
                "transportation": "高铁",
                "start_date": "2026-09-23",
            }
        if "景点挑选助手" in system:
            self.calls.append("planner")
            return {
                "summary": "杭州3日人文自然游",
                "attractions": [
                    {"name": "西湖", "tips": "清晨人少"},
                    {"name": "雷峰塔", "tips": ""},
                    # 同一片景区的别名（雷峰塔景区 vs 雷峰塔）：应被临时结构拦下
                    {"name": "雷峰塔景区", "tips": ""},
                    {"name": "灵隐寺", "tips": ""},
                    # 不在候选池：应被拦下并提示
                    {"name": "上海外滩", "tips": ""},
                ],
            }
        if "审稿人" in system:
            self.calls.append("check")
            return {
                "passed": False,
                "summary": "整体可行，个别点位偏赶",
                "issues": [
                    {
                        "category": "时间",
                        "severity": "medium",
                        "message": "第1天上午连排两个大景点偏赶",
                        "suggestion": "可把雷峰塔挪到下午",
                    },
                    {
                        # 与事实矛盾（住宿费其实有），应被事实校验过滤掉
                        "category": "预算",
                        "severity": "high",
                        "message": "预算未包含住宿费用",
                        "suggestion": "补上住宿费",
                    },
                    {
                        # 轻微夸大（2 公里内不算远），应被事实校验过滤掉
                        "category": "路径",
                        "severity": "medium",
                        "message": "第1天从西湖到雷峰塔距离较远，约 1.5 公里",
                        "suggestion": "换成更近的点",
                    },
                    {
                        # 说"没安排"，但西湖明明在行程里 → 应被过滤掉
                        "category": "覆盖",
                        "severity": "high",
                        "message": "用户想去的西湖未被安排在行程中",
                        "suggestion": "把西湖加进去",
                    },
                    {
                        # 归到"时间"类、但其实是重复的误报 → 同样应被过滤掉
                        "category": "时间",
                        "severity": "high",
                        "message": "西湖在 2026-09-23 被安排，但 2026-09-24 又安排了一次",
                        "suggestion": "去掉重复",
                    },
                    {
                        # 距离说法与真实坐标差距过大（西湖与雷峰塔实际约 2 公里）→ 应被过滤掉
                        "category": "路径",
                        "severity": "high",
                        "message": "2026-09-23 的行程中，西湖和雷峰塔相距超过 40 公里",
                        "suggestion": "换掉其中一个",
                    },
                    {
                        # 说某景点出现在两天，但实际没有 → 应被过滤掉
                        "category": "时间",
                        "severity": "high",
                        "message": "雷峰塔被安排在了 2026-09-23 和 2026-09-25 的行程中",
                        "suggestion": "去掉一次",
                    },
                    {
                        # 不带数字的"距离较远"，但两点实际约 2 公里 → 应被过滤掉
                        "category": "路径",
                        "severity": "medium",
                        "message": "第一天从雷峰塔到西湖的步行距离较远，建议优化",
                        "suggestion": "换个近点",
                    },
                ],
            }
        if "旅游需求修订助手" in system:
            # 对话式修改：在既有画像上只改用户提到的字段
            self.calls.append("revise")
            payload = json.loads(user)
            pref = dict(payload["当前画像"])
            pref["budget"] = 2500
            pref["pace"] = "悠闲"
            return pref
        return None


def build(available=True):
    llm = FakeLLM(available=available)
    orch = Orchestrator()
    orch.intent.llm = llm
    orch.planner.llm = llm
    orch.check.llm = llm
    orch.retrieve.amap = FakeAmap()
    # planner 也要换成假客户端：它内部会自己 new 一个真 AmapClient，
    # 不换的话所谓「离线检查」里的路线查询会真的打到高德去。
    orch.planner.amap = orch.retrieve.amap
    orch.retrieve.weather_svc = FakeWeather()
    orch.retrieve.retriever = FakeRetriever()
    return orch, llm


def main():
    # 0) 确定性用例：08:30 出发 + 只有 2 个景点时，午餐不能被排到下午
    from app.models.plan import Location, POI
    from app.models.preference import Travelers, UserPreference
    from app.skills.planner_skill import PlannerSkill

    def poi(name, kind, lat, lng):
        return POI(name=name, type=kind, location=Location(lat=lat, lng=lng))

    early = UserPreference(
        destination="杭州", duration_days=1, budget=1000,
        travelers=Travelers(adults=2), preferences=["人文历史"],
        pace="悠闲", departure_time="08:30", return_hotel_time="20:00",
    )
    sim = PlannerSkill(llm=FakeLLM(), amap=FakeAmap())
    items, _end, _used = sim._simulate_day(
        early,
        [poi("A景点", "景点", 30.25, 120.15), poi("B景点", "景点", 30.26, 120.16)],
        None,
        None,
        [poi("餐厅1", "餐厅", 30.251, 120.151), poi("餐厅2", "餐厅", 30.252, 120.152)],
        set(),
        8 * 60 + 30,
        [],
    )
    print(
        "== 08:30 出发 / 2 个景点的时间轴 ==",
        [(i.time, i.poi.type, i.poi.name) for i in items],
    )
    lunch = next((i for i in items if i.poi.type == "餐厅"), None)
    lunch_start = int(lunch.time.split("-")[0].split(":")[0]) * 60 + int(lunch.time.split("-")[0].split(":")[1]) if lunch else -1
    print("午餐开始时间:", lunch.time.split("-")[0] if lunch else "无", "| 是否晚于 14:00:", lunch_start > 14 * 60)

    # 1) 正常路径：应生成 3 天行程，并把重复/超范围景点记进体检问题
    orch, llm = build()
    plan = orch.run(raw_text="带80岁老人特种兵游杭州，3天，预算2000，想去雷峰塔")
    print("== LLM 调用顺序 ==", llm.calls)
    print("== 摘要 ==", plan.summary)
    print("== 预算 ==", plan.total_budget_estimate, plan.budget_breakdown.model_dump())
    for day in plan.daily_plans:
        print(
            f"-- {day.date} {day.weather.condition} 酒店={day.hotel.name if day.hotel else None}",
            [(it.time, it.poi.type, it.poi.name) for it in day.timeline],
            "plan_b=", day.plan_b,
        )
    print("== 体检 passed ==", plan.checks.passed)
    for issue in plan.checks.issues:
        print("  -", issue.category, issue.severity, issue.message)
    print("== 冲突 ==", [c.id for c in plan.conflicts])

    # 2) 对话式修改：应在既有画像上只改提到的字段，并重新生成
    orch_r, llm_r = build()
    plan_v1 = orch_r.run(raw_text="带80岁老人特种兵游杭州，3天，预算2000，想去雷峰塔")
    plan_v2 = orch_r.revise("预算压到 2500，节奏改成悠闲", plan_v1)
    print(
        "== 对话式修改 ==",
        "LLM 调用:", llm_r.calls,
        "| 新画像预算:", plan_v2.user_preference.budget,
        "节奏:", plan_v2.user_preference.pace,
        "| 传送给前端可继续改:", plan_v2.user_preference is not None,
        "| 交通口径:", bool(plan_v2.transport_note),
    )

    # 3) 缺目的地：应直接提示用户
    orch2, _ = build()
    orch2.intent.llm = FakeLLM()
    orig = orch2.intent.llm.chat_json
    orch2.intent.llm.chat_json = lambda system, user, options=None, timeout=None, model=None: (
        {**orig(system, user), "destination": ""} if "结构化助手" in system else orig(system, user)
    )
    try:
        orch2.run(raw_text="帮我安排三天行程")
        print("!! 缺目的地时没有报错")
    except MissingRequiredInfoError as exc:
        print("== 缺目的地提示 ==", exc)

    # 3) 无大模型：应明确提示未接入，不降级
    orch3, _ = build(available=False)
    try:
        orch3.run(raw_text="杭州3天")
        print("!! 无大模型时没有报错")
    except LLMUnavailableError as exc:
        print("== 无大模型提示 ==", exc)


if __name__ == "__main__":
    sys.exit(main())
