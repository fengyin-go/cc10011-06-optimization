/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

/** 阈值重算的两种落库做法。 */
export type ThresholdPolicy = 'immediate' | 'nextDetection'

/** 跨阈值方向：降上限被禁用 / 升上限恢复资格。 */
export type CrossingKind = 'disable' | 'restore'

/**
 * 代理节点阈值重算清单（一条记录对应一次阈值生效中跨过阈值的一个节点）。
 * 主业务为代理轮换：代理轮换、代理节点、节点编号共同构成主记录，代理地址可回查。
 */
export type ProxyRecalcRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  批次编号: string
  节点编号: string
  代理地址: string
  节点编号值: number
  当前失败计数: number
  原失败上限: number
  新失败上限: number
  跨阈值方向: string
  原节点状态: string
  重算节点状态: string
  重算策略: string
  生效时间: string
  切换时间: string
  复核依据: string
  业务日期: string
}

/** 运行中采集作业持有的轮换池快照：配置生效不打断运行中作业。 */
export type ProxyPoolSnapshot = {
  作业编号: string
  作业状态: string
  生效批次: string
  原池节点编号: string[]
  下一波池节点编号: string[]
  移除节点编号: string[]
  更新时间: string
}

/** 失败上限配置与生效历史。 */
export type ThresholdConfig = {
  currentLimit: number
  activeBatchNo: string
  policy: ThresholdPolicy
  history: {
    批次编号: string
    原失败上限: number
    新失败上限: number
    重算策略: string
    生效时间: string
    跨阈值节点数: number
    复核依据: string
    业务日期: string
  }[]
  recoveredBatchNo: string
}
