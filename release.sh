#!/bin/bash

# Release script for WhatPulse Web Insights browser extension
# Usage: ./release.sh <version> [--force]
# Example: ./release.sh 1.0.0
# Example: ./release.sh 1.0.0 --force  (overwrites existing tag)

set -e  # Exit on any error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Helper functions
error() {
    echo -e "${RED}Error: $1${NC}" >&2
    exit 1
}

success() {
    echo -e "${GREEN}$1${NC}"
}

info() {
    echo -e "${YELLOW}$1${NC}"
}

# Cleanup function to ensure we return to main branch
cleanup() {
    if [ "$CURRENT_BRANCH" != "main" ]; then
        info "Switching back to main branch..."
        git checkout main 2>/dev/null || true
    fi
}

# Set trap to run cleanup on exit
trap cleanup EXIT

# Parse arguments
VERSION=""
FORCE=false

for arg in "$@"; do
    case $arg in
        --force|-f)
            FORCE=true
            ;;
        -*)
            echo "Unknown option: $arg"
            echo "Usage: $0 <version> [--force]"
            exit 1
            ;;
        *)
            if [ -z "$VERSION" ]; then
                VERSION="$arg"
            fi
            ;;
    esac
done

# Check if version argument is provided
if [ -z "$VERSION" ]; then
    echo "Usage: $0 <version> [--force]"
    echo "Example: $0 1.0.0"
    echo "Example: $0 1.0.0 --force  (overwrites existing tag)"
    exit 1
fi

# Validate version format (semver)
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    error "Invalid version format. Please use semantic versioning (e.g., 1.0.0)"
fi

TAG_NAME="v$VERSION"

info "Starting release process for version $VERSION..."

# Check if we're in a git repository
if ! git rev-parse --is-inside-work-tree > /dev/null 2>&1; then
    error "Not in a git repository"
fi

# Get current branch
CURRENT_BRANCH=$(git branch --show-current)
info "Current branch: $CURRENT_BRANCH"

# Check for uncommitted changes
if ! git diff-index --quiet HEAD -- 2>/dev/null; then
    error "You have uncommitted changes. Please commit or stash them first."
fi

# Check if tag already exists
if git tag -l | grep -q "^$TAG_NAME$"; then
    if [ "$FORCE" = true ]; then
        info "Tag $TAG_NAME already exists, will overwrite (--force)"
    else
        error "Tag $TAG_NAME already exists. Use --force to overwrite, or use a different version."
    fi
fi

# Ensure we're on main branch
if [ "$CURRENT_BRANCH" != "main" ]; then
    info "Switching to main branch..."
    git checkout main || error "Failed to switch to main branch"
    CURRENT_BRANCH="main"
fi

# Pull latest changes from main
info "Pulling latest changes from main..."
git pull origin main || error "Failed to pull from main"

# Update version in all manifest files
info "Updating version to $VERSION in manifest files..."

MANIFEST_FILES=(
    "manifest-chrome.json"
    "manifest-firefox.json"
    "manifest-safari.json"
)

for manifest in "${MANIFEST_FILES[@]}"; do
    if [ -f "$manifest" ]; then
        # Use sed to update the version field
        if [[ "$OSTYPE" == "darwin"* ]]; then
            # macOS sed requires different syntax
            sed -i '' "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" "$manifest"
        else
            # Linux sed
            sed -i "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" "$manifest"
        fi
        success "  Updated $manifest"
    else
        error "Manifest file not found: $manifest"
    fi
done

# Also update manifest.json if it exists (for local testing consistency)
if [ -f "manifest.json" ]; then
    if [[ "$OSTYPE" == "darwin"* ]]; then
        sed -i '' "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" "manifest.json"
    else
        sed -i "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" "manifest.json"
    fi
    success "  Updated manifest.json (local testing)"
fi

# Commit the version changes (if any)
info "Committing version changes..."
git add manifest-chrome.json manifest-firefox.json manifest-safari.json
if git diff --cached --quiet; then
    if [ "$FORCE" = true ]; then
        info "  No version changes to commit (same version, --force repackage)"
    else
        error "No version changes detected. Version may already be $VERSION"
    fi
else
    git commit -m "Bump version to $VERSION" || error "Failed to commit version changes"
    success "  Committed version bump"
fi

# Create the tag
info "Creating tag $TAG_NAME..."
if [ "$FORCE" = true ]; then
    git tag -fa "$TAG_NAME" -m "Release $VERSION" || error "Failed to create tag"
    success "  Created tag $TAG_NAME (forced)"
else
    git tag -a "$TAG_NAME" -m "Release $VERSION" || error "Failed to create tag"
    success "  Created tag $TAG_NAME"
fi

# Push to main branch
info "Pushing to main branch..."
git push origin main || error "Failed to push to main"
success "  Pushed to main"

# Push the tag
info "Pushing tag $TAG_NAME..."
if [ "$FORCE" = true ]; then
    git push origin "$TAG_NAME" --force || error "Failed to push tag"
    success "  Pushed tag $TAG_NAME (forced)"
else
    git push origin "$TAG_NAME" || error "Failed to push tag"
    success "  Pushed tag $TAG_NAME"
fi

# Push to release branch (this triggers the GitHub Actions workflow)
info "Pushing to release branch..."
git push origin main:release --force || error "Failed to push to release branch"
success "  Pushed to release branch"

echo ""
success "========================================"
success "Release $VERSION completed successfully!"
success "========================================"
echo ""
info "Next steps:"
echo "  1. Check GitHub Actions for build status"
echo "  2. Download built extensions from R2 storage"
echo "  3. Submit to Chrome Web Store and Firefox Add-ons"
echo ""
info "Release artifacts will be available at:"
echo "  - https://releases-dev.whatpulse.org/browser-extensions/v${VERSION}-chrome-extension.zip"
echo "  - https://releases-dev.whatpulse.org/browser-extensions/v${VERSION}-firefox-extension.zip"
