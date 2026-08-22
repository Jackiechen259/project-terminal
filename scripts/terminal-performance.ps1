[CmdletBinding()]
param(
    [ValidateSet("debug", "release")]
    [string]$Profile = "release",
    [string]$OutputPath
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$manifest = Join-Path $repoRoot "src-tauri/Cargo.toml"

$commit = (& git -C $repoRoot rev-parse --short HEAD).Trim()
$osCaption = [System.Environment]::OSVersion.VersionString
$osBuild = [System.Environment]::OSVersion.Version.Build
$cpuName = $env:PROCESSOR_IDENTIFIER
try {
    $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
    $osCaption = $os.Caption
    $osBuild = $os.BuildNumber
    $cpu = Get-CimInstance Win32_Processor -ErrorAction Stop | Select-Object -First 1
    $cpuName = $cpu.Name
} catch {
    # Managed CI and sandboxed shells may deny WMI. The environment fallback
    # still records a useful OS/build/CPU identifier instead of aborting the
    # benchmark itself.
}

$metadata = @(
    "terminal benchmark"
    "date=$([DateTime]::Now.ToString('o'))"
    "commit=$commit"
    "os=$osCaption build=$osBuild"
    "cpu=$cpuName"
    "profile=$Profile"
    "renderer=rust-engine-frame-serialization"
)

$cargoArgs = @(
    "test",
    "--manifest-path", $manifest
)
if ($Profile -eq "release") {
    $cargoArgs += "--release"
}
$cargoArgs += @(
    "render_frame_benchmark_reports_metrics",
    "--",
    "--ignored",
    "--nocapture"
)

$ErrorActionPreference = "Continue"
$result = & cargo @cargoArgs 2>&1 | Out-String
$exitCode = $LASTEXITCODE
$ErrorActionPreference = "Stop"
$record = ($metadata -join [Environment]::NewLine) + [Environment]::NewLine + $result.TrimEnd()

if ($OutputPath) {
    $record | Tee-Object -FilePath $OutputPath
} else {
    $record
}

if ($exitCode -ne 0) {
    exit $exitCode
}
