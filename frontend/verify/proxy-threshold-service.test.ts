import { test } from 'node:test'
import assert from 'node:assert/strict'

// 内存版 localStorage 垫片：服务层只在浏览器环境持久化，测试里用 Map 代替。
const mem = new Map<string, string>()
;(globalThis as unknown as { window: unknown }).window = {
  localStorage: {
    getItem: (key: string) => (mem.has(key) ? mem.get(key)! : null),
    setItem: (key: string, value: string) => mem.set(key, String(value)),
    removeItem: (key: string) => mem.delete(key),
  },
}

const {
  applyFailureLimit,
  completeDetectionRound,
  recoverProxyRotation,
  resetThresholdState,
  reviewRecalcRow,
  listRecalcRows,
  loadPoolSnapshots,
  loadThresholdConfig,
} = await import('@/api/proxy-threshold-service')
const { listRows } = await import('@/data/local-store')
const { loadOverview } = await import('@/api/local-service')

const IMMEDIATE = 'immediate' as const
const NEXT = 'nextDetection' as const

function proxyByNo(no: string) {
  return listRows('proxy').find((row) => row['节点编号'] === no)!
}
function jobByNo(no: string) {
  return listRows('spider').find((row) => row['作业编号'] === no)!
}

test('S1 立即重判：只有跨过新阈值的节点改状态并写入待处理记录', () => {
  resetThresholdState()
  const result = applyFailureLimit(3, IMMEDIATE)
  assert.equal(result.ok, true)
  assert.equal(result.crossings.length, 2)
  assert.deepEqual(
    result.crossings.map((c) => c.nodeNo).sort(),
    ['PROX-0002', 'PROX-0003'],
  )
  assert.ok(result.crossings.find((c) => c.nodeNo === 'PROX-0002')?.boundary, '计数恰好压新阈值=边界节点')

  // 节点状态：跨阈值的禁用，其余一律不动
  assert.equal(proxyByNo('PROX-0001').status, '可用')
  assert.equal(proxyByNo('PROX-0002').status, '不可用')
  assert.equal(proxyByNo('PROX-0003').status, '不可用')
  assert.equal(proxyByNo('PROX-0004').status, '不可用')
  assert.equal(proxyByNo('PROX-0006').status, '已移除')
  assert.equal(proxyByNo('PROX-0001')['连续失败上限'], 3)

  // 重算清单只含跨阈值节点，且都是待处理记录，复核依据可回查
  const recalc = listRecalcRows()
  assert.equal(recalc.length, 2)
  assert.ok(recalc.every((row) => row.pending && row.status === '待立即重判'))
  assert.ok(recalc.every((row) => row.复核依据 === '配置生效时立即按新上限重判'))
  assert.ok(!recalc.some((row) => row.节点编号 === 'PROX-0001'), '未跨阈值节点不得写入待处理记录')

  // 运行中作业原池保持不变，只更新下一波池
  const running = jobByNo('SPID-0003')
  assert.equal(running.status, '运行中')
  assert.equal(running['当前轮换池'], 'PROX-0001,PROX-0002,PROX-0003')
  assert.equal(running['下一波轮换池'], 'PROX-0001')
  const snapshot = loadPoolSnapshots()['SPID-0003']
  assert.deepEqual(snapshot.原池节点编号, ['PROX-0001', 'PROX-0002', 'PROX-0003'])
  assert.deepEqual(snapshot.移除节点编号.sort(), ['PROX-0002', 'PROX-0003'])
})

test('S2 幂等：重复应用同一阈值不再次减少可用节点、不新增待处理记录', () => {
  const availableBefore = listRows('proxy').filter((r) => r.status === '可用').length
  const recalcBefore = listRecalcRows().length
  const result = applyFailureLimit(3, IMMEDIATE)
  assert.equal(result.ok, true)
  assert.equal(result.crossings.length, 0)
  assert.equal(listRows('proxy').filter((r) => r.status === '可用').length, availableBefore)
  assert.equal(listRecalcRows().length, recalcBefore)
  assert.equal(loadThresholdConfig().history.length, 1, '不产生新的阈值变更历史')
})

test('S3 非法上限被拒绝且无任何写入', () => {
  const recalcBefore = listRecalcRows().length
  const result = applyFailureLimit(0, IMMEDIATE)
  assert.equal(result.ok, false)
  assert.equal(listRecalcRows().length, recalcBefore)
})

test('S4 升上限：跨阈值节点恢复资格并回到下一波轮换池', () => {
  const result = applyFailureLimit(6, IMMEDIATE)
  assert.equal(result.restoreCrossings?.length ?? result.crossings.filter((c) => c.kind === 'restore').length, 2)
  assert.equal(proxyByNo('PROX-0002').status, '可用')
  assert.equal(proxyByNo('PROX-0003').status, '可用')
  assert.equal(proxyByNo('PROX-0004').status, '不可用', '计数 7 仍达到新上限 6，不恢复')
  assert.equal(listRecalcRows().length, 4, '两次生效累计 4 条跨阈值记录')
  assert.equal(jobByNo('SPID-0003')['下一波轮换池'], 'PROX-0001,PROX-0002,PROX-0003')
  // 运行中作业的原池自始至终未被刷新
  assert.equal(jobByNo('SPID-0003')['当前轮换池'], 'PROX-0001,PROX-0002,PROX-0003')
})

test('S5 复核动作幂等：同一条重算记录不能重复复核', () => {
  const target = listRecalcRows()[0]
  assert.equal(reviewRecalcRow(Number(target.id)).ok, true)
  const again = reviewRecalcRow(Number(target.id))
  assert.equal(again.ok, false)
  assert.equal(listRecalcRows().find((r) => Number(r.id) === Number(target.id))?.status, '已重判复核')
})

test('S6 下一轮检测模式：生效时不切状态，检测完成后才切换，作业池随后刷新', () => {
  resetThresholdState()
  const result = applyFailureLimit(3, NEXT)
  assert.equal(result.ok, true)
  // 立即时刻：节点状态维持原样（与立即重判形成处理边界冲突的两种落库做法）
  assert.equal(proxyByNo('PROX-0002').status, '可用')
  assert.equal(proxyByNo('PROX-0003').status, '可用')
  assert.equal(proxyByNo('PROX-0002')['连续失败上限'], 3)
  const recalc = listRecalcRows()
  assert.ok(recalc.every((row) => row.status === '待下一轮检测' && row.pending))
  // 下一波池已按重算结果预留，运行中作业原池仍锁定
  assert.equal(jobByNo('SPID-0003')['当前轮换池'], 'PROX-0001,PROX-0002,PROX-0003')
  assert.equal(jobByNo('SPID-0003')['下一波轮换池'], 'PROX-0001')

  const done = completeDetectionRound()
  assert.equal(done.ok, true)
  assert.equal(proxyByNo('PROX-0002').status, '不可用')
  assert.equal(proxyByNo('PROX-0003').status, '不可用')
  assert.ok(listRecalcRows().every((row) => row.status === '已重判复核' && !row.pending))
  assert.equal(jobByNo('SPID-0003')['当前轮换池'], 'PROX-0001', '检测完成后任务编排当前记录才刷新')

  const again = completeDetectionRound()
  assert.equal(again.ok, false, '没有待切换记录时重复切换被拒绝')
})

test('S7 中断恢复：从最后完整版本续做，当日业务记录保留不重算', () => {
  resetThresholdState()
  applyFailureLimit(3, IMMEDIATE)
  const batchNo = loadThresholdConfig().activeBatchNo
  const before = listRecalcRows().length
  const recovered = recoverProxyRotation()
  assert.equal(recovered.ok, true)
  assert.equal(loadThresholdConfig().recoveredBatchNo, batchNo)
  assert.equal(listRecalcRows().length, before, '恢复不重新生成差异')
  // 全部完结后再恢复：不报错、不新增
  for (const row of listRecalcRows()) {
    reviewRecalcRow(Number(row.id))
  }
  const second = recoverProxyRotation()
  assert.equal(second.ok, true)
})

test('S8 重算清单接入概览待处理统计', () => {
  resetThresholdState()
  applyFailureLimit(3, IMMEDIATE)
  const overview = loadOverview()
  const mod = overview.modules.find((item) => item.name === '代理节点阈值重算清单')
  assert.ok(mod)
  assert.equal(mod!.pending, 2)
  assert.equal(mod!.created, 2)
})

test('S9 两种落库做法对同一边界节点的处理时机不同但最终口径一致', () => {
  // 立即重判路径
  resetThresholdState()
  applyFailureLimit(3, IMMEDIATE)
  const immediateStatus = proxyByNo('PROX-0002').status
  // 下一轮检测路径
  resetThresholdState()
  applyFailureLimit(3, NEXT)
  const deferredStatusBefore = proxyByNo('PROX-0002').status
  completeDetectionRound()
  const deferredStatusAfter = proxyByNo('PROX-0002').status

  assert.equal(immediateStatus, '不可用', '立即重判：生效即移出轮换池')
  assert.equal(deferredStatusBefore, '可用', '延迟切换：检测完成前留在原池')
  assert.equal(deferredStatusAfter, '不可用', '检测完成后与立即重判口径一致')
})
