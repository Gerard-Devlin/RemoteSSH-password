param(
 [Parameter(Mandatory=$true)][string]$ArtifactDirectory,
 [Parameter(Mandatory=$true)][string]$ExpectedCommit,
 [string]$ExpectedPublisher='Devlin',
 [string]$ExpectedSha256=''
)
$ErrorActionPreference='Stop'
if($ExpectedCommit -notmatch '^[a-fA-F0-9]{40}$'){throw 'Invalid expected commit'}
$project=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$metadata=Get-Content -LiteralPath (Join-Path $project 'package.json') -Raw | ConvertFrom-Json
if($metadata.publisher -cne $ExpectedPublisher -or $metadata.name -notmatch '^[a-z0-9][a-z0-9-]*$' -or $metadata.version -notmatch '^\d+\.\d+\.\d+$'){throw 'Unexpected source identity'}
$directory=(Resolve-Path -LiteralPath $ArtifactDirectory).Path
$record=Get-Content -LiteralPath (Join-Path $directory 'package-verification.json') -Raw | ConvertFrom-Json
$filename=$metadata.name+'-'+$metadata.version+'-win32-x64.vsix'
$package=Join-Path $directory $filename
if($record.verified -ne $true -or $record.publisher -cne $ExpectedPublisher -or $record.extensionId -cne ($ExpectedPublisher+'.'+$metadata.name) -or $record.version -cne $metadata.version -or $record.target -ne 'win32-x64' -or $record.sourceCommit -ine $ExpectedCommit){throw 'CI verification record does not match the trusted source commit and identity'}
function Hash-Bytes([byte[]]$bytes){
 $sha=[Security.Cryptography.SHA256]::Create()
 try{return [BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
}
$digest=Hash-Bytes ([IO.File]::ReadAllBytes($package))
if(!$ExpectedSha256){$ExpectedSha256=$record.sha256}
if($ExpectedSha256 -notmatch '^[a-f0-9]{64}$' -or $digest -cne $ExpectedSha256){throw 'CI package SHA256 mismatch'}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip=[IO.Compression.ZipFile]::OpenRead($package)
try{
 $entries=@($zip.Entries | ForEach-Object {$_.FullName})
 if($entries.Count -ne $record.files.Count -or (Compare-Object ($entries | Sort-Object) ($record.files | Sort-Object) -CaseSensitive)){throw 'CI package inventory mismatch'}
 if(@($record.fileHashes.PSObject.Properties).Count -ne $entries.Count){throw 'Incomplete CI entry hashes'}
 $manifestBytes=$null;$packageBytes=$null
 foreach($entry in $zip.Entries){
  $stream=$entry.Open();$memory=New-Object IO.MemoryStream
  try{$stream.CopyTo($memory);$bytes=$memory.ToArray()}finally{$stream.Dispose();$memory.Dispose()}
  $expected=$record.fileHashes.PSObject.Properties[$entry.FullName]
  if(!$expected -or (Hash-Bytes $bytes) -cne $expected.Value){throw ('CI entry hash mismatch: '+$entry.FullName)}
  if($entry.FullName -eq 'extension.vsixmanifest'){$manifestBytes=$bytes}
  if($entry.FullName -eq 'extension/package.json'){$packageBytes=$bytes}
 }
 if(!$manifestBytes -or !$packageBytes){throw 'Missing package manifests'}
 [xml]$manifest=[Text.Encoding]::UTF8.GetString($manifestBytes)
 $identity=$manifest.PackageManifest.Metadata.Identity
 $packaged=[Text.Encoding]::UTF8.GetString($packageBytes) | ConvertFrom-Json
 if($identity.TargetPlatform -ne 'win32-x64' -or $identity.Id -cne $metadata.name -or $identity.Version -cne $metadata.version -or $identity.Publisher -ine $ExpectedPublisher -or $packaged.publisher -cne $ExpectedPublisher -or $packaged.name -cne $metadata.name -or $packaged.version -cne $metadata.version){throw 'CI package identity mismatch'}
 [pscustomobject]@{package=(Resolve-Path -LiteralPath $package).Path; filename=$filename; sha256=$digest; version=$metadata.version; publisher=$ExpectedPublisher; sourceCommit=$ExpectedCommit; verified=$true} | ConvertTo-Json
}finally{$zip.Dispose()}
