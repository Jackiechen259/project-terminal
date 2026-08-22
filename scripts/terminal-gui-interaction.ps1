[CmdletBinding()]
param(
    [ValidateRange(1, 1000000)]
    [int]$OutputLines = 10000,
    [ValidateRange(32, 4096)]
    [int]$OutputPayloadLength = 256,
    [ValidateRange(1, 1000)]
    [int]$ResizeIterations = 100,
    [ValidateRange(0, 3)]
    [int]$SplitAdditionalPanes = 0,
    [ValidateRange(10, 300)]
    [int]$TimeoutSeconds = 120,
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
Add-Type -AssemblyName System.Windows.Forms

if (-not ("TerminalGuiNative" -as [type])) {
    Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class TerminalGuiNative
{
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetWindowPos(
        IntPtr hWnd,
        IntPtr hWndInsertAfter,
        int x,
        int y,
        int cx,
        int cy,
        uint flags);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int command);
}
"@
}

$browserArguments = @(
    "--no-sandbox",
    "--disable-gpu",
    "--disable-gpu-compositing",
    "--disable-features=RendererCodeIntegrity,msWebOOUI"
)

function Get-ProcessTree {
    param([int]$RootProcessId)

    $processes = Get-CimInstance Win32_Process
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

    if ($WindowHandle -eq 0) {
        return $null
    }
    return [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$WindowHandle)
}

function Get-UiDescendants {
    param([System.Windows.Automation.AutomationElement]$Root)

    if ($null -eq $Root) {
        return @()
    }
    $all = $Root.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.Condition]::TrueCondition
    )
    $result = [System.Collections.Generic.List[object]]::new()
    for ($index = 0; $index -lt $all.Count; $index++) {
        $result.Add($all.Item($index))
    }
    return @($result)
}

function Find-UiElement {
    param(
        [System.Windows.Automation.AutomationElement]$Root,
        [string]$NameLike,
        [string]$ControlType = ""
    )

    foreach ($candidate in @(Get-UiDescendants -Root $Root)) {
        if ($candidate.Current.Name -notlike $NameLike) {
            continue
        }
        if ($ControlType -ne "" -and $candidate.Current.ControlType.ProgrammaticName -notlike "*$ControlType*") {
            continue
        }
        return $candidate
    }
    return $null
}

function Invoke-UiButton {
    param(
        [System.Windows.Automation.AutomationElement]$Root,
        [string]$NameLike,
        [string]$ClassLike = ""
    )

    foreach ($candidate in @(Get-UiDescendants -Root $Root)) {
        if ($candidate.Current.Name -notlike $NameLike) {
            continue
        }
        if ($ClassLike -ne "" -and $candidate.Current.ClassName -notlike $ClassLike) {
            continue
        }
        $invokePattern = $null
        if (-not $candidate.TryGetCurrentPattern(
                [System.Windows.Automation.InvokePattern]::Pattern,
                [ref]$invokePattern
            )) {
            continue
        }
        ([System.Windows.Automation.InvokePattern]$invokePattern).Invoke()
        return $true
    }
    return $false
}

function Wait-ForUi {
    param([int]$ProcessId)

    for ($attempt = 0; $attempt -lt 240; $attempt++) {
        $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
        if ($null -ne $process -and $process.MainWindowHandle -ne 0) {
            $root = Get-UiRoot -WindowHandle $process.MainWindowHandle
            if ($null -ne (Find-UiElement -Root $root -NameLike "新建终端" -ControlType "Button")) {
                return [pscustomobject]@{
                    Handle = $process.MainWindowHandle
                    Root   = $root
                }
            }
        }
        Start-Sleep -Milliseconds 250
    }

    throw "Project Terminal GUI did not become automation-ready: $ProcessId"
}

function Get-RendererAttachment {
    param([System.Windows.Automation.AutomationElement]$Root)

    $canvas = 0
    $input = 0
    $canvasRect = $null
    foreach ($element in @(Get-UiDescendants -Root $Root)) {
        $rect = $element.Current.BoundingRectangle
        $visible =
            -not $element.Current.IsOffscreen -and
            $rect.Width -gt 0 -and
            $rect.Height -gt 0
        if ($element.Current.Name -eq "终端") {
            if ($visible) {
                $canvas++
                $canvasRect = $rect
            }
        }
        if ($element.Current.Name -eq "Terminal input") {
            if ($visible) {
                $input++
            }
        }
    }
    return [pscustomobject]@{
        Canvas     = $canvas
        Input      = $input
        CanvasRect = $canvasRect
    }
}

function Send-TerminalText {
    param(
        [System.Windows.Automation.AutomationElement]$Root,
        [string]$Text
    )

    $input = Find-UiElement -Root $Root -NameLike "Terminal input" -ControlType "Edit"
    if ($null -eq $input) {
        throw "Terminal input was not exposed through UI Automation"
    }

    $valuePattern = $null
    if (-not $input.TryGetCurrentPattern(
            [System.Windows.Automation.ValuePattern]::Pattern,
            [ref]$valuePattern
        )) {
        throw "Terminal input does not expose ValuePattern"
    }
    ([System.Windows.Automation.ValuePattern]$valuePattern).SetValue($Text)
    $input.SetFocus()
    [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
}

function Wait-ForExitedTab {
    param(
        [int]$WindowHandle,
        [datetime]$Deadline
    )

    while ([datetime]::UtcNow -lt $Deadline) {
        $root = Get-UiRoot -WindowHandle $WindowHandle
        foreach ($element in @(Get-UiDescendants -Root $root)) {
            if (
                $element.Current.ControlType.ProgrammaticName -like "*TabItem*" -and
                $element.Current.Name -like "*已退出*"
            ) {
                return $element.Current.Name
            }
        }
        Start-Sleep -Milliseconds 100
    }
    return $null
}

function Invoke-ApplicationQuit {
    param(
        [int]$ProcessId,
        [int]$WindowHandle
    )

    $root = Get-UiRoot -WindowHandle $WindowHandle
    if ($null -ne $root) {
        [void](Invoke-UiButton -Root $root -NameLike "关闭" -ClassLike "*window-control--close*")
    }

    $deadline = [datetime]::UtcNow.AddSeconds(8)
    while ([datetime]::UtcNow -lt $deadline) {
        $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
        if ($null -eq $process) {
            return $true
        }
        $currentRoot = Get-UiRoot -WindowHandle $process.MainWindowHandle
        if ($null -ne (Find-UiElement -Root $currentRoot -NameLike "停止终端并退出*")) {
            if (Invoke-UiButton -Root $currentRoot -NameLike "停止终端并退出*") {
                break
            }
        }
        Start-Sleep -Milliseconds 200
    }

    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        if ($null -eq (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) {
            return $true
        }
        Start-Sleep -Milliseconds 250
    }

    # This process is the exact GUI instance created by this probe. The
    # fallback prevents a failed native/WebView confirmation from leaking a
    # test shell; PTYs have already been asked to exit by the probes above.
    Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
    return $false
}

function Get-WindowRect {
    param([int]$WindowHandle)

    $rect = New-Object TerminalGuiNative+RECT
    if (-not [TerminalGuiNative]::GetWindowRect([IntPtr]$WindowHandle, [ref]$rect)) {
        return $null
    }
    return [pscustomobject]@{
        Width  = $rect.Right - $rect.Left
        Height = $rect.Bottom - $rect.Top
    }
}

$application = Start-Process -FilePath $ExecutablePath -ArgumentList $browserArguments -PassThru -WindowStyle Normal
$ready = $null
$result = [ordered]@{
    InputRoundTripMs       = $null
    InputExitedTab         = $null
    OutputLines            = $OutputLines
    OutputPayloadLength    = $OutputPayloadLength
    ApproxOutputBytes      = $OutputLines * ($OutputPayloadLength + 2)
    OutputElapsedMs        = $null
    OutputMiBPerSecond     = $null
    OutputWorkingSetMiB     = $null
    ResizeIterations       = $ResizeIterations
    SplitAdditionalPanes   = $SplitAdditionalPanes
    SplitCanvasAttachments = $null
    SplitInputAttachments  = $null
    ResizeElapsedMs        = $null
    FinalWindowWidth       = $null
    FinalWindowHeight      = $null
    CanvasAttachments      = $null
    InputAttachments       = $null
    CleanExit              = $false
}

try {
    $ready = Wait-ForUi -ProcessId $application.Id
    if (-not (Invoke-UiButton -Root $ready.Root -NameLike "新建终端")) {
        throw "The new-terminal button was unavailable"
    }
    Start-Sleep -Seconds 3

    $inputStart = [System.Diagnostics.Stopwatch]::StartNew()
    Send-TerminalText -Root (Get-UiRoot -WindowHandle $ready.Handle) -Text "exit"
    $inputTab = Wait-ForExitedTab -WindowHandle $ready.Handle -Deadline ([datetime]::UtcNow.AddSeconds(15))
    $inputStart.Stop()
    if ($null -eq $inputTab) {
        throw "The semantic input probe did not produce an exited terminal tab"
    }
    $result.InputRoundTripMs = [math]::Round($inputStart.Elapsed.TotalMilliseconds, 1)
    $result.InputExitedTab = $inputTab

    if (-not (Invoke-UiButton -Root (Get-UiRoot -WindowHandle $ready.Handle) -NameLike "新建终端")) {
        throw "The new-terminal button was unavailable after the input probe"
    }
    Start-Sleep -Seconds 3

    $outputCommand = "[Console]::Out.Write(-join ((('x' * $OutputPayloadLength) + [Environment]::NewLine) * $OutputLines)); exit"
    $outputStart = [System.Diagnostics.Stopwatch]::StartNew()
    Send-TerminalText -Root (Get-UiRoot -WindowHandle $ready.Handle) -Text $outputCommand
    $outputTab = Wait-ForExitedTab -WindowHandle $ready.Handle -Deadline ([datetime]::UtcNow.AddSeconds($TimeoutSeconds))
    $outputStart.Stop()
    if ($null -eq $outputTab) {
        throw "The large-output probe did not exit within $TimeoutSeconds seconds"
    }
    $result.OutputElapsedMs = [math]::Round($outputStart.Elapsed.TotalMilliseconds, 1)
    $result.OutputMiBPerSecond = [math]::Round(
        (($result.ApproxOutputBytes / 1MB) / [math]::Max($outputStart.Elapsed.TotalSeconds, 0.001)),
        3
    )
    $afterOutput = Get-ProcessMetrics -RootProcessId $application.Id
    $afterMemory = ($afterOutput.Rows | Measure-Object -Property Memory -Sum).Sum
    $result.OutputWorkingSetMiB = [math]::Round($afterMemory / 1MB, 1)

    # Start a fresh live session before the resize probe. This both exercises
    # resize against an active PTY/model and gives the application quit flow a
    # running session to close explicitly during cleanup.
    if (-not (Invoke-UiButton -Root (Get-UiRoot -WindowHandle $ready.Handle) -NameLike "新建终端")) {
        throw "The new-terminal button was unavailable before the resize probe"
    }
    Start-Sleep -Seconds 3

    $splitRenderer = Get-RendererAttachment -Root (Get-UiRoot -WindowHandle $ready.Handle)
    for ($splitIndex = 0; $splitIndex -lt $SplitAdditionalPanes; $splitIndex++) {
        $splitInput = Find-UiElement `
            -Root (Get-UiRoot -WindowHandle $ready.Handle) `
            -NameLike "Terminal input" `
            -ControlType "Edit"
        if ($null -eq $splitInput) {
            throw "Terminal input was not exposed before split $($splitIndex + 1)"
        }
        $splitInput.SetFocus()
        # Ctrl+Shift+\ is the product shortcut for a side-by-side split.
        [System.Windows.Forms.SendKeys]::SendWait("^+\")
        $targetCanvasCount = $splitIndex + 2
        $splitDeadline = [datetime]::UtcNow.AddSeconds(15)
        do {
            Start-Sleep -Milliseconds 150
            $splitRenderer = Get-RendererAttachment -Root (Get-UiRoot -WindowHandle $ready.Handle)
        } while (
            $splitRenderer.Canvas -lt $targetCanvasCount -and
            [datetime]::UtcNow -lt $splitDeadline
        )
        if ($splitRenderer.Canvas -lt $targetCanvasCount) {
            throw "Side-by-side split did not expose $targetCanvasCount canvas attachments"
        }
    }
    $result.SplitCanvasAttachments = $splitRenderer.Canvas
    $result.SplitInputAttachments = $splitRenderer.Input

    [void][TerminalGuiNative]::ShowWindow([IntPtr]$ready.Handle, 9)
    $resizeStart = [System.Diagnostics.Stopwatch]::StartNew()
    for ($index = 0; $index -lt $ResizeIterations; $index++) {
        $width = if (($index % 2) -eq 0) { 1180 } else { 1360 }
        $height = if (($index % 2) -eq 0) { 720 } else { 860 }
        if (-not [TerminalGuiNative]::SetWindowPos(
                [IntPtr]$ready.Handle,
                [IntPtr]::Zero,
                0,
                0,
                $width,
                $height,
                0x0002 -bor 0x0004 -bor 0x0010
            )) {
            throw "SetWindowPos failed at iteration $($index + 1)"
        }
    }
    $resizeStart.Stop()
    Start-Sleep -Seconds 2
    $rect = Get-WindowRect -WindowHandle $ready.Handle
    $renderer = Get-RendererAttachment -Root (Get-UiRoot -WindowHandle $ready.Handle)
    $result.ResizeElapsedMs = [math]::Round($resizeStart.Elapsed.TotalMilliseconds, 1)
    $result.FinalWindowWidth = $rect.Width
    $result.FinalWindowHeight = $rect.Height
    $result.CanvasAttachments = $renderer.Canvas
    $result.InputAttachments = $renderer.Input
}
finally {
    if ($null -ne $ready) {
        $result.CleanExit = Invoke-ApplicationQuit -ProcessId $application.Id -WindowHandle $ready.Handle
    }
    else {
        Stop-Process -Id $application.Id -Force -ErrorAction SilentlyContinue
    }
}

[pscustomobject]$result | Format-List
Write-Output ""
[pscustomobject]$result | ConvertTo-Json -Depth 3
