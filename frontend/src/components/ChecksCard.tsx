import type { TravelPlan } from '../types/plan'
import { severityOf } from '../lib/format'

interface Props {
  plan: TravelPlan
  disabled?: boolean
  onApply: () => void
  notify: (text: string) => void
}

/** 规划体检 + 偏好冲突：系统只提示、不擅自改，采纳与否由用户决定 */
export default function ChecksCard({ plan, disabled, onApply, notify }: Props) {
  const issues = [
    ...(plan.checks?.issues ?? []).map((i) => ({
      category: i.category as string,
      severity: severityOf(i.severity),
      message: i.message,
      suggestion: i.suggestion,
    })),
    ...(plan.conflicts ?? []).map((c) => ({
      category: '偏好冲突',
      severity: 'medium' as const,
      message: c.message,
      suggestion: c.suggestion,
    })),
  ]

  return (
    <div className="card">
      <div className="card__head">
        <h2 className="card__title">规划体检</h2>
        <span className="meta">{issues.length} 条</span>
      </div>
      {issues.length === 0 ? (
        <p className="meta">未发现明显问题。</p>
      ) : (
        <div className="issues">
          {issues.map((it, i) => (
            <div className="issue" key={i}>
              <span className={`issue__sev sev-${it.severity}`} />
              <div className="issue__body">
                <div className="issue__cat">{it.category}</div>
                <p className="issue__msg">{it.message}</p>
                {it.suggestion && <p className="issue__msg faint">建议：{it.suggestion}</p>}
                <div className="issue__acts">
                  <button className="btn btn--link" disabled={disabled} onClick={onApply}>
                    采纳并重排
                  </button>
                  <button className="btn btn--muted" onClick={() => notify('已保持原样')}>
                    忽略
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
