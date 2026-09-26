// ===== 前端运行时配置 =====
// 后端 API 基础地址。本地开发（npm start 同源部署）留空即可；
// GitHub Pages 部署时，由 .github/workflows/deploy.yml 读取仓库 Secret BACKEND_API_URL 生成覆盖本文件。
window.__API_BASE__ = '';
// 把以 "/" 开头的相对路径（API 路径 / 上传图片路径）拼接到后端域名；
// 非 "/" 开头（完整 URL）原样返回。
window.__apiUrl = function (p) { return p && p.charAt(0) === '/' ? (window.__API_BASE__ || '') + p : p; };
