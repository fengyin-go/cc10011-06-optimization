import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  applyFailureLimit,
  listProxyNodes,
  listRecalcRows,
  loadThresholdConfig,
  recoverProxyRotation,
  reviewRecalcRow,
} from '@/api/proxy-threshold-service'
import { downloadEntries, listEntries, moduleMeta, runAction as applyAction } from '@/api/local-service'
import type { EntryRow, ProxyRecalcRow, ThresholdConfig, ThresholdPolicy } from '@/data/types'
import type { ApplyLimitResult } from '@/api/proxy-threshold-service'

const meta = moduleMeta('proxy')
const columns = [
  "节点编号",
  "代理地址",
  "代理协议",
  "地域标签",
  "匿名级别",
  "响应速度",
  "存活检测间隔",
  "当前失败计数",
  "连续失败上限"
]
const actions = [
  "标记可用",
  "标记不可用",
  "移除节点"
]
const statuses = [
  "草稿",
  "可用",
  "不可用",
  "已移除"
]

export default function ProxyView() {
  const [rows, setRows] = useState<EntryRow[]>([])
  const [total, setTotal] = useState(0)
  const [errorMessage, setErrorMessage] = useState('')
  const [notice, setNotice] = useState('')
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [limitInput, setLimitInput] = useState('5')
  const [policy, setPolicy] = useState<ThresholdPolicy>('immediate')
  const [config, setConfig] = useState<ThresholdConfig | null>(null)
  const [recalcRows, setRecalcRows] = useState<ProxyRecalcRow[]>([])
  const [lastResult, setLastResult] = useState<ApplyLimitResult | null>(null)
  const filterFields = useMemo(() => ['节点编号', '代理地址', '代理协议'], [])

  const reload = useCallback(() => {
    setErrorMessage('')
    try {
      const payload = listEntries(meta.key, filters)
      setRows(payload.items)
      setTotal(payload.total)
      const current = loadThresholdConfig()
      setConfig(current)
      setLimitInput(String(current.currentLimit))
      setPolicy(current.policy)
      setRecalcRows(listRecalcRows())
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '代理轮换列表读取失败')
    }
  }, [filters])

  useEffect(() => {
    reload()
  }, [reload])

  const stats = useMemo(() => {
    const available = rows.filter((row) => String(row.status) === '可用').length
    const unavailable = rows.filter((row) => String(row.status) === '不可用').length
    const pendingRecalc = recalcRows.filter((row) => row.pending).length
    return [
      { label: '代理节点总数', value: rows.length },
      { label: '可用节点数', value: available },
      { label: '不可用节点数', value: unavailable },
      { label: '重算待处理节点', value: pendingRecalc },
    ]
  }, [rows, recalcRows])

  const nodes = useMemo(() => listProxyNodes(), [rows])

  function runAction(action: string, row: EntryRow) {
    setErrorMessage('')
    const result = applyAction(meta.key, Number(row.id), action)
    if (!result.ok) {
      setErrorMessage(result.message)
      return
    }
    reload()
  }

  function handleApplyLimit() {
    setErrorMessage('')
    setNotice('')
    const result = applyFailureLimit(Number(limitInput), policy)
    if (!result.ok) {
      setErrorMessage(result.message)
      return
    }
    setNotice(result.message)
    setLastResult(result)
    reload()
  }

  function handleRecover() {
    setErrorMessage('')
    const result = recoverProxyRotation()
    if (!result.ok) {
      setErrorMessage(result.message)
      return
    }
    setNotice(result.message)
    reload()
  }

  function handleReview(row: ProxyRecalcRow) {
    setErrorMessage('')
    const result = reviewRecalcRow(Number(row.id))
    if (!result.ok) {
      setErrorMessage(result.message)
      return
    }
    setNotice(result.message)
    reload()
  }

  const boundaryNos = useMemo(
    () => new Set((lastResult?.crossings ?? []).filter((item) => item.boundary).map((item) => item.nodeNo)),
    [lastResult],
  )

  return (
    <section className="page" data-module="proxy">
      <header className="page-head">
        <div>
          <h2>代理轮换管理</h2>
          <p className="page-desc">调整连续失败上限后按阈值差额重算节点资格，只标记跨过阈值的节点；运行中采集作业继续使用原池。</p>
        </div>
        <div className="page-actions">
          <button className="btn primary" type="button" onClick={() => setErrorMessage('代理节点登记入口尚未接入审批流')}>
            登记代理节点
          </button>
          <button className="btn" type="button" onClick={() => downloadEntries(meta.key)}>
            导出代理轮换清单
          </button>
        </div>
      </header>

      <div className="stat-row">
        {stats.map((item) => (
          <article key={item.label} className="stat-card">
            <span className="stat-label">{item.label}</span>
            <strong className="stat-value">{item.value}</strong>
          </article>
        ))}
      </div>

      <div className="threshold-panel">
        <h3>失败上限调整与阈值重算</h3>
        <div className="threshold-form">
          <label className="filter-item">
            <span>新连续失败上限</span>
            <input
              type="number"
              min={1}
              value={limitInput}
              onChange={(event) => setLimitInput(event.target.value)}
            />
          </label>
          <label className="filter-item">
            <span>落库做法</span>
            <select value={policy} onChange={(event) => setPolicy(event.target.value as ThresholdPolicy)}>
              <option value="immediate">配置生效时立即按新上限重判（复核依据）</option>
              <option value="nextDetection">下一轮检测完成后再按新上限切换（侧重影响范围）</option>
            </select>
          </label>
          <button className="btn primary" type="button" onClick={handleApplyLimit}>保存并按新上限重判</button>
          <button className="btn" type="button" onClick={handleRecover}>代理轮换中断恢复</button>
        </div>
        <p className="page-desc">
          当前生效上限：{config?.currentLimit ?? '—'}　｜　生效批次：{config?.activeBatchNo || '暂无'}　｜　重算次数：{config?.history.length ?? 0}
          （同阈值重复应用不会再次减少可用节点，也不会写入新的待处理记录）
        </p>
        {notice && <p className="notice-text">{notice}</p>}
        {errorMessage && <p className="error-text">{errorMessage}</p>}
        {config && config.history.length > 0 && (
          <details className="history-box">
            <summary>阈值变更历史（旧标准只作为历史依据，共 {config.history.length} 次）</summary>
            <table className="data-table inner-table">
              <thead>
                <tr><th>批次编号</th><th>原上限</th><th>新上限</th><th>跨阈值节点</th><th>落库做法</th><th>生效时间</th><th>业务日期</th></tr>
              </thead>
              <tbody>
                {[...config.history].reverse().map((item) => (
                  <tr key={item.批次编号}>
                    <td>{item.批次编号}</td>
                    <td>{item.原失败上限}</td>
                    <td>{item.新失败上限}</td>
                    <td>{item.跨阈值节点数}</td>
                    <td>{item.重算策略}</td>
                    <td>{item.生效时间}</td>
                    <td>{item.业务日期}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        )}
      </div>

      <p className="status-legend">
        {statuses.map((status: string) => (
          <span key={status} className="legend-item">
            {status}：{rows.filter((row) => String(row.status) === status).length}
          </span>
        ))}
      </p>

      <form className="filter-bar" onSubmit={(event) => { event.preventDefault(); reload() }}>
        {filterFields.map((field) => (
          <label key={field} className="filter-item">
            <span>{field}</span>
            <input
              value={filters[field] ?? ''}
              placeholder={`按${field}检索`}
              onChange={(event) => setFilters((prev) => ({ ...prev, [field]: event.target.value }))}
            />
          </label>
        ))}
        <button className="btn" type="submit">查询</button>
        <button className="btn ghost" type="button" onClick={() => setFilters({})}>重置条件</button>
      </form>

      <table className="data-table">
        <thead>
          <tr>
            {columns.map((column) => <th key={column}>{column}</th>)}
            <th>当前状态</th>
            <th>阈值判定预览</th>
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const node = nodes.find((item) => item.nodeNo === String(row['节点编号']))
            const preview = node
              ? node.failureCount >= node.failureLimit
                ? '已达上限→不可用'
                : `距上限还差 ${node.failureLimit - node.failureCount} 次`
              : '—'
            const isBoundary = boundaryNos.has(String(row['节点编号']))
            return (
              <tr key={String(row.id)} className={isBoundary ? 'boundary-row' : undefined}>
                {columns.map((column) => <td key={column}>{row[column] ?? '—'}</td>)}
                <td>{row.status}{isBoundary && <span className="boundary-tag">边界节点</span>}</td>
                <td>{preview}</td>
                <td className="row-actions">
                  {actions.map((action) => (
                    <button key={action} className="link" type="button" onClick={() => runAction(action, row)}>
                      {action}
                    </button>
                  ))}
                </td>
              </tr>
            )
          })}
          {rows.length === 0 && (
            <tr>
              <td className="empty-state" colSpan={columns.length + 3}>暂无代理轮换数据，可先登记代理节点</td>
            </tr>
          )}
        </tbody>
      </table>

      <div className="recalc-panel">
        <h3>代理节点阈值重算清单（只含跨过阈值的节点，供复核）</h3>
        <table className="data-table">
          <thead>
            <tr>
              <th>批次编号</th><th>节点编号</th><th>代理地址</th><th>失败计数</th>
              <th>原上限</th><th>新上限</th><th>跨阈值方向</th><th>原状态</th>
              <th>重算状态</th><th>落库做法</th><th>复核依据</th><th>清单状态</th><th>生效时间</th><th>操作</th>
            </tr>
          </thead>
          <tbody>
            {recalcRows.map((row) => (
              <tr key={String(row.id)} className={row.pending ? 'pending-row' : undefined}>
                <td>{row.批次编号}</td>
                <td>{row.节点编号}</td>
                <td>{row.代理地址}</td>
                <td>{row.当前失败计数}</td>
                <td>{row.原失败上限}</td>
                <td>{row.新失败上限}</td>
                <td>{row.跨阈值方向}</td>
                <td>{row.原节点状态}</td>
                <td>{row.重算节点状态}</td>
                <td>{row.重算策略}</td>
                <td>{row.复核依据}</td>
                <td>{row.status}</td>
                <td>{row.生效时间}</td>
                <td className="row-actions">
                  <button className="link" type="button" disabled={!row.pending} onClick={() => handleReview(row)}>
                    复核确认
                  </button>
                </td>
              </tr>
            ))}
            {recalcRows.length === 0 && (
              <tr>
                <td className="empty-state" colSpan={14}>暂无重算记录：调整失败上限后，只有跨过新阈值的节点会出现在这里</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <footer className="page-foot">
        <span>共 {total} 条代理轮换记录</span>
      </footer>
    </section>
  )
}
