import { useEffect, useState } from 'react'

/**
 * 本地 7B 生成一整份规划的典型耗时（秒）。
 *
 * 按后端 skill 计时实测校准：检索 30~40s + 规划 30~70s + 体检 55~80s，
 * 小规划约 90s，大规划接近 190s。原先写 100 会导致进度条早早卡在
 * 「已超出预估时间」一分多钟，看起来像卡死或反复重算。
 */
const ESTIMATED_TOTAL_SECONDS = 180

interface Props {
  elapsed: number
  checking: boolean
  onCancel: () => void
  onCheckConnection: () => void
}

export default function ProgressCard({ elapsed, checking, onCancel, onCheckConnection }: Props) {
  const [pct, setPct] = useState(0)

  /* 超过预估时间后进度条停在 95%，不假装还在推进 */
  useEffect(() => {
    const next = Math.min(95, Math.round((elapsed / ESTIMATED_TOTAL_SECONDS) * 100))
    setPct((cur) => Math.max(cur, next))
  }, [elapsed])

  const remain = Math.max(0, ESTIMATED_TOTAL_SECONDS - elapsed)

  return (
    <div className="card">
      <div className="card__head" style={{ marginBottom: 0 }}>
        <div>
          <h2 className="card__title">正在生成规划</h2>
          <div className="meta" style={{ marginTop: 4 }}>
            已等待 {elapsed} 秒
            {elapsed < ESTIMATED_TOTAL_SECONDS
              ? ` · 预计还需约 ${remain} 秒`
              : ' · 比预估慢一些，仍在运行中…'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn--ghost btn--sm" onClick={onCheckConnection} disabled={checking}>
            {checking ? '检测中…' : '检查连接'}
          </button>
          <button className="btn btn--ghost btn--sm" onClick={onCancel}>
            取消
          </button>
        </div>
      </div>

      <div className="bar" style={{ marginTop: 14 }}>
        <div className="bar__seg" style={{ width: `${pct}%`, background: 'var(--accent)' }} />
      </div>

      <p className="meta" style={{ margin: '12px 0 0' }}>
        本地大模型生成一整份规划通常 1~2 分钟；首次运行需要加载模型、或触发重新生成时会久一些。
        超过 5 分钟会自动超时，你也可以先取消。
      </p>
    </div>
  )
}
