// 验收脚本：把 verify 下的测试用 esbuild 打包（解析 @ 路径别名），再交给 node:test 执行。
// 用法：node verify/run.mjs
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { build } from 'esbuild'

const here = path.dirname(fileURLToPath(import.meta.url))
const outdir = path.join(here, '.build')
rmSync(outdir, { recursive: true, force: true })
mkdirSync(outdir, { recursive: true })

const entries = ['proxy-threshold-engine.test.ts', 'proxy-threshold-service.test.ts'].map((name) =>
  path.join(here, name),
)

await build({
  entryPoints: entries,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outdir,
  outExtension: { '.js': '.mjs' },
  logLevel: 'info',
  alias: { '@': path.resolve(here, '..', 'src') },
})

const proc = spawnSync('node', ['--test', path.join(outdir, 'proxy-threshold-engine.test.mjs'), path.join(outdir, 'proxy-threshold-service.test.mjs')], {
  stdio: 'inherit',
})
process.exit(proc.status ?? 1)
