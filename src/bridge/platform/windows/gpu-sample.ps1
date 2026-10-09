# GPU use for the Bridge's This PC panel. Started once by lib/sensors.js and kept waiting on its input:
# each line it is sent = take one reading. When the Bridge stops, its input closes and this ends.
# Reads the same Windows counters Task Manager uses (GPU Engine, Utilization Percentage); no admin needed.
# Prints: "ADAPTERS name|name" once, then per reading "GPU <instances> name=value|..." (only engines above 0)
# or "ERR <message>".
$ErrorActionPreference = 'Stop'
$inv = [Globalization.CultureInfo]::InvariantCulture
try { $names = @(Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name }) -join '|' } catch { $names = '' }
[Console]::Out.WriteLine('ADAPTERS ' + $names)
[Console]::Out.Flush()
while ($null -ne ($line = [Console]::In.ReadLine())) {
  try {
    $s = @((Get-Counter '\GPU Engine(*)\Utilization Percentage' -ErrorAction SilentlyContinue).CounterSamples)
    if ($s.Count -eq 0) { throw 'Windows has no GPU Engine counters on this PC.' }
    $busy = @($s | Where-Object { $_.CookedValue -gt 0 } | ForEach-Object { $_.InstanceName + '=' + $_.CookedValue.ToString($inv) })
    [Console]::Out.WriteLine('GPU ' + $s.Count + ' ' + ($busy -join '|'))
  } catch {
    [Console]::Out.WriteLine('ERR ' + ($_.Exception.Message -replace '[\r\n]+', ' '))
  }
  [Console]::Out.Flush()
}
