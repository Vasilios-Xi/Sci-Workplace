[CmdletBinding(SupportsShouldProcess)]
param(
  [ValidateSet('SciWorkplace', 'OpenLab')]
  [string]$StateName = 'SciWorkplace'
)

$ErrorActionPreference = 'Stop'
$roamingRoot = [IO.Path]::GetFullPath([Environment]::GetFolderPath('ApplicationData')).TrimEnd('\')
$stateRoot = [IO.Path]::GetFullPath((Join-Path $roamingRoot $StateName)).TrimEnd('\')
$expectedParent = [IO.Path]::GetDirectoryName($stateRoot).TrimEnd('\')
if ($expectedParent -ne $roamingRoot -or [IO.Path]::GetFileName($stateRoot) -ne $StateName) {
  throw "Refusing to reset an unexpected path: $stateRoot"
}
if (-not (Test-Path -LiteralPath $stateRoot -PathType Container)) {
  Write-Output "No managed state exists at $stateRoot"
  exit 0
}

$running = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -in @('Sci Workplace', 'OpenLab') }
if ($running) {
  throw 'Close Sci Workplace before resetting its managed state.'
}

$backupBase = [IO.Path]::GetFullPath((Join-Path $roamingRoot "$StateName-backups")).TrimEnd('\')
if ([IO.Path]::GetDirectoryName($backupBase).TrimEnd('\') -ne $roamingRoot) {
  throw "Refusing to use an unexpected backup path: $backupBase"
}
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupRoot = Join-Path $backupBase $timestamp
if (Test-Path -LiteralPath $backupRoot) { throw "Backup already exists: $backupRoot" }

function Get-StateInventory([string]$Root) {
  $prefixLength = $Root.TrimEnd('\').Length + 1
  return @(Get-ChildItem -LiteralPath $Root -File -Recurse -Force | Sort-Object FullName | ForEach-Object {
    [pscustomobject]@{
      path = $_.FullName.Substring($prefixLength).Replace('\', '/')
      bytes = $_.Length
      sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
    }
  })
}

if ($PSCmdlet.ShouldProcess($stateRoot, "Move managed app state to $backupRoot and create a clean state root")) {
  $before = Get-StateInventory $stateRoot
  New-Item -ItemType Directory -Path $backupBase -Force | Out-Null
  Move-Item -LiteralPath $stateRoot -Destination $backupRoot
  $after = Get-StateInventory $backupRoot
  if (($before | ConvertTo-Json -Compress -Depth 4) -ne ($after | ConvertTo-Json -Compress -Depth 4)) {
    throw "Backup verification failed; original bytes remain at $backupRoot and were not deleted."
  }
  $manifest = [pscustomobject]@{
    schemaVersion = 1
    stateName = $StateName
    source = $stateRoot
    backup = $backupRoot
    createdAt = (Get-Date).ToUniversalTime().ToString('o')
    fileCount = $before.Count
    totalBytes = ($before | Measure-Object -Property bytes -Sum).Sum
    files = $before
    note = 'Credentials remain encrypted exactly as stored. External project directories are never traversed by this script.'
  }
  $manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $backupRoot 'backup-manifest.json') -Encoding utf8NoBOM
  New-Item -ItemType Directory -Path $stateRoot | Out-Null
  Write-Output "Managed state reset completed. Verified backup: $backupRoot"
}
