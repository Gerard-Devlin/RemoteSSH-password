param(
 [Parameter(Mandatory=$true)][string]$ArtifactDirectory,
 [Parameter(Mandatory=$true)][string]$ExpectedCommit
)
$ErrorActionPreference='Stop'
if(!$env:GH_TOKEN -or !$env:GITHUB_OUTPUT -or $env:GITHUB_EVENT_NAME -ne 'workflow_run'){throw 'Run this script from the trusted distribution workflow'}
$repository=$env:GITHUB_REPOSITORY
if($repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'){throw 'Invalid repository'}
$directory=(Resolve-Path -LiteralPath $ArtifactDirectory).Path
$verified=& (Join-Path $PSScriptRoot 'verify-ci-artifact.ps1') -ArtifactDirectory $directory -ExpectedCommit $ExpectedCommit | ConvertFrom-Json
$tag='v'+$verified.version
$utf8=[Text.UTF8Encoding]::new($false)
function Set-Output([string]$name,[string]$value){
 [IO.File]::AppendAllText($env:GITHUB_OUTPUT,$name+'='+$value+[char]10,$utf8)
}
function Add-Summary([string]$message){
 if($env:GITHUB_STEP_SUMMARY){[IO.File]::AppendAllText($env:GITHUB_STEP_SUMMARY,$message+[char]10,$utf8)}
}
function GitHub-Json([string]$endpoint,[bool]$allowMissing=$false){
 $response=& gh api $endpoint 2>&1
 $code=$LASTEXITCODE
 $text=$response | Out-String
 if($code -ne 0){
  if($allowMissing -and $text -match 'HTTP\s+404'){return $null}
  throw ('GitHub API request failed: '+$endpoint)
 }
 return ($text | ConvertFrom-Json)
}
Set-Output 'version' $verified.version
$reference=GitHub-Json ('repos/'+$repository+'/git/ref/tags/'+$tag) $true
if($reference){
 $object=$reference.object
 for($i=0;$object.type -eq 'tag' -and $i -lt 5;$i++){
  $object=(GitHub-Json ('repos/'+$repository+'/git/tags/'+$object.sha)).object
 }
 if($object.type -ne 'commit'){throw 'Could not resolve the release tag commit'}
 if($object.sha -ine $ExpectedCommit){
  Set-Output 'publishable' 'false'
  Add-Summary ('### Version '+$verified.version+' is already released')
  Add-Summary 'No existing tag, asset, or Marketplace version was overwritten. Run npm run version:patch before publishing new changes.'
  exit 0
 }
}
$release=GitHub-Json ('repos/'+$repository+'/releases/tags/'+$tag) $true
if($release -and $release.draft){throw 'This version has a draft Release. Resolve it before automatic distribution.'}
if(!$release){
 $changelog=Get-Content -LiteralPath (Join-Path $PSScriptRoot '../CHANGELOG.md') -Raw
 $section=[regex]::Match($changelog,'(?ms)^## '+[regex]::Escape($verified.version)+'[^\n]*\n(.*?)(?=^## |\z)')
 if(!$section.Success){throw 'The version has no changelog entry'}
 $notes=$section.Groups[1].Value.Trim()+[char]10+[char]10
 $notes+='Publisher: Devlin. Platform: Windows x64. This is a preview package.'+[char]10+[char]10
 $notes+='If moving from the local-tools preview, restore its SSH settings, uninstall it, and reload VS Code before installing this Devlin package. Saved passwords do not automatically migrate. See https://github.com/'+$repository+'/blob/main/docs/marketplace.md for migration and upload instructions.'+[char]10+[char]10
 $notes+='Source commit: '+$ExpectedCommit+[char]10
 if($env:CI_RUN_URL -match '^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/actions/runs/\d+$'){$notes+='Verified CI: '+$env:CI_RUN_URL+[char]10}
 $notesFile=Join-Path $env:RUNNER_TEMP ('sshpm-release-'+[guid]::NewGuid().ToString('N')+'.md')
 [IO.File]::WriteAllText($notesFile,$notes,$utf8)
 & gh release create $tag $verified.package (Join-Path $directory 'SHA256SUMS.txt') --repo $repository --target $ExpectedCommit --prerelease --title ($tag+' - Windows x64 preview') --notes-file $notesFile
 if($LASTEXITCODE -ne 0){throw 'Release creation or asset upload failed'}
 $release=GitHub-Json ('repos/'+$repository+'/releases/tags/'+$tag)
}
$packageAsset=@($release.assets | Where-Object {$_.name -ceq $verified.filename}) | Select-Object -First 1
if(!$packageAsset){
 & gh release upload $tag $verified.package --repo $repository
 if($LASTEXITCODE -ne 0){throw 'Missing VSIX asset could not be uploaded'}
 $release=GitHub-Json ('repos/'+$repository+'/releases/tags/'+$tag)
 $packageAsset=@($release.assets | Where-Object {$_.name -ceq $verified.filename}) | Select-Object -First 1
}
if(!$packageAsset -or $packageAsset.state -ne 'uploaded'){throw 'The release VSIX is not uploaded'}
$assetDigest=[regex]::Match([string]$packageAsset.digest,'^sha256:([a-f0-9]{64})$')
if(!$assetDigest.Success){throw 'The release VSIX has no verified server digest'}
$canonicalDigest=$assetDigest.Groups[1].Value
$uploadDirectory=Join-Path $env:RUNNER_TEMP ('sshpm-upload-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $uploadDirectory | Out-Null
& gh release download $tag --repo $repository --pattern $verified.filename --dir $uploadDirectory
if($LASTEXITCODE -ne 0){throw 'Could not download the canonical release package'}
Copy-Item -LiteralPath (Join-Path $directory 'package-verification.json') -Destination (Join-Path $uploadDirectory 'package-verification.json')
$canonical=& (Join-Path $PSScriptRoot 'verify-ci-artifact.ps1') -ArtifactDirectory $uploadDirectory -ExpectedCommit $ExpectedCommit -ExpectedSha256 $canonicalDigest | ConvertFrom-Json
$checksumLine=$canonical.sha256+'  '+$verified.filename
$checksumAsset=@($release.assets | Where-Object {$_.name -ceq 'SHA256SUMS.txt'}) | Select-Object -First 1
if($checksumAsset){
 & gh release download $tag --repo $repository --pattern 'SHA256SUMS.txt' --dir $uploadDirectory
 if($LASTEXITCODE -ne 0 -or (Get-Content -LiteralPath (Join-Path $uploadDirectory 'SHA256SUMS.txt') -Raw).Trim() -cne $checksumLine){throw 'Published checksum does not match the canonical VSIX'}
}else{
 [IO.File]::WriteAllText((Join-Path $uploadDirectory 'SHA256SUMS.txt'),$checksumLine+[char]10,$utf8)
 & gh release upload $tag (Join-Path $uploadDirectory 'SHA256SUMS.txt') --repo $repository
 if($LASTEXITCODE -ne 0){throw 'Checksum asset upload failed'}
}
$record=Get-Content -LiteralPath (Join-Path $uploadDirectory 'package-verification.json') -Raw | ConvertFrom-Json
$record.sha256=$canonical.sha256
$record.package=$canonical.package
$record.bytes=(Get-Item -LiteralPath $canonical.package).Length
[IO.File]::WriteAllText((Join-Path $uploadDirectory 'package-verification.json'),($record | ConvertTo-Json -Depth 8)+[char]10,$utf8)
Set-Output 'upload_directory' $uploadDirectory
Set-Output 'publishable' 'true'
Add-Summary ('### Verified Release '+$tag)
Add-Summary $release.html_url
Add-Summary ('Publisher: Devlin; Windows x64; source commit '+$ExpectedCommit)
Add-Summary ('Installer SHA256: '+$canonical.sha256)
