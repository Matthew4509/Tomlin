# Which program is listening on each port? Prints JSON: [{ port, pid, name, cmd }]. Ports nobody listens on are left out.
# Run by the Bridge (lib/platform/windows.js) with a list of port numbers it chose (project start ports); nothing typed into the page reaches here.
param([string]$Ports = '')
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$want = $Ports -split ',' | Where-Object { $_ -match '^\d+$' } | ForEach-Object { [int]$_ }
$out = @()
foreach ($c in (Get-NetTCPConnection -State Listen | Where-Object { $want -contains $_.LocalPort } | Sort-Object LocalPort, OwningProcess -Unique)) {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)"
    $out += [pscustomobject]@{ port = $c.LocalPort; pid = $c.OwningProcess; name = $p.Name; cmd = $p.CommandLine; parent = $p.ParentProcessId }
}
ConvertTo-Json -InputObject @($out) -Compress
