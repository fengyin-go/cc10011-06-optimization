# 采集调度策略管理工具

离线版采集调度策略配置工具，涵盖站点登记、模板编排、代理轮换、限速调节、反爬策略、增量水位与结果校验规则，所有配置持久化到浏览器本地存储。

这是一个**纯前端**管理平台：React + Vite + TypeScript，仓库里没有后端服务。业务数据由
`frontend/src/data/` 下的本地数据层提供：首次打开用示例数据播种，之后的登记、筛选与状态流转
结果都持久化在浏览器 `localStorage` 里，刷新或重开浏览器都还在。dev server 已关掉自动打开页面，
启动后按终端打印的地址手工打开。

## 目录结构

```text
.
├── frontend/                 React + Vite + TypeScript 前端（唯一运行单元）
│   ├── src/views/            每个业务模块一个页面
│   ├── src/api/local-service.ts   本地数据服务：列表、筛选、动作流转、导出
│   ├── src/data/             模块元数据 / 示例数据 / localStorage 持久化
│   ├── src/stores/           会话与筛选状态
│   └── vite.config.ts        dev server 配置（open: false，无 /api 代理）
├── .gitignore
└── docker-compose.yml
```

## 启动

```bash
cd frontend
npm install
npm run dev
```

前端默认监听 `http://127.0.0.1:5173/`，dev server 不会自动打开浏览器，需要自己访问。

生产构建：

```bash
cd frontend
npm run build
```

## 业务模块

| 模块 | 目录 | 业务对象 | 主要字段 |
| --- | --- | --- | --- |
| 站点登记 | `site` | 采集站点 | 站点编号、域名地址、站点类型 |
| 模板编排 | `template` | 抽取模板 | 模板编号、入口地址、列表选择器 |
| 代理轮换 | `proxy` | 代理节点 | 节点编号、代理地址、代理协议、当前失败计数、连续失败上限 |
| 代理节点阈值重算清单 | `proxyRecalc` | 代理节点阈值重算记录 | 批次编号、节点编号、跨阈值方向、原/新失败上限、复核依据 |
| 任务编排 | `spider` | 采集作业 | 作业编号、目标站点、抽取模板、当前轮换池、下一波轮换池 |
| 调度编排 | `schedule` | 调度规则 | 规则编号、关联站点、调度表达式 |
| 反爬策略 | `antibot` | 对抗策略 | 策略编号、验证码类型、识别服务 |
| 限速调节 | `ratelimit` | 限速配置 | 配置编号、目标站点、每秒请求上限 |
| 重试机制 | `retry` | 重试策略 | 策略编号、关联任务、最大重试次数 |
| 字段映射 | `extractor` | 映射规则 | 规则编号、源字段名称、目标字段名称 |
| 采集流水线 | `pipeline` | 流水线步骤 | 步骤编号、步骤名称、输入数据源 |
| 结果校验 | `validator` | 校验规则 | 规则编号、校验对象、校验类型 |
| 数据落盘 | `storage` | 存储配置 | 配置编号、存储类型、输出路径 |
| 采集监控 | `monitor` | 监控指标 | 指标编号、关联任务、指标名称 |
| 数据清洗 | `cleanse` | 清洗规则 | 规则编号、目标字段、空值替换 |
| 增量水位 | `delta` | 增量游标 | 游标编号、目标站点、增量字段 |
| 数据分发 | `export` | 分发通道 | 通道编号、输出数据集、目标系统 |
| RPA流程 | `rpaflow` | 自动化流程 | 流程编号、目标页面、操作序列 |
| 登录凭证 | `auth` | 凭证配置 | 凭证编号、目标站点、认证方式 |

## 约定

- 每个模块的页面在 `frontend/src/views/<模块>/index.vue`，页面只负责渲染，读写统一走
  `frontend/src/api/local-service.ts`。
- 字段、状态、动作与流转目标集中在 `frontend/src/data/modules.ts`；示例数据在
  `frontend/src/data/seed.ts`。
- 状态流转只允许在 `local-service.ts` 里改，页面组件不做业务判断。
- 想回到初始数据：清掉浏览器里 `scraper-strategy-studio:entries` 这一项，或调用 `resetModule(模块)`。

## 代理失败上限阈值重算

调整代理节点「连续失败上限」时不再重建整个节点池，重算逻辑分两层：

- 领域引擎 `frontend/src/domain/proxy-threshold.ts`（纯函数）：读取各节点当前失败计数和新上限，
  按阈值差额判定，只有结论发生变化（可用→不可用 / 不可用→可用）的节点才算**跨过阈值**；
  同一上限重复应用天然幂等，不会再次减少可用节点。
- 写库服务 `frontend/src/api/proxy-threshold-service.ts`：
  - `applyFailureLimit`：配置生效时立即按新上限重判，只改跨阈值节点并生成
    「代理节点阈值重算清单」（未跨阈值节点不进待处理记录），同时把跨阈值节点从任务编排的
    **下一波轮换池**移除；运行中作业的当前池保持不变。
  - `completeDetectionRound`：选择「下一轮检测完成后再按新上限切换」时，生效只预留差异，
    检测完成后才落节点状态并刷新作业当前池。两种落库做法都在清单的「复核依据」里留痕。
  - `recoverProxyRotation`：代理轮换中断后从最后完整批次续做，当日业务记录保留、不重新生成差异。
- 阈值配置、生效历史与作业轮换池快照存在 `localStorage` 的独立键
  （`scraper-strategy-studio:value:*`），与条目清单互不覆盖；旧上限只保留在历史里作为依据。

验收脚本（不依赖浏览器，node 内置 test runner）：

```bash
cd frontend
node verify/run.mjs
```

领域：数据工程
子方向：数据采集、爬虫与RPA
