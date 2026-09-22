/**
 * 代码包体积检查。
 *
 * 为什么需要它：微信开发者工具的「代码质量」会把项目目录下**所有**未被
 * packOptions.ignore 排除的文件算进代码包。开发期的产物（无头 Chrome 的
 * profile、仿真 HTML、npm 缓存、node_modules）动辄几百 MB，一旦漏配，
 * 主包会瞬间超限——而报错只会出现在上传/预览时才发现的扫描结果里。
 *
 * 主包上限 1.5 MB，图片与音频资源另有 200 KB 的限制。
 * 本脚本按 project.config.json 的 packOptions 规则模拟打包，提前发现。
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const ASSETS_LIMIT = 200 * 1024
const MAIN_LIMIT = 1.5 * 1024 * 1024

const cfgPath = path.join(ROOT, 'project.config.json')
if (!fs.existsSync(cfgPath)) {
  console.error('✗ 找不到 project.config.json')
  process.exit(1)
}
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
const rules = (cfg.packOptions && cfg.packOptions.ignore) || []

if (!rules.length) {
  console.error('✗ packOptions.ignore 是空的：开发期产物会全部进入代码包')
  process.exit(1)
}

function shouldIgnore (rel, isDir) {
  return rules.some((r) => {
    const v = r.value
    if (r.type === 'folder') return isDir ? rel === v || rel.startsWith(v + '/') : rel.startsWith(v + '/')
    if (r.type === 'file') return !isDir && path.basename(rel) === v
    if (r.type === 'suffix') return !isDir && rel.endsWith(v)
    return false
  })
}

const files = []
const assets = []
let total = 0
function walk (dir, rel) {
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name)
    const r = rel ? rel + '/' + name : name
    const st = fs.lstatSync(abs)
    if (shouldIgnore(r, st.isDirectory())) continue
    if (st.isDirectory()) { walk(abs, r); continue }
    total += st.size
    files.push({ size: st.size, rel: r })
    if (/\.(png|jpe?g|gif|webp|svg|mp3|m4a|wav|aac)$/i.test(name)) assets.push({ size: st.size, rel: r })
  }
}
walk(ROOT, '')

let fail = 0
const check = (name, ok, detail) => {
  if (ok) console.log('  ✓ ' + name + (detail ? ' —— ' + detail : ''))
  else { fail++; console.log('  ✗ ' + name + (detail ? ' —— ' + detail : '')) }
}

console.log('\n[代码包体积]')
check('主包体积小于 1.5 MB', total < MAIN_LIMIT,
  (total / 1024).toFixed(1) + ' KB / 1536 KB，余量 ' + ((MAIN_LIMIT - total) / 1024).toFixed(0) + ' KB')

const assetTotal = assets.reduce((a, x) => a + x.size, 0)
check('图片与音频资源不超过 200 KB', assetTotal < ASSETS_LIMIT,
  (assetTotal / 1024).toFixed(1) + ' KB，共 ' + assets.length + ' 个文件')

// 开发期产物绝不能进入代码包
const leaked = files.filter((f) =>
  /^(\.work|\.port|node_modules|\.npm-cache|\.npm-logs|tools|\.git)\//.test(f.rel) ||
  /\.DS_Store$/.test(f.rel) ||
  /\.(cjs|mjs|log)$/.test(f.rel) ||
  /^README\.md$/.test(f.rel)
)
check('开发期产物未混入代码包', leaked.length === 0,
  leaked.length ? leaked.slice(0, 5).map((f) => f.rel).join(', ') + (leaked.length > 5 ? ' 等 ' + leaked.length + ' 个' : '') : '')

// 每个页面/组件的四件套是否齐全（少一个都会导致打包后运行时报错）
const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'))
const missing = []
for (const p of appJson.pages) {
  for (const ext of ['.js', '.wxml', '.json']) {
    if (!files.some((f) => f.rel === p + ext)) missing.push(p + ext)
  }
}
check('app.json 登记的页面都在代码包内', missing.length === 0, missing.join(', '))

console.log('\n代码包内 ' + files.length + ' 个文件，合计 ' + (total / 1024).toFixed(1) + ' KB')
const top = files.slice().sort((a, b) => b.size - a.size).slice(0, 5)
console.log('最大的 5 个：')
for (const f of top) console.log('  ' + (f.size / 1024).toFixed(1).padStart(7) + ' KB  ' + f.rel)

console.log('\n' + (fail ? '✗ 有 ' + fail + ' 项未通过' : '✓ 全部通过'))
process.exit(fail ? 1 : 0)
