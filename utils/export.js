/**
 * 导出与文件工具。
 *
 * 参考站的导出有 PDF / PNG / Word / JSON / HTML 五种：
 *   · PDF  —— 依赖浏览器打印窗口，小程序里没有等价能力（无法调起系统打印）
 *   · Word —— 依赖 HTML 转 .doc，小程序无法生成并打开
 *   · HTML —— 小程序没有可分享的 HTML 文件形态
 * 因此这里保留小程序里真正可用的两种，并把 JSON 备份做成「复制到剪贴板」，
 * 这样它仍然能跨设备迁移（贴到新设备的导入框里即可），不丢功能。
 */

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

module.exports = { safeName, toast, saveImageToAlbum, copyText, fmtTime, cancelledError, isUserCancel }
