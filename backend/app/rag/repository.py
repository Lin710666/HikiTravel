"""知识库数据访问层：知识以 SQLite 行存储，可运营维护，而非硬编码在代码里。

内容原则（与用户对齐）：
1. 知识库只存放「慢变」的编辑类知识：历史人文、游览动线、拍照机位、
   防坑常识、本地特色。
2. 「快变」的动态事实（门票价、预约规则、开放时间、酒店房价）
   **不进知识库**，运行时通过高德 API 等外部接口获取；
   预约提醒使用通用安全话术并提示「以官方公告为准」。
3. 文旅从业者可通过修改数据库直接扩充知识，无需改动代码。
"""
import sqlite3
from typing import Any, Dict, List

from ..db import get_conn

# 慢变的编辑类知识（首版种子数据，无时效性事实）
# city 字段：该条知识所属城市（城市级名，如「杭州」）；空字符串表示通用知识，
# 任何目的地都可展示（防坑/拍照/动线等通用建议）。
STABLE_KNOWLEDGE: List[Dict[str, str]] = [
    {
        "text": "西湖十景包括苏堤春晓、断桥残雪、雷峰夕照、三潭印月等，环湖免费游览。",
        "tags": "西湖,历史人文",
        "category": "历史人文",
        "city": "杭州",
        "source": "",
        "updated_at": "2026-09-19",
    },
    {
        "text": "断桥是《白蛇传》中白娘子与许仙相遇的地方，冬季雪后「断桥残雪」最有意境。",
        "tags": "断桥,历史人文",
        "category": "历史人文",
        "city": "杭州",
        "source": "",
        "updated_at": "2026-09-19",
    },
    {
        "text": "雷峰塔因《白蛇传》而闻名，登塔可俯瞰西湖全景，日落时分视野最佳。",
        "tags": "雷峰塔,历史人文,拍照",
        "category": "历史人文",
        "city": "杭州",
        "source": "",
        "updated_at": "2026-09-19",
    },
    {
        "text": "灵隐寺始建于东晋，飞来峰保存有五代至元代的石窟造像群，是全国重点文保单位。",
        "tags": "灵隐寺,历史人文",
        "category": "历史人文",
        "city": "杭州",
        "source": "",
        "updated_at": "2026-09-19",
    },
    {
        "text": "动线建议：西湖沿线可逆时针串联断桥、苏堤、雷峰塔，减少回头路。",
        "tags": "动线,西湖",
        "category": "动线",
        "city": "杭州",
        "source": "",
        "updated_at": "2026-09-19",
    },
    {
        "text": "拍照建议：断桥残雪、苏堤春晓清晨人少、光线柔和，适合拍照。",
        "tags": "拍照,建议",
        "category": "拍照",
        "city": "杭州",
        "source": "",
        "updated_at": "2026-09-19",
    },
    {
        "text": "防坑建议：景区内「野导」拉客、路边「低价一日游」多为陷阱，请勿轻信。",
        "tags": "防坑,避雷",
        "category": "防坑",
        "city": "",
        "source": "",
        "updated_at": "2026-09-19",
    },
    {
        "text": "防坑建议：景区周边部分龙井茶以次充好，购茶建议到龙井村正规门店。",
        "tags": "防坑,购物",
        "category": "防坑",
        "city": "杭州",
        "source": "",
        "updated_at": "2026-09-19",
    },
    {
        "text": "本地特色：龙井茶产自西湖龙井村一带，以「色绿、香郁、味甘、形美」四绝著称。",
        "tags": "本地特色,龙井茶",
        "category": "本地特色",
        "city": "杭州",
        "source": "",
        "updated_at": "2026-09-19",
    },
    {
        "text": "本地特色：杭帮菜代表有西湖醋鱼、东坡肉、龙井虾仁，老字号如楼外楼、知味观。",
        "tags": "本地特色,美食",
        "category": "本地特色",
        "city": "杭州",
        "source": "",
        "updated_at": "2026-09-19",
    },
    # ---- 通用知识（city 为空，任何目的地均适用）----
    {
        "text": "拍照建议：清晨与黄昏光线柔和、人少，适合拍风景；正午强光易过曝，可避开。",
        "tags": "拍照,建议",
        "category": "拍照",
        "city": "",
        "source": "",
        "updated_at": "2026-09-19",
    },
    {
        "text": "动线建议：先在地图上标记想去的点，按地理就近串联，可减少往返路程。",
        "tags": "动线,建议",
        "category": "动线",
        "city": "",
        "source": "",
        "updated_at": "2026-09-19",
    },
    {
        "text": "防坑建议：热门景区建议提前通过官方渠道预约购票，现场可能排长队。",
        "tags": "防坑,预约",
        "category": "防坑",
        "city": "",
        "source": "",
        "updated_at": "2026-09-19",
    },
    {
        "text": "装备建议：户外或海边出行注意防晒补水，备好帽子、防晒霜与饮用水。",
        "tags": "装备,建议",
        "category": "装备",
        "city": "",
        "source": "",
        "updated_at": "2026-09-19",
    },
    {
        "text": "出行建议：热门目的地建议错峰出行，避开节假日人流高峰，赶场预留交通缓冲时间。",
        "tags": "出行,建议",
        "category": "出行",
        "city": "",
        "source": "",
        "updated_at": "2026-09-19",
    },
]


# 种子数据版本号：STABLE_KNOWLEDGE 内容有增删时 +1，触发旧库清空重播
SEED_VERSION = 2


def init_kb() -> None:
    """初始化知识库表结构（幂等，含旧库 city 列迁移）。"""
    conn = get_conn()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS knowledge_chunks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            text TEXT NOT NULL,
            tags TEXT NOT NULL,
            category TEXT NOT NULL,
            city TEXT NOT NULL DEFAULT '',
            source TEXT DEFAULT '',
            updated_at TEXT DEFAULT ''
        )
        """
    )
    # 迁移：旧版表没有 city 列，动态补列
    cols = [r["name"] for r in conn.execute("PRAGMA table_info(knowledge_chunks)")]
    if "city" not in cols:
        conn.execute(
            "ALTER TABLE knowledge_chunks ADD COLUMN city TEXT NOT NULL DEFAULT ''"
        )
    conn.commit()
    conn.close()


def _insert_seed(conn: sqlite3.Connection) -> None:
    """把种子知识写入表。"""
    rows = [
        (c["text"], c["tags"], c["category"], c["city"], c["source"], c["updated_at"])
        for c in STABLE_KNOWLEDGE
    ]
    conn.executemany(
        "INSERT INTO knowledge_chunks(text, tags, category, city, source, updated_at)"
        " VALUES (?, ?, ?, ?, ?, ?)",
        rows,
    )


def seed_kb() -> None:
    """首次运行播种知识库；种子内容版本变化时清空重播（旧版杭州写死亦被覆盖）。"""
    init_kb()
    conn = get_conn()
    conn.execute(
        "CREATE TABLE IF NOT EXISTS kb_meta (key TEXT PRIMARY KEY, value TEXT)"
    )
    row = conn.execute("SELECT value FROM kb_meta WHERE key = 'seed_version'").fetchone()
    current = int(row["value"]) if row else 0
    count = conn.execute("SELECT COUNT(*) AS c FROM knowledge_chunks").fetchone()["c"]
    if count == 0:
        _insert_seed(conn)  # 首次播种
    elif current != SEED_VERSION:
        # 种子内容有更新（或旧版杭州写死、无 city 标记）：清空重播。
        # 注意：运营在库里手工新增的行会被覆盖，如需保留请先导出。
        conn.execute("DELETE FROM knowledge_chunks")
        _insert_seed(conn)
    conn.execute(
        "INSERT OR REPLACE INTO kb_meta(key, value) VALUES ('seed_version', ?)",
        (str(SEED_VERSION),),
    )
    conn.commit()
    conn.close()


def get_all_chunks() -> List[Dict[str, Any]]:
    """读取全部知识片段（自动初始化 + 播种）。"""
    init_kb()
    seed_kb()
    conn = get_conn()
    rows = conn.execute(
        "SELECT text, tags, category, city, source FROM knowledge_chunks"
    ).fetchall()
    conn.close()
    return [
        {
            "text": r["text"],
            "tags": r["tags"].split(","),
            "category": r["category"],
            "city": r["city"],
            "source": r["source"],
        }
        for r in rows
    ]
