param(
  [Parameter(Mandatory = $true)] [string] $Exe,
  [Parameter(Mandatory = $true)] [string] $Workspace,
  [Parameter(Mandatory = $true)] [string] $Stdout,
  [Parameter(Mandatory = $true)] [string] $Stderr
)

# End-to-end LSP probe: spawn OmniSharp the same way lsp.rs does, drive it
# through initialize -> didOpen -> hover for a real .cs file, then dump the
# transcript. The bat wrapper greps the result for `o#/error` frames and
# prints the hover response.

$ErrorActionPreference = 'Stop'

# Pick any .cs file under the workspace. Prefer Assets/Scripts (Unity), fall
# back to whatever we can find.
$csFile = $null
foreach ($candidate in @(
    (Join-Path $Workspace 'Assets\Scripts'),
    (Join-Path $Workspace 'Assets'),
    $Workspace
  )) {
  if (-not (Test-Path $candidate)) { continue }
  $hit = Get-ChildItem -Path $candidate -Filter '*.cs' -Recurse -File `
           -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($hit) { $csFile = $hit.FullName; break }
}
if (-not $csFile) {
  Write-Host "no .cs file found under $Workspace; aborting probe"
  return
}
Write-Host "probe target: $csFile"
$csText = [System.IO.File]::ReadAllText($csFile)
$csUri  = 'file:///' + ($csFile -replace '\\','/')

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $Exe
$psi.Arguments = "-lsp -s `"$Workspace`""
$psi.UseShellExecute = $false
$psi.RedirectStandardInput  = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError  = $true
$psi.CreateNoWindow = $true
# Mirror lsp.rs:124-141 exactly so this probe reflects what the app spawns.
$psi.EnvironmentVariables['DOTNET_ROLL_FORWARD'] = 'Major'
foreach ($name in @(
    'MSBUILD_EXE_PATH','MSBuildExtensionsPath','MSBuildExtensionsPath32',
    'MSBuildExtensionsPath64','MSBuildSDKsPath','MSBuildToolsPath',
    'MSBuildToolsPath32','MSBuildToolsPath64','VSINSTALLDIR','VCINSTALLDIR',
    'VisualStudioVersion'
  )) {
  $psi.EnvironmentVariables.Remove($name) | Out-Null
}

$proc = [System.Diagnostics.Process]::Start($psi)

function Send-LspMessage {
  param([System.Diagnostics.Process] $Proc, [string] $JsonBody)
  $body = [System.Text.Encoding]::UTF8.GetBytes($JsonBody)
  $hdr  = [System.Text.Encoding]::ASCII.GetBytes("Content-Length: $($body.Length)`r`n`r`n")
  $Proc.StandardInput.BaseStream.Write($hdr, 0, $hdr.Length)
  $Proc.StandardInput.BaseStream.Write($body, 0, $body.Length)
  $Proc.StandardInput.BaseStream.Flush()
}

$rootUri = 'file:///' + ($Workspace -replace '\\','/')

# 1. initialize / initialized
Send-LspMessage $proc ('{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"processId":null,"clientInfo":{"name":"locus-diag"},"rootUri":"' + $rootUri + '","workspaceFolders":[{"uri":"' + $rootUri + '","name":"diag"}],"capabilities":{"textDocument":{"hover":{"contentFormat":["markdown","plaintext"]}}}}}')
Send-LspMessage $proc '{"jsonrpc":"2.0","method":"initialized","params":{}}'

# 2. didOpen the .cs file. JSON-encode the body so we don't accidentally
#    blow up on quotes / backslashes / newlines in the source text.
$didOpenParams = @{
  textDocument = @{
    uri        = $csUri
    languageId = 'csharp'
    version    = 1
    text       = $csText
  }
} | ConvertTo-Json -Depth 5 -Compress
Send-LspMessage $proc ('{"jsonrpc":"2.0","method":"textDocument/didOpen","params":' + $didOpenParams + '}')

# Give OmniSharp time to load .csproj files for this Unity workspace.
$loadSeconds = 90
Write-Host "waiting ${loadSeconds}s for project load..."
Start-Sleep -Seconds $loadSeconds

# 3. textDocument/hover at a few positions. Try (10,10), (20,10), (5,5)
#    to maximize the chance of landing on a symbol with hover info.
$probes = @(@{l=10;c=10}, @{l=20;c=10}, @{l=5;c=5}, @{l=2;c=4})
$nextId = 100
foreach ($p in $probes) {
  $hoverParams = @{
    textDocument = @{ uri = $csUri }
    position     = @{ line = $p.l; character = $p.c }
  } | ConvertTo-Json -Depth 5 -Compress
  Send-LspMessage $proc ('{"jsonrpc":"2.0","id":' + $nextId + ',"method":"textDocument/hover","params":' + $hoverParams + '}')
  $nextId++
}

# Wait briefly for hover responses.
Start-Sleep -Seconds 5

# Kill, drain pipes synchronously.
if (-not $proc.HasExited) {
  try { $proc.Kill() } catch { }
}
$proc.WaitForExit(5000) | Out-Null

$stdoutText = $proc.StandardOutput.ReadToEnd()
$stderrText = $proc.StandardError.ReadToEnd()
[System.IO.File]::WriteAllText($Stdout, $stdoutText, [System.Text.UTF8Encoding]::new($false))
[System.IO.File]::WriteAllText($Stderr, $stderrText, [System.Text.UTF8Encoding]::new($false))

Write-Host "exit=$($proc.ExitCode), stdout bytes=$($stdoutText.Length), stderr bytes=$($stderrText.Length)"
Write-Host "probe-target=$csFile"
