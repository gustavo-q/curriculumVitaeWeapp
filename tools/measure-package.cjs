
const fs = require('fs'), path = require('path')
const ROOT = process.cwd()
const cfg = JSON.parse(fs.readFileSync('project.config.json', 'utf8'))
const rules = cfg.packOptions.ignore
const shouldIgnore = (rel, isDir) => rules.some((r) => {
  const v = r.value
  if (r.type === 'folder') return isDir ? rel === v || rel.startsWith(v + '/') : rel.startsWith(v + '/')
  if (r.type === 'file') return !isDir && path.basename(rel) === v
  if (r.type === 'suffix') return !isDir && rel.endsWith(v)
  return false
})
const rows = []
let total = 0
const imgRows = []
function walk (dir, rel) {
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name)
    const r = rel ? rel + '/' + name : name
    const st = fs.lstatSync(abs)
    if (shouldIgnore(r, st.isDirectory())) continue
    if (st.isDirectory()) walk(abs, r)
    else {
      total += st.size
      rows.push([st.size, r])
      if (/\.(png|jpg|jpeg|gif|webp|mp3|m4a|wav)$/i.test(name)) imgRows.push([st.size, r])
    }
  }
}
walk(ROOT, '')
rows.sort((a, b) => b[0] - a[0])
console.log('=== 进入代码包的文件（前 15 大）===')
for (const [s, r] of rows.slice(0, 15)) console.log('  ' + (s/1024).toFixed(1).padStart(8) + ' KB  ' + r)
console.log()
console.log('文件总数:', rows.length)
console.log('未压缩合计: ' + (total/1024).toFixed(1) + ' KB  (' + (total/1048576).toFixed(3) + ' MB)')
console.log('主包上限 1.5 MB → 余量 ' + ((1.5*1048576 - total)/1024).toFixed(0) + ' KB')
console.log()
const imgTotal = imgRows.reduce((a, x) => a + x[0], 0)
console.log('=== 图片资源 ===')
for (const [s, r] of imgRows) console.log('  ' + (s/1024).toFixed(1).padStart(8) + ' KB  ' + r)
console.log('图片合计: ' + (imgTotal/1024).toFixed(1) + ' KB （阈值 200 KB）→ ' + (imgTotal < 200*1024 ? '通过' : '仍未通过'))
