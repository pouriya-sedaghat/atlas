# Read-only collection on the actual Windows VMware host. Never edits VM settings/services.
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$VmDirectory,
  [Parameter(Mandatory=$true)][string]$OutputDirectory,
  [ValidateRange(10,600)][int]$Seconds=120,
  [datetimeoffset]$FailureStart='2026-10-29T05:52:00Z',
  [datetimeoffset]$FailureEnd='2026-10-29T05:58:00Z'
)
$ErrorActionPreference='Stop'
$vm=(Resolve-Path -LiteralPath $VmDirectory).Path
$destination=[IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $destination) { throw 'OutputDirectory must be a new directory' }
if ($destination.StartsWith($vm.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase) -or $destination -eq $vm) { throw 'OutputDirectory must be outside the VM directory' }
if (-not (Get-ChildItem -LiteralPath $vm -Filter '*.vmx' -File)) { throw 'VM directory must contain a .vmx file' }
if ($FailureEnd -le $FailureStart) { throw 'Failure window is invalid' }
$null=New-Item -ItemType Directory -Path $destination
$errorsList=New-Object 'System.Collections.Generic.List[object]'
function Save-Json($name,$value) { ConvertTo-Json -InputObject $value -Depth 14 | Set-Content -LiteralPath (Join-Path $destination $name) -Encoding UTF8 }
function Record-Error($scope,$exception) { $errorsList.Add(@{scope=$scope;error=$exception.GetType().Name;message=$exception.Message}) }
$inventory=@{schema='atlas.windows-host-inventory/1';at=[datetimeoffset]::UtcNow.ToString('o');scope='User-selected VMware VM directory on its actual Windows host';vm_directory=$vm;settings_changed=$false;vmx=@();files=@();computer=$null;os=$null;physical_disks=$null;volumes=$null;vmware_product=@();vmware_processes=@()}
try { $inventory.computer=Get-CimInstance Win32_ComputerSystem | Select-Object Manufacturer,Model,TotalPhysicalMemory,NumberOfLogicalProcessors } catch { Record-Error 'computer' $_.Exception }
try { $inventory.os=Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,BuildNumber,LastBootUpTime } catch { Record-Error 'os' $_.Exception }
try { $inventory.physical_disks=@(Get-PhysicalDisk -ErrorAction Stop | Select-Object FriendlyName,MediaType,BusType,Size,HealthStatus) } catch { Record-Error 'physical_disks' $_.Exception }
try { $inventory.volumes=@(Get-Volume -ErrorAction Stop | Where-Object { $_.DriveLetter -eq [IO.Path]::GetPathRoot($vm).TrimEnd('\').TrimEnd(':') } | Select-Object DriveLetter,FileSystem,Size,SizeRemaining,HealthStatus) } catch { Record-Error 'volumes' $_.Exception }
foreach ($registry in @('HKLM:\SOFTWARE\VMware, Inc.\VMware Workstation','HKLM:\SOFTWARE\WOW6432Node\VMware, Inc.\VMware Workstation')) {
  if (Test-Path -LiteralPath $registry) { try { $inventory.vmware_product+=Get-ItemProperty -LiteralPath $registry | Select-Object ProductVersion,InstallPath } catch { Record-Error 'vmware_product' $_.Exception } }
}
try { $inventory.vmware_processes=@(Get-Process -Name vmware-vmx -ErrorAction SilentlyContinue | Select-Object Id,CPU,WorkingSet64,PrivateMemorySize64) } catch { Record-Error 'vmware_processes' $_.Exception }
$allowed='^(numvcpus|memsize|virtualHW\.version|guestOS|priority\.[A-Za-z]+|mainMem\.[A-Za-z]+|MemTrimRate|sched\.(cpu|mem)\.[A-Za-z]+|(?:scsi|nvme|sata)\d+:\d+\.(?:fileName|present|deviceType))\s*=\s*"([^"]*)"\s*$'
foreach ($file in Get-ChildItem -LiteralPath $vm -Filter '*.vmx' -File) {
  $selected=@();foreach ($line in Get-Content -LiteralPath $file.FullName) { if ($line -match $allowed) { $selected+=@{key=$Matches[1];value=$Matches[3]} } }
  $inventory.vmx+=@{file=$file.Name;selected_settings=$selected;raw_vmx_exported=$false}
}
$inventory.files=@(Get-ChildItem -LiteralPath $vm -File | Where-Object { $_.Extension -in @('.vmdk','.vmsd','.vmsn','.vmem') } | Select-Object Name,Length,LastWriteTimeUtc)
Save-Json 'inventory.json' $inventory
$counters=@('\Processor(_Total)\% Processor Time','\Memory\Available MBytes','\Memory\Pages Input/sec','\PhysicalDisk(*)\Avg. Disk sec/Read','\PhysicalDisk(*)\Avg. Disk sec/Write','\PhysicalDisk(*)\Current Disk Queue Length','\PhysicalDisk(*)\Disk Read Bytes/sec','\PhysicalDisk(*)\Disk Write Bytes/sec')
$samples=New-Object 'System.Collections.Generic.List[object]'
$watch=[Diagnostics.Stopwatch]::StartNew();$previous=$null;$countersAvailable=$true
while ($watch.Elapsed.TotalSeconds -lt $Seconds) {
  $begin=$watch.Elapsed.TotalMilliseconds;$values=$null
  if ($countersAvailable) {
    try { $values=@((Get-Counter -Counter $counters -SampleInterval 1 -MaxSamples 1).CounterSamples | Select-Object Path,CookedValue,Status,Timestamp) }
    catch { $countersAvailable=$false;Record-Error 'performance_counters (English paths may require localization)' $_.Exception }
  } else { Start-Sleep -Milliseconds 1000 }
  $processes=$null;try { $processes=@(Get-Process -Name vmware-vmx -ErrorAction SilentlyContinue | Select-Object Id,CPU,WorkingSet64,PrivateMemorySize64) } catch { Record-Error 'sample_processes' $_.Exception }
  $gap=$null;if ($null -ne $previous) { $gap=$begin-$previous }
  $samples.Add(@{at=[datetimeoffset]::UtcNow.ToString('o');begin_ms=$begin;previous_gap_ms=$gap;collection_ms=$watch.Elapsed.TotalMilliseconds-$begin;counters=$values;vmware_processes=$processes});$previous=$begin
}
Save-Json 'performance.json' @{schema='atlas.windows-host-samples/1';requested_seconds=$Seconds;elapsed_ms=$watch.Elapsed.TotalMilliseconds;counter_paths=$counters;counter_collection_available=$countersAvailable;samples=$samples;missing_metrics_are_not_zero=$true;heavy_workload_started=$false}
$events=$null;try { $events=@(Get-WinEvent -FilterHashtable @{LogName='System';StartTime=$FailureStart.LocalDateTime;EndTime=$FailureEnd.LocalDateTime} | Where-Object { $_.ProviderName -match 'disk|stor|ntfs|volmgr|WHEA|Kernel-Power|Resource-Exhaustion' } | Select-Object TimeCreated,ProviderName,Id,LevelDisplayName,Message) } catch { Record-Error 'system_events (including unavailable/no-matching-events)' $_.Exception }
Save-Json 'historical-events.json' @{start_utc=$FailureStart.ToUniversalTime().ToString('o');end_utc=$FailureEnd.ToUniversalTime().ToString('o');events=$events}
$logRecords=@();foreach ($file in (Get-ChildItem -LiteralPath $vm -Filter 'vmware*.log' -File | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 4)) {
  $matchesList=@();foreach ($line in (Get-Content -LiteralPath $file.FullName -Tail 5000)) {
    if ($line -match '(?i)stun|unstun|suspend|resume|checkpoint|DISKLIB|SCSI.*RESET|took.*seconds|latency|HostMem|VmMem|GuestRpc|MonitorMode|Host is under memory') {
      if ($line -match '(?i)password|authorization|secret|token|encryption|encryptedKey') { $matchesList+='[sensitive matching log line omitted]' } else { $matchesList+=$line.Substring(0,[Math]::Min(1500,$line.Length)) }
    }
  }
  $logRecords+=@{file=$file.Name;last_write_utc=$file.LastWriteTimeUtc.ToString('o');tail_limit=5000;selected_lines=@($matchesList | Select-Object -Last 500);full_log_exported=$false}
}
Save-Json 'vmware-log-excerpts.json' @{schema='atlas.vmware-log-excerpts/1';logs=$logRecords;historical_window_coverage_guaranteed=$false}
Save-Json 'collection-errors.json' ($errorsList.ToArray())
$sums=@();foreach ($file in Get-ChildItem -LiteralPath $destination -File) { $sums+=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()+'  '+$file.Name }
$sums | Sort-Object | Set-Content -LiteralPath (Join-Path $destination 'SHA256SUMS') -Encoding ASCII
Write-Output "Collection saved in $destination. VM settings and services were not modified. Missing metrics are recorded as unavailable."
