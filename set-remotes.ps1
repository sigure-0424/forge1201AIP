<#
set-remotes.ps1
Place at the root of a git repository. Manages the "origin" remote (code)
and the LFS destination (large files) independently, per the split-remote
pattern used in this repo. Run with no arguments for an interactive menu,
or pass -Action directly for scripted use.

Examples:
  .\set-remotes.ps1 -Action view
  .\set-remotes.ps1 -Action set-origin -OriginUrl "git@github.com:user/repo.git"
  .\set-remotes.ps1 -Action set-lfs -LfsHost "huggingface.co" -LfsNamespace "user" -LfsRepo "repo" -LfsType model -LfsUsername "user" -TokenEnvVar "HF_TOKEN"
#>

param(
    [ValidateSet("view","set-origin","set-lfs","remove-lfs","verify")]
    [string]$Action,

    [string]$OriginUrl,

    [string]$LfsHost,
    [string]$LfsNamespace,
    [string]$LfsRepo,
    [ValidateSet("model","dataset","space")]
    [string]$LfsType = "model",
    [string]$LfsUsername,
    [string]$TokenEnvVar = "HF_TOKEN"
)

function Show-Current {
    Write-Host "`n--- origin ---" -ForegroundColor Cyan
    git remote get-url origin 2>$null
    if ($LASTEXITCODE -ne 0) { Write-Host "(no origin set)" }

    Write-Host "`n--- lfs.url ---" -ForegroundColor Cyan
    $lfsUrl = git config --local --get lfs.url 2>$null
    if ($lfsUrl) { Write-Host $lfsUrl } else { Write-Host "(none set -- LFS will follow origin by default)" }

    Write-Host "`n--- credential.helper (global) ---" -ForegroundColor Cyan
    git config --global --get credential.helper 2>$null
}

function Set-Origin {
    param([string]$Url)
    if (-not $Url) { $Url = Read-Host "Enter the new origin URL (e.g. git@github.com:user/repo.git)" }
    $exists = git remote get-url origin 2>$null
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

    $credInput = @"
protocol=https
host=$RHost
path=$repoPath.git
username=$Username
password=$token

"@
    $credInput | git credential approve
    Write-Host "Credential injected for $RHost / $repoPath." -ForegroundColor Green
}

function Remove-Lfs {
    git config --local --unset lfs.url 2>$null
    Write-Host "lfs.url removed -- LFS objects will now follow the origin remote by default." -ForegroundColor Green
}

function Test-Remotes {
    Write-Host "`n--- Testing origin ---" -ForegroundColor Cyan
    $originUrl = git remote get-url origin 2>$null
    if ($originUrl) {
        git ls-remote $originUrl *> $null
        if ($LASTEXITCODE -eq 0) { Write-Host "OK: origin reachable ($originUrl)" -ForegroundColor Green }
        else { Write-Host "FAIL: origin not reachable ($originUrl)" -ForegroundColor Red }
    } else {
        Write-Host "(no origin set)"
    }

    Write-Host "`n--- Testing LFS endpoint ---" -ForegroundColor Cyan
    $lfsUrl = git config --local --get lfs.url 2>$null
    if ($lfsUrl) {
        git lfs env | Select-String -Pattern "Endpoint"
        $repoUrl = $lfsUrl -replace "/info/lfs$", ""
        git ls-remote $repoUrl *> $null
        if ($LASTEXITCODE -eq 0) { Write-Host "OK: LFS host reachable ($repoUrl)" -ForegroundColor Green }
        else { Write-Host "FAIL: LFS host not reachable -- check credentials with set-lfs again" -ForegroundColor Red }
    } else {
        Write-Host "(no lfs.url set -- LFS follows origin)"
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
    Write-Host "  5) Just show current config (already shown above)"
    $choice = Read-Host "Enter 1-5"
    switch ($choice) {
        "1" { Set-Origin }
        "2" { Set-Lfs }
        "3" { Remove-Lfs }
        "4" { Test-Remotes }
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
}
