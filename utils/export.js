/**
 * 导出与文件工具。
 *
 * 小程序里真正可用的导出形态：
 *   · PNG 长图    —— canvas 渲染后存相册（见各页面的 onExportImage）
 *   · PDF         —— 逐页 JPEG → utils/pdf.js 纯 JS 组装 → 写用户目录 →
 *                    wx.openDocument 预览 / 转发（对应参考站的 PDF 导出）
 *   · Word(.doc)  —— utils/word.js 生成 Word HTML → 写用户目录 →
 *                    wx.openDocument 交给 Word/WPS（对应参考站的 Word 导出）
 *   · JSON 备份   —— 复制到剪贴板，跨设备迁移
 *
 * 参考站的 HTML 导出仍不提供：小程序没有可分享的 HTML 文件形态。
 */

const PDF_MIME = 'application/pdf'
const DOC_MIME = 'application/msword'

/** 文件名安全化：去掉路径分隔符与小程序不允许的字符（对应参考站 exporters.js） */
function safeName (name) {
  return String(name || '简历')
    .replace(/[\\/:*?"<>|\n\r\t]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40) || '简历'
}

/** 轻提示：统一 1.6 秒，避免各处时长不一 */
function toast (title, icon) {
  wx.showToast({ title, icon: icon || 'none', duration: 1600 })
}

/**
 * 用户主动取消（拒绝授权 / 点了取消）时抛出的错误。
 *
 * 与真实故障区分开：调用方据此提示「已取消」而不是「导出失败」——
 * 把用户自己的选择报成系统故障会让人以为功能坏了。
 */
function cancelledError (msg) {
  const e = new Error(msg || '已取消')
  e.cancelled = true
  return e
}

/** 保存图片到相册（含权限拒绝的兜底引导） */
function saveImageToAlbum (filePath) {
  return new Promise((resolve, reject) => {
    const write = () => {
      wx.saveImageToPhotosAlbum({
        filePath,
        success: () => resolve(true),
        // 用户在系统弹窗里点「不允许」也走这里，属于主动取消
        fail: (err) => reject(isUserCancel(err) ? cancelledError('已取消') : err)
      })
    }
    wx.getSetting({
      success: (res) => {
        const auth = res.authSetting['scope.writePhotosAlbum']
        if (auth === false) {
          wx.showModal({
            title: '需要相册权限',
            content: '保存图片需要「保存到相册」权限，请在设置里打开。',
            confirmText: '去设置',
            success: (m) => {
              if (m.confirm) {
                wx.openSetting({
                  success: (s) => {
                    if (s.authSetting['scope.writePhotosAlbum']) write()
                    else reject(cancelledError('未授权相册'))
                  },
                  fail: () => reject(cancelledError('未授权相册'))
                })
              } else {
                reject(cancelledError('已取消'))
              }
            }
          })
          return
        }
        write()
      },
      fail: () => write()
    })
  })
}

/** 识别「用户拒绝授权」这类失败（errMsg 形如 saveImageToPhotosAlbum:fail auth deny） */
function isUserCancel (err) {
  const msg = String((err && err.errMsg) || err || '').toLowerCase()
  return msg.indexOf('cancel') >= 0 || msg.indexOf('deny') >= 0 || msg.indexOf('auth') >= 0
}

/** 复制文本到剪贴板 */
function copyText (text, tip) {
  return new Promise((resolve) => {
    wx.setClipboardData({
      data: String(text == null ? '' : text),
      success: () => {
        if (tip) toast(tip)
        resolve(true)
      },
      fail: () => {
        toast('复制失败')
        resolve(false)
      }
    })
  })
}

const fmtTime = (ts) => {
  if (!ts) return '—'
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
}

/**
 * 在用户目录里准备 exports/ 子目录并返回目录路径。
 * 目录已存在时静默复用（mkdir recursive 语义）。
 */
function ensureExportDir () {
  const dir = wx.env.USER_DATA_PATH + '/exports'
  try {
    wx.getFileSystemManager().mkdirSync(dir, true)
  } catch (e) {
    // 已存在或创建失败：失败由后续 writeFile 再暴露
  }
  return dir
}

/** 生成安全的导出文件名（不含扩展名） */
function exportBaseName (resume) {
  return safeName((resume && (resume.resumeName || resume.baseInfo && resume.baseInfo.name)) || '简历')
}

/**
 * 把二进制 / 文本内容写入用户目录 exports/ 下。
 * @returns {Promise<string>} 写入的文件路径
 */
function writeExportFile (name, content, encoding) {
  return new Promise((resolve, reject) => {
    const dir = ensureExportDir()
    const filePath = dir + '/' + safeName(name)
    const fs = wx.getFileSystemManager()
    const done = () => resolve(filePath)
    if (typeof fs.writeFile === 'function') {
      fs.writeFile({
        filePath,
        data: content,
        encoding: encoding || 'binary',
        success: done,
        fail: (e) => reject(new Error((e && e.errMsg) || '写入文件失败'))
      })
    } else {
      reject(new Error('当前环境不支持写文件'))
    }
  })
}

/**
 * 用 wx.openDocument 打开导出的文件（PDF / Word）。
 * 用户可在预览里进一步「用其他应用打开」转发给电脑。
 */
function openExportedFile (filePath, fileType) {
  return new Promise((resolve, reject) => {
    wx.openDocument({
      filePath,
      fileType,
      showMenu: true,
      success: () => resolve(true),
      fail: (e) => reject(new Error((e && e.errMsg) || '打开文档失败'))
    })
  })
}

/**
 * 生成 PDF：把逐页 JPEG 交给 utils/pdf.js 组装并写入用户目录。
 *
 * @param {string[]} pageFiles  每页 JPEG 的临时文件路径（renderPagesToFiles 的产物）
 * @param {string}   baseName   导出文件名（不含扩展名）
 * @param {object}   [pageMeta] { width, height } 每页像素尺寸（决定清晰度）
 * @returns {Promise<{filePath:string, pages:number}>}
 */
async function buildPdf (pageFiles, baseName, pageMeta) {
  const fs = wx.getFileSystemManager()
  const metas = pageMeta || {}
  const pages = []
  for (let i = 0; i < pageFiles.length; i++) {
    const data = await new Promise((resolve, reject) => {
      fs.readFile({
        filePath: pageFiles[i],
        success: (r) => resolve(r.data),
        fail: (e) => reject(new Error('读取第 ' + (i + 1) + ' 页图像失败：' + ((e && e.errMsg) || '')))
      })
    })
    pages.push({ data, width: metas.width, height: metas.height })
  }
  const { imagesToPdf, PDF_A4_W, PDF_A4_H } = require('./pdf.js')
  const bytes = imagesToPdf(pages, { pageW: PDF_A4_W, pageH: PDF_A4_H, producer: 'resume-weapp' })
  const filePath = await writeExportFile(baseName + '.pdf', bytes.buffer, 'binary')
  return { filePath, pages: pages.length }
}

/**
 * 生成 Word(.doc)：utils/word.js 的 HTML 写盘，交给 Word / WPS 打开。
 * @returns {Promise<{filePath:string}>}
 */
async function buildWordFile (resume, baseName) {
  const { resumeToWordHtml } = require('./word.js')
  const html = resumeToWordHtml(resume)
  const filePath = await writeExportFile(baseName + '.doc', html, 'utf8')
  return { filePath }
}

/**
 * 画布 → 逐页 JPEG → PDF 的完整流程（PDF 导出的共享实现）。
 *
 * @param {function} getCanvas  () => Promise<{canvas, ctx}>，页面上的离屏画布
 * @param {object}   resume     简历数据
 * @param {string}   baseName   导出文件名（不含扩展名）
 * @returns {Promise<{filePath:string, pages:number, scale:number}>}
 */
async function exportPdfFromCanvas (getCanvas, resume, baseName) {
  const { renderPagesToFiles } = require('./render.js')
  const L = require('./layout.js')
  const { canvas, ctx } = await getCanvas()
  const rendered = await renderPagesToFiles(ctx, canvas, resume, {
    scale: 2,
    toFile: (c) => new Promise((resolve, reject) => {
      wx.canvasToTempFilePath({
        canvas: c,
        fileType: 'jpg',
        quality: 0.92,
        success: (r) => resolve(r.tempFilePath),
        fail: (e) => reject(new Error((e && e.errMsg) || '生成页面图像失败'))
      })
    })
  })
  const pdf = await buildPdf(rendered.files, baseName, {
    width: Math.round(L.A4_W * rendered.scale),
    height: Math.round(L.A4_H * rendered.scale)
  })
  return { filePath: pdf.filePath, pages: pdf.pages, scale: rendered.scale }
}

/**
 * 导出任务的统一外壳：loading 遮罩 + 统一错误提示。
 * 任务内部在进入交互步骤（存相册 / 打开文档）前自行 hideLoading。
 *
 * @param {string}   loadingTitle 遮罩文案
 * @param {function} task         async 任务体
 * @returns {Promise<boolean>} 是否成功
 */
async function runExportTask (loadingTitle, task) {
  wx.showLoading({ title: loadingTitle, mask: true })
  try {
    await task()
    return true
  } catch (err) {
    wx.hideLoading()
    if (err && err.cancelled) {
      toast('已取消')
      return false
    }
    console.error('[export] failed', err)
    toast('导出失败：' + (err && err.message ? err.message : '未知错误'))
    return false
  }
}

module.exports = {
  safeName,
  toast,
  saveImageToAlbum,
  copyText,
  fmtTime,
  cancelledError,
  isUserCancel,
  ensureExportDir,
  exportBaseName,
  writeExportFile,
  openExportedFile,
  buildPdf,
  buildWordFile,
  exportPdfFromCanvas,
  runExportTask,
  PDF_MIME,
  DOC_MIME
}
