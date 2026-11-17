/**
 * 代理节点失败上限重算服务：状态重算的唯一写入口（页面组件不做业务判断）。
 *
 * 链路：管理员在代理轮换页调整「连续失败上限」 -> applyFailureLimit 立即按新上限重判，
 * 只改跨过阈值的节点并生成代理节点阈值重算清单 -> 任务编排页同步接收回写，
 * 运行中作业保留原池，只更新下一波轮换池 -> 下一轮检测完成后 completeDetectionRound 切换。
 */
import { listRows, readValue, resetRows, saveRows, writeValue } from '@/data/local-store'
import type {
  ActionResult,
  EntryRow,
  ProxyPoolSnapshot,
  ProxyRecalcRow,
  ThresholdConfig,
  ThresholdPolicy,
} from '@/data/types'
import {
  PROXY_STATUS_AVAILABLE,
  PROXY_STATUS_UNAVAILABLE,
  RECALC_STATUS_DONE,
  RECALC_STATUS_PENDING_IMMEDIATE,
  RECALC_STATUS_PENDING_NEXT,
  buildNextRotationPool,
  businessDate,
  nextBatchNo,
  pendingRecalcStatus,
  planThresholdRecalc,
  toNumber,
  type ProxyNodeView,
  type ThresholdCrossing,
} from '@/domain/proxy-threshold'

const PROXY_KEY = 'proxy'
const RECALC_KEY = 'proxyRecalc'
const SPIDER_KEY = 'spider'
const CONFIG_STORE_KEY = 'proxy-threshold-config'
const SNAPSHOT_STORE_KEY = 'proxy-pool-snapshots'

const DEFAULT_LIMIT = 5
const IMMEDIATE_REASON = '配置生效时立即按新上限重判'
const NEXT_DETECTION_REASON = '下一轮检测完成后再按新上限切换'

function defaultConfig(): ThresholdConfig {
  return {
    currentLimit: DEFAULT_LIMIT,
    activeBatchNo: '',
    policy: 'immediate',
    history: [],
    recoveredBatchNo: '',
  }
}

export function loadThresholdConfig(): ThresholdConfig {
  return readValue<ThresholdConfig>(CONFIG_STORE_KEY, defaultConfig())
}

function saveThresholdConfig(config: ThresholdConfig): void {
  writeValue(CONFIG_STORE_KEY, config)
}

export function loadPoolSnapshots(): Record<string, ProxyPoolSnapshot> {
  return readValue<Record<string, ProxyPoolSnapshot>>(SNAPSHOT_STORE_KEY, {})
}

function savePoolSnapshots(snapshots: Record<string, ProxyPoolSnapshot>): void {
  writeValue(SNAPSHOT_STORE_KEY, snapshots)
}

/** 代理节点存储行 -> 领域引擎视图（读取当前失败计数和当前上限）。 */
function toNodeView(row: EntryRow): ProxyNodeView {
  return {
    id: Number(row.id),
    nodeNo: String(row['节点编号'] ?? ''),
    address: String(row['代理地址'] ?? ''),
    status: String(row.status),
    failureCount: toNumber(row['当前失败计数'], 0),
    failureLimit: toNumber(row['连续失败上限'], DEFAULT_LIMIT),
  }
}

export function listProxyNodes(): ProxyNodeView[] {
  return listRows(PROXY_KEY).map(toNodeView)
}

export function listRecalcRows(): ProxyRecalcRow[] {
  return listRows(RECALC_KEY) as ProxyRecalcRow[]
}

function nowText(): string {
  return new Date().toLocaleString('zh-CN', { hour12: false })
}

function directionText(crossing: ThresholdCrossing): string {
  return crossing.kind === 'disable' ? '跨阈值禁用（移出下一波轮换池）' : '跨阈值恢复（回到轮换池）'
}

function reasonOf(policy: ThresholdPolicy): string {
  return policy === 'immediate' ? IMMEDIATE_REASON : NEXT_DETECTION_REASON
}

export type ApplyLimitResult = {
  ok: boolean
  message: string
  batchNo: string
  oldLimit: number
  newLimit: number
  policy: ThresholdPolicy
  crossings: ThresholdCrossing[]
  appliedNodes: ProxyNodeView[]
}

/**
 * 配置生效：立即按新上限重判。
 *
 * - 同一阈值重复应用直接幂等返回，不再减少可用节点，也不写新的待处理记录；
 * - 只有跨过阈值的节点会改状态、进重算清单（待处理记录）；
 * - 未跨阈值节点只跟随上限，状态不动，节点池不重建；
 * - 运行中采集作业保留原池，只把跨阈值节点从下一波轮换池移除。
 */
export function applyFailureLimit(newLimitInput: number, policy: ThresholdPolicy): ApplyLimitResult {
  const newLimit = toNumber(newLimitInput, Number.NaN)
  if (!Number.isFinite(newLimit) || newLimit < 1) {
    return {
      ok: false,
      message: '连续失败上限必须是不小于 1 的整数',
      batchNo: '',
      oldLimit: 0,
      newLimit: toNumber(newLimitInput, 0),
      policy,
      crossings: [],
      appliedNodes: [],
    }
  }

  const config = loadThresholdConfig()
  const proxyRows = listRows(PROXY_KEY)
  const nodes = proxyRows.map(toNodeView)
  const oldLimit = config.history.length
    ? config.currentLimit
    : nodes.find((node) => node.failureLimit > 0)?.failureLimit ?? DEFAULT_LIMIT

  // 幂等：重复应用同一阈值时没有任何阈值差额，直接返回，不产生写入。
  if (newLimit === oldLimit && config.activeBatchNo) {
    return {
      ok: true,
      message: `失败上限仍为 ${newLimit}，与当前生效阈值一致，未重复重算，可用节点保持不变`,
      batchNo: config.activeBatchNo,
      oldLimit,
      newLimit,
      policy,
      crossings: [],
      appliedNodes: nodes,
    }
  }

  const plan = planThresholdRecalc(nodes, newLimit)
  const batchNo = nextBatchNo(config.history.length)
  const reason = reasonOf(policy)
  const today = businessDate()
  const time = nowText()
  const pendingStatus = pendingRecalcStatus(policy)

  // 1) 回写代理节点：立即重判直接落新状态；下一轮检测模式只跟随上限，状态等检测完成再切。
  const nextProxyRows = proxyRows.map((row) => {
    const view = plan.nodes.find((item) => item.id === Number(row.id))
    if (!view) {
      return row
    }
    const crossing = plan.crossings.find((item) => item.nodeId === view.id)
    const base: EntryRow = { ...row, 连续失败上限: newLimit }
    if (crossing && policy === 'immediate') {
      base.status = crossing.nextStatus
      base.abnormal = crossing.nextStatus === PROXY_STATUS_UNAVAILABLE
      base.pending = crossing.nextStatus !== '已移除'
    }
    return base
  })
  saveRows(PROXY_KEY, nextProxyRows)

  // 2) 只把跨过阈值的节点写入重算清单（待处理记录），未跨阈值节点不写。
  const existingRecalc = listRecalcRows()
  const nextId = existingRecalc.reduce((max, row) => Math.max(max, Number(row.id)), 0)
  const addedRecalc: ProxyRecalcRow[] = plan.crossings.map((crossing, index) => ({
    id: nextId + index + 1,
    status: pendingStatus,
    pending: true,
    abnormal: crossing.kind === 'disable',
    批次编号: batchNo,
    节点编号: crossing.nodeNo,
    代理地址: crossing.address,
    节点编号值: crossing.nodeId,
    当前失败计数: crossing.failureCount,
    原失败上限: crossing.oldLimit,
    新失败上限: crossing.newLimit,
    跨阈值方向: directionText(crossing),
    原节点状态: crossing.oldStatus,
    重算节点状态: policy === 'immediate'
      ? crossing.nextStatus
      : crossing.oldStatus,
    重算策略: reason,
    生效时间: time,
    切换时间: '',
    复核依据: reason,
    业务日期: today,
  }))
  saveRows(RECALC_KEY, [...existingRecalc, ...addedRecalc])

  // 3) 任务编排回写：运行中作业继续使用原池，只更新下一波轮换池。
  const spiderRows = listRows(SPIDER_KEY)
  const availableNos = nextProxyRows
    .filter((row) => String(row.status) === PROXY_STATUS_AVAILABLE)
    .map((row) => String(row['节点编号']))
  const nextPool = buildNextRotationPool(
    availableNos,
    plan.disableCrossings,
    plan.restoreCrossings,
  )
  const removedNos = plan.disableCrossings.map((item) => item.nodeNo)
  const snapshots = loadPoolSnapshots()
  const nextSpiderRows = spiderRows.map((row) => {
    if (String(row.status) === '草稿') {
      return row
    }
    const jobNo = String(row['作业编号'])
    const originalPool = String(row['当前轮换池'] ?? '')
    const originalNodes = originalPool ? originalPool.split(',').filter(Boolean) : availableNos
    if (String(row.status) === '运行中') {
      // 运行中作业：原池不动，下一波池移除跨阈值节点。
      snapshots[jobNo] = {
        作业编号: jobNo,
        作业状态: '运行中',
        生效批次: batchNo,
        原池节点编号: originalNodes,
        下一波池节点编号: nextPool,
        移除节点编号: removedNos,
        更新时间: time,
      }
      return { ...row, 下一波轮换池: nextPool.join(',') }
    }
    // 待执行等非运行作业：下一波池直接采用重算结果。
    snapshots[jobNo] = {
      作业编号: jobNo,
      作业状态: String(row.status),
      生效批次: batchNo,
      原池节点编号: originalNodes,
      下一波池节点编号: nextPool,
      移除节点编号: removedNos,
      更新时间: time,
    }
    return { ...row, 下一波轮换池: nextPool.join(',') }
  })
  saveRows(SPIDER_KEY, nextSpiderRows)
  savePoolSnapshots(snapshots)

  // 4) 阈值配置与历史：旧标准只作为历史依据保留。
  const nextConfig: ThresholdConfig = {
    ...config,
    currentLimit: newLimit,
    activeBatchNo: batchNo,
    policy,
    history: [
      ...config.history,
      {
        批次编号: batchNo,
        原失败上限: oldLimit,
        新失败上限: newLimit,
        重算策略: reason,
        生效时间: time,
        跨阈值节点数: plan.crossings.length,
        复核依据: reason,
        业务日期: today,
      },
    ],
  }
  saveThresholdConfig(nextConfig)

  const crossingText = plan.crossings.length
    ? `跨阈值节点 ${plan.crossings.length} 个（禁用 ${plan.disableCrossings.length} / 恢复 ${plan.restoreCrossings.length}），已写入重算清单`
    : '没有节点跨过阈值，未产生待处理记录'
  return {
    ok: true,
    message: `失败上限 ${oldLimit} -> ${newLimit} 已生效（${reason}）：${crossingText}；运行中作业继续使用原池`,
    batchNo,
    oldLimit,
    newLimit,
    policy,
    crossings: plan.crossings,
    appliedNodes: plan.nodes,
  }
}

/**
 * 下一轮检测完成后再按新上限切换：
 * 把「待下一轮检测」的重算记录落为节点最终状态，并把作业从原池切到下一波池。
 */
export function completeDetectionRound(batchNo?: string): ActionResult {
  const config = loadThresholdConfig()
  const targetBatch = batchNo ?? config.activeBatchNo
  if (!targetBatch) {
    return { ok: false, message: '没有待切换的阈值重算批次' }
  }
  const recalcRows = listRecalcRows()
  const pending = recalcRows.filter(
    (row) => row.批次编号 === targetBatch && row.status === RECALC_STATUS_PENDING_NEXT,
  )
  if (pending.length === 0) {
    return { ok: false, message: `批次 ${targetBatch} 没有待下一轮检测切换的记录` }
  }

  const time = nowText()
  const proxyRows = listRows(PROXY_KEY)
  const nextProxyRows = proxyRows.map((row) => {
    const crossing = pending.find((item) => item.节点编号 === String(row['节点编号']))
    if (!crossing) {
      return row
    }
    const nextStatus = crossing.跨阈值方向.startsWith('跨阈值禁用')
      ? PROXY_STATUS_UNAVAILABLE
      : PROXY_STATUS_AVAILABLE
    return {
      ...row,
      status: nextStatus,
      abnormal: nextStatus === PROXY_STATUS_UNAVAILABLE,
      pending: true,
    }
  })
  saveRows(PROXY_KEY, nextProxyRows)

  const nextRecalc = recalcRows.map((row) =>
    row.批次编号 === targetBatch && row.status === RECALC_STATUS_PENDING_NEXT
      ? { ...row, status: RECALC_STATUS_DONE, pending: false, 切换时间: time }
      : row,
  )
  saveRows(RECALC_KEY, nextRecalc)

  // 检测完成：作业当前池切换到下一波池，原池快照保留供复核。
  const spiderRows = listRows(SPIDER_KEY)
  const snapshots = loadPoolSnapshots()
  const nextSpiderRows = spiderRows.map((row) => {
    const jobNo = String(row['作业编号'] ?? '')
    const snapshot = snapshots[jobNo]
    if (!snapshot || snapshot.生效批次 !== targetBatch) {
      return row
    }
    snapshot.作业状态 = String(row.status)
    snapshot.更新时间 = time
    return { ...row, 当前轮换池: snapshot.下一波池节点编号.join(',') }
  })
  saveRows(SPIDER_KEY, nextSpiderRows)
  savePoolSnapshots(snapshots)

  return {
    ok: true,
    message: `批次 ${targetBatch} 已在新一轮检测完成后切换，${pending.length} 个节点落定，作业轮换池已切到下一波池`,
  }
}

/**
 * 代理轮换中断后立即恢复：重算清单从最后完整版本续做，当日业务记录保留。
 * 只恢复未完结的待处理记录，不重新生成差异、不重复减少可用节点。
 */
export function recoverProxyRotation(): ActionResult {
  const config = loadThresholdConfig()
  if (!config.activeBatchNo) {
    return { ok: false, message: '当前没有生效中的阈值重算批次，无需恢复' }
  }
  const recalcRows = listRecalcRows()
  const openRows = recalcRows.filter(
    (row) => row.pending &&
      (row.status === RECALC_STATUS_PENDING_IMMEDIATE || row.status === RECALC_STATUS_PENDING_NEXT),
  )
  if (openRows.length === 0) {
    return { ok: true, message: `批次 ${config.activeBatchNo} 的重算清单均已完结，无需续做` }
  }
  const today = businessDate()
  const todayOpen = openRows.filter((row) => row.业务日期 === today)
  const resumed = todayOpen.length ? todayOpen : openRows
  saveThresholdConfig({ ...config, recoveredBatchNo: config.activeBatchNo })
  return {
    ok: true,
    message: `代理轮换已恢复，批次 ${config.activeBatchNo} 从最后完整版本续做，保留待处理记录 ${resumed.length} 条，当日业务记录不重算`,
  }
}

/** 复核单条重算记录（代理轮换用户核对业务状态）。 */
export function reviewRecalcRow(id: number): ActionResult {
  const rows = listRecalcRows()
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的重算记录` }
  }
  if (rows[index].status === RECALC_STATUS_DONE) {
    return { ok: false, message: '该重算记录已经复核，不用重复操作' }
  }
  const next = [...rows]
  next[index] = { ...rows[index], status: RECALC_STATUS_DONE, pending: false, 切换时间: nowText() }
  saveRows(RECALC_KEY, next)
  return { ok: true, message: `节点 ${rows[index].节点编号} 的重算差异已复核` }
}

/**
 * 复位阈值重算相关状态（回到示例数据）：
 * 仅用于测试与页面之外的核验脚本，浏览器侧的 resetModule 仍走各模块自己的重置。
 */
export function resetThresholdState(): void {
  resetRows(PROXY_KEY)
  resetRows(RECALC_KEY)
  resetRows(SPIDER_KEY)
  saveThresholdConfig(defaultConfig())
  savePoolSnapshots({})
}
