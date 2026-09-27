# 本机运行应用并开放公网访问（Cloudflare 快速隧道，免费）
# 用法：双击 deploy\windows\start-public.cmd，或执行：
#   powershell -NoProfile -ExecutionPolicy Bypass -File deploy\windows\start-public.ps1
# 说明：链接仅在“本机开机且本窗口未关闭”时有效；快速隧道每次启动的公网网址会变化。
[CmdletBinding()]
param(
  [int]$Port = 0,
  [switch]$NoServer
)
$ErrorActionPreference = 'Stop'

# 仓库根目录（本脚本位于 <root>\deploy\windows）
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Runtime = Join-Path $Root '.runtime'
New-Item -ItemType Directory -Force -Path $Runtime | Out-Null

# 端口：优先命令行参数，其次 .env 的 PORT，最后 3000
if ($Port -le 0) {
  $Port = 3000
  $envFile = Join-Path $Root '.env'
  if (Test-Path $envFile) {
    $m = Select-String -Path $envFile -Pattern '^\s*PORT\s*=\s*(\d+)' | Select-Object -First 1
    if ($m) { $Port = [int]$m.Matches[0].Groups[1].Value }
  }
}

# 确保 cloudflared 可用（缺失则自动下载到 %LOCALAPPDATA%\cloudflared）
$cfExe = Join-Path $env:LOCALAPPDATA 'cloudflared\cloudflared.exe'
if (-not (Test-Path $cfExe)) {
  Write-Host '首次运行：正在下载 cloudflared ...' -ForegroundColor Yellow
  New-Item -ItemType Directory -Force -Path (Split-Path $cfExe) | Out-Null
  $ProgressPreference = 'SilentlyContinue'
  Invoke-WebRequest -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile $cfExe -TimeoutSec 180
}

$procs = @()
try {
  if (-not $NoServer) {
    if (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) {
      Write-Host "端口 $Port 已有服务在监听，跳过启动应用。" -ForegroundColor DarkGray
    } else {
      Write-Host "启动应用（node server/index.js，端口 $Port）..." -ForegroundColor Cyan
      $srv = Start-Process node -ArgumentList 'server/index.js' -WorkingDirectory $Root -PassThru `
        -RedirectStandardOutput (Join-Path $Runtime 'server.out.log') `
        -RedirectStandardError  (Join-Path $Runtime 'server.err.log')
      $procs += $srv
      for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Seconds 1
        if (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) { break }
      }
    }
  }

  Write-Host '启动 Cloudflare 隧道 ...' -ForegroundColor Cyan
  $cfLog = Join-Path $Runtime 'cloudflared.err.log'
  Remove-Item $cfLog -ErrorAction SilentlyContinue
  $cf = Start-Process $cfExe -ArgumentList 'tunnel', '--url', "http://localhost:$Port", '--no-autoupdate' -PassThru `
    -RedirectStandardOutput (Join-Path $Runtime 'cloudflared.out.log') `
    -RedirectStandardError  $cfLog
  $procs += $cf

  $url = $null
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 1
    if (Test-Path $cfLog) {
      $m = Select-String -Path $cfLog -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($m) { $url = [regex]::Match($m.Line, 'https://[a-z0-9-]+\.trycloudflare\.com').Value; break }
    }
  }
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 1
    if (Select-String -Path $cfLog -Pattern 'Registered tunnel connection' -Quiet -ErrorAction SilentlyContinue) { break }
  }

  if ($url) {
    $url | Out-File (Join-Path $Runtime 'public-url.txt') -Encoding ascii
    Write-Host ''
    Write-Host '==================================================' -ForegroundColor Green
    Write-Host ' 公网访问地址（本机开机且本窗口不关时有效）：' -ForegroundColor Green
    Write-Host "   $url" -ForegroundColor Green
    Write-Host '==================================================' -ForegroundColor Green
    Write-Host ' 按 Ctrl+C 停止；日志见 .runtime\ 目录。' -ForegroundColor DarkGray
  } else {
    Write-Host "未能获取公网地址，请查看 $cfLog" -ForegroundColor Red
  }

  Wait-Process -Id $cf.Id
}
finally {
  foreach ($p in $procs) {
    if ($p -and -not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
  }
}
