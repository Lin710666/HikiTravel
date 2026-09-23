import { useEffect, useRef, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Col,
  Empty,
  Input,
  List,
  Modal,
  Progress,
  Row,
  Space,
  Spin,
  Typography,
} from 'antd'
import type { UserPreference } from '../types/preference'
import type { TravelPlan } from '../types/plan'
import {
  ApiError,
  getPlan,
  health,
  listPlans,
  planByChat,
  planByForm,
  revisePlan,
  savePlan,
  type ApiErrorKind,
  type PlanSummary,
} from '../api/client'
import PreferenceForm from '../components/PreferenceForm'
import PlanView from '../components/PlanView'
import MapView from '../components/MapView'

// 记录最近一次请求，用于「一键采纳建议」时按原画像/原话重新生成
type LastRequest =
  | { kind: 'form'; pref: Partial<UserPreference> }
  | { kind: 'chat'; message: string; base?: Partial<UserPreference> }
  | { kind: 'revise'; message: string; plan: TravelPlan }

// 本地 7B 的典型耗时（秒）：用于给用户一个"大概还要等多久"的估计
const ESTIMATED_TOTAL_SECONDS = 100

export default function PlannerPage() {
  const [plan, setPlan] = useState<TravelPlan | null>(null)
  const [loading, setLoading] = useState(false)
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errorKind, setErrorKind] = useState<ApiErrorKind | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [checking, setChecking] = useState(false)
  const [env, setEnv] = useState<{ amap_configured: boolean; ollama_available: boolean } | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyList, setHistoryList] = useState<PlanSummary[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const lastReqRef = useRef<LastRequest | null>(null)
  // 生成中的请求控制器：用于「取消」与超时中断
  const abortRef = useRef<AbortController | null>(null)
  // 表单当前已填的部分画像：对话生成时作为「底」一并提交，避免对话解析覆盖表单的精确填写
  const formPrefRef = useRef<Partial<UserPreference>>({})

  useEffect(() => {
    health().then(setEnv).catch(() => setEnv(null))
  }, [])

  // 生成中显示已等待时长（本地大模型较慢，用户需要知道系统没卡死）
  useEffect(() => {
    if (!loading) {
      setElapsed(0)
      return
    }
    const startedAt = Date.now()
    const id = window.setInterval(
      () => setElapsed(Math.floor((Date.now() - startedAt) / 1000)),
      1000,
    )
    return () => window.clearInterval(id)
  }, [loading])

  const run = async (req: LastRequest, apply = false) => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setLoading(true)
    setError(null)
    setErrorKind(null)
    try {
      const p =
        req.kind === 'form'
          ? await planByForm(req.pref, apply, controller.signal)
          : req.kind === 'chat'
            ? await planByChat(req.message, apply, req.base, controller.signal)
            : await revisePlan(req.message, req.plan, controller.signal)
      setPlan(p)
      lastReqRef.current = req
    } catch (e) {
      const err = e as ApiError
      if (err.kind === 'aborted') {
        setNotice('已取消本次生成')
        return
      }
      setError(err.message || '生成失败')
      setErrorKind(err.kind ?? 'network')
    } finally {
      setLoading(false)
      if (abortRef.current === controller) abortRef.current = null
    }
  }

  // 取消生成：等待太久或想换条件时不用干等
  const handleCancel = () => {
    abortRef.current?.abort()
    setLoading(false)
  }

  // 重试：用最近一次的条件重新生成
  const handleRetry = () => {
    if (lastReqRef.current) run(lastReqRef.current)
    else setNotice('请重新填写偏好，或输入一句话生成')
  }

  // 对话式修改：在当前画像与行程基础上改，不用重新填表
  const handleRevise = (message: string) => {
    if (!plan) return
    run({ kind: 'revise', message, plan })
  }

  // 连接自检：后端 / 本地大模型 / 高德密钥 分别是什么状态
  const handleCheckConnection = async () => {
    setChecking(true)
    try {
      const h = await health()
      setEnv(h)
      const missing = [
        h.ollama_available ? '' : '未检测到本地大模型（Ollama）',
        h.amap_configured ? '' : '未配置高德密钥（AMAP_API_KEY）',
      ].filter(Boolean)
      setNotice(
        missing.length === 0
          ? '连接正常：后端、本地大模型、高德密钥均可用'
          : `后端连接正常，但${missing.join('、')}`,
      )
    } catch (e) {
      const err = e as ApiError
      setError(err.message || '连接检查失败')
      setErrorKind(err.kind ?? 'network')
    } finally {
      setChecking(false)
    }
  }

  const handleApply = async () => {
    if (!lastReqRef.current) return
    setApplying(true)
    try {
      await run(lastReqRef.current, true)
    } finally {
      setApplying(false)
    }
  }

  // 保存（覆盖）当前规划（含编辑结果）到后端，下次可从「历史计划」打开
  const handleSave = async () => {
    if (!plan) return
    try {
      await savePlan(plan)
      setNotice('已保存，可在「历史计划」中查看')
    } catch (e) {
      setError((e as Error).message)
    }
  }

  // 导出当前规划为 JSON 文件（便于离线保存 / 分享）
  const handleExport = () => {
    if (!plan) return
    const blob = new Blob([JSON.stringify(plan, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `travelplan-${plan.plan_id}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const openHistory = async () => {
    setHistoryOpen(true)
    setHistoryLoading(true)
    setError(null)
    try {
      setHistoryList(await listPlans())
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setHistoryLoading(false)
    }
  }

  const loadPlan = async (id: string) => {
    try {
      const p = await getPlan(id)
      // 兼容旧计划（可能缺少新增的推荐池/出行人数/每晚酒店字段），兜底避免渲染崩溃
      setPlan({
        ...p,
        dining_options: p.dining_options || [],
        hotel_options: p.hotel_options || [],
        attraction_options: p.attraction_options || [],
        travelers: p.travelers || 1,
        daily_plans: (p.daily_plans || []).map((d) => ({ ...d, hotel: d.hotel || null })),
      })
      setHistoryOpen(false)
      setNotice('已加载历史计划')
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', padding: 16 }}>
      <Typography.Title level={3} style={{ marginTop: 8 }}>
        文旅智能辅助 · 个性化旅游规划
      </Typography.Title>

      {env && !env.amap_configured && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="未检测到高德密钥（AMAP_API_KEY）。请在 backend/.env 中配置后重启后端，否则无法获取实时 POI/天气数据。"
        />
      )}

      {env && !env.ollama_available && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="未检测到本地大模型（Ollama）。需求解析与规划生成都依赖大模型，请先启动 Ollama 并拉取模型后再生成规划。"
        />
      )}

      <Row gutter={16}>
        <Col xs={24} lg={8}>
          <PreferenceForm
            onSubmit={(pref) => run({ kind: 'form', pref })}
            onChange={(pref) => (formPrefRef.current = pref)}
            loading={loading}
          />

          <Card title="对话生成" size="small" style={{ marginTop: 12 }}>
            <Input.Search
              placeholder="例如：带80岁老人特种兵游杭州，3天，预算2000"
              enterButton="生成"
              loading={loading}
              onSearch={(value) => value && run({ kind: 'chat', message: value, base: formPrefRef.current })}
            />
          </Card>
        </Col>

        <Col xs={24} lg={16}>
          {/* 生成中：显示已等待时长，并提供「取消 / 检查连接」 */}
          {loading && (
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 12 }}
              message={`正在生成你的规划…已等待 ${elapsed} 秒`}
              description={
                <div>
                  <Progress
                    percent={Math.min(95, Math.round((elapsed / ESTIMATED_TOTAL_SECONDS) * 100))}
                    status="active"
                    showInfo={false}
                    style={{ marginBottom: 6 }}
                  />
                  预计还需约 {Math.max(0, ESTIMATED_TOTAL_SECONDS - elapsed)} 秒
                  （本地大模型生成一整份规划通常 1~2 分钟；首次运行需要加载模型、或触发重新生成时会久一些）。
                  若超过 5 分钟会自动超时，你也可以先取消。
                </div>
              }
              action={
                <Space>
                  <Button size="small" loading={checking} onClick={handleCheckConnection}>
                    检查连接
                  </Button>
                  <Button size="small" danger onClick={handleCancel}>
                    取消
                  </Button>
                </Space>
              }
            />
          )}
          {error && (
            <Alert
              type="error"
              showIcon
              style={{ marginBottom: 12 }}
              message={error}
              description={
                errorKind === 'network' || errorKind === 'timeout'
                  ? '这通常是后端服务或本地大模型（Ollama）断开、或还在加载导致的。' +
                    '可以先点「检查连接」看状态，恢复后点「重试」继续，不用重新填一遍。'
                  : undefined
              }
              action={
                <Space direction="vertical" size={4}>
                  <Button size="small" type="primary" onClick={handleRetry}>
                    重试
                  </Button>
                  <Button size="small" loading={checking} onClick={handleCheckConnection}>
                    检查连接
                  </Button>
                </Space>
              }
            />
          )}
          {notice && (
            <Alert type="success" showIcon message={notice} closable onClose={() => setNotice(null)} style={{ marginBottom: 12 }} />
          )}
          <Spin spinning={loading}>
            {plan ? (
              <>
                <Space style={{ marginBottom: 12 }} wrap>
                  <Button onClick={handleSave}>保存计划</Button>
                  <Button onClick={handleExport}>导出 JSON</Button>
                  <Button onClick={openHistory}>历史计划</Button>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    可移除景点 / 换餐厅，预算与地图将实时更新
                  </Typography.Text>
                </Space>
                {/* 对话式修改：在已有画像上提新要求，不用重新填表 */}
                <Card size="small" title="不满意？直接用一句话改" style={{ marginBottom: 12 }}>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    会基于当前条件与行程重排，例如「预算压到 2500」「第二天换成室内景点」
                    「节奏改悠闲」「加一天」
                  </Typography.Text>
                  <Input.Search
                    placeholder="说说你想怎么改，回车即可"
                    enterButton="修改规划"
                    loading={loading}
                    style={{ marginTop: 8 }}
                    onSearch={(value) => value && handleRevise(value)}
                  />
                </Card>
                <PlanView plan={plan} onApplySuggestions={handleApply} applying={applying} onUpdate={setPlan} />
                <MapView plan={plan} />
              </>
            ) : (
              <Card>
                <Empty description="填写偏好或输入一句话，生成你的专属旅行规划" />
              </Card>
            )}
          </Spin>
        </Col>
      </Row>

      {/* 页脚显示前端构建时间：一眼就能确认浏览器加载的是不是最新前端（排查缓存问题用） */}
      <Typography.Paragraph type="secondary" style={{ fontSize: 11, textAlign: 'center', marginTop: 16 }}>
        前端构建时间：{__BUILD_TIME__} · 后端接口：/api/health
      </Typography.Paragraph>

      <Modal title="历史计划" open={historyOpen} footer={null} onCancel={() => setHistoryOpen(false)}>
        <List
          loading={historyLoading}
          dataSource={historyList}
          locale={{ emptyText: '暂无历史计划' }}
          renderItem={(item) => (
            <List.Item
              actions={[
                <Button key="load" type="link" onClick={() => loadPlan(item.plan_id)}>
                  打开
                </Button>,
              ]}
            >
              <List.Item.Meta title={item.summary} description={item.created_at} />
            </List.Item>
          )}
        />
      </Modal>
    </div>
  )
}
