/**
 * 代理节点失败上限重算领域引擎（纯函数，无存储、无 DOM、无路径别名依赖）。
 *
 * 验收口径：
 * 1. 读取各节点当前失败计数和新的上限，按阈值差额重算，只输出/标记跨过阈值的节点；
 * 2. 重复应用同一阈值时不能再次减少可用节点，也不能把未跨阈值的节点写入待处理记录；
 * 3. 运行中作业继续使用原池，任务编排只把跨过阈值的节点从下一波轮换池移除。
 */
import type { CrossingKind, ThresholdPolicy } from '../data/types'

export const PROXY_STATUS_DRAFT = '草稿'
export const PROXY_STATUS_AVAILABLE = '可用'
export const PROXY_STATUS_UNAVAILABLE = '不可用'
export const PROXY_STATUS_REMOVED = '已移除'

/** 参与轮换池判定的节点状态：草稿/已移除不参与阈值重算。 */
const ROTATION_STATUSES = new Set([PROXY_STATUS_AVAILABLE, PROXY_STATUS_UNAVAILABLE])

/** 重算清单状态。 */
export const RECALC_STATUS_PENDING_IMMEDIATE = '待立即重判'
export const RECALC_STATUS_PENDING_NEXT = '待下一轮检测'
export const RECALC_STATUS_DONE = '已重判复核'

export type ProxyNodeView = {
  id: number
  nodeNo: string
  address: string
  status: string
  failureCount: number
  failureLimit: number
}

export type ThresholdCrossing = {
  nodeId: number
  nodeNo: string
  address: string
  failureCount: number
  oldLimit: number
  newLimit: number
  kind: CrossingKind
  oldStatus: string
  nextStatus: string
  /** 恰好落在新旧阈值边界上的节点，供冲突复核。 */
  boundary: boolean
}

export type RecalcPlan = {
  crossings: ThresholdCrossing[]
  disableCrossings: ThresholdCrossing[]
  restoreCrossings: ThresholdCrossing[]
  boundaryCrossings: ThresholdCrossing[]
  /** 应用后的节点视图（未跨阈值节点只更新上限，状态不动）。 */
  nodes: ProxyNodeView[]
}

export function toNumber(value: unknown, fallback = 0): number {
  const num = Number(value)
  return Number.isFinite(num) ? num : fallback
}

/** 节点是否处于轮换池判定范围内。 */
export function isRotationNode(status: string): boolean {
  return ROTATION_STATUSES.has(status)
}

/**
 * 判定单个节点在「旧上限 -> 新上限」下是否跨过阈值。
 *
 * 判定规则（同一规则对新旧上限一致，新阈值保存后旧标准只作为历史依据）：
 * - 失败计数 >= 上限 即不可用，< 上限即可用；
 * - 降上限：旧规则下可用、新规则下不可用 -> 跨过阈值，移出下一波轮换池；
 * - 升上限：旧规则下不可用、新规则下可用 -> 跨过阈值，恢复轮换资格；
 * - 其余（含两规则下结论一致）一律不算跨过阈值。
 */
export function evaluateCrossing(
  node: ProxyNodeView,
  newLimit: number,
): ThresholdCrossing | null {
  if (!isRotationNode(node.status)) {
    return null
  }
  const oldUnavailable = node.failureCount >= node.failureLimit
  const newUnavailable = node.failureCount >= newLimit
  if (oldUnavailable === newUnavailable) {
    return null
  }
  const kind: CrossingKind = newUnavailable ? 'disable' : 'restore'
  return {
    nodeId: node.id,
    nodeNo: node.nodeNo,
    address: node.address,
    failureCount: node.failureCount,
    oldLimit: node.failureLimit,
    newLimit,
    kind,
    oldStatus: node.status,
    nextStatus: newUnavailable ? PROXY_STATUS_UNAVAILABLE : PROXY_STATUS_AVAILABLE,
    boundary: node.failureCount === newLimit || node.failureCount === node.failureLimit,
  }
}

/**
 * 按新上限对整池节点做阈值重算。
 *
 * 幂等：同一新上限重复应用时，节点的 failureLimit 已等于新上限，
 * oldUnavailable === newUnavailable 恒成立，不会再产生任何跨阈值差异。
 */
export function planThresholdRecalc(
  nodes: ProxyNodeView[],
  newLimit: number,
): RecalcPlan {
  const crossings: ThresholdCrossing[] = []
  const nextNodes = nodes.map((node) => {
    const crossing = evaluateCrossing(node, newLimit)
    if (crossing) {
      crossings.push(crossing)
      return { ...node, failureLimit: newLimit, status: crossing.nextStatus }
    }
    // 未跨阈值：只跟随新上限，状态保持不变，不重建节点池、不写待处理记录。
    return { ...node, failureLimit: newLimit }
  })
  return {
    crossings,
    disableCrossings: crossings.filter((item) => item.kind === 'disable'),
    restoreCrossings: crossings.filter((item) => item.kind === 'restore'),
    boundaryCrossings: crossings.filter((item) => item.boundary),
    nodes: nextNodes,
  }
}

/**
 * 计算下一波轮换池：从当前可用池里移除跨过阈值（被禁用）的节点。
 * 运行中作业不调用本函数覆盖原池，只在生成下一波池时使用。
 */
export function buildNextRotationPool(
  availableNodeNos: string[],
  disableCrossings: ThresholdCrossing[],
  restoreCrossings: ThresholdCrossing[],
): string[] {
  const removed = new Set(disableCrossings.map((item) => item.nodeNo))
  const restored = new Set(restoreCrossings.map((item) => item.nodeNo))
  const merged = new Set(availableNodeNos.filter((no) => !removed.has(no)))
  for (const item of restoreCrossings) {
    merged.add(item.nodeNo)
  }
  void restored
  return [...merged]
}

/** 重算清单在不同落库策略下的初始状态。 */
export function pendingRecalcStatus(policy: ThresholdPolicy): string {
  return policy === 'immediate'
    ? RECALC_STATUS_PENDING_IMMEDIATE
    : RECALC_STATUS_PENDING_NEXT
}

/** 业务日期（本地时区 YYYY-MM-DD），用于当日业务记录保留与续做。 */
export function businessDate(now: Date = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** 批次编号：按天顺序号，代理轮换中断恢复后从最后完整版本续做。 */
export function nextBatchNo(existingCount: number, now: Date = new Date()): string {
  const day = businessDate(now).replace(/-/g, '')
  return `RCALC-${day}-${String(existingCount + 1).padStart(3, '0')}`
}
