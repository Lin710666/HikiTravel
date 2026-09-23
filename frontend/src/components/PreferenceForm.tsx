import {
  Alert,
  Button,
  Card,
  Col,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Row,
  Select,
  TimePicker,
} from 'antd'
import type { UserPreference } from '../types/preference'

// 可选值配置
const PREFERENCE_OPTIONS = ['人文历史', '自然风光', '美食', '娱乐']
const PACE_OPTIONS = ['悠闲', '适中', '特种兵']
const TRANSPORT_OPTIONS = ['自驾', '高铁', '飞机', '本地']
const AVOID_OPTIONS = ['爬山', '排队', '网红打卡']
const DIET_OPTIONS = ['海鲜', '清真', '素食', '无辣']

interface Props {
  onSubmit: (pref: Partial<UserPreference>) => void
  onChange?: (pref: Partial<UserPreference>) => void
  loading?: boolean
}

// 从表单值构建「仅含已填字段」的部分画像（表单生成 + 对话合并复用）
function buildPartial(values: Record<string, unknown>): Partial<UserPreference> {
  const partial: Partial<UserPreference> = {}
  if (values.destination) partial.destination = values.destination as string
  if (values.duration_days != null) partial.duration_days = values.duration_days as number
  if (values.budget != null) partial.budget = values.budget as number
  if ((values.preferences as string[])?.length) partial.preferences = values.preferences as string[]
  if ((values.must_visit as string[])?.length) partial.must_visit = values.must_visit as string[]
  if (values.pace) partial.pace = values.pace as UserPreference['pace']
  if (values.transportation) partial.transportation = values.transportation as UserPreference['transportation']
  if ((values.dietary_restrictions as string[])?.length)
    partial.dietary_restrictions = values.dietary_restrictions as string[]
  if ((values.avoidances as string[])?.length) partial.avoidances = values.avoidances as string[]
  if (values.start_date) partial.start_date = (values.start_date as { format: (f: string) => string }).format('YYYY-MM-DD')
  // TimePicker 返回 Dayjs，统一格式化成后端约定的 HH:MM
  const hhmm = (v: unknown) => (v as { format: (f: string) => string }).format('HH:mm')
  if (values.departure_time) partial.departure_time = hhmm(values.departure_time)
  if (values.return_hotel_time) partial.return_hotel_time = hhmm(values.return_hotel_time)

  const { adults, children, elderly } = values as Record<string, number | undefined>
  if (adults != null || children != null || elderly != null) {
    partial.travelers = { adults: adults ?? 0, children: children ?? 0, elderly: elderly ?? 0 }
  }
  return partial
}

/**
 * 极简表单：
 * 目的地 / 游玩天数 / 同行人数 / 兴趣导向 / 总预算为必填——这几项直接决定规划结果，
 * 后端不再用"默认杭州""默认 3 天"这类静默参数替用户决定；
 * 其余字段选填，填得越细，规划越贴合。
 */
export default function PreferenceForm({ onSubmit, onChange, loading }: Props) {
  const [form] = Form.useForm()

  const handleFinish = (values: Record<string, unknown>) => {
    onSubmit(buildPartial(values))
  }

  return (
    <Card title="告诉我你的旅行偏好">
      <Alert
        type="info"
        showIcon
        message="目的地、天数、人数、兴趣导向、总预算为必填，其余选填；填得越细，规划越贴合。"
        style={{ marginBottom: 16 }}
      />
      <Form
        form={form}
        layout="vertical"
        onFinish={handleFinish}
        onValuesChange={(_, all) => onChange?.(buildPartial(all))}
      >
        <Row gutter={12}>
          <Col span={24}>
            <Form.Item
              name="destination"
              label="目的地"
              rules={[{ required: true, message: '请填写目的地城市' }]}
            >
              <Input placeholder="例如：杭州（必填）" allowClear />
            </Form.Item>
          </Col>
          <Col span={24}>
            <Form.Item name="must_visit" label="特别想去的景点">
              <Select
                mode="tags"
                placeholder="输入景点名后回车，如：雷峰塔、西湖（选填）"
                allowClear
                tokenSeparators={['、', '，', ',']}
                open={false}
              />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item
              name="adults"
              label="成人"
              dependencies={['children', 'elderly']}
              rules={[
                (form) => ({
                  validator: () => {
                    const total =
                      (form.getFieldValue('adults') || 0) +
                      (form.getFieldValue('children') || 0) +
                      (form.getFieldValue('elderly') || 0)
                    return total > 0
                      ? Promise.resolve()
                      : Promise.reject(new Error('同行人数至少 1 人'))
                  },
                }),
              ]}
            >
              <InputNumber min={0} placeholder="0" style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item name="children" label="儿童">
              <InputNumber min={0} placeholder="0" style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item name="elderly" label="老人">
              <InputNumber min={0} placeholder="0" style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item
              name="duration_days"
              label="游玩天数"
              rules={[{ required: true, message: '请填写游玩天数' }]}
            >
              <InputNumber min={1} max={30} placeholder="例如：3" style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item
              name="budget"
              label="总预算（元）"
              rules={[{ required: true, message: '请填写总预算' }]}
            >
              <InputNumber min={0} placeholder="例如：3000" prefix="¥" style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item
              name="preferences"
              label="兴趣导向"
              rules={[{ required: true, message: '请至少选择一项兴趣导向' }]}
            >
              <Select
                mode="multiple"
                placeholder="选填，可多选"
                allowClear
                options={PREFERENCE_OPTIONS.map((o) => ({ label: o, value: o }))}
              />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="pace" label="游玩节奏">
              <Select
                placeholder="选填"
                allowClear
                options={PACE_OPTIONS.map((o) => ({ label: o, value: o }))}
              />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="transportation" label="往返交通">
              <Select
                placeholder="选填"
                allowClear
                options={TRANSPORT_OPTIONS.map((o) => ({ label: o, value: o }))}
              />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="avoidances" label="讨厌的项目">
              <Select
                mode="multiple"
                placeholder="选填，可多选"
                allowClear
                options={AVOID_OPTIONS.map((o) => ({ label: o, value: o }))}
              />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="dietary_restrictions" label="饮食禁忌">
              <Select
                mode="multiple"
                placeholder="选填，可多选"
                allowClear
                options={DIET_OPTIONS.map((o) => ({ label: o, value: o }))}
              />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item name="start_date" label="出行日期">
              <DatePicker style={{ width: '100%' }} placeholder="选填" />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item
              name="departure_time"
              label="每天出发时间"
              tooltip="留空按 09:00 安排。非特种兵节奏不早于 08:00（特种兵 07:00）"
            >
              <TimePicker format="HH:mm" minuteStep={15} placeholder="默认 09:00" style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item
              name="return_hotel_time"
              label="期望回酒店时间"
              tooltip="留空按 21:00。超过这个时间会优先砍掉靠后的景点（你点名必去的景点不会砍）"
            >
              <TimePicker format="HH:mm" minuteStep={15} placeholder="默认 21:00" style={{ width: '100%' }} />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item style={{ marginBottom: 0 }}>
          <Button type="primary" htmlType="submit" loading={loading} block>
            生成我的旅行规划
          </Button>
        </Form.Item>
      </Form>
    </Card>
  )
}
