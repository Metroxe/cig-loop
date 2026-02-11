#!/bin/bash
set -euo pipefail

REPO="Metroxe/cig-loop"
BIN_NAME="cig-loop"

# Detect OS
OS="$(uname -s)"
case "$OS" in
  Darwin) os="darwin" ;;
  Linux)  os="linux" ;;
  *)
    echo "Error: Unsupported operating system: $OS"
    exit 1
    ;;
esac

# Detect architecture
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64)  arch="x64" ;;
  arm64|aarch64) arch="arm64" ;;
  *)
    echo "Error: Unsupported architecture: $ARCH"
    exit 1
    ;;
esac

TARGET="${os}-${arch}"
ASSET_NAME="${BIN_NAME}-${TARGET}"

echo "Detected platform: ${TARGET}"

# Get latest release tag from GitHub API
echo "Fetching latest release..."
RELEASE_JSON="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest")"
TAG="$(echo "$RELEASE_JSON" | grep '"tag_name"' | head -1 | sed 's/.*"tag_name": *"//;s/".*//')"

if [ -z "$TAG" ]; then
  echo "Error: Could not determine the latest release version."
  exit 1
fi

echo "Latest version: ${TAG}"

# Check if already installed
if [ -f "./${BIN_NAME}" ]; then
  echo "Existing installation found. Upgrading to ${TAG}..."
else
  echo "Installing ${BIN_NAME} ${TAG}..."
fi

# Download the binary
DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${TAG}/${ASSET_NAME}"
echo "Downloading from ${DOWNLOAD_URL}..."
curl -f#L -o "./${BIN_NAME}" "$DOWNLOAD_URL"

# Make executable
chmod +x "./${BIN_NAME}"

echo ""
echo "${BIN_NAME} ${TAG} installed successfully to ./${BIN_NAME}"
