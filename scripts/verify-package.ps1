param([string]$Package = '', [string]$ExpectedPublisher = 'Devlin')
$ErrorActionPreference='Stop'
$project=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$metadata=Get-Content -LiteralPath (Join-Path $project 'package.json') -Raw | ConvertFrom-Json
if($metadata.publisher -cne $ExpectedPublisher){throw 'Unexpected source publisher'}
Push-Location $project
try {
 $arguments=@('scripts/verify-package.mjs','--target','win32-x64')
 if($Package){$arguments+=@('--package',$Package)}
 & node @arguments | Out-Host
 if($LASTEXITCODE -ne 0){throw 'Package verification failed'}
 Get-Content -LiteralPath 'artifacts/package-verification-win32-x64.json' -Raw
} finally { Pop-Location }
