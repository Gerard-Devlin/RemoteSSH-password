param([string]$Package = '', [string]$ExpectedPublisher = 'Devlin')
$ErrorActionPreference='Stop'
$project=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$metadata=Get-Content -LiteralPath (Join-Path $project 'package.json') -Raw | ConvertFrom-Json
if($metadata.publisher -cne $ExpectedPublisher){throw 'Unexpected source publisher'}
if(!$Package){$Package=Join-Path $project ('artifacts\'+$metadata.name+'-'+$metadata.version+'-win32-x64.vsix')}
$Package=(Resolve-Path -LiteralPath $Package).Path
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip=[IO.Compression.ZipFile]::OpenRead($Package)
function Read-EntryBytes($entry){
 if(!$entry){throw 'Required VSIX entry is missing'}
 $stream=$entry.Open();$memory=New-Object IO.MemoryStream
 try{$stream.CopyTo($memory);return ,$memory.ToArray()}finally{$stream.Dispose();$memory.Dispose()}
}
function Hash-Bytes([byte[]]$bytes){
 $sha=[Security.Cryptography.SHA256]::Create()
 try{return [BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
}
try{
 $expected=@('extension.vsixmanifest','[Content_Types].xml','extension/changelog.md','extension/LICENSE.txt','extension/package.json','extension/readme.md','extension/SECURITY.md','extension/TEST-RESULTS.md','extension/THIRD-PARTY-NOTICES.txt','extension/bin/askpass.exe','extension/bin/broker.exe','extension/bin/scp.exe','extension/bin/ssh.exe','extension/dist/compatibility.js','extension/dist/core.js','extension/dist/hostIdentity.js','extension/dist/extension.js','extension/dist/settings.js','extension/docs/README.zh-CN.md','extension/docs/architecture.md','extension/docs/compatibility.md','extension/docs/testing.md','extension/docs/ui-text.md','extension/docs/testing/2026-11-05.md','extension/docs/testing/2026-11-06.md','extension/docs/troubleshooting.md','extension/CONTRIBUTING.md','extension/package.nls.json','extension/package.nls.zh-cn.json','extension/l10n/bundle.l10n.zh-cn.json','extension/media/icon.png','extension/docs/marketplace.md')
 $actual=@($zip.Entries | ForEach-Object {$_.FullName})
 if($actual.Count -ne $expected.Count -or (Compare-Object ($expected | Sort-Object) ($actual | Sort-Object) -CaseSensitive)){throw 'VSIX file inventory mismatch'}
 [xml]$manifest=[Text.Encoding]::UTF8.GetString((Read-EntryBytes $zip.GetEntry('extension.vsixmanifest')))
 $identity=$manifest.PackageManifest.Metadata.Identity
 if($identity.TargetPlatform -ne 'win32-x64' -or $identity.Id -cne $metadata.name -or $identity.Version -cne $metadata.version -or $identity.Publisher -ine $ExpectedPublisher){throw 'VSIX identity, version, publisher, or target mismatch'}
 $packaged=[Text.Encoding]::UTF8.GetString((Read-EntryBytes $zip.GetEntry('extension/package.json'))) | ConvertFrom-Json
 if($packaged.publisher -cne $ExpectedPublisher -or $packaged.name -cne $metadata.name -or $packaged.version -cne $metadata.version){throw 'Packaged manifest identity mismatch'}
 $readme=[Text.Encoding]::UTF8.GetString((Read-EntryBytes $zip.GetEntry('extension/readme.md')))
 $linkPattern=@'
(?:href|src)=["']([^"']+)["']|\]\(([^)\s]+)\)
'@
 foreach($match in [regex]::Matches($readme,$linkPattern.Trim())){
  $url=if($match.Groups[1].Success){$match.Groups[1].Value}else{$match.Groups[2].Value}
  if(!$url.StartsWith('#') -and !$url.StartsWith('https://')){throw 'Marketplace README has a non-HTTPS link or image'}
 }
 $nativeHashes=@{};$fileHashes=@{}
 foreach($entry in $zip.Entries){
  $bytes=Read-EntryBytes $entry
  $hash=Hash-Bytes $bytes
  $fileHashes[$entry.FullName]=$hash
  if(!$entry.FullName.StartsWith('extension/')){continue}
  $relative=$entry.FullName.Substring('extension/'.Length)
  if($relative -eq 'LICENSE.txt'){$relative='LICENSE'}
  $source=Join-Path $project $relative
  if($hash -ne (Hash-Bytes ([IO.File]::ReadAllBytes($source)))){throw ('Packaged file differs from source: '+$relative)}
  if($relative.EndsWith('.exe')){
   if($bytes[0] -ne 77 -or $bytes[1] -ne 90){throw 'Not a Windows PE binary'}
   $offset=[BitConverter]::ToInt32($bytes,0x3c)
   if([BitConverter]::ToUInt16($bytes,$offset+4) -ne 0x8664){throw 'Native binary is not x64'}
   $nativeHashes[$relative]=$hash
  }
 }
 [pscustomobject]@{package=$Package; bytes=(Get-Item -LiteralPath $Package).Length; sha256=(Hash-Bytes ([IO.File]::ReadAllBytes($Package))); publisher=$metadata.publisher; extensionId=($metadata.publisher+'.'+$metadata.name); version=$metadata.version; target='win32-x64'; files=$actual; fileHashes=$fileHashes; nativeHashes=$nativeHashes; readmeHttps=$true; verified=$true} | ConvertTo-Json -Depth 6
}finally{$zip.Dispose()}
