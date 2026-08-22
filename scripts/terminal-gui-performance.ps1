[CmdletBinding()]
param(
    # Pass as one comma-separated argument when invoking with -File, e.g.
    # -Counts 1,5,10. Keeping the raw value as a string avoids PowerShell
    # converting the command-line token "1,10" into the integer 110.
    [string]$Counts = "1,5,10",
    [ValidateRange(1, 60)]
    [int]$SampleSeconds = 10,
    [string]$ExecutablePath
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($ExecutablePath)) {
    $repoRoot = Split-Path -Parent $PSScriptRoot
    $ExecutablePath = Join-Path $repoRoot "src-tauri/target/release/project-terminal.exe"
}

if (-not (Test-Path -LiteralPath $ExecutablePath -PathType Leaf)) {
    throw "Project Terminal executable was not found: $ExecutablePath"
}

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes

$browserArguments = @(
    "--no-sandbox",
    "--disable-gpu",
    "--disable-gpu-compositing",
    "--disable-features=RendererCodeIntegrity,msWebOOUI"
)

function Get-ProcessTree {
    param([int]$RootProcessId)

    $processes = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue
    $childrenByParent = @{}
    foreach ($process in $processes) {
        $parentId = [int]$process.ParentProcessId
        if (-not $childrenByParent.ContainsKey($parentId)) {
            $childrenByParent[$parentId] = [System.Collections.Generic.List[object]]::new()
        }
        $childrenByParent[$parentId].Add($process)
    }

    $seen = [System.Collections.Generic.HashSet[int]]::new()
    $queue = [System.Collections.Generic.Queue[int]]::new()
    $queue.Enqueue($RootProcessId)
    $result = [System.Collections.Generic.List[object]]::new()

    while ($queue.Count -gt 0) {
        $parentId = $queue.Dequeue()
        if (-not $childrenByParent.ContainsKey($parentId)) {
            continue
        }
        foreach ($child in $childrenByParent[$parentId]) {
            $childId = [int]$child.ProcessId
            if ($seen.Add($childId)) {
                $result.Add($child)
                $queue.Enqueue($childId)
            }
        }
    }

    return @($result)
}

function Get-ProcessMetrics {
    param([int]$RootProcessId)

    $tree = @(Get-ProcessTree -RootProcessId $RootProcessId)
    $processIds = @($RootProcessId) + @($tree | ForEach-Object { [int]$_.ProcessId })
    $processIds = @($processIds | Sort-Object -Unique)
    $rows = [System.Collections.Generic.List[object]]::new()

    foreach ($processId in $processIds) {
        $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
        if ($null -eq $process) {
            continue
        }
        $process.Refresh()
        $rows.Add([pscustomobject]@{
                Id     = $process.Id
                Name   = $process.ProcessName
                Cpu    = $process.TotalProcessorTime.TotalSeconds
                Memory = $process.WorkingSet64
            })
    }

    return [pscustomobject]@{
        Tree = $tree
        Rows = @($rows)
    }
}

function Get-UiRoot {
    param([int]$WindowHandle)

    return [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$WindowHandle)
}

function Invoke-UiButton {
    param(
        [System.Windows.Automation.AutomationElement]$Root,
        [string]$NameLike,
        [string]$ClassLike = ""
    )

    $all = $Root.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.Condition]::TrueCondition
    )
    $target = $null
    for ($index = 0; $index -lt $all.Count; $index++) {
        $candidate = $all.Item($index)
        if (
            $candidate.Current.Name -like $NameLike -and
            ($ClassLike -eq "" -or $candidate.Current.ClassName -like $ClassLike)
        ) {
            $target = $candidate
            break
        }
    }

    if ($null -eq $target) {
        return $false
    }

    $invokePattern = $null
    if (-not $target.TryGetCurrentPattern(
            [System.Windows.Automation.InvokePattern]::Pattern,
            [ref]$invokePattern
        )) {
        return $false
    }
    ([System.Windows.Automation.InvokePattern]$invokePattern).Invoke()
    return $true
}

function Wait-ForUi {
    param([int]$ProcessId)

    # The first WebView2 environment creation can take more than 20 seconds on
    # a managed Windows desktop. Keep the probe patient; a failed probe must
    # not be mistaken for a terminal startup failure.
    for ($attempt = 0; $attempt -lt 240; $attempt++) {
        $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
        if ($null -ne $process -and $process.MainWindowHandle -ne 0) {
            $root = Get-UiRoot -WindowHandle $process.MainWindowHandle
            if ($null -ne $root) {
                $condition = New-Object System.Windows.Automation.PropertyCondition(
                    [System.Windows.Automation.AutomationElement]::NameProperty,
                    "新建终端"
                )
                if ($null -ne $root.FindFirst(
                        [System.Windows.Automation.TreeScope]::Descendants,
                        $condition
                    )) {
                    return [pscustomobject]@{
                        Handle = $process.MainWindowHandle
                        Root   = $root
                    }
                }
            }
        }
        Start-Sleep -Milliseconds 250
    }

    throw "Project Terminal GUI did not become automation-ready: $ProcessId"
}

function Get-RendererAttachmentCount {
    param([System.Windows.Automation.AutomationElement]$Root)

    $all = $Root.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.Condition]::TrueCondition
    )
    $canvas = 0
    $input = 0
    for ($index = 0; $index -lt $all.Count; $index++) {
        $name = $all.Item($index).Current.Name
        if ($name -eq "终端") {
            $canvas++
        }
        if ($name -eq "Terminal input") {
            $input++
        }
    }
    return [pscustomobject]@{
        Canvas = $canvas
        Input  = $input
    }
}

function Close-Application {
    param(
        [int]$ProcessId,
        [int]$WindowHandle
    )

    $root = Get-UiRoot -WindowHandle $WindowHandle
    if (-not (Invoke-UiButton -Root $root -NameLike "关闭" -ClassLike "*window-control--close*")) {
        Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
        return $false
    }

    Start-Sleep -Seconds 2
    $root = Get-UiRoot -WindowHandle $WindowHandle
    if (-not (Invoke-UiButton -Root $root -NameLike "停止终端并退出*")) {
        Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
        return $false
    }

    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        if ($null -eq (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) {
            return $true
        }
        Start-Sleep -Milliseconds 250
    }

    Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
    return $false
}

$sessionCounts = @(
    $Counts -split "," | ForEach-Object {
        $value = $_.Trim()
        if ($value -notmatch "^\d+$") {
            throw "Session counts must be comma-separated positive integers: $Counts"
        }
        [int]$value
    }
)

$results = [System.Collections.Generic.List[object]]::new()
foreach ($sessionCount in $sessionCounts) {
    if ($sessionCount -lt 1) {
        throw "Each session count must be positive: $sessionCount"
    }

    $application = Start-Process -FilePath $ExecutablePath -ArgumentList $browserArguments -PassThru -WindowStyle Normal
    $ready = $null
    $result = $null
    $clean = $false
    try {
        $ready = Wait-ForUi -ProcessId $application.Id
        for ($index = 0; $index -lt $sessionCount; $index++) {
            if (-not (Invoke-UiButton -Root $ready.Root -NameLike "新建终端")) {
                throw "The new-terminal button was unavailable at $($index + 1)/$sessionCount"
            }
            Start-Sleep -Milliseconds 700
        }

        Start-Sleep -Seconds 5
        $renderer = Get-RendererAttachmentCount -Root (Get-UiRoot -WindowHandle $ready.Handle)
        $before = Get-ProcessMetrics -RootProcessId $application.Id
        Start-Sleep -Seconds $SampleSeconds
        $after = Get-ProcessMetrics -RootProcessId $application.Id

        $cpuBefore = ($before.Rows | Measure-Object -Property Cpu -Sum).Sum
        $cpuAfter = ($after.Rows | Measure-Object -Property Cpu -Sum).Sum
        $memory = ($after.Rows | Measure-Object -Property Memory -Sum).Sum
        $shells = @($after.Tree | Where-Object {
                $_.Name -in @("pwsh.exe", "powershell.exe", "cmd.exe", "bash.exe", "wsl.exe", "ssh.exe")
            })

        $result = [pscustomobject]@{
                Sessions            = $sessionCount
                ShellProcesses      = $shells.Count
                CanvasAttachments   = $renderer.Canvas
                InputAttachments    = $renderer.Input
                TreeProcesses       = $after.Rows.Count
                CpuSeconds          = [math]::Round($cpuAfter - $cpuBefore, 3)
                CpuPercentOneCore   = [math]::Round((($cpuAfter - $cpuBefore) / $SampleSeconds) * 100, 2)
                WorkingSetMiB       = [math]::Round($memory / 1MB, 1)
                CleanExit            = $false
            }
    } finally {
        if ($null -ne $ready) {
            $clean = Close-Application -ProcessId $application.Id -WindowHandle $ready.Handle
        } else {
            Stop-Process -Id $application.Id -Force -ErrorAction SilentlyContinue
        }
    }
    if ($null -ne $result) {
        $result.CleanExit = $clean
        $results.Add($result)
    }
    Start-Sleep -Seconds 3
}

$results | Format-Table -AutoSize
Write-Output ""
$results | ConvertTo-Json -Depth 3
