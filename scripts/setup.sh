#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

check_command() {
    if ! command -v "$1" >/dev/null 2>&1; then
        echo "ERROR: $1 is required but not installed."
        exit 1
    fi
}

check_command node
check_command npm
check_command ffmpeg

cd "$PROJECT_DIR"
npm install

if [ ! -f "$PROJECT_DIR/voiceops.config.json" ]; then
    cp "$PROJECT_DIR/voiceops.config.example.json" "$PROJECT_DIR/voiceops.config.json"
    echo "Created voiceops.config.json from example. Fill in local values before runtime use."
fi

npm test
