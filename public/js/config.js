// ===== 前端运行时配置 =====
// 后端 API 基础地址。本地开发（npm start 同源部署）留空即可；
// Zeabur 同源部署（后端同时托管前端）时保持空串即可，请求走相对路径；
// 若日后改为前后端分离部署，再把后端完整域名填到 __API_BASE__。
window.__API_BASE__ = '';
// 把以 "/" 开头的相对路径（API 路径 / 上传图片路径）拼接到后端域名；
// 非 "/" 开头（完整 URL）原样返回。
window.__apiUrl = function (p) { return p && p.charAt(0) === '/' ? (window.__API_BASE__ || '') + p : p; };
