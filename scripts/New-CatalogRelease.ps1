[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^\d+\.\d+\.\d+([-.][0-9A-Za-z.-]+)?$')]
    [string]$Version,
    [string]$SigningKeyPath
)

$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..')
if ([string]::IsNullOrWhiteSpace($SigningKeyPath)) {
    $SigningKeyPath = Join-Path $root '.keys\catalog-update-ed25519.pem'
}
$manifestPath = Join-Path $root 'manifest.json'
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json

node (Join-Path $PSScriptRoot 'validate-catalog-release.mjs')

if ($manifest.version -ne $Version) {
    throw "manifest.json version '$($manifest.version)' must match requested release version '$Version'."
}
if (-not (Test-Path -LiteralPath $SigningKeyPath -PathType Leaf)) {
    throw "Signing key not found at '$SigningKeyPath'. It must remain outside Git."
}

$dist = Join-Path $root 'dist'
$stage = Join-Path $dist ('.stage-' + [guid]::NewGuid().ToString('N'))
$zip = Join-Path $dist 'catalog-pack.zip'
$signature = Join-Path $dist 'catalog-pack.sig'

New-Item -ItemType Directory -Force -Path $stage | Out-Null
New-Item -ItemType Directory -Force -Path $dist | Out-Null
try {
    Copy-Item -LiteralPath $manifestPath -Destination (Join-Path $stage 'manifest.json')
    Copy-Item -LiteralPath (Join-Path $root 'catalog') -Destination (Join-Path $stage 'catalog') -Recurse
    $avatars = Join-Path $root 'assets'
    if (Test-Path -LiteralPath $avatars -PathType Container) {
        Copy-Item -LiteralPath $avatars -Destination (Join-Path $stage 'assets') -Recurse
    }
    Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $signature -Force -ErrorAction SilentlyContinue
    $releaseItems = Get-ChildItem -LiteralPath $stage -Force
    Compress-Archive -Path $releaseItems.FullName -DestinationPath $zip -CompressionLevel Optimal
    node (Join-Path $PSScriptRoot 'sign-catalog-release.mjs') $zip $signature $SigningKeyPath
    Write-Host "Created $zip and $signature"
}
finally {
    Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
}
