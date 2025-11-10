# Markdown Extended for Sublime Text - Installation Script
# PowerShell script for Windows

param(
    [switch]$Uninstall,
    [switch]$SyntaxOnly,
    [switch]$ColorSchemeOnly
)

# Determine Sublime Text packages directory
$sublimePackagesPath = ""

# Check common Sublime Text installation locations
$possiblePaths = @(
    "$env:APPDATA\Sublime Text\Packages\User",
    "$env:APPDATA\Sublime Text 3\Packages\User",
    "$env:APPDATA\Sublime Text 4\Packages\User",
    "C:\Private\Software\Sublime\Packages\User"
)

foreach ($path in $possiblePaths) {
    if (Test-Path $path) {
        $sublimePackagesPath = $path
        Write-Host "✓ Found Sublime Text packages directory: $path" -ForegroundColor Green
        break
    }
}

if (-not $sublimePackagesPath) {
    Write-Host "✗ Error: Could not find Sublime Text packages directory" -ForegroundColor Red
    Write-Host "Please install Sublime Text or manually specify the path" -ForegroundColor Yellow
    exit 1
}

# Get current script directory
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# Define source files
$syntaxFile = Join-Path $scriptDir "Markdown Extended.sublime-syntax"
$colorSchemeFile = Join-Path $scriptDir "Markdown Extended.sublime-color-scheme"
$darkColorSchemeFile = Join-Path $scriptDir "Markdown Extended Dark.sublime-color-scheme"

# Define destination paths
$syntaxDest = Join-Path $sublimePackagesPath "Markdown Extended.sublime-syntax"
$colorSchemeDest = Join-Path $sublimePackagesPath "Markdown Extended.sublime-color-scheme"
$darkColorSchemeDest = Join-Path $sublimePackagesPath "Markdown Extended Dark.sublime-color-scheme"

# Uninstall function
function Uninstall-MarkdownExtended {
    Write-Host "`nUninstalling Markdown Extended..." -ForegroundColor Yellow
    
    if (Test-Path $syntaxDest) {
        Remove-Item $syntaxDest -Force
        Write-Host "✓ Removed syntax file" -ForegroundColor Green
    }
    
    if (Test-Path $colorSchemeDest) {
        Remove-Item $colorSchemeDest -Force
        Write-Host "✓ Removed color scheme file" -ForegroundColor Green
    }
    
    if (Test-Path $darkColorSchemeDest) {
        Remove-Item $darkColorSchemeDest -Force
        Write-Host "✓ Removed dark color scheme file" -ForegroundColor Green
    }
    
    Write-Host "`n✓ Uninstallation complete!" -ForegroundColor Green
}

# Install function
function Install-MarkdownExtended {
    param(
        [bool]$InstallSyntax = $true,
        [bool]$InstallColorScheme = $true
    )
    
    Write-Host "`nInstalling Markdown Extended for Sublime Text..." -ForegroundColor Cyan
    Write-Host "Target directory: $sublimePackagesPath`n" -ForegroundColor Gray
    
    $installed = @()
    $errors = @()
    
    # Install syntax file
    if ($InstallSyntax) {
        if (Test-Path $syntaxFile) {
            try {
                Copy-Item $syntaxFile $syntaxDest -Force -ErrorAction Stop
                Write-Host "✓ Installed syntax file: Markdown Extended.sublime-syntax" -ForegroundColor Green
                $installed += "syntax"
            } catch {
                $errors += "Syntax file: $_"
                Write-Host "✗ Error installing syntax file: $_" -ForegroundColor Red
            }
        } else {
            $errors += "Syntax file not found"
            Write-Host "✗ Error: Syntax file not found at $syntaxFile" -ForegroundColor Red
        }
    }
    
    # Install color scheme files
    if ($InstallColorScheme) {
        if (Test-Path $colorSchemeFile) {
            try {
                Copy-Item $colorSchemeFile $colorSchemeDest -Force -ErrorAction Stop
                Write-Host "✓ Installed color scheme: Markdown Extended.sublime-color-scheme" -ForegroundColor Green
                $installed += "color scheme"
            } catch {
                $errors += "Color scheme file: $_"
                Write-Host "✗ Error installing color scheme: $_" -ForegroundColor Red
            }
        } else {
            $errors += "Color scheme file not found"
            Write-Host "✗ Error: Color scheme file not found at $colorSchemeFile" -ForegroundColor Red
        }
        
        if (Test-Path $darkColorSchemeFile) {
            try {
                Copy-Item $darkColorSchemeFile $darkColorSchemeDest -Force -ErrorAction Stop
                Write-Host "✓ Installed dark color scheme: Markdown Extended Dark.sublime-color-scheme" -ForegroundColor Green
            } catch {
                $errors += "Dark color scheme file: $_"
                Write-Host "✗ Error installing dark color scheme: $_" -ForegroundColor Red
            }
        }
    }
    
    # Display results
    if ($installed.Count -gt 0) {
        Write-Host "`n╔══════════════════════════════════════════════════════════════╗" -ForegroundColor Green
        Write-Host "║  ✓ Installation Complete!                                   ║" -ForegroundColor Green
        Write-Host "╚══════════════════════════════════════════════════════════════╝" -ForegroundColor Green
        
        Write-Host "`n┌─────────────────────────────────────────────────────────────┐" -ForegroundColor Yellow
        Write-Host "│  CRITICAL: Required Steps (DO NOT SKIP)                    │" -ForegroundColor Yellow
        Write-Host "└─────────────────────────────────────────────────────────────┘" -ForegroundColor Yellow
        Write-Host ""
        Write-Host "  Step 1: RESTART Sublime Text" -ForegroundColor White
        Write-Host "    → Close completely (File → Exit or Alt+F4)" -ForegroundColor DarkGray
        Write-Host "    → Then reopen Sublime Text" -ForegroundColor DarkGray
        Write-Host "    → This is REQUIRED for syntax file to load" -ForegroundColor Red
        Write-Host ""
        Write-Host "  Step 2: OPEN a Markdown file" -ForegroundColor White
        Write-Host "    → Open existing .md file, or" -ForegroundColor DarkGray
        Write-Host "    → Create new file and save as test.md" -ForegroundColor DarkGray
        Write-Host ""
        Write-Host "  Step 3: SELECT 'Markdown Extended' syntax" -ForegroundColor White
        Write-Host "    → Look at BOTTOM-RIGHT corner of Sublime window" -ForegroundColor Cyan
        Write-Host "    → Click on it (may say 'Markdown' or 'Plain Text')" -ForegroundColor DarkGray
        Write-Host "    → Select: 'Markdown Extended' from list" -ForegroundColor DarkGray
        Write-Host "    → To set as default: View → Syntax → Open all with current extension as..." -ForegroundColor DarkGray
        Write-Host ""
        Write-Host "  Step 4: SELECT color scheme" -ForegroundColor White
        Write-Host "    → Preferences → Select Color Scheme..." -ForegroundColor DarkGray
        Write-Host "    → Choose: 'Markdown Extended' (light theme)" -ForegroundColor DarkGray
        Write-Host "    →     or: 'Markdown Extended Dark' (dark theme)" -ForegroundColor DarkGray
        Write-Host ""
        Write-Host "┌─────────────────────────────────────────────────────────────┐" -ForegroundColor Cyan
        Write-Host "│  Testing Your Installation                                 │" -ForegroundColor Cyan
        Write-Host "└─────────────────────────────────────────────────────────────┘" -ForegroundColor Cyan
        Write-Host ""
        Write-Host "  Open TEST.md to verify highlighting works:" -ForegroundColor White
        Write-Host "    • ++ref|note++ should be purple/orange reference" -ForegroundColor DarkGray
        Write-Host "    • ==highlight== should have yellow/gold background" -ForegroundColor DarkGray
        Write-Host "    • @sidebar@ should be purple/pink text" -ForegroundColor DarkGray
        Write-Host "    • `$`math`$` should be green inline" -ForegroundColor DarkGray
        Write-Host ""
        Write-Host "┌─────────────────────────────────────────────────────────────┐" -ForegroundColor Red
        Write-Host "│  ⚠ If Nothing is Highlighted                                │" -ForegroundColor Red
        Write-Host "└─────────────────────────────────────────────────────────────┘" -ForegroundColor Red
        Write-Host ""
        Write-Host "  Most common cause: Syntax not selected" -ForegroundColor Yellow
        Write-Host "    → Check bottom-right corner shows 'Markdown Extended'" -ForegroundColor DarkGray
        Write-Host "    → NOT 'Markdown' or 'Plain Text'" -ForegroundColor DarkGray
        Write-Host ""
        Write-Host "  Second most common: Sublime not restarted" -ForegroundColor Yellow
        Write-Host "    → MUST fully close and reopen Sublime Text" -ForegroundColor DarkGray
        Write-Host ""
        Write-Host "  For detailed help, see: TROUBLESHOOTING.md" -ForegroundColor Cyan
        Write-Host ""
    }
    
    if ($errors.Count -gt 0) {
        Write-Host "┌─────────────────────────────────────────────────────────────┐" -ForegroundColor Red
        Write-Host "│  Errors Occurred                                            │" -ForegroundColor Red
        Write-Host "└─────────────────────────────────────────────────────────────┘" -ForegroundColor Red
        Write-Host ""
        foreach ($error in $errors) {
            Write-Host "  • $error" -ForegroundColor Red
        }
        Write-Host ""
    }
}

# Main execution
Write-Host @"
╔══════════════════════════════════════════════════════════╗
║  Markdown Extended for Sublime Text - Installer         ║
║  Based on VS Code Markdown Extended extension           ║
╚══════════════════════════════════════════════════════════╝
"@ -ForegroundColor Cyan

if ($Uninstall) {
    Uninstall-MarkdownExtended
} elseif ($SyntaxOnly) {
    Install-MarkdownExtended -InstallSyntax $true -InstallColorScheme $false
} elseif ($ColorSchemeOnly) {
    Install-MarkdownExtended -InstallSyntax $false -InstallColorScheme $true
} else {
    Install-MarkdownExtended -InstallSyntax $true -InstallColorScheme $true
}

Write-Host ""
