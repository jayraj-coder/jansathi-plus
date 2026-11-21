$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$target = Join-Path $root 'data\tessdata'
New-Item -ItemType Directory -Path $target -Force | Out-Null
foreach ($language in @('eng', 'hin', 'guj')) {
  $file = Join-Path $target ($language + '.traineddata')
  if (-not (Test-Path -LiteralPath $file)) {
    $url = "https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/$language.traineddata"
    Invoke-WebRequest -Uri $url -OutFile $file
    Write-Host "Downloaded $language trained data."
  } else {
    Write-Host "$language trained data already exists."
  }
}
Write-Host 'Install Tesseract 5 separately, then restart the JanSathi API and verify GET /api/health.'
