#!/bin/bash

set -e

# Parse command line arguments
TARGET="${1:-}"  # Optional target parameter (version)

# GitHub repository configuration
GITHUB_REPO="andforce/Openclaude"
DOWNLOAD_DIR="$HOME/.claude/downloads"
INSTALL_DIR="$HOME/.local/bin"

# Validate version if provided
if [[ -n "$TARGET" ]]; then
    if [[ ! "$TARGET" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        echo "Usage: $0 [VERSION]" >&2
        echo "  VERSION format: x.x.x (e.g., 2.1.88)" >&2
        exit 1
    fi
fi

# Check for required dependencies
DOWNLOADER=""
if command -v curl >/dev/null 2>&1; then
    DOWNLOADER="curl"
elif command -v wget >/dev/null 2>&1; then
    DOWNLOADER="wget"
else
    echo "Error: Either curl or wget is required but neither is installed" >&2
    exit 1
fi

# Check if jq is available (optional but preferred)
HAS_JQ=false
if command -v jq >/dev/null 2>&1; then
    HAS_JQ=true
fi

# Download function that works with both curl and wget
download_file() {
    local url="$1"
    local output="$2"

    if [ "$DOWNLOADER" = "curl" ]; then
        if [ -n "$output" ]; then
            curl -fsSL -o "$output" "$url"
        else
            curl -fsSL "$url"
        fi
    elif [ "$DOWNLOADER" = "wget" ]; then
        if [ -n "$output" ]; then
            wget -q -O "$output" "$url"
        else
            wget -q -O - "$url"
        fi
    else
        return 1
    fi
}

# Get latest version from GitHub API
get_latest_version() {
    local api_url="https://api.github.com/repos/$GITHUB_REPO/releases/latest"

    if [ "$HAS_JQ" = true ]; then
        download_file "$api_url" | jq -r '.tag_name'
    else
        download_file "$api_url" | grep '"tag_name":' | head -n1 | sed -E 's/.*"tag_name": "([^"]+)".*/\1/'
    fi
}

# Download manifest.json from release
download_manifest() {
    local version="$1"
    local url="https://github.com/$GITHUB_REPO/releases/download/$version/manifest.json"

    if ! download_file "$url" -; then
        echo "Error: Failed to download manifest.json" >&2
        return 1
    fi
}

# Extract checksum from manifest (bash-only fallback for jq)
get_checksum_from_manifest() {
    local json="$1"
    local platform="$2"

    if [ "$HAS_JQ" = true ]; then
        echo "$json" | jq -r ".platforms[\"$platform\"].checksum // empty"
    else
        # Pure bash JSON extraction
        json=$(echo "$json" | tr -d '\n\r\t' | sed 's/  */ /g')
        if [[ $json =~ \"$platform\"[^}]*\"checksum\"[[:space:]]*:[[:space:]]*\"([a-f0-9]{64})\" ]]; then
            echo "${BASH_REMATCH[1]}"
            return 0
        fi
        return 1
    fi
}

# Detect platform
detect_platform() {
    local os
    local arch

    case "$(uname -s)" in
        Darwin) os="darwin" ;;
        Linux) os="linux" ;;
        MINGW*|MSYS*|CYGWIN*)
            echo "Error: Windows is not supported by this script." >&2
            exit 1
            ;;
        *)
            echo "Error: Unsupported operating system: $(uname -s)" >&2
            exit 1
            ;;
    esac

    case "$(uname -m)" in
        x86_64|amd64) arch="x64" ;;
        arm64|aarch64) arch="arm64" ;;
        *)
            echo "Error: Unsupported architecture: $(uname -m)" >&2
            exit 1
            ;;
    esac

    # Detect Rosetta 2 on macOS
    if [ "$os" = "darwin" ] && [ "$arch" = "x64" ]; then
        if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = "1" ]; then
            arch="arm64"
            echo "Detected Rosetta 2, using native arm64 binary"
        fi
    fi

    # Check for musl on Linux
    if [ "$os" = "linux" ]; then
        if [ -f /lib/libc.musl-x86_64.so.1 ] || [ -f /lib/libc.musl-aarch64.so.1 ] || ldd /bin/ls 2>&1 | grep -q musl; then
            echo "${os}-${arch}-musl"
        else
            echo "${os}-${arch}"
        fi
    else
        echo "${os}-${arch}"
    fi
}

# Main installation flow
main() {
    echo "Claude Code Installer"
    echo "===================="
    echo

    # Create directories
    mkdir -p "$DOWNLOAD_DIR"
    mkdir -p "$INSTALL_DIR"

    # Determine version
    if [ -n "$TARGET" ]; then
        VERSION="$TARGET"
        echo "Installing specified version: $VERSION"
    else
        echo "Fetching latest version..."
        VERSION=$(get_latest_version)
        if [ -z "$VERSION" ] || [ "$VERSION" = "null" ]; then
            echo "Error: Failed to get latest version" >&2
            exit 1
        fi
        echo "Latest version: $VERSION"
    fi

    # Detect platform
    PLATFORM=$(detect_platform)
    echo "Detected platform: $PLATFORM"

    # Download manifest
    echo "Downloading manifest..."
    MANIFEST=$(download_manifest "$VERSION")
    if [ -z "$MANIFEST" ]; then
        echo "Error: Failed to download manifest" >&2
        exit 1
    fi

    # Get checksum
    CHECKSUM=$(get_checksum_from_manifest "$MANIFEST" "$PLATFORM")
    if [ -z "$CHECKSUM" ] || [[ ! "$CHECKSUM" =~ ^[a-f0-9]{64}$ ]]; then
        echo "Error: Platform $PLATFORM not found in manifest or invalid checksum" >&2
        exit 1
    fi

    # Download binary
    BINARY_NAME="claude-${VERSION}-${PLATFORM}"
    DOWNLOAD_URL="https://github.com/${GITHUB_REPO}/releases/download/${VERSION}/${BINARY_NAME}"
    TEMP_PATH="${DOWNLOAD_DIR}/${BINARY_NAME}"

    echo "Downloading ${BINARY_NAME}..."
    if ! download_file "$DOWNLOAD_URL" "$TEMP_PATH"; then
        echo "Error: Download failed" >&2
        rm -f "$TEMP_PATH"
        exit 1
    fi

    # Verify checksum
    echo "Verifying checksum..."
    if [ "$(uname -s)" = "Darwin" ]; then
        ACTUAL=$(shasum -a 256 "$TEMP_PATH" | cut -d' ' -f1)
    else
        ACTUAL=$(sha256sum "$TEMP_PATH" | cut -d' ' -f1)
    fi

    if [ "$ACTUAL" != "$CHECKSUM" ]; then
        echo "Error: Checksum verification failed" >&2
        echo "  Expected: $CHECKSUM" >&2
        echo "  Actual:   $ACTUAL" >&2
        rm -f "$TEMP_PATH"
        exit 1
    fi

    chmod +x "$TEMP_PATH"

    # Install
    INSTALL_PATH="${INSTALL_DIR}/claude"

    echo "Installing to ${INSTALL_PATH}..."
    mv -f "$TEMP_PATH" "$INSTALL_PATH"

    # Setup shell integration
    echo "Setting up shell integration..."

    # Check if install_dir is in PATH
    if [[ ":$PATH:" != *":$INSTALL_DIR:"* ]]; then
        echo
        echo "Warning: $INSTALL_DIR is not in your PATH"
        echo "Add the following to your shell configuration:"
        echo "  export PATH=\"$INSTALL_DIR:\$PATH\""
        echo
    fi

    # Cleanup
    rm -f "$TEMP_PATH"

    echo
    echo "Installation complete!"
    echo
    echo "Claude Code $VERSION has been installed to: $INSTALL_PATH"
    echo
    echo "To get started, run: claude --help"
    echo
}

main "$@"
