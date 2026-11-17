import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  completeDetectionRound,
  listRecalcRows,
  loadPoolSnapshots,
  loadThresholdConfig,
} from '@/api/proxy-threshold-service'
import { downloadEntries, listEntries, moduleMeta, runAction as applyAction } from '@/api/local-service'
import type { EntryRow, ProxyPoolSnapshot, ProxyRecalcRow, ThresholdConfig } from '@/data/types'

const meta = moduleMeta('spider')
const columns = [
  "作业编号",
  "目标站点",
  "抽取模板",
  "起始地址",
  "并发线程数",
  "请求间隔秒",
  "每日上限条数",
  "超时秒数"
]
const actions = [
  "提交执行",
  "启动采集",
  "终止采集",
  "归档结果"
]
const statuses = [
  "草稿",
  "待执行",
  "运行中",
  "已完成",
  "已失败"
]

export default function SpiderView() {
  const [rows, setRows] = useState<EntryRow[]>([])
  const [total, setTotal] = useState(0)
  const [errorMessage, setErrorMessage] = useState('')
  const [notice, setNotice] = useState('')
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [snapshots, setSnapshots] = useState<Record<string, ProxyPoolSnapshot>>({})
  const [recalcRows, setRecalcRows] = useState<ProxyRecalcRow[]>([])
  const [config, setConfig] = useState<ThresholdConfig | null>(null)
  const filterFields = useMemo(() => columns.slice(0, 3), [])

  const reload = useCallback(() => {
    setErrorMessage('')
    try {
      const payload = listEntries(meta.key, filters)
      setRows(payload.items)
      setTotal(payload.total)
      setSnapshots(loadPoolSnapshots())
      setRecalcRows(listRecalcRows())
      setConfig(loadThresholdConfig())
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '任务编排列表读取失败')
    }
  }, [filters])

  useEffect(() => {
    reload()
  }, [reload])

  const stats = useMemo(() => {
    const running = rows.filter((row) => String(row.status) === '运行中').length
    const done = rows.filter((row) => String(row.status) === '已完成').length
    const pendingRecalc = recalcRows.filter((row) => row.pending).length
    return [
      { label: '采集作业总数', value: rows.length },
      { label: '运行中作业', value: running },
      { label: '已完成作业', value: done },
      { label: '重算待回写节点', value: pendingRecalc },
    ]
  }, [rows, recalcRows])

  function runAction(action: string, row: EntryRow) {
    setErrorMessage('')
    const result = applyAction(meta.key, Number(row.id), action)
    if (!result.ok) {
      setErrorMessage(result.message)
      return
    }
    reload()
  }

  function handleDetectionDone() {
    setErrorMessage('')
    const result = completeDetectionRound()
    if (!result.ok) {
      setErrorMessage(result.message)
      return
    }
    setNotice(result.message)
    reload()
  }

  const pendingNextCount = recalcRows.filter((row) => row.status === '待下一轮检测').length

  return (
    <section className="page" data-module="spider">
      <header className="page-head">
        <div>
          <h2>任务编排管理</h2>
          <p className="page-desc">代理节点阈值重算清单同步回写本页：运行中作业继续使用原池，只有跨过阈值的节点从下一波轮换池移除。</p>
        </div>
        <div className="page-actions">
          <button className="btn primary" type="button" onClick={() => setErrorMessage('采集作业登记入口尚未接入审批流')}>
            登记采集作业
          </button>
          <button className="btn" type="button" onClick={handleDetectionDone} disabled={pendingNextCount === 0}>
            下一轮检测完成，按新上限切换
          </button>
          <button className="btn" type="button" onClick={() => downloadEntries(meta.key)}>
            导出任务编排清单
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

      {notice && <p className="notice-text">{notice}</p>}
      {errorMessage && <p className="error-text">{errorMessage}</p>}
      <p className="page-desc">
        当前生效阈值批次：{config?.activeBatchNo || '暂无'}　｜　待下一轮检测切换节点：{pendingNextCount}
      </p>

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
            <th>当前轮换池（原池）</th>
            <th>下一波轮换池</th>
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const jobNo = String(row['作业编号'] ?? '')
            const snapshot = snapshots[jobNo]
            const running = String(row.status) === '运行中'
            return (
              <tr key={String(row.id)}>
                {columns.map((column) => <td key={column}>{row[column] ?? '—'}</td>)}
                <td>{row.status}</td>
                <td className={running ? 'pool-locked' : undefined}>
                  {row['当前轮换池'] || '—'}
                  {running && <span className="pool-tag">运行中锁定原池</span>}
                  {snapshot && <div className="pool-sub">快照批次：{snapshot.生效批次}</div>}
                </td>
                <td>
                  {row['下一波轮换池'] || '—'}
                  {snapshot && snapshot.移除节点编号.length > 0 && (
                    <div className="pool-sub removed">移除：{snapshot.移除节点编号.join(',')}</div>
                  )}
                </td>
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
              <td className="empty-state" colSpan={columns.length + 4}>暂无任务编排数据，可先登记采集作业</td>
            </tr>
          )}
        </tbody>
      </table>

      <div className="recalc-panel">
        <h3>代理节点阈值重算清单回写（任务编排只移除跨过阈值的节点）</h3>
        <table className="data-table">
          <thead>
            <tr>
              <th>批次编号</th><th>节点编号</th><th>代理地址</th><th>失败计数</th>
              <th>原上限</th><th>新上限</th><th>跨阈值方向</th><th>重算状态</th>
              <th>落库做法</th><th>复核依据</th><th>清单状态</th><th>业务日期</th>
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
                <td>{row.重算节点状态}</td>
                <td>{row.重算策略}</td>
                <td>{row.复核依据}</td>
                <td>{row.status}</td>
                <td>{row.业务日期}</td>
              </tr>
            ))}
            {recalcRows.length === 0 && (
              <tr>
                <td className="empty-state" colSpan={12}>暂无回写记录</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <footer className="page-foot">
        <span>共 {total} 条任务编排记录</span>
      </footer>
    </section>
  )
}
