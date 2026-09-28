<#
  Extract WeChat Official Account article URLs from the WeChat PC client's memory (read-only).

  Why this exists:
    WeChat shut down the "cross-account article list" API on mp.weixin.qq.com around 2026-07-30
    (returns ret=200013 on the very first page), so enumerating articles through the
    Official Account platform backend is no longer possible. However, when the WeChat
    desktop client renders an article list, the article URLs sit in Weixin.exe memory as
    plain text. This script reads only those plaintext URLs.

  Before running:
    Open WeChat, go to the target Official Account, open its article list / history, and
    scroll down so the client loads more articles.

  Output:
    work\urls.txt    one line per article:  <__biz> TAB <normalized url>
    work\urls.json   structured result for the downloader
#>
param(
  [int]$MaxUrls = 3000,
  [string]$OutDir = ""
)

$ErrorActionPreference = "Stop"
if (-not $OutDir) { $OutDir = Join-Path (Split-Path $PSScriptRoot -Parent) "work" }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$csPath = Join-Path $PSScriptRoot "WxArticleScan.cs"
$src = [System.IO.File]::ReadAllText($csPath, [System.Text.Encoding]::UTF8)
Add-Type -TypeDefinition $src -ErrorAction Stop

$procs = Get-Process -Name Weixin -ErrorAction SilentlyContinue | Sort-Object WorkingSet64 -Descending
if (-not $procs) { throw "WeChat is not running. Start and log in to WeChat, open the target account's article list, then retry." }

$all = New-Object System.Collections.Generic.List[string]
foreach ($p in $procs) {
  Write-Host ("Scanning PID {0} ({1} MB) ..." -f $p.Id, [math]::Round($p.WorkingSet64 / 1MB))
  try {
    $lines = [WxArticleScan]::Scan($p.Id, $MaxUrls)
    foreach ($l in $lines) { $all.Add($l) }
  } catch {
    Write-Host ("  PID {0} scan failed: {1}" -f $p.Id, $_.Exception.Message)
  }
}

$scanned = $all | Where-Object { $_ -like "SCANNED_MB=*" }
$rows = $all | Where-Object { $_ -match "`t" } | Sort-Object -Unique

$urlsPath = Join-Path $OutDir "urls.txt"
$rows | Set-Content -Path $urlsPath -Encoding UTF8

$byBiz = @{}
foreach ($r in $rows) {
  $biz = ($r -split "`t")[0]
  if (-not $byBiz.ContainsKey($biz)) { $byBiz[$biz] = 0 }
  $byBiz[$biz] = $byBiz[$biz] + 1
}

$articles = @()
foreach ($r in $rows) {
  $parts = $r -split "`t"
  $articles += @{ biz = $parts[0]; url = $parts[1] }
}

$json = @{
  scannedAt = (Get-Date).ToString("o")
  scannedMb = ($scanned -join "; ")
  totalUrls = $rows.Count
  byBiz     = $byBiz
  articles  = $articles
}
$jsonPath = Join-Path $OutDir "urls.json"
$json | ConvertTo-Json -Depth 5 | Set-Content -Path $jsonPath -Encoding UTF8

Write-Host ""
Write-Host ("Extracted {0} unique article URLs" -f $rows.Count)
Write-Host "Top __biz by count:"
$byBiz.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 10 | ForEach-Object {
  Write-Host ("  {0} -> {1} articles" -f $_.Key, $_.Value)
}
Write-Host ""
Write-Host "Written:"
Write-Host "  $urlsPath"
Write-Host "  $jsonPath"
