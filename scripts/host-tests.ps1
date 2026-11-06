param(
 [string]$Code = '',
 [string]$ExtensionSource = "$env:USERPROFILE\.vscode\extensions",
 [string[]]$DependencyFolders = @(
  'ms-vscode-remote.remote-ssh-0.128.0',
  'ms-vscode-remote.remote-ssh-edit-0.87.0',
  'ms-vscode.remote-explorer-0.5.0'
 )
)
$ErrorActionPreference='Stop'
$project=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
if(!$Code){
 $candidates=@(
  $env:VSCODE_EXECUTABLE,
  (Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code\Code.exe'),
  (Join-Path $env:ProgramFiles 'Microsoft VS Code\Code.exe')
 )
 $cli=Get-Command code -ErrorAction SilentlyContinue
 if($cli -and $cli.Source){$candidates+=(Join-Path (Split-Path (Split-Path $cli.Source -Parent) -Parent) 'Code.exe')}
 $Code=$candidates | Where-Object {$_ -and (Test-Path -LiteralPath $_ -PathType Leaf)} | Select-Object -First 1
}
if(!$Code -or !(Test-Path -LiteralPath $Code -PathType Leaf)){throw 'Code.exe was not found. Supply -Code or VSCODE_EXECUTABLE.'}
foreach($name in $DependencyFolders){
 if(!(Test-Path -LiteralPath (Join-Path $ExtensionSource $name) -PathType Container)){throw "Missing isolated-host dependency: $name. Supply -ExtensionSource or install the required test version separately."}
}
$testRoot=Join-Path $project ('.test-host\'+[guid]::NewGuid().ToString('N'))
$userData=Join-Path $testRoot 'user-data'
$extensions=Join-Path $testRoot 'extensions'
New-Item -ItemType Directory -Path $extensions -Force | Out-Null
foreach($name in $DependencyFolders){
 Copy-Item -LiteralPath (Join-Path $ExtensionSource $name) -Destination (Join-Path $extensions $name) -Recurse
}
$sourceMetadata=Get-Content -LiteralPath (Join-Path $project 'package.json') -Raw | ConvertFrom-Json
$utf8=New-Object Text.UTF8Encoding($false)
$oldPhase=$env:SSHPM_TEST_PHASE
$oldRoot=$env:SSHPM_TEST_PROJECT
$oldRunner=$env:SSHPM_TEST_RUNNER
$oldNode=$env:ELECTRON_RUN_AS_NODE
try{
 Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
 $env:SSHPM_TEST_PROJECT=$project
 $env:SSHPM_TEST_RUNNER=Join-Path $project 'scripts\host-tests.cjs'
 foreach($phase in @('seed','verify')){
  $env:SSHPM_TEST_PHASE=$phase
  # Different installation paths and manifest versions, same extension identity.
  # The wrapper exists only in this isolated test copy, never in the VSIX.
  $development=Join-Path $testRoot ('extension-'+$phase)
  New-Item -ItemType Directory -Path $development -Force | Out-Null
  foreach($item in @('dist','bin','l10n','media','package.nls.json','package.nls.zh-cn.json')){
   Copy-Item -LiteralPath (Join-Path $project $item) -Destination (Join-Path $development $item) -Recurse
  }
  $metadata=$sourceMetadata | ConvertTo-Json -Depth 20 | ConvertFrom-Json
  if($phase -eq 'seed'){$metadata.version='0.0.1'}
  $metadata.main='./dist/host-context.cjs'
  [IO.File]::WriteAllText((Join-Path $development 'package.json'),($metadata | ConvertTo-Json -Depth 20),$utf8)
  $wrapper=@'
const entry = require('./extension.js');
exports.activate = async context => {
  await entry.activate(context);
  const api = { secrets: context.secrets, state: context.globalState, storage: context.globalStorageUri.fsPath };
  setTimeout(async () => {
    try { await require(process.env.SSHPM_TEST_RUNNER).run(api); }
    catch (error) { console.error(error); }
    finally { await require('vscode').commands.executeCommand('workbench.action.quit'); }
  }, 100);
  return api;
};
exports.deactivate = entry.deactivate;
'@
  [IO.File]::WriteAllText((Join-Path $development 'dist\host-context.cjs'),$wrapper,$utf8)
  $resultFile=Join-Path $project ('artifacts\host-'+$phase+'.json')
  if(Test-Path -LiteralPath $resultFile){Remove-Item -LiteralPath $resultFile}
  $args=@('--new-window','--skip-welcome','--skip-release-notes','--disable-workspace-trust','--disable-updates','--disable-telemetry',
    ('--user-data-dir="'+$userData+'"'),('--extensions-dir="'+$extensions+'"'),
    ('--extensionDevelopmentPath="'+$development+'"'))
  $p=Start-Process -FilePath $Code -ArgumentList $args -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $testRoot ($phase+'.stdout')) -RedirectStandardError (Join-Path $testRoot ($phase+'.stderr'))
  $null=$p.Handle
  if(-not $p.WaitForExit(90000)){Stop-Process -Id $p.Id -ErrorAction SilentlyContinue;throw 'Isolated VS Code test timed out'}
  $p.Refresh()
  if($p.ExitCode -ne 0){
   Get-Content -LiteralPath (Join-Path $testRoot ($phase+'.stdout'))
   Get-Content -LiteralPath (Join-Path $testRoot ($phase+'.stderr'))
   throw "VS Code test phase failed: $phase"
  }
  if(!(Test-Path -LiteralPath $resultFile)){throw "VS Code exited without host assertions: $phase. Inspect isolated stdout/stderr under $testRoot."}
  $result=Get-Content -LiteralPath $resultFile -Raw | ConvertFrom-Json
  if(!$result.results -or @($result.results | Where-Object {!$_.passed}).Count){throw "Host assertions failed: $phase"}
  Get-Content -LiteralPath $resultFile
 }
}finally{
 $env:SSHPM_TEST_PHASE=$oldPhase
 $env:SSHPM_TEST_PROJECT=$oldRoot
 $env:SSHPM_TEST_RUNNER=$oldRunner
 $env:ELECTRON_RUN_AS_NODE=$oldNode
}
