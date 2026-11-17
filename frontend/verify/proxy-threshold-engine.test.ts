import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  PROXY_STATUS_AVAILABLE,
  PROXY_STATUS_UNAVAILABLE,
  buildNextRotationPool,
  evaluateCrossing,
  planThresholdRecalc,
  type ProxyNodeView,
} from '../src/domain/proxy-threshold'

function node(id: number, count: number, limit = 5, status = PROXY_STATUS_AVAILABLE): ProxyNodeView {
  return {
    id,
    nodeNo: `PROX-000${id}`,
    address: `10.0.0.${id}`,
    status,
    failureCount: count,
    failureLimit: limit,
  }
}

test('降上限：只有失败计数跨过新阈值的节点被标记禁用', () => {
  const nodes = [node(1, 1), node(2, 3), node(3, 4), node(4, 7, 5, PROXY_STATUS_UNAVAILABLE)]
  const plan = planThresholdRecalc(nodes, 3)

  assert.equal(plan.crossings.length, 2, '只有 PROX-0002/PROX-0003 跨过阈值')
  assert.deepEqual(
    plan.disableCrossings.map((item) => item.nodeNo).sort(),
    ['PROX-0002', 'PROX-0003'],
  )
  assert.equal(plan.crossings[0].boundary, true, '计数恰好等于新阈值属于边界节点')
  // 未跨阈值节点状态不动，只跟随上限
  const n1 = plan.nodes.find((item) => item.id === 1)!
  assert.equal(n1.status, PROXY_STATUS_AVAILABLE)
  assert.equal(n1.failureLimit, 3)
  // 已不可用节点不会重复进差异
  assert.ok(!plan.crossings.some((item) => item.nodeNo === 'PROX-0004'))
})

test('幂等：同一上限重算不产生任何差异，不再次减少可用节点', () => {
  const nodes = [node(1, 1), node(2, 3), node(3, 4)]
  const first = planThresholdRecalc(nodes, 3)
  assert.equal(first.crossings.length, 2)
  // 用重算后的节点（上限已是 3）再按 3 重算
  const second = planThresholdRecalc(first.nodes, 3)
  assert.equal(second.crossings.length, 0)
  assert.equal(second.nodes.filter((n) => n.status === PROXY_STATUS_AVAILABLE).length, 1)
})

test('升上限：跨过阈值恢复资格的节点标记 restore', () => {
  const nodes = [node(1, 3, 3, PROXY_STATUS_UNAVAILABLE), node(2, 5, 3, PROXY_STATUS_UNAVAILABLE)]
  const plan = planThresholdRecalc(nodes, 6)
  assert.equal(plan.restoreCrossings.length, 2)
  assert.equal(plan.nodes[0].status, PROXY_STATUS_AVAILABLE)
  assert.equal(plan.crossings[0].boundary, true)
})

test('边界判定规则一致：计数恰好等于上限即不可用', () => {
  assert.equal(evaluateCrossing(node(1, 3, 5), 3)?.kind, 'disable')
  assert.equal(evaluateCrossing(node(1, 2, 5), 3), null)
  // 计数恰好等于旧上限：旧规则不可用、新规则可用 -> 恢复，且属于边界节点
  const restore = evaluateCrossing(node(1, 3, 3, PROXY_STATUS_UNAVAILABLE), 6)
  assert.equal(restore?.kind, 'restore')
  assert.equal(restore?.boundary, true)
})

test('草稿与已移除节点不参与阈值重算', () => {
  const nodes = [node(1, 9, 5, '草稿'), node(2, 9, 5, '已移除')]
  const plan = planThresholdRecalc(nodes, 3)
  assert.equal(plan.crossings.length, 0)
  assert.equal(plan.nodes[0].failureLimit, 3)
})

test('下一波轮换池只移除跨阈值禁用节点，并加回恢复节点', () => {
  const nodes = [node(1, 1), node(2, 3), node(3, 4), node(4, 7, 5, PROXY_STATUS_UNAVAILABLE)]
  const plan = planThresholdRecalc(nodes, 3)
  const available = plan.nodes.filter((n) => n.status === PROXY_STATUS_AVAILABLE).map((n) => n.nodeNo)
  const pool = buildNextRotationPool(available, plan.disableCrossings, plan.restoreCrossings)
  assert.deepEqual(pool, ['PROX-0001'])

  const raise = planThresholdRecalc(plan.nodes, 6)
  const available2 = nodes.map((n) => n.nodeNo)
  const pool2 = buildNextRotationPool(available2, raise.disableCrossings, raise.restoreCrossings)
  assert.deepEqual(pool2.sort(), ['PROX-0001', 'PROX-0002', 'PROX-0003', 'PROX-0004'])
})
