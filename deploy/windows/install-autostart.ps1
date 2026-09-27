# 配置“登录后自动启动公网访问”（写入当前用户启动文件夹的快捷方式，无需管理员）
# 安装：powershell -NoProfile -ExecutionPolicy Bypass -File deploy\windows\install-autostart.ps1
# 卸载：powershell -NoProfile -ExecutionPolicy Bypass -File deploy\windows\install-autostart.ps1 -Uninstall
[CmdletBinding()]
param([switch]$Uninstall)

$Root  = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Startup = [Environment]::GetFolderPath('Startup')
$LnkPath  = Join-Path $Startup 'EcomAI-Public.lnk'

if ($Uninstall) {
  Remove-Item $LnkPath -Force -ErrorAction SilentlyContinue
  Write-Host "已移除开机自启：$LnkPath"
  return
}

$ps1 = Join-Path $PSScriptRoot 'start-public.ps1'
$ws  = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut($LnkPath)
$lnk.TargetPath       = 'powershell.exe'
$lnk.Arguments        = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$ps1`""
$lnk.WorkingDirectory = $Root
$lnk.Description      = '登录后自动启动电商AI平台并开启 Cloudflare 公网隧道'
$lnk.Save()

Write-Host "已配置登录自启：$LnkPath"
Write-Host "公网地址启动后写入：$(Join-Path $Root '.runtime\public-url.txt')"
Write-Host "提示：快速隧道每次启动网址会变化；如需固定网址，见 README 的 Cloudflare Tunnel 说明。"
