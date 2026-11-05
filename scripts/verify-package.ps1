param([string]$Package = '')
$ErrorActionPreference='Stop'
$project=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$metadata=Get-Content -LiteralPath (Join-Path $project 'package.json') -Raw | ConvertFrom-Json
if(!$Package){$Package=Join-Path $project ('artifacts\'+$metadata.name+'-'+$metadata.version+'-win32-x64.vsix')}
$Package=(Resolve-Path -LiteralPath $Package).Path
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip=[IO.Compression.ZipFile]::OpenRead($Package)
function Read-EntryBytes($entry){
 $stream=$entry.Open();$memory=New-Object IO.MemoryStream
 try{$stream.CopyTo($memory);return ,$memory.ToArray()}finally{$stream.Dispose();$memory.Dispose()}
}
function Hash-Bytes([byte[]]$bytes){
 $sha=[Security.Cryptography.SHA256]::Create()
 try{return [BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
}
try{
 $expected=@('extension.vsixmanifest','[Content_Types].xml','extension/changelog.md','extension/LICENSE.txt','extension/package.json','extension/readme.md','extension/SECURITY.md','extension/TEST-RESULTS.md','extension/THIRD-PARTY-NOTICES.txt','extension/bin/askpass.exe','extension/bin/broker.exe','extension/bin/scp.exe','extension/bin/ssh.exe','extension/dist/compatibility.js','extension/dist/core.js','extension/dist/hostIdentity.js','extension/dist/extension.js','extension/dist/settings.js','extension/docs/README.zh-CN.md','extension/docs/architecture.md','extension/docs/compatibility.md','extension/docs/testing.md','extension/docs/testing/2026-11-05.md','extension/docs/testing/2026-11-06.md','extension/docs/troubleshooting.md','extension/CONTRIBUTING.md','extension/package.nls.json','extension/package.nls.zh-cn.json','extension/l10n/bundle.l10n.zh-cn.json','extension/media/icon.png')
 $actual=@($zip.Entries | ForEach-Object {$_.FullName})
 if($actual.Count -ne $expected.Count -or (Compare-Object ($expected | Sort-Object) ($actual | Sort-Object))){throw 'VSIX file inventory mismatch'}
 $manifest=[Text.Encoding]::UTF8.GetString((Read-EntryBytes $zip.GetEntry('extension.vsixmanifest')))
 if($manifest -notmatch 'TargetPlatform="win32-x64"'){throw 'Missing win32-x64 target'}
 $nativeHashes=@{}
 foreach($entry in $zip.Entries){
  if(!$entry.FullName.StartsWith('extension/')){continue}
  $relative=$entry.FullName.Substring('extension/'.Length)
  if($relative -eq 'LICENSE.txt'){$relative='LICENSE'}
  $source=Join-Path $project $relative
  $bytes=Read-EntryBytes $entry
  $hash=Hash-Bytes $bytes
  if($hash -ne (Hash-Bytes ([IO.File]::ReadAllBytes($source)))){throw ('Packaged file differs from source: '+$relative)}
  if($relative.EndsWith('.exe')){
   if($bytes[0] -ne 77 -or $bytes[1] -ne 90){throw 'Not a Windows PE binary'}
   $offset=[BitConverter]::ToInt32($bytes,0x3c)
   if([BitConverter]::ToUInt16($bytes,$offset+4) -ne 0x8664){throw 'Native binary is not x64'}
   $nativeHashes[$relative]=$hash
  }
 }
 [pscustomobject]@{package=(Resolve-Path -LiteralPath $Package).Path; bytes=(Get-Item -LiteralPath $Package).Length; sha256=(Hash-Bytes ([IO.File]::ReadAllBytes($Package))); target='win32-x64'; files=$actual; nativeHashes=$nativeHashes; verified=$true} | ConvertTo-Json -Depth 5
}finally{$zip.Dispose()}
