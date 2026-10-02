import type { TravelPlan } from '../types/plan'
import { severityOf } from '../lib/format'

interface Props {
  plan: TravelPlan
  disabled?: boolean
  notify: (text: string) => void
}

/** 规划体检：系统只提示、不擅自改行程 */
export default function ChecksCard({ plan, disabled, notify }: Props) {
  // 流式生成下，行程会先于体检到达：这时不要让"未发现明显问题"误导用户
  const pending = Boolean(disabled) && !plan.checks
  // 体检结论只是"报告"：系统不替用户改任何东西，所以没有一键采纳按钮
  const issues = (plan.checks?.issues ?? []).map((i) => ({
    category: i.category as string,
    severity: severityOf(i.severity),
    message: i.message,
    suggestion: i.suggestion,
  }))

  return (
    <div className="card">
      <div className="card__head">
        <h2 className="card__title">规划体检</h2>
        <span className="meta">{pending ? '进行中…' : `${issues.length} 条`}</span>
      </div>
      {pending ? (
        <p className="meta">
          行程已经可以先看了，体检还在跑——它会检查绕路、重复安排、时间是否过满，
          结论出来后自动补在这里。
        </p>
      ) : issues.length === 0 ? (
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
                  <span className="issue__hint">可按建议调整条件后重新生成</span>
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
