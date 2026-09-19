"""本地计划存储（SQLite）。

对应需求文档「数据安全导出、用户隐私数据本地存储」：
生成的规划落地到本地 SQLite，支持历史查看与导出，隐私数据不出机。
"""
import json
from typing import Any, Dict, List, Optional

from .db import get_conn


def init_store() -> None:
    """初始化 plans 表（幂等）。"""
    conn = get_conn()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS plans (
            plan_id TEXT PRIMARY KEY,
            summary TEXT,
            created_at TEXT DEFAULT (datetime('now','localtime')),
            payload TEXT NOT NULL
        )
        """
    )
    conn.commit()
    conn.close()


def save_plan(plan: Dict[str, Any]) -> None:
    """保存（或覆盖）一条规划。"""
    init_store()
    conn = get_conn()
    conn.execute(
        "INSERT OR REPLACE INTO plans(plan_id, summary, payload) VALUES (?, ?, ?)",
        (plan.get("plan_id"), plan.get("summary"), json.dumps(plan, ensure_ascii=False)),
    )
    conn.commit()
    conn.close()


def get_plan(plan_id: str) -> Optional[Dict[str, Any]]:
    """按 ID 读取一条规划。"""
    init_store()
    conn = get_conn()
    row = conn.execute("SELECT payload FROM plans WHERE plan_id = ?", (plan_id,)).fetchone()
    conn.close()
    return json.loads(row["payload"]) if row else None


def list_plans() -> List[Dict[str, Any]]:
    """读取历史规划列表（最近 50 条）。"""
    init_store()
    conn = get_conn()
    rows = conn.execute(
        "SELECT plan_id, summary, created_at FROM plans ORDER BY created_at DESC LIMIT 50"
    ).fetchall()
    conn.close()
    return [
        {"plan_id": r["plan_id"], "summary": r["summary"], "created_at": r["created_at"]}
        for r in rows
    ]
