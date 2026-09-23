# -*- coding: utf-8 -*-
"""
智能体对话（真正的 persona 对话），供 /api/agent 使用。

## 为什么单独做一份

原来 `/api/agent` 只是 `_chat_stream` 的别名 —— 两者**完全一样**，
都无条件走 `orchestrator.run()`。后果是：

    用户说"你好，你能做什么" → 后端给他排了一份杭州两天的行程

因为规划链路不读角色卡的人设，也不做对话；它只认"给我一个行程"。
而需求方要的是**像扣子那样结合智能体设定的偏好方向**（我们是旅游顾问）：
会赞美景点、推荐吃喝、像地陪一样聊天，**只有明确要行程时才出规划**。

## 两种模式

| 模式 | 触发 | 行为 |
|---|---|---|
| **对话**（默认） | 其它所有话 | 带人设 + 真实资料，像旅游顾问一样回答 |
| **规划** | 明确说"生成规划 / 排个行程 / 几天怎么安排"等 | 走原规划链路出结构化方案 |

判据是**前端显式传 `mode`** 优先，其次按关键词判意图 ——
不把这件事交给模型自己决定（7B 模型上不稳定，而且多一次往返）。

## 资料来源（不编）

  · `plan.system.txt` —— 项目里的旅游知识底稿（20 KB）
  · 高德 POI —— 问"吃什么/住哪/有什么景点"时实时搜真实的店与景点
  · 角色卡 —— persona / speakingStyle / tagline / greeting
"""
from __future__ import annotations

import re
import time
from typing import Any, Dict, Iterator, List, Optional

#: 判"要出规划"的关键词。宁可少判（退化成对话）也不要把闲聊误判成规划 ——
#: 误判的代价是"随便说句话就被塞一份行程"，那正是这次要修的毛病。
PLAN_HINTS = (
    "生成规划", "生成方案", "做个规划", "做个方案", "出个方案", "出个规划",
    "排个行程", "安排行程", "帮我安排", "帮我排", "规划一下", "排一下",
    "几天怎么玩", "天怎么安排", "行程安排", "怎么安排", "给我个方案",
    "完整方案", "详细方案", "出行计划", "旅行计划",
    # ★ 补几个之前漏掉的写法。实测踩到：「帮我做个**旅游**规划」——
    #   中间多了"旅游"两字，前面那批是精确子串匹配，全都命中不了，
    #   于是被判成"闲聊"走进对话链路，而对话模型一旦失败，用户就只拿到一句道歉
    #   —— 明明规划链路不依赖模型、本来能出方案的。
    "旅游规划", "旅游方案", "旅行方案", "出行方案", "游玩规划",
    "帮我规划", "做个行程", "出个行程", "规划个", "安排一下",
)

#: 判城市（只用于给 POI 检索定城市，判不出来就不搜、避免编）
CITY_HINTS = (
    "杭州", "上海", "北京", "成都", "苏州", "广州", "深圳", "西安", "南京",
    "重庆", "厦门", "青岛", "大理", "丽江", "三亚", "长沙", "武汉", "天津",
    "昆明", "桂林", "哈尔滨", "拉萨", "乌鲁木齐", "郑州", "宁波", "温州",
    "绍兴", "嘉兴", "湖州", "千岛湖", "西塘", "乌镇",
)

#: 问了这些就值得去搜真实 POI
POI_TRIGGERS = {
    "food": ("吃", "餐厅", "美食", "小吃", "饭", "菜", "夜宵", "甜品", "咖啡", "喝"),
    "hotel": ("住", "酒店", "民宿", "宾馆", "旅馆", "客栈"),
    "spot": ("景点", "好玩", "玩什么", "去哪", "逛", "打卡", "风景", "景区"),
}


def want_plan(text: str, mode: str = "") -> bool:
    """要不要走规划链路。

    前端显式给 `mode` 时以它为准（对话页的「AI 规划」按钮就是显式传 plan）。
    """
    m = (mode or "").strip().lower()
    if m in ("plan", "wenlv"):
        return True
    if m in ("chat", "talk", "agent"):
        return False
    t = (text or "").strip()
    if not t:
        return False
    # 很短的一句话不太可能是要行程（"你好"、"谢谢"）
    if len(t) <= 6 and not any(h in t for h in ("规划", "行程", "方案")):
        return False
    return any(h in t for h in PLAN_HINTS)


def pick_city(text: str, default: str = "") -> str:
    for c in CITY_HINTS:
        if c in (text or ""):
            return c
    return default or ""


def poi_kinds(text: str) -> List[str]:
    out = []
    t = text or ""
    for kind, kws in POI_TRIGGERS.items():
        if any(k in t for k in kws):
            out.append(kind)
    return out


def _fmt_pois(rows: List[Dict[str, Any]], limit: int = 6) -> str:
    """把高德返回的 POI 摘成几行给模型做依据（只给名字/类型/地址/评分）。"""
    lines = []
    for p in (rows or [])[:limit]:
        name = str(p.get("name") or "").strip()
        if not name:
            continue
        typ = str(p.get("type") or "").split(";")[-1]
        addr = str(p.get("address") or "")
        if isinstance(addr, list):
            addr = "".join(str(x) for x in addr)
        biz = p.get("biz_ext") or {}
        rating = ""
        if isinstance(biz, dict):
            rating = str(biz.get("rating") or "")
        seg = f"- {name}"
        if typ:
            seg += f"（{typ}）"
        if rating and rating not in ("[]", "None"):
            seg += f" 评分{rating}"
        if addr:
            seg += f"  {addr[:40]}"
        lines.append(seg)
    return "\n".join(lines)


def gather_poi(text: str) -> str:
    """按问的内容去高德搜真实 POI。搜不到就返回空串（宁可不给，也不编）。"""
    kinds = poi_kinds(text)
    if not kinds:
        return ""
    city = pick_city(text)
    if not city:
        return ""
    try:
        from .orchestrator import orchestrator  # 延迟导入，避免循环依赖
        amap = getattr(getattr(orchestrator, "retrieve", None), "amap", None)
        if amap is None or not getattr(amap, "key", ""):
            return ""
    except Exception:
        return ""

    blocks = []
    kw = {
        "food": f"{city}美食",
        "hotel": f"{city}酒店",
        "spot": f"{city}景点",
    }
    types = {"food": "050000", "hotel": "100000", "spot": "110000"}
    for k in kinds[:2]:
        try:
            rows = amap.search_poi(kw[k], city, types=types.get(k), offset=8)
        except Exception:
            rows = []
        body = _fmt_pois(rows)
        if body:
            label = {"food": "餐饮", "hotel": "住宿", "spot": "景点"}[k]
            blocks.append(f"【{city} · {label}（来自高德实时检索）】\n{body}")
    return "\n\n".join(blocks)


def build_system_prompt(card: Optional[Dict[str, Any]], poi: str, history: List[Dict[str, Any]]) -> str:
    """拼系统提示词：人设 + 说话风格 + 真实资料 + 行为约束。"""
    name = (card or {}).get("name") or "小文"
    persona = (card or {}).get("persona") or ""
    style = (card or {}).get("speakingStyle") or ""
    tagline = (card or {}).get("tagline") or ""

    # 项目里的旅游知识底稿。**截断**用：20 KB 全塞进提示词会让本机 7B 明显变慢，
    # 而对话场景用不到全部细则（那些是"出结构化方案"时才需要的字段定义）。
    kb = ""
    try:
        from .routers.ui_compat import _load_prompt
        kb = (_load_prompt("plan", "system") or "")[:6000]
    except Exception:
        kb = ""

    parts = [
        f"你是「{name}」，一位**旅游顾问**。" + (f"（{tagline}）" if tagline else ""),
        "",
        "## 你的身份设定",
        persona or "你熟悉国内主要目的地的景点、餐饮、住宿与交通，能给实用建议。",
        "",
        "## 说话风格",
        style or "像朋友聊天，先给结论再给理由，口语化，不写官腔。",
        "",
        "## 回答方式（很重要）",
        "1. **像一个真人在聊天**，不要每次都输出行程表。",
        "2. 用户问景点，就介绍这个景点好在哪、什么时候去合适、有什么坑；",
        "   问吃的，就推荐具体的菜与店、口味特点、人均大概多少。",
        "3. 该夸就夸：遇到值得去的地方，用你自己的语气把它讲得让人想去，",
        "   但**不许编造**不存在的地名、店名、价格。没有把握就说不确定。",
        "4. 长度控制在 3~8 句，别写成论文；用 Markdown，但少用大标题。",
        "5. 只有用户**明确要一份行程安排**时，才输出分天表格那种结构化方案。",
        "6. 不确定的事（营业时间、票价、实时天气）要说明「建议出行前再确认」。",
    ]
    if poi:
        parts += [
            "",
            "## 可用的真实资料（优先据此回答，别自己编店名）",
            poi,
        ]
    if kb:
        parts += [
            "",
            "## 项目知识底稿（仅供参考，不要照抄格式）",
            kb,
        ]
    if history:
        lines = []
        for m in history[-6:]:
            r = "用户" if m.get("role") == "user" else name
            c = str(m.get("content") or "").replace("\n", " ")[:160]
            if c:
                lines.append(f"{r}：{c}")
        if lines:
            parts += ["", "## 刚才聊过的（接着聊，别重复）", "\n".join(lines)]
    return "\n".join(parts)


def agent_reply(message: str, card: Optional[Dict[str, Any]],
                history: List[Dict[str, Any]], llm) -> str:
    """生成一段对话回复。llm 失败时抛异常，由调用方转成 error 事件。"""
    poi = gather_poi(message)
    system = build_system_prompt(card, poi, history)
    temp = 0.7
    try:
        m = (card or {}).get("model") or {}
        if isinstance(m, dict) and m.get("temperature") is not None:
            temp = float(m["temperature"])
    except Exception:
        pass
    user = message
    if poi:
        # 把资料同时挂在用户消息后面，弱模型更容易用上（双保险）
        user = f"{message}\n\n（可参考的资料如下，请据此回答，不要另编）\n{poi}"
    text = llm.chat_text(system, user, temperature=temp, num_predict=1200) or ""
    return text.strip()


def _parse_days(text: str, default: int = 2) -> int:
    """从话里猜玩几天。猜不到给 default。

    支持「两天」「2天」「三日游」「玩3天」「两天一夜」这几种常见说法。
    """
    CN = {"一": 1, "两": 2, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7,
          "八": 8, "九": 9, "十": 10}
    t = text or ""
    m = re.search(r"(\d+)\s*天", t)
    if m:
        n = int(m.group(1))
    else:
        m = re.search(r"([一两二三四五六七八九十])\s*(?:日|天)", t)
        n = CN.get(m.group(1), 0) if m else 0
    if n <= 0:
        return default
    return max(1, min(n, 7))


def _quick_pois(city: str, kinds: List[str], limit: int = 12) -> List[str]:
    """快取一批景点名（直接打高德，只发几次请求）。

    ★ 为什么不用 orchestrator：
      第一版简版是直接调 `orchestrator.run()` 复用完整链路的，结果**要 40~57 秒**
      —— 那条链路会做几十次高德请求（多关键词 POI + 餐厅 + 酒店 + 天气 + RAG），
      而且高德客户端有 0.4 秒限流，串起来就是半分钟起。
      可"简版"根本不需要那些：每天去哪儿，一批景点名就够。
      所以这里直接搜，2~3 次请求、一秒左右返回。
    """
    try:
        from .services.amap import AmapClient
    except Exception:
        return []
    amap = AmapClient()
    names: List[str] = []
    seen = set()
    for kw in (kinds or ["热门景点"]):
        try:
            for it in amap.search_poi(kw, city):
                n = str(it.get("name") or "").strip()
                # 只要真的在目的地的（高德 city 匹配不上时会默默给北京，
                # 见 retrieve_skill 里的说明）
                c = str(it.get("cityname") or "") or str(it.get("adname") or "")
                if c and city not in c and c not in city:
                    continue
                pid = it.get("id") or n
                if n and pid not in seen:
                    seen.add(pid)
                    names.append(n)
                if len(names) >= limit:
                    return names
        except Exception:
            continue
    return names


def brief_plan_reply(message: str, card: Optional[Dict[str, Any]],
                     reason: str = "") -> str:
    """模型不可用 / 用户在对话里要行程时，给一份**简版**骨架。

    为什么要有这个：
      兜底原来只回一句"我帮不了你，去点 AI 规划"。可这个项目的规划链路
      **本来就不靠对话模型**（PlannerSkill 在 LLM 不可用时会自动降级到规则引擎）。
      用户明明说了"杭州两天"，我们其实交得出东西，却只给了道歉 —— 很亏。
      但反过来也不能直接把**完整方案**糊到对话里（那是「AI 规划」抽屉的活），
      所以这里只给"每天去哪儿 + 粗估"，末尾指向完整方案。

    返回空串表示认不出目的地（调用方再退回纯文字兜底）。
    """
    city = pick_city(message or "")
    if not city:
        return ""
    days = _parse_days(message or "")

    # 按用户提的兴趣挑搜索词；没提就搜热门景点
    kinds: List[str] = []
    for k, kws in POI_TRIGGERS.items():
        if k == "spot" and any(w in (message or "") for w in kws):
            kinds = ["景点", "公园"]
    if not kinds:
        kinds = ["热门景点"]

    names = _quick_pois(city, kinds, limit=max(days * 3, 6))

    name = (card or {}).get("name") or "小文"
    lines: List[str] = [
        f"我是{name}，你的旅游顾问。",
        "",
        f"我先按你说的搭一份 **{city} · {days} 天** 的**简版**：",
        "",
    ]
    if names:
        per = max(1, len(names) // days)
        for i in range(days):
            seg = names[i * per: (i + 1) * per] or names[:2]
            lines.append(f"- **第 {i + 1} 天**：" + " → ".join(seg[:4]))
        lines += ["",
                  f"（每天约 {per} 个点，都是高德上真实存在的景点；"
                  "顺序按兴趣排的，还没排具体时间。）"]
    else:
        lines += [f"- 没能从地图上取到 {city} 的景点（可能是网络或地名写法的问题）。"]

    # 粗估：不查餐厅/酒店，给一个常见的档位口径，明确说是估算
    lines += [
        "",
        "**粗估花费**（按 1 人 1 天，实际以到店为准）：",
        f"- 餐饮约 {150 * days} 元 ｜ 门票约 {80 * days} 元 ｜ 本地交通约 {30 * days} 元",
    ]
    if reason:
        lines += ["", f"> 说明：{reason}"]
    lines += [
        "",
        "---",
        "",
        "这**只是简版骨架**（每天去哪儿 + 粗估）。"
        "**想要完整方案** —— 每天的几点到几点、景点/餐厅/酒店的具体选择、"
        "预算逐项拆解、交通方式和备选，**请点下方的「AI 规划」**："
        "那里出的是完整行程，而且同样不依赖对话模型。",
    ]
    return "\n".join(lines)


def fallback_reply(message: str, card: Optional[Dict[str, Any]], reason: str = "") -> str:
    """模型不可用时的兜底回答，至少保证对话不是空白。

    ★ 别再自己猜原因。
      原来这里写死了"Ollama 未运行或没拉模型" —— 而实测 Ollama 一直是好的、
      模型也在，只是某一次调用出了岔子。用户看到一句**错误的诊断**，
      只会往错的方向查（去重装 Ollama、重拉模型）。
      现在把调用方拿到的真实原因原样带出来；不知道就不说。
    """
    name = (card or {}).get("name") or "小文"
    why = f"\n\n> 具体原因：{reason}\n" if reason else ""
    return (
        f"我是{name}，你的旅游顾问。\n\n"
        "本机的对话模型这次没能返回内容，所以我暂时没法像平时那样跟你聊。"
        f"{why}\n"
        "你可以先点下面的 **AI 规划**，那条链路不依赖对话模型，"
        "能直接按目的地和天数出一份行程；过一会儿再发一次对话也往往就好了。"
    )


def sse_type_of(text: str) -> Optional[str]:
    """留个口子：以后要加"意图标签"可以从这里出。"""
    return None


_RE_TABLE = re.compile(r"^\s*\|.*\|\s*$", re.M)


def looks_like_plan(text: str) -> bool:
    """回复里出现了分天表格 → 大概率是结构化方案（用于埋点/日志，不影响渲染）。"""
    return bool(_RE_TABLE.search(text or ""))
