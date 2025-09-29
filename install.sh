#!/bin/bash
# myAIDE CLI Installation Script
# Usage: curl -fsSL https://raw.githubusercontent.com/ahmedm224/myAIDE_cli/main/install.sh | bash

set -e

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  myAIDE CLI - Multi-Agent Coding Assistant"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Check Node.js version
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed."
    echo "Please install Node.js 18+ from: https://nodejs.org/"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo "❌ Node.js version $NODE_VERSION is too old."
    echo "Please upgrade to Node.js 18+ from: https://nodejs.org/"
    exit 1
fi

echo "✓ Node.js $(node -v) detected"
echo ""

# Check npm
if ! command -v npm &> /dev/null; then
    echo "❌ npm is not installed."
    exit 1
fi

echo "✓ npm $(npm -v) detected"
echo ""

# Install myAIDE CLI
echo "📦 Installing myAIDE CLI globally..."
echo ""

if npm install -g git+https://github.com/ahmedm224/myAIDE_cli.git; then
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  ✨ Installation Complete!"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "Quick Start:"
    echo "  1. Navigate to your project: cd /path/to/your/project"
    echo "  2. Run myAIDE:              myaide"
    echo "  3. Enter your OpenAI API key when prompted"
    echo ""
    echo "For more info: https://github.com/ahmedm224/myAIDE_cli"
    echo ""
else
    echo ""
    echo "❌ Installation failed."
    echo ""
    echo "Try manual installation:"
    echo "  git clone https://github.com/ahmedm224/myAIDE_cli.git"
    echo "  cd myAIDE_cli"
    echo "  npm install && npm run build && npm install -g ."
    echo ""
    exit 1
fi