[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$InputPath,

  [Parameter(Mandatory = $true)]
  [string]$OutputPath,

  [Parameter(Mandatory = $true)]
  [string]$ReceiptPath,

  [string]$ExpectedBibliographyText = ''
)

$ErrorActionPreference = 'Stop'

function Resolve-OutputPath([string]$Path) {
  if ([IO.Path]::IsPathRooted($Path)) {
    return [IO.Path]::GetFullPath($Path)
  }
  return [IO.Path]::GetFullPath((Join-Path (Get-Location) $Path))
}

$inputFull = (Resolve-Path -LiteralPath $InputPath).Path
$outputFull = Resolve-OutputPath $OutputPath
$receiptFull = Resolve-OutputPath $ReceiptPath
if ($inputFull.Equals($outputFull, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Word/Zotero smoke test must write to a copy, not the input DOCX.'
}

New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($outputFull)) -Force | Out-Null
New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($receiptFull)) -Force | Out-Null

$sourceHashBefore = (Get-FileHash -Algorithm SHA256 -LiteralPath $inputFull).Hash
Copy-Item -LiteralPath $inputFull -Destination $outputFull -Force
$outputHashBefore = (Get-FileHash -Algorithm SHA256 -LiteralPath $outputFull).Hash

$word = $null
$document = $null
$macro = 'ZoteroRefresh'
$wordVersion = ''
$fieldsBefore = 0
$fieldsAfter = 0
$templateLoaded = $false
$bibliographyPresent = $false
try {
  $word = New-Object -ComObject Word.Application
  $word.Visible = $false
  $word.DisplayAlerts = 0
  $wordVersion = [string]$word.Version
  $document = $word.Documents.Open($outputFull, $false, $false)
  $fieldsBefore = [int]$document.Fields.Count
  $templateLoaded = @($word.Templates | ForEach-Object { $_.Name }) -contains 'Zotero.dotm'
  if (-not $templateLoaded) {
    throw 'Zotero.dotm is not loaded in Microsoft Word.'
  }
  try {
    $word.Run($macro)
  }
  catch {
    $macro = 'Zotero.dotm!ZoteroRefresh'
    $word.Run($macro)
  }
  $document.Save()
  $fieldsAfter = [int]$document.Fields.Count
  $bibliographyPresent = if ($ExpectedBibliographyText) {
    $document.Content.Text.Contains($ExpectedBibliographyText)
  }
  else {
    $fieldsAfter -gt 0
  }
}
finally {
  if ($null -ne $document) {
    $document.Close(0)
    [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($document)
  }
  if ($null -ne $word) {
    $word.Quit()
    [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($word)
  }
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
}

$sourceHashAfter = (Get-FileHash -Algorithm SHA256 -LiteralPath $inputFull).Hash
$outputHashAfter = (Get-FileHash -Algorithm SHA256 -LiteralPath $outputFull).Hash
$completed = $templateLoaded -and $fieldsBefore -gt 0 -and $fieldsAfter -eq $fieldsBefore -and $bibliographyPresent -and $sourceHashAfter -eq $sourceHashBefore
$receipt = [ordered]@{
  schemaVersion = 1
  completed = $completed
  testedAt = [DateTimeOffset]::UtcNow.ToString('O')
  macro = $macro
  wordVersion = $wordVersion
  templateLoaded = $templateLoaded
  fieldsBefore = $fieldsBefore
  fieldsAfter = $fieldsAfter
  bibliographyPresent = $bibliographyPresent
  sourcePath = $inputFull
  sourceSha256 = $sourceHashBefore
  sourceHashUnchanged = $sourceHashAfter -eq $sourceHashBefore
  outputPath = $outputFull
  outputSha256BeforeWordRefresh = $outputHashBefore
  outputSha256AfterWordRefresh = $outputHashAfter
  outputByteStable = $outputHashAfter -eq $outputHashBefore
}
[IO.File]::WriteAllText($receiptFull, ($receipt | ConvertTo-Json -Depth 8) + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
$receipt | ConvertTo-Json -Compress
if (-not $completed) {
  throw 'Microsoft Word + Zotero field refresh smoke test did not satisfy its assertions.'
}
