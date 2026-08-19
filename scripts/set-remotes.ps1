<#
set-remotes.ps1
NOTE: run this from a native Windows PowerShell prompt, outside WSL.
It is a standalone, manual utility -- it is not invoked by tk_start_claude.sh,
tk_ensure_docker.sh, or .vscode/sessions.json, and is not part of the
Terminal Keeper / Claude Code startup path.

Place at the root of a git repository. Manages the "origin" remote (code)
and the LFS destination (large files) independently, per the split-remote
pattern used in this repo. Run with no arguments for an interactive menu,
or pass -Action directly for scripted use.

Examples:
  .\set-remotes.ps1 -Action view
  .\set-remotes.ps1 -Action set-origin -OriginUrl "git@github.com:user/repo.git"
  .\set-remotes.ps1 -Action set-lfs -LfsHost "huggingface.co" -LfsNamespace "user" -LfsRepo "repo" -LfsType model -LfsUsername "user" -TokenEnvVar "HF_TOKEN"
  .\set-remotes.ps1 -Action push-lfs -Branch main
  .\set-remotes.ps1 -Action verify
#>

param(
    [ValidateSet("view","set-origin","set-lfs","remove-lfs","verify","push-lfs")]
    [string]$Action,

    [string]$OriginUrl,

    [string]$LfsHost,
    [string]$LfsNamespace,
    [string]$LfsRepo,
    [ValidateSet("model","dataset","space")]
    [string]$LfsType = "model",
    [string]$LfsUsername,
    [string]$TokenEnvVar = "HF_TOKEN",

    # Branch used by push-lfs
    [string]$Branch = "main"
)

function Show-Current {
    Write-Host "`n--- origin ---" -ForegroundColor Cyan
    $originUrl = git remote get-url origin 2>$null
    if ($LASTEXITCODE -eq 0) { Write-Host $originUrl } else { Write-Host "(no origin set)" }

    Write-Host "`n--- lfs.url ---" -ForegroundColor Cyan
    $lfsUrl = git config --local --get lfs.url 2>$null
    if ($lfsUrl) { Write-Host $lfsUrl } else { Write-Host "(none set -- LFS will follow origin by default)" }

    Write-Host "`n--- lfs auth mode ---" -ForegroundColor Cyan
    # auth=none means no credential is being sent; important to surface explicitly
    git lfs env | Select-String -Pattern "Endpoint"

    Write-Host "`n--- credential.helper (global) ---" -ForegroundColor Cyan
    $helper = git config --global --get credential.helper 2>$null
    if ($helper) { Write-Host $helper } else { Write-Host "(none configured globally)" }
}

function Set-Origin {
    param([string]$Url)
    if (-not $Url) { $Url = Read-Host "Enter the new origin URL (e.g. git@github.com:user/repo.git)" }
    git remote get-url origin 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) {
        git remote set-url origin $Url
        Write-Host "origin updated to: $Url" -ForegroundColor Green
    } else {
        git remote add origin $Url
        Write-Host "origin added: $Url" -ForegroundColor Green
    }
}

function Set-Lfs {
    param(
        [string]$RHost, [string]$Namespace, [string]$Repo,
        [string]$Type, [string]$Username, [string]$TokenVar
    )
    if (-not $RHost)      { $RHost      = Read-Host "LFS host (e.g. huggingface.co)" }
    if (-not $Namespace)  { $Namespace  = Read-Host "Namespace / username on that host" }
    if (-not $Repo)       { $Repo       = Read-Host "Repo name on that host" }
    if (-not $Type) {
        $Type = Read-Host "Repo type on that host (model / dataset / space) [default: model]"
        if (-not $Type) { $Type = "model" }
    }
    if (-not $Username)   { $Username   = Read-Host "Username to authenticate as" }

    $typePrefix = switch ($Type) {
        "dataset" { "datasets/" }
        "space"   { "spaces/" }
        default   { "" }
    }
    $repoPath = "$typePrefix$Namespace/$Repo"
    $lfsUrl = "https://$RHost/$repoPath.git/info/lfs"

    git config --local lfs.url "$lfsUrl"
    Write-Host "lfs.url set to: $lfsUrl" -ForegroundColor Green

    $token = [Environment]::GetEnvironmentVariable($TokenVar)
    if (-not $token) {
        Write-Host "WARN: `$env:$TokenVar is not set -- skipping credential injection." -ForegroundColor Yellow
        Write-Host "Set it and re-run with the same -Action set-lfs arguments to inject the credential."
        return
    }

    $globalHelper = git config --global --get credential.helper 2>$null
    if (-not $globalHelper) {
        Write-Host "No credential.helper configured globally -- setting one (manager)." -ForegroundColor Yellow
        git config --global credential.helper manager
    }

    # Store credential WITHOUT a path= line so that Git Credential Manager (GCM)
    # matches on protocol+host alone. GCM ignores path; including it can prevent
    # a match when git-lfs queries credentials later.
    $credInput = @"
protocol=https
host=$RHost
username=$Username
password=$token

"@
    $credInput | git credential approve
    if ($LASTEXITCODE -eq 0) {
        Write-Host "Credential injected for $RHost." -ForegroundColor Green
    } else {
        Write-Host "WARN: git credential approve exited with code $LASTEXITCODE -- credential may not have been stored." -ForegroundColor Yellow
    }
}

function Remove-Lfs {
    git config --local --unset lfs.url 2>$null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "lfs.url removed -- LFS objects will now follow the origin remote by default." -ForegroundColor Green
    } elseif ($LASTEXITCODE -eq 5) {
        # Exit code 5 = key was not set; treat as no-op
        Write-Host "(lfs.url was not set -- nothing to remove.)" -ForegroundColor Yellow
    } else {
        Write-Host "ERROR: git config --unset exited with code $LASTEXITCODE" -ForegroundColor Red
    }
}

function Test-Remotes {
    Write-Host "`n--- Testing origin (git) ---" -ForegroundColor Cyan
    $originUrl = git remote get-url origin 2>$null
    if ($originUrl) {
        git ls-remote $originUrl HEAD 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) { Write-Host "OK: origin reachable ($originUrl)" -ForegroundColor Green }
        else { Write-Host "FAIL: origin not reachable ($originUrl)" -ForegroundColor Red }
    } else {
        Write-Host "(no origin set)"
    }

    Write-Host "`n--- Testing LFS endpoint ---" -ForegroundColor Cyan
    $lfsUrl = git config --local --get lfs.url 2>$null
    if ($lfsUrl) {
        Write-Host "Configured lfs.url: $lfsUrl"
        git lfs env | Select-String -Pattern "Endpoint"

        # Use git lfs push --dry-run to verify auth + connectivity without
        # actually uploading. This is the correct check for an LFS endpoint
        # because lfs.url is not a valid git remote URL (git ls-remote would
        # always fail on it, giving a false negative).
        Write-Host "Running dry-run LFS push to verify connectivity and credentials..."
        git lfs push --dry-run origin $Branch 2>&1
        if ($LASTEXITCODE -eq 0) {
            Write-Host "OK: LFS endpoint reachable and credentials accepted." -ForegroundColor Green
        } else {
            Write-Host "FAIL: LFS push dry-run failed (exit $LASTEXITCODE) -- check credentials with set-lfs again." -ForegroundColor Red
        }
    } else {
        Write-Host "(no lfs.url set -- LFS follows origin)"
    }
}

function Push-Lfs {
    param([string]$Br)
    Write-Host "Pushing LFS objects for branch '$Br' to $(git config --local --get lfs.url 2>$null)..." -ForegroundColor Cyan
    git lfs push origin $Br 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "LFS push completed (exit 0)." -ForegroundColor Green
        Write-Host "(If no upload lines appeared above, all objects were already present on the remote.)"
    } else {
        Write-Host "FAIL: git lfs push exited with code $LASTEXITCODE" -ForegroundColor Red
    }
}

# --- entry point ---
if (-not $Action) {
    Show-Current
    Write-Host "`nWhat do you want to do?"
    Write-Host "  1) Change/add origin"
    Write-Host "  2) Change/add LFS destination"
    Write-Host "  3) Remove LFS override (LFS follows origin again)"
    Write-Host "  4) Verify current setup"
    Write-Host "  5) Push LFS objects"
    Write-Host "  6) Just show current config (already shown above)"
    $choice = Read-Host "Enter 1-6"
    switch ($choice) {
        "1" { Set-Origin }
        "2" { Set-Lfs -RHost $LfsHost -Namespace $LfsNamespace -Repo $LfsRepo -Type $LfsType -Username $LfsUsername -TokenVar $TokenEnvVar }
        "3" { Remove-Lfs }
        "4" { Test-Remotes }
        "5" { Push-Lfs -Br $Branch }
        default { }
    }
    exit 0
}

switch ($Action) {
    "view"        { Show-Current }
    "set-origin"  { Set-Origin -Url $OriginUrl }
    "set-lfs"     { Set-Lfs -RHost $LfsHost -Namespace $LfsNamespace -Repo $LfsRepo -Type $LfsType -Username $LfsUsername -TokenVar $TokenEnvVar }
    "remove-lfs"  { Remove-Lfs }
    "verify"      { Test-Remotes }
    "push-lfs"    { Push-Lfs -Br $Branch }
}
