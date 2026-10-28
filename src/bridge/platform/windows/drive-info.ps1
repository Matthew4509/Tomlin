# Every drive with a letter, for backups: prints JSON [{ letter, serial, label, type, bus, fs, size, free }].
# type is Windows' own: 2 = removable (a USB stick, a card), 3 = fixed (inside the PC, and most USB hard drives too),
# 4 = network. bus is "USB" for a disk plugged in by USB (or that Windows calls external), which Windows may still call
# fixed. serial is the volume's serial number: TOMLIN finds a backup drive by it, since the letter can change.
# Takes no arguments; nothing from the page reaches here. (Get-Disk would say the bus too, but takes about 2 s.)
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$usb = @{}
foreach ($k in (Get-CimInstance Win32_DiskDrive)) {
    if ($k.InterfaceType -eq 'USB' -or "$($k.PNPDeviceID)" -match '^USB' -or "$($k.MediaType)" -match 'External|Removable') { $usb[[int]$k.Index] = $true }
}
$bus = @{}
# "Disk #1, Partition #0" holds "E:": which disk each letter is on (Get-Partition loads the same slow module as Get-Disk).
foreach ($m in (Get-CimInstance Win32_LogicalDiskToPartition)) {
    if ("$($m.Antecedent.DeviceID)" -match '^Disk #(\d+),' -and $usb[[int]$Matches[1]]) { $bus["$($m.Dependent.DeviceID)".Substring(0, 1).ToUpper()] = 'USB' }
}
$out = @()
foreach ($d in (Get-CimInstance Win32_LogicalDisk)) {
    $letter = "$($d.DeviceID)".Substring(0, 1).ToUpper()
    $out += [pscustomobject]@{ letter = $letter; serial = "$($d.VolumeSerialNumber)"; label = "$($d.VolumeName)"; type = [int]$d.DriveType; bus = "$($bus[$letter])"; fs = "$($d.FileSystem)"; size = [double]$d.Size; free = [double]$d.FreeSpace }
}
ConvertTo-Json -InputObject @($out) -Compress
