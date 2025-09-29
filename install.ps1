# myAIDE CLI Installation Script for Windows PowerShell
# Usage: iwr -useb https://raw.githubusercontent.com/ahmedm224/myAIDE_cli/main/install.ps1 | iex

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Cyan
Write-Host "  myAIDE CLI - Multi-Agent Coding Assistant" -ForegroundColor Cyan
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Cyan
Write-Host ""

# Check Node.js
try {
    $nodeVersion = node -v
    $versionNumber = [int]($nodeVersion -replace 'v(\d+)\..*', '$1')

    if ($versionNumber -lt 18) {
        Write-Host "❌ Node.js version $nodeVersion is too old." -ForegroundColor Red
        Write-Host "Please upgrade to Node.js 18+ from: https://nodejs.org/" -ForegroundColor Yellow
        exit 1
    }

    Write-Host "✓ Node.js $nodeVersion detected" -ForegroundColor Green
} catch {
    Write-Host "❌ Node.js is not installed." -ForegroundColor Red
    Write-Host "Please install Node.js 18+ from: https://nodejs.org/" -ForegroundColor Yellow
    exit 1
}

# Check npm
try {
    $npmVersion = npm -v
    Write-Host "✓ npm $npmVersion detected" -ForegroundColor Green
} catch {
    Write-Host "❌ npm is not installed." -ForegroundColor Red
    exit 1
}

Write-Host ""

# Install myAIDE CLI
Write-Host "📦 Installing myAIDE CLI globally..." -ForegroundColor Cyan
Write-Host ""

try {
    npm install -g git+https://github.com/ahmedm224/myAIDE_cli.git

    Write-Host ""
    Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Green
    Write-Host "  ✨ Installation Complete!" -ForegroundColor Green
    Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Green
    Write-Host ""
    Write-Host "Quick Start:" -ForegroundColor Yellow
    Write-Host "  1. Navigate to your project: cd C:\path\to\your\project"
    Write-Host "  2. Run myAIDE:              myaide"
    Write-Host "  3. Enter your OpenAI API key when prompted"
    Write-Host ""
    Write-Host "For more info: https://github.com/ahmedm224/myAIDE_cli" -ForegroundColor Cyan
    Write-Host ""
} catch {
    Write-Host ""
    Write-Host "❌ Installation failed." -ForegroundColor Red
    Write-Host ""
    Write-Host "Try manual installation:" -ForegroundColor Yellow
    Write-Host "  git clone https://github.com/ahmedm224/myAIDE_cli.git"
    Write-Host "  cd myAIDE_cli"
    Write-Host "  npm install"
    Write-Host "  npm run build"
    Write-Host "  npm install -g ."
    Write-Host ""
    exit 1
}