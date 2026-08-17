# runner.ps1 - interactive front end for web-archiver, for PowerShell.
#
#   .\runner.ps1                        guided prompts, then archive
#   .\runner.ps1 https://example.com --max-pages 50 --depth 2
#                                       skip the prompts, pass flags straight
#                                       through to bin/archive.js
#   .\runner.ps1 --help
#
# Runs in the terminal you start it from. Honours NO_COLOR and drops colour
# when the output is redirected.
#
# No param() block on purpose: it keeps PowerShell from trying to bind
# --max-pages and friends as script parameters, so $args reaches the CLI as-is.

$ErrorActionPreference = 'Stop'

$Root = $PSScriptRoot
$Cli = Join-Path $Root 'bin\archive.js'
$NodeMin = [version]'22.4.0'

# ----------------------------------------------------------------------------
# Presentation
# ----------------------------------------------------------------------------

$UseColor = -not $env:NO_COLOR -and -not [Console]::IsOutputRedirected
if ($UseColor) {
    # [char]27 rather than the `e escape, which only exists in PowerShell 6+.
    # ${e} braces are required: "$e[1m" would parse as an index into $e.
    $e = [char]27
    $C = @{
        B     = "${e}[1m";           D     = "${e}[2m";           R = "${e}[0m"
        Blue  = "${e}[38;5;39m";     Green = "${e}[38;5;42m"
        Amber = "${e}[38;5;214m";    Red   = "${e}[38;5;203m"
        Grey  = "${e}[38;5;245m";    Cyan  = "${e}[38;5;80m"
    }
} else {
    $C = @{}
    'B', 'D', 'R', 'Blue', 'Green', 'Amber', 'Red', 'Grey', 'Cyan' | ForEach-Object { $C[$_] = '' }
}

$Width = 66

function Write-Rule { Write-Host "$($C.Grey)$('─' * $Width)$($C.R)" }
function Write-Ok    ([string]$Text) { Write-Host "  $($C.Green)$([char]0x2713)$($C.R) $Text" }
function Write-Bad   ([string]$Text) { Write-Host "  $($C.Red)$([char]0x2717)$($C.R) $Text" }
function Write-Warn  ([string]$Text) { Write-Host "  $($C.Amber)!$($C.R) $Text" }
function Write-Note  ([string]$Text) { Write-Host "    $($C.Grey)$Text$($C.R)" }

function Write-Section ([string]$Title) {
    Write-Host ''
    Write-Host "$($C.B)$($C.Blue)$Title$($C.R)"
    Write-Rule
}

function Show-Banner {
    Write-Host ''
    $art = @(
        '              _                        _     _'
        ' __ __ ___| |__  ___ __ _ _ _ __| |_ _(_)_ _____ _ _'
        ' \ V  V / -_) ''_ \/ _/ _` | ''_/ _| '' \ \ V / -_) ''_|'
        '  \_/\_/\___|_.__/\__\__,_|_| \__|_||_|_|\_/\___|_|'
    )
    foreach ($line in $art) { Write-Host "$($C.B)$($C.Cyan)$line$($C.R)" }
    Write-Host "$($C.Grey)  crawl a domain -> one standalone HTML file per page$($C.R)"
}

function Stop-WithError ([string]$Message) {
    Write-Host ''
    Write-Host "$($C.Red)$($C.B)$([char]0x2717) $Message$($C.R)"
    Write-Host ''
    exit 1
}

# ----------------------------------------------------------------------------
# Prompts
# ----------------------------------------------------------------------------

# [Console]::ReadLine rather than Read-Host so the script also works when the
# answers are piped in. $null means the input ended - stop instead of looping.
function Read-Answer ([string]$Prompt) {
    Write-Host $Prompt -NoNewline
    $line = [Console]::ReadLine()
    if ($null -eq $line) {
        Write-Host ''
        Stop-WithError 'Input ended before the questions were answered.'
    }
    return $line.Trim()
}

function Read-Text ([string]$Label, [string]$Default = '') {
    $hint = if ($Default) { " $($C.Grey)[$Default]$($C.R)" } else { '' }
    $answer = Read-Answer "  $($C.Cyan)$Label$($C.R)${hint}: "
    if ($answer) { return $answer }
    return $Default
}

function Read-Int ([string]$Label, [int]$Default, [int]$Min = 0) {
    while ($true) {
        $answer = Read-Text $Label "$Default"
        if ($answer -match '^\d+$' -and [int]$answer -ge $Min) { return [int]$answer }
        Write-Bad "whole number >= $Min please, got ""$answer"""
    }
}

function Read-YesNo ([string]$Label, [string]$Default) {
    $hint = if ($Default -eq 'y') { 'Y/n' } else { 'y/N' }
    while ($true) {
        $answer = Read-Answer "  $($C.Cyan)$Label$($C.R) $($C.Grey)[$hint]$($C.R): "
        if (-not $answer) { $answer = $Default }
        switch -Regex ($answer.ToLower()) {
            '^(y|yes)$' { return $true }
            '^(n|no)$'  { return $false }
            default     { Write-Bad 'answer y or n' }
        }
    }
}

function Read-Url {
    while ($true) {
        $answer = Read-Answer "  $($C.Cyan)Start URL$($C.R) $($C.Grey)(the site to archive)$($C.R): "
        $url = $answer -replace '\s', ''
        if (-not $url) { Write-Bad 'a URL is required'; continue }
        if ($url -notmatch '^https?://') { $url = "https://$url" }
        if ($url -match '^https?://[A-Za-z0-9._~-]+(:\d+)?(/.*)?$') { return $url }
        Write-Bad "that does not look like a URL: $answer"
    }
}

# ----------------------------------------------------------------------------
# Preflight
# ----------------------------------------------------------------------------

# Read one KEY=value out of .env without pulling in a parser.
function Get-EnvFileValue ([string]$Key) {
    $envFile = Join-Path $Root '.env'
    if (-not (Test-Path $envFile)) { return '' }
    $match = Select-String -Path $envFile -Pattern "^\s*$Key=(.*)$" -ErrorAction SilentlyContinue |
             Select-Object -Last 1
    if (-not $match) { return '' }
    return $match.Matches[0].Groups[1].Value.Trim().Trim('"').Trim("'")
}

function Test-Preflight {
    Write-Section 'Environment'

    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { Stop-WithError "Node.js not found on PATH. Install Node >= $NodeMin." }

    $nodeVersion = [version]((& node --version).TrimStart('v'))
    if ($nodeVersion -lt $NodeMin) {
        Write-Bad "Node $nodeVersion - too old"
        Write-Note "SingleFile needs the native WebSocket in Node >= $NodeMin"
        Stop-WithError "Upgrade Node to $NodeMin or newer."
    }
    Write-Ok "Node $nodeVersion"

    if (-not (Test-Path $Cli)) {
        Stop-WithError "bin\archive.js not found - keep runner.ps1 in the web-archiver folder."
    }

    if (-not (Test-Path (Join-Path $Root 'node_modules'))) {
        Write-Warn 'dependencies are not installed'
        if (-not (Read-YesNo 'run npm install now?' 'y')) {
            Stop-WithError 'Install them first: npm install'
        }
        & npm install
        if ($LASTEXITCODE -ne 0) { Stop-WithError 'npm install failed.' }
    }
    Write-Ok 'dependencies installed'

    # The capture engine is vendored into this repository - nothing to install.
    $engineDir = $env:CAPTURE_ENGINE_DIR
    if (-not $engineDir) { $engineDir = Get-EnvFileValue 'CAPTURE_ENGINE_DIR' }
    if (-not $engineDir) { $engineDir = Join-Path $Root 'vendor\capture-engine' }

    if (Test-Path (Join-Path $engineDir 'capture-api.mjs')) {
        Write-Ok "capture engine ready ($engineDir)"
    } else {
        Write-Bad "capture engine missing at $engineDir"
        Write-Note 'it ships in vendor/capture-engine; restore it or set CAPTURE_ENGINE_DIR'
        Write-Note 'a dry run still works without it'
    }
}

# ----------------------------------------------------------------------------
# Wizard
# ----------------------------------------------------------------------------

$script:CliArgs = [System.Collections.Generic.List[string]]::new()
$script:Summary = [ordered]@{}
$script:Url = ''
$script:Output = './archive'
$Helper = Join-Path $Root 'tools\resumable.js'

function Add-Arg { foreach ($a in $args) { $script:CliArgs.Add([string]$a) } }

# Same precedence the CLI uses: environment first, then .env, then the default.
function Get-DefaultOutput {
    if ($env:OUTPUT_FOLDER) { return $env:OUTPUT_FOLDER }
    $value = Get-EnvFileValue 'OUTPUT_FOLDER'
    if ($value) { return $value }
    return './archive'
}

# ----------------------------------------------------------------------------
# Start menu
# ----------------------------------------------------------------------------

# Resumable crawls under $Base, as "index url age archived pending" TSV lines.
function Find-Resumable ([string]$Base) {
    $lines = @(& node $Helper list $Base 2>$null)
    if ($LASTEXITCODE -ne 0) { return @() }
    # Always an array: a bare string would break .Count on a single result.
    return @($lines | Where-Object { $_ })
}

function Show-StartMenu ([int]$SavedCount) {
    Write-Section 'Start'
    $saved = if ($SavedCount -eq 0) {
        "$($C.Grey)(none saved)$($C.R)"
    } elseif ($SavedCount -eq 1) {
        "$($C.Grey)(1 saved)$($C.R)"
    } else {
        "$($C.Grey)($SavedCount saved)$($C.R)"
    }
    Write-Host "  $($C.B)1$($C.R)  Start with a new URL"
    Write-Host "  $($C.B)2$($C.R)  Resume a saved crawl        $saved"
    Write-Host ''

    while ($true) {
        $answer = Read-Text 'Choice' '1'
        switch ($answer) {
            '1' { return 'new' }
            '2' { return 'resume' }
            default { Write-Bad 'enter 1 or 2' }
        }
    }
}

# ----------------------------------------------------------------------------
# Resume
# ----------------------------------------------------------------------------

function Invoke-ResumeWizard ([string]$Base) {
    Write-Section 'Resume'

    $crawls = Find-Resumable $Base
    while ($crawls.Count -eq 0) {
        Write-Warn "no saved crawls under $Base"
        Write-Note 'a crawl is saved when it is interrupted, or when it hits --max-pages with URLs left'
        if (-not (Read-YesNo 'Look in a different output folder?' 'n')) { return $false }
        $Base = Read-Text 'Output folder to scan' $Base
        $crawls = Find-Resumable $Base
    }

    foreach ($line in $crawls) {
        $f = $line -split "`t"
        Write-Host "  $($C.B)$($f[0])$($C.R)  $($f[1])"
        Write-Host "     $($C.Grey)saved $($f[2]) - $($f[3]) archived, $($f[4]) pending$($C.R)"
    }
    Write-Host ''

    $index = 1
    if ($crawls.Count -gt 1) {
        while ($true) {
            $index = Read-Int 'Which crawl?' 1 1
            if ($index -le $crawls.Count) { break }
            Write-Bad "pick a number between 1 and $($crawls.Count)"
        }
    }

    # Pull the saved crawl's details, including the settings it ran with.
    $prev = @{}
    foreach ($line in @(& node $Helper show $Base $index)) {
        $split = $line.IndexOf('=')
        if ($split -lt 0) { continue }
        $prev[$line.Substring(0, $split)] = $line.Substring($split + 1)
    }
    if (-not $prev.ContainsKey('url')) { Stop-WithError 'Could not read that crawl''s saved state.' }

    # The URL comes from the state file, never retyped: the archiver only
    # resumes when the start URL matches the saved one exactly.
    $script:Url = $prev['url']
    $script:Output = $prev['base']
    $processed = [int]$prev['processed']
    $prevMax = [int]$prev['maxPages']

    # --max-pages counts the whole crawl, saved progress included, so the old
    # value would archive nothing. Default to the number that clears the queue.
    $pending = [int]$prev['pending']
    $suggested = [Math]::Max($prevMax, $processed + $pending)

    Write-Section 'Scope'
    Write-Host "  $($C.Grey)$processed of $prevMax pages used, $pending URLs still pending.$($C.R)"
    Write-Host "  $($C.Grey)--max-pages is the total for the whole crawl - $suggested covers everything pending.$($C.R)"
    Write-Host ''

    $pages = 0
    while ($true) {
        $pages = Read-Int 'Pages to archive (total)' $suggested 1
        if ($pages -gt $processed) { break }
        Write-Warn "$processed pages of that budget are already used - the crawl would stop immediately"
        if (Read-YesNo 'Use it anyway?' 'n') { break }
    }
    $depth = Read-Int 'Link depth from the seeds' ([int]$prev['maxDepth']) 0

    if ($prev['optionsFound'] -ne '1') {
        Write-Warn 'no previous report found - the settings below fall back to CLI defaults'
    }

    $script:Summary['Resuming'] = "$($script:Url)  $($C.Grey)(saved $($prev['age']), $($prev['pending']) pending)$($C.R)"
    $script:Summary['Pages'] = "$pages  $($C.Grey)($processed already used)$($C.R)"
    $script:Summary['Depth'] = $depth
    $script:Summary['Output'] = $script:Output

    Add-Arg $script:Url '--max-pages' $pages '--depth' $depth '--output' $script:Output '--resume'

    Write-Section 'Advanced'
    Write-Host "  $($C.Grey)the previous run's filters and tuning are kept unless you change them$($C.R)"
    Write-Host ''
    if (Read-YesNo 'Change filters or tuning?' 'n') {
        Invoke-WizardAdvanced -Defaults $prev -IsResume
    } else {
        # Carry the previous scope and tuning flags over verbatim. Dropping the
        # filters here would let a resumed crawl wander into URLs the original
        # run deliberately excluded.
        $carried = @(& node $Helper args $Base $index)
        foreach ($arg in $carried) { if ($arg) { Add-Arg $arg } }
        if ($carried.Count -gt 0) {
            $script:Summary['Carried over'] = ($carried -join ' ')
        }
    }

    return $true
}

function Invoke-Wizard {
    Write-Section 'Target'
    $script:Url = Read-Url
    $script:Summary['URL'] = $script:Url

    Write-Section 'Scope'
    $pages = Read-Int 'Pages to archive' 100 1
    $depth = Read-Int 'Link depth from the seeds (0 = seeds only)' 3 0

    $script:Output = Read-Text 'Output folder' (Get-DefaultOutput)

    $dryRun = Read-YesNo 'Dry run (crawl and report, archive nothing)?' 'n'

    $script:Summary['Pages'] = $pages
    $script:Summary['Depth'] = $depth
    $script:Summary['Output'] = $script:Output
    $script:Summary['Mode'] = if ($dryRun) { 'dry run' } else { 'archive' }

    Add-Arg $script:Url '--max-pages' $pages '--depth' $depth '--output' $script:Output
    if ($dryRun) { Add-Arg '--dry-run' }

    Write-Section 'Linked files'
    Write-Host "  $($C.Grey)PDFs and spreadsheets are linked, not embedded, so archiving a page$($C.R)"
    Write-Host "  $($C.Grey)does not fetch them. Downloaded files land in assets/, and the saved$($C.R)"
    Write-Host "  $($C.Grey)pages are repointed at them so the archive works offline.$($C.R)"
    Write-Host ''
    if (Read-YesNo 'Download linked files (PDFs, spreadsheets, ...)?' 'y') {
        $script:Summary['Files'] = 'documents'
    } else {
        Add-Arg '--no-assets'
        $script:Summary['Files'] = 'none'
    }

    Write-Section 'Advanced'
    Write-Host "  $($C.Grey)filters, tuning, resume - defaults are fine for most sites$($C.R)"
    Write-Host ''
    if (Read-YesNo 'Configure advanced options?' 'n') { Invoke-WizardAdvanced }
}

# $Defaults carries the previous run's settings on a resume, so every prompt
# starts on what that crawl used. Empty for a new crawl.
function Invoke-WizardAdvanced ([hashtable]$Defaults = @{}, [switch]$IsResume) {
    function Prior ([string]$Key, $Fallback) {
        if ($Defaults.ContainsKey($Key) -and "$($Defaults[$Key])" -ne '') { return $Defaults[$Key] }
        return $Fallback
    }

    Write-Host ''
    # Only the first pattern can be offered as a default; say so rather than
    # dropping the others silently.
    foreach ($kind in 'include', 'exclude') {
        $count = [int](Prior "${kind}Count" 0)
        if ($count -gt 1) {
            Write-Warn "the saved crawl had $count $kind patterns - keeping only the one shown below"
        }
    }

    $include = Read-Text 'Only crawl URLs matching (regex, blank = all)' (Prior 'include' '')
    if ($include) { Add-Arg '--include' $include; $script:Summary['Include'] = $include }

    $exclude = Read-Text 'Never crawl URLs matching (regex, blank = none)' (Prior 'exclude' '')
    if ($exclude) { Add-Arg '--exclude' $exclude; $script:Summary['Exclude'] = $exclude }

    $sitemap = Read-Text 'Sitemap: auto, off, or a sitemap URL' (Prior 'sitemap' 'auto')
    switch -Regex ($sitemap.ToLower()) {
        '^(auto|)$'      { }
        '^(off|no|none)$' { Add-Arg '--no-sitemap'; $script:Summary['Sitemap'] = 'disabled' }
        default          { Add-Arg '--sitemap' $sitemap; $script:Summary['Sitemap'] = $sitemap }
    }

    Write-Host ''
    # Blank keeps whatever the top-level "download linked files" answer set.
    $assets = Read-Text 'File types to download (documents/archives/media/code/all/none, blank = keep)' (Prior 'assets' '')
    if ($assets) {
        Add-Arg '--assets' $assets
        $script:Summary['Files'] = $assets
    }
    if ($assets -notmatch '^(none)$') {
        $assetDomains = Read-Text 'Take files from which hosts (same/linked/any)' (Prior 'assetDomains' 'linked')
        if ($assetDomains) { Add-Arg '--asset-domains' $assetDomains }
        $maxAssets = Read-Int 'Maximum files to download' ([int](Prior 'maxAssets' 1000)) 1
        $maxSize   = Read-Int 'Skip files larger than (MB)' ([int](Prior 'maxAssetSize' 100)) 1
        Add-Arg '--max-assets' $maxAssets '--max-asset-size' $maxSize
        if (-not (Read-YesNo 'Repoint saved pages at the downloaded files?' 'y')) {
            Add-Arg '--no-rewrite-links'
        }
    }

    Write-Host ''
    $workers     = Read-Int 'Parallel browser tabs per batch' ([int](Prior 'workers' 4)) 1
    $concurrency = Read-Int 'Parallel discovery fetches' ([int](Prior 'concurrency' 2)) 1
    $delay       = Read-Int 'Delay between requests (ms)' ([int](Prior 'delay' 500)) 0
    $timeout     = Read-Int 'Per-request / per-page timeout (ms)' ([int](Prior 'timeout' 30000)) 1000
    $idle        = Read-Int 'Lazy-image wait per page (ms; raise for image-heavy sites)' ([int](Prior 'idle' 500)) 0
    $wait        = Read-Int 'Settle time after load, before capture (ms; for JS-rendered sites)' ([int](Prior 'wait' 600)) 0
    Add-Arg '--workers' $workers '--concurrency' $concurrency '--delay' $delay `
            '--timeout' $timeout '--deferred-images-idle' $idle '--wait' $wait
    $script:Summary['Tuning'] =
        "$workers tabs, $concurrency fetches, ${delay}ms delay, ${timeout}ms timeout, ${idle}ms lazy-image wait, ${wait}ms settle"

    Write-Host ''
    # Text that fades in on scroll is invisible to a capture that never
    # scrolls, so this is on unless it is explicitly turned off.
    if (-not (Read-YesNo 'Scroll pages before capturing (keeps text that animates in)?' 'y')) {
        Add-Arg '--no-reveal-animations'
        $script:Summary['Reveal'] = 'off'
    } else {
        $revealMs = Read-Int 'Scroll budget per page (ms)' ([int](Prior 'revealScrollMs' 4000)) 0
        Add-Arg '--reveal-scroll-ms' $revealMs
        $script:Summary['Reveal'] = "${revealMs}ms scroll"
    }

    Write-Host ''
    $toggles = [ordered]@{}
    $yn = { param($v) if ("$v" -eq '1' -or "$v" -eq 'yes') { 'y' } else { 'n' } }
    # --resume is already set by the resume flow, so it is not asked there.
    if (-not $IsResume) {
        $toggles['--resume'] = Read-YesNo 'Resume a previous interrupted crawl?' 'n'
    }
    $toggles['--overwrite']      = Read-YesNo 'Overwrite files already in raw-html/ and assets/?' 'n'
    $toggles['--respect-robots'] = Read-YesNo 'Respect robots.txt disallow rules?' (& $yn (Prior 'respectRobots' 0))
    $toggles['--all-domains']    = Read-YesNo 'Follow links to external domains?' (& $yn (Prior 'allDomains' 0))
    $toggles['--verbose']        = Read-YesNo 'Verbose logging?' 'n'
    $on = @()
    foreach ($flag in $toggles.Keys) {
        if ($toggles[$flag]) { Add-Arg $flag; $on += $flag.TrimStart('-') }
    }
    if ($on) { $script:Summary['Flags'] = $on -join ' ' }
}

# ----------------------------------------------------------------------------
# Confirmation
# ----------------------------------------------------------------------------

function Confirm-Run {
    Write-Section 'Ready'
    foreach ($key in $script:Summary.Keys) {
        Write-Host "  $($C.Grey)$($key.PadRight(12))$($C.R) $($script:Summary[$key])"
    }

    # The equivalent one-liner, so this run can be scripted later.
    $quoted = $script:CliArgs | ForEach-Object {
        if ($_ -match '[\s''"|&<>()$]') { "'" + ($_ -replace "'", "''") + "'" } else { $_ }
    }
    Write-Host ''
    Write-Host "  $($C.Grey)command$($C.R) $($C.D)node bin\archive.js $($quoted -join ' ')$($C.R)"
    Write-Host ''

    if (-not (Read-YesNo 'Start?' 'y')) {
        Write-Host ''
        Write-Host "  $($C.Grey)cancelled$($C.R)"
        Write-Host ''
        exit 0
    }
}

# ----------------------------------------------------------------------------
# Run
# ----------------------------------------------------------------------------

function Invoke-Archive {
    Write-Section 'Crawling'
    Write-Host ''

    $started = Get-Date
    & node $Cli @($script:CliArgs)
    $code = $LASTEXITCODE
    $elapsed = (Get-Date) - $started
    $took = if ($elapsed.TotalMinutes -ge 1) {
        '{0}m {1}s' -f [int]$elapsed.TotalMinutes, $elapsed.Seconds
    } else {
        '{0}s' -f [int]$elapsed.TotalSeconds
    }

    Write-Host ''
    Write-Rule
    switch ($code) {
        0 {
            Write-Host "$($C.Green)$($C.B)  $([char]0x2713) Finished$($C.R) $($C.Grey)in $took$($C.R)"
            $host_ = ([uri]$script:Url).Host
            $site = Join-Path $script:Output $host_
            Write-Host "  $($C.Grey)Pages$($C.R)   $site\raw-html\"
            # assets\ only exists when the crawl actually downloaded something.
            if (Test-Path (Join-Path $site 'assets')) {
                Write-Host "  $($C.Grey)Files$($C.R)   $site\assets\"
            }
            Write-Host "  $($C.Grey)Report$($C.R)  $site\report\crawl-report.json"
        }
        2 {
            Write-Host "$($C.Amber)$($C.B)  ! Nothing archived$($C.R) $($C.Grey)every page failed - see the report above$($C.R)"
        }
        130 {
            Write-Host "$($C.Amber)$($C.B)  ! Interrupted$($C.R) $($C.Grey)after $took - state was saved$($C.R)"
            Write-Host "  $($C.Grey)Re-run with the same URL and answer yes to ""Resume"" to continue.$($C.R)"
        }
        default {
            Write-Host "$($C.Red)$($C.B)  $([char]0x2717) Failed$($C.R) $($C.Grey)exit code $code$($C.R)"
        }
    }
    Write-Rule
    Write-Host ''
    exit $code
}

function Show-Usage {
    Show-Banner
    Write-Host ''
    Write-Host "$($C.B)Usage$($C.R)"
    Write-Host '  .\runner.ps1                     guided prompts, then archive'
    Write-Host '  .\runner.ps1 <url> [flags...]    skip the prompts; flags go straight to the CLI'
    Write-Host '  .\runner.ps1 --help              this message'
    Write-Host ''
    Write-Host "$($C.B)Examples$($C.R)"
    Write-Host '  .\runner.ps1'
    Write-Host '  .\runner.ps1 https://example.com --max-pages 50 --depth 2'
    Write-Host '  .\runner.ps1 https://example.com --dry-run'
    Write-Host ''
    Write-Host "Run $($C.D)node bin\archive.js --help$($C.R) for the full flag list."
    Write-Host ''
}

# ----------------------------------------------------------------------------

Push-Location $Root
try {
    if ($args.Count -gt 0) {
        if ($args[0] -in '-h', '--help', '-Help', '/?') { Show-Usage; exit 0 }
        # Pass-through: the caller already knows the flags they want.
        & node $Cli @args
        exit $LASTEXITCODE
    }

    if ([Console]::IsInputRedirected -and -not $env:WEB_ARCHIVER_PIPED_INPUT) {
        Stop-WithError 'No arguments and no terminal to prompt on. Pass flags instead: .\runner.ps1 <url> [flags]'
    }

    Show-Banner
    Test-Preflight

    $base = Get-DefaultOutput
    $choice = Show-StartMenu (Find-Resumable $base).Count
    # Invoke-ResumeWizard returns false when there is nothing to resume, which
    # falls through to the new-URL flow rather than dead-ending.
    if ($choice -eq 'resume' -and (Invoke-ResumeWizard $base)) { } else { Invoke-Wizard }

    Confirm-Run
    Invoke-Archive
} finally {
    Pop-Location
}
