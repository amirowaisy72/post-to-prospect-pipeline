# LeadHunter setup helper - runs once per install or update.
#
# Called by the Inno Setup installer after the files are copied
# (post-install, as the installing user - no admin rights), or by hand:
#   powershell -ExecutionPolicy Bypass -File setup-helper.ps1 -AppDir "C:\Users\<you>\AppData\Local\LeadHunter"
#
# What it does, in order:
#   1. Checks the app is not running (ports 8080 / 8001) and asks the
#      user to close it first.
#   2. Applies the app payload from .payload-new with a SHA-256 manifest
#      diff: only added or changed files are copied, files that vanished
#      from the manifest are deleted. User data is never touched.
#   3. Seeds the owner's data on a FRESH install only: the bundled
#      leadhunter.db and public/seed.json are copied only when the
#      target has no copy yet. On update they are never overwritten.
#   4. Installs every runtime component the app needs, skipping each
#      one that is already satisfied: Bun, Python 3.14, the agent venv
#      (pip packages), Playwright Chromium, node_modules.
#   5. OLLAMA IS MANDATORY. The installer installs Ollama and pulls
#      BOTH models (qwen2.5:1.5b and llama3.1:8b). If the Ollama install
#      or either model pull fails, the whole install STOPS with a clear
#      message - it never proceeds without Ollama.
#
# Downloads use the bundled aria2c (multi-connection, segmented,
# resumable) from official CDNs only, and every downloaded installer
# is SHA-256 verified against installer/downloads.json (written by the
# build workflow with version-pinned URLs). Nothing is downloaded twice:
# every component is checked before downloading.
#
# Safe to re-run by hand: every step is a presence check first.

param(
    [Parameter(Mandatory = $true)]
    [string]$AppDir
)

$ErrorActionPreference = "Stop"

$InstallerDir = Join-Path $AppDir "installer"
$PayloadNew = Join-Path $AppDir ".payload-new"
$LogFile = Join-Path $InstallerDir "setup.log"
$Aria2Exe = Join-Path $InstallerDir "aria2c.exe"
$DownloadsJson = Join-Path $InstallerDir "downloads.json"

$RequiredModels = @("qwen2.5:1.5b", "llama3.1:8b")

function Write-Log {
    param([string]$Message)
    $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
    Write-Host $line
    try { Add-Content -Path $LogFile -Value $line -ErrorAction SilentlyContinue } catch { }
}

function Fail {
    param([string]$Message)
    Write-Log "ERROR: $Message"
    Write-Log "See $LogFile for the full trail."
    throw $Message
}

function Get-FileSha256 {
    param([string]$Path)
    return (Get-FileHash -Algorithm SHA256 -Path $Path).Hash.ToLower()
}

function ConvertTo-Hashtable {
    # Windows PowerShell 5.1 has no AsHashtable switch on ConvertFrom-Json
    # (that arrived in PowerShell 6). Convert the PSCustomObject tree by
    # hand so the manifest diff works on every Windows PC.
    param([object]$InputObject)
    if ($InputObject -is [System.Management.Automation.PSCustomObject]) {
        $ht = @{}
        foreach ($prop in $InputObject.PSObject.Properties) {
            $ht[$prop.Name] = ConvertTo-Hashtable $prop.Value
        }
        return $ht
    }
    return $InputObject
}

function Test-PortFree {
    param([int]$Port)
    $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    return ($null -eq $conn)
}

function Get-Downloads {
    if (-not (Test-Path $DownloadsJson)) {
        Fail "downloads.json is missing from $InstallerDir - the installer build is incomplete."
    }
    return (Get-Content $DownloadsJson -Raw | ConvertFrom-Json)
}

function Download-Verified {
    param(
        [string]$Url,
        [string]$Sha256,
        [string]$OutFile,
        [string]$Label
    )
    if (Test-Path $OutFile) {
        if ((Get-FileSha256 $OutFile) -eq $Sha256.ToLower()) {
            Write-Log "$Label already downloaded and verified - reusing it."
            return
        }
        Remove-Item $OutFile -Force
    }
    Write-Log "Downloading $Label ..."
    if (Test-Path $Aria2Exe) {
        # 16 connections, 16 segments, resume on failure.
        & $Aria2Exe --console-log-level=error -c -x16 -s16 -k1M -d (Split-Path $OutFile -Parent) -o (Split-Path $OutFile -Leaf) $Url
        if ($LASTEXITCODE -ne 0) { Fail "Download failed for $Label ($Url)." }
    } else {
        Write-Log "aria2c not found - falling back to a plain download (slower, no resume)."
        Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing
    }
    if (-not (Test-Path $OutFile)) { Fail "Download produced no file for $Label." }
    $actual = Get-FileSha256 $OutFile
    if ($actual -ne $Sha256.ToLower()) {
        Remove-Item $OutFile -Force -ErrorAction SilentlyContinue
        Fail "$Label failed its SHA-256 check - the download may be corrupt. Delete it and run the installer again."
    }
    Write-Log "$Label downloaded and verified."
}

function Find-Bun {
    $found = Get-Command bun -ErrorAction SilentlyContinue
    if ($found) {
        try { & bun --version 2>$null | Out-Null; if ($LASTEXITCODE -eq 0) { return "bun" } } catch { }
    }
    $perUser = Join-Path $env:USERPROFILE ".bun\bin\bun.exe"
    if (Test-Path $perUser) {
        try { & $perUser --version 2>$null | Out-Null; if ($LASTEXITCODE -eq 0) { return $perUser } } catch { }
    }
    return $null
}

function Find-Python314 {
    # Prefer a python.exe that reports 3.14; else ask the py launcher.
    $found = Get-Command python -ErrorAction SilentlyContinue
    if ($found) {
        try {
            $v = & python --version 2>&1
            if ($v -match "Python 3\.14") { return $found.Source }
        } catch { }
    }
    $py = Get-Command py -ErrorAction SilentlyContinue
    if ($py) {
        try {
            $exe = & py -3.14 -c "import sys; print(sys.executable)" 2>$null
            if ($exe -and (Test-Path $exe.Trim())) { return $exe.Trim() }
        } catch { }
    }
    return $null
}

function Refresh-PathFromRegistry {
    $userPath = (Get-ItemProperty -Path "HKCU:\Environment" -Name Path -ErrorAction SilentlyContinue).Path
    if ($userPath) {
        $env:Path = "$userPath;$env:Path"
    }
}

function Find-Ollama {
    $found = Get-Command ollama -ErrorAction SilentlyContinue
    if ($found) {
        try { & ollama --version 2>$null | Out-Null; if ($LASTEXITCODE -eq 0) { return "ollama" } } catch { }
    }
    foreach ($candidate in @(
        (Join-Path $env:LOCALAPPDATA "Programs\Ollama\ollama.exe"),
        (Join-Path $env:ProgramFiles "Ollama\ollama.exe")
    )) {
        if (Test-Path $candidate) {
            try { & $candidate --version 2>$null | Out-Null; if ($LASTEXITCODE -eq 0) { return $candidate } } catch { }
        }
    }
    return $null
}

function Test-OllamaServer {
    param([string]$OllamaExe, [int]$Tries = 24)
    for ($i = 1; $i -le $Tries; $i++) {
        try {
            & $OllamaExe list 2>$null | Out-Null
            if ($LASTEXITCODE -eq 0) { return $true }
        } catch { }
        Start-Sleep -Seconds 5
    }
    return $false
}

function Get-OllamaModels {
    param([string]$OllamaExe)
    $out = & $OllamaExe list 2>$null
    $names = @()
    foreach ($line in $out) {
        $first = ($line -split "\s+")[0]
        if ($first -and $first -ne "NAME") { $names += $first }
    }
    return $names
}

# ---------------------------------------------------------------- main ---

try {
    New-Item -ItemType Directory -Force -Path $InstallerDir | Out-Null
    Write-Log "LeadHunter setup started. App dir: $AppDir"

    if (-not (Test-Path $PayloadNew)) {
        Fail "Payload staging folder is missing ($PayloadNew) - the installer build is incomplete."
    }
    $downloads = Get-Downloads

    # --- 1. The app must not be running while files are replaced. ---
    $prompts = 0
    while ((-not (Test-PortFree 8080)) -or (-not (Test-PortFree 8001))) {
        $prompts++
        if ($prompts -gt 5) {
            Fail "LeadHunter is still running (port 8080 or 8001 is busy). Close both LeadHunter windows and run the installer again."
        }
        Write-Host ""
        Write-Host "LeadHunter is still running - close both LeadHunter windows first,"
        Write-Host "then press Enter here to continue."
        Read-Host | Out-Null
    }

    # --- 2. Manifest diff: copy only added/changed payload files. ---
    Write-Log "Applying the app payload (only changed files are copied)..."
    $newManifestPath = Join-Path $PayloadNew "manifest.json"
    if (-not (Test-Path $newManifestPath)) {
        Fail "manifest.json is missing from the payload - the installer build is incomplete."
    }
    $newManifest = ConvertTo-Hashtable (Get-Content $newManifestPath -Raw | ConvertFrom-Json)
    $newFiles = $newManifest["files"]
    $oldManifestPath = Join-Path $AppDir "manifest.json"
    $oldFiles = @{}
    if (Test-Path $oldManifestPath) {
        try {
            $oldFiles = (ConvertTo-Hashtable (Get-Content $oldManifestPath -Raw | ConvertFrom-Json))["files"]
        } catch { $oldFiles = @{} }
    }
    # Paths the diff must never delete, even if a manifest ever listed them.
    $protected = @("agent\leadhunter.db", "public\seed.json")
    $copied = 0
    $skipped = 0
    foreach ($rel in $newFiles.Keys) {
        $relWin = $rel -replace "/", "\"
        $src = Join-Path $PayloadNew $relWin
        $dst = Join-Path $AppDir $relWin
        if (-not (Test-Path $src)) { Fail "Payload file missing from the installer: $rel" }
        $want = $newFiles[$rel]
        if ((Test-Path $dst) -and ((Get-FileSha256 $dst) -eq $want.ToLower())) {
            $skipped++
            continue
        }
        $parent = Split-Path $dst -Parent
        if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
        Copy-Item $src $dst -Force
        $copied++
    }
    $removed = 0
    foreach ($rel in $oldFiles.Keys) {
        if ($newFiles.ContainsKey($rel)) { continue }
        $relWin = $rel -replace "/", "\"
        if ($protected -contains $relWin) { continue }
        $dst = Join-Path $AppDir $relWin
        if (Test-Path $dst) {
            Remove-Item $dst -Force -ErrorAction SilentlyContinue
            $removed++
        }
    }
    Write-Log "Payload applied: $copied copied, $skipped unchanged, $removed removed."

    # --- 3. Seed the owner's data on a FRESH install only. ---
    $seedDbSrc = Join-Path $PayloadNew "agent\leadhunter.db"
    $seedDbDst = Join-Path $AppDir "agent\leadhunter.db"
    if ((Test-Path $seedDbSrc) -and (-not (Test-Path $seedDbDst))) {
        $parent = Split-Path $seedDbDst -Parent
        if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
        Copy-Item $seedDbSrc $seedDbDst -Force
        Write-Log "Seed database installed (fresh install only)."
    } elseif (Test-Path $seedDbDst) {
        Write-Log "Existing database kept - the seed is never applied over it."
    }
    $seedJsonSrc = Join-Path $PayloadNew "public\seed.json"
    $seedJsonDst = Join-Path $AppDir "public\seed.json"
    if ((Test-Path $seedJsonSrc) -and (-not (Test-Path $seedJsonDst))) {
        $parent = Split-Path $seedJsonDst -Parent
        if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
        Copy-Item $seedJsonSrc $seedJsonDst -Force
        Write-Log "Seed data file installed (fresh install only)."
    } elseif (Test-Path $seedJsonDst) {
        Write-Log "Existing seed file kept - it is never overwritten."
    }

    # Record the new manifest + version, then drop the staging folder.
    Copy-Item $newManifestPath $oldManifestPath -Force
    $versionSrc = Join-Path $PayloadNew "version.json"
    if (Test-Path $versionSrc) { Copy-Item $versionSrc (Join-Path $AppDir "version.json") -Force }
    Remove-Item $PayloadNew -Recurse -Force -ErrorAction SilentlyContinue

    $tempDir = Join-Path $env:TEMP "leadhunter-setup"
    New-Item -ItemType Directory -Force -Path $tempDir | Out-Null

    # --- 4. Bun. ---
    $bun = Find-Bun
    if ($bun) {
        Write-Log "Bun already installed ($bun) - skipped."
    } else {
        $bunZip = Join-Path $tempDir "bun-windows-x64.zip"
        Download-Verified -Url $downloads.bun.url -Sha256 $downloads.bun.sha256 -OutFile $bunZip -Label ("Bun " + $downloads.bun.version)
        $bunTmp = Join-Path $tempDir "bun"
        if (Test-Path $bunTmp) { Remove-Item $bunTmp -Recurse -Force }
        New-Item -ItemType Directory -Force -Path $bunTmp | Out-Null
        Expand-Archive $bunZip $bunTmp -Force
        $bunExe = Get-ChildItem $bunTmp -Recurse -Filter "bun.exe" | Select-Object -First 1 -ExpandProperty FullName
        if (-not $bunExe) { Fail "Bun download did not contain bun.exe." }
        $bunDir = Join-Path $env:USERPROFILE ".bun\bin"
        New-Item -ItemType Directory -Force -Path $bunDir | Out-Null
        Copy-Item $bunExe (Join-Path $bunDir "bun.exe") -Force
        $bun = Find-Bun
        if (-not $bun) { Fail "Bun install finished but bun still does not run." }
        Write-Log "Bun installed ($bun)."
    }
    $bunCmd = $bun

    # --- 5. Python 3.14. ---
    $pythonExe = Find-Python314
    if ($pythonExe) {
        Write-Log "Python 3.14 already installed ($pythonExe) - skipped."
    } else {
        $pyInstaller = Join-Path $tempDir "python-installer.exe"
        Download-Verified -Url $downloads.python.url -Sha256 $downloads.python.sha256 -OutFile $pyInstaller -Label ("Python " + $downloads.python.version)
        Write-Log "Installing Python (per-user, no admin)..."
        $proc = Start-Process -FilePath $pyInstaller -ArgumentList "/quiet", "InstallAllUsers=0", "PrependPath=1", "Include_test=0" -Wait -PassThru
        if ($proc.ExitCode -ne 0) { Fail "Python installer exited with code $($proc.ExitCode)." }
        Refresh-PathFromRegistry
        $pythonExe = Find-Python314
        if (-not $pythonExe) { Fail "Python install finished but Python 3.14 still does not run." }
        Write-Log "Python installed ($pythonExe)."
    }

    # --- 6. Agent venv (pip packages, pinned at build time). ---
    $venvDir = Join-Path $AppDir "agent\.venv"
    $venvPy = Join-Path $venvDir "Scripts\python.exe"
    $pinnedReq = Join-Path $AppDir "agent\requirements-pinned.txt"
    $plainReq = Join-Path $AppDir "agent\requirements.txt"
    $reqFile = if (Test-Path $pinnedReq) { $pinnedReq } else { $plainReq }
    $reqMarker = Join-Path $venvDir "requirements.sha256"
    $reqHash = Get-FileSha256 $reqFile
    $venvOk = $false
    if ((Test-Path $venvPy) -and (Test-Path $reqMarker)) {
        $oldHash = (Get-Content $reqMarker -Raw).Trim().ToLower()
        if ($oldHash -eq $reqHash) { $venvOk = $true }
    }
    if ($venvOk) {
        Write-Log "Agent venv already matches the pinned requirements - skipped."
    } else {
        Write-Log "Setting up the agent venv (this downloads the Python packages)..."
        if (Test-Path $venvDir) { Remove-Item $venvDir -Recurse -Force }
        & $pythonExe -m venv $venvDir
        if ($LASTEXITCODE -ne 0) { Fail "Could not create the agent venv." }
        & $venvPy -m pip install --upgrade pip
        if ($LASTEXITCODE -ne 0) { Fail "pip upgrade failed in the agent venv." }
        & $venvPy -m pip install -r $reqFile
        if ($LASTEXITCODE -ne 0) { Fail "pip install of the agent requirements failed." }
        Set-Content -Path $reqMarker -Value $reqHash
        Write-Log "Agent venv ready."
    }

    # --- 7. Playwright Chromium (full Chromium - the one-time Facebook
    # sign-in opens a visible window, the headless shell is not enough).
    $chromiumRevision = $downloads.chromiumRevision
    $chromiumExe = $null
    if ($chromiumRevision) {
        $chromiumExe = Join-Path $env:LOCALAPPDATA ("ms-playwright\" + $chromiumRevision + "\chrome-win\chrome.exe")
    }
    if ($chromiumExe -and (Test-Path $chromiumExe)) {
        Write-Log "Playwright Chromium already installed ($chromiumRevision) - skipped."
    } else {
        Write-Log "Installing Playwright Chromium (about 300 MB)..."
        & $venvPy -m playwright install chromium
        if ($LASTEXITCODE -ne 0) { Fail "Playwright Chromium install failed." }
        if ($chromiumRevision) {
            $chromiumExe = Join-Path $env:LOCALAPPDATA ("ms-playwright\" + $chromiumRevision + "\chrome-win\chrome.exe")
            if (-not (Test-Path $chromiumExe)) {
                # The installed revision differs from the recorded one -
                # accept any Chromium the install just placed.
                $anyChrome = Get-ChildItem (Join-Path $env:LOCALAPPDATA "ms-playwright") -Recurse -Filter "chrome.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
                if (-not $anyChrome) { Fail "Playwright Chromium install finished but no chrome.exe was found." }
                Write-Log "Chromium installed at $($anyChrome.FullName)."
            } else {
                Write-Log "Chromium installed ($chromiumRevision)."
            }
        }
    }

    # --- 8. node_modules (bun install is incremental on update). ---
    $bunLock = Join-Path $AppDir "bun.lock"
    $lockMarker = Join-Path $AppDir "node_modules\.bun-lock-hash"
    $lockHash = Get-FileSha256 $bunLock
    $nmOk = $false
    if ((Test-Path (Join-Path $AppDir "node_modules")) -and (Test-Path $lockMarker)) {
        $oldLock = (Get-Content $lockMarker -Raw).Trim().ToLower()
        if ($oldLock -eq $lockHash) { $nmOk = $true }
    }
    if ($nmOk) {
        Write-Log "node_modules already matches bun.lock - skipped."
    } else {
        Write-Log "Installing the frontend dependencies (bun install)..."
        Push-Location $AppDir
        try {
            if ($bunCmd -eq "bun") { & bun install --frozen-lockfile }
            else { & $bunCmd install --frozen-lockfile }
            if ($LASTEXITCODE -ne 0) { Fail "bun install failed." }
        } finally { Pop-Location }
        Set-Content -Path $lockMarker -Value $lockHash
        Write-Log "Frontend dependencies installed."
    }

    # --- 9. OLLAMA - MANDATORY. Without it the install MUST NOT proceed. ---
    Write-Log "Checking Ollama (mandatory)..."
    $ollama = Find-Ollama
    if (-not $ollama) {
        $ollamaSetup = Join-Path $tempDir "OllamaSetup.exe"
        Download-Verified -Url $downloads.ollama.url -Sha256 $downloads.ollama.sha256 -OutFile $ollamaSetup -Label ("Ollama " + $downloads.ollama.version)
        Write-Log "Installing Ollama (about 1.6 GB download, per-user)..."
        $proc = Start-Process -FilePath $ollamaSetup -ArgumentList "/S" -Wait -PassThru
        if ($proc.ExitCode -ne 0) { Fail "Ollama installer exited with code $($proc.ExitCode). LeadHunter cannot install without Ollama." }
        Refresh-PathFromRegistry
        Start-Sleep -Seconds 10
        $ollama = Find-Ollama
        if (-not $ollama) {
            Fail "Ollama install finished but the ollama command still does not run. LeadHunter cannot install without Ollama."
        }
        Write-Log "Ollama installed ($ollama)."
    } else {
        Write-Log "Ollama already installed ($ollama) - skipped the installer."
    }
    if (-not (Test-OllamaServer -OllamaExe $ollama -Tries 12)) {
        Write-Log "Ollama server is not answering - starting it in the background..."
        try { Start-Process -FilePath $ollama -ArgumentList "serve" -WindowStyle Hidden -ErrorAction Stop | Out-Null } catch { }
        if (-not (Test-OllamaServer -OllamaExe $ollama -Tries 12)) {
            Fail "Ollama is installed but its server does not answer. Start Ollama once by hand, then run the installer again. LeadHunter cannot install without a working Ollama."
        }
    }
    $installedModels = Get-OllamaModels -OllamaExe $ollama
    foreach ($model in $RequiredModels) {
        if ($installedModels -contains $model) {
            Write-Log "Ollama model $model already present - skipped."
            continue
        }
        Write-Log "Pulling Ollama model $model (this is a large download - please wait)..."
        & $ollama pull $model
        if ($LASTEXITCODE -ne 0) {
            Fail "Could not pull Ollama model $model. LeadHunter cannot install without both models."
        }
        Write-Log "Ollama model $model ready."
    }

    # --- 10. Install record (diagnostics, not user data). ---
    try {
        $state = @{
            version = (Get-Content (Join-Path $AppDir "version.json") -Raw | ConvertFrom-Json).version
            installedAt = (Get-Date).ToString("o")
            bun = (& $bunCmd --version 2>$null)
            python = (& $pythonExe --version 2>&1)
            ollama = (& $ollama --version 2>$null)
            models = $RequiredModels
        }
        $state | ConvertTo-Json | Set-Content (Join-Path $InstallerDir "install-state.json")
        New-Item -Path "HKCU:\Software\LeadHunter" -Force | Out-Null
        Set-ItemProperty -Path "HKCU:\Software\LeadHunter" -Name "InstallDir" -Value $AppDir
        Set-ItemProperty -Path "HKCU:\Software\LeadHunter" -Name "Version" -Value $state.version
    } catch { Write-Log "Install record could not be written (non-fatal): $_" }

    Write-Log "LeadHunter setup finished."
    Write-Host ""
    Write-Host "LeadHunter is ready. Double-click Run-LeadHunter.bat (or the desktop icon)."
    Write-Host "First run only: open Configurations and pick Gemini or Ollama, then go to"
    Write-Host "Agent Control and press ""Sign in to Facebook"" and sign in yourself."
    exit 0
} catch {
    Write-Log "Setup failed: $_"
    Write-Host ""
    Write-Host "LeadHunter setup FAILED: $_"
    Write-Host "Nothing was half-installed into your data - run the installer again once"
    Write-Host "the reason above is fixed. Full trail: $LogFile"
    exit 1
}
