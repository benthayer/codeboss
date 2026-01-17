#!/bin/bash
# codeboss - Amend current commit with vanity hash
#
# Usage: codeboss '<template>'
# Example: codeboss '{fix|Fix}: {typo|spelling} in README'
#
# Workflow:
#   1. Make your commit normally
#   2. Run: codeboss '<template>'
#   3. Your commit is amended with vanity hash c0deb055...

set -euo pipefail

INSTANCE="sha1-bench-224"
ZONE="us-central1-a"
TARGET="c0deb055"

# =============================================================================
# Main
# =============================================================================

main() {
    local template="$1"
    
    print_job_info "$template"
    ensure_instance_running
    
    local message
    message=$(mine_vanity_message "$template") || exit $?
    
    amend_commit "$message"
    verify_vanity_hash
}

# =============================================================================
# Commit Metadata
# =============================================================================

get_tree()        { git rev-parse HEAD^{tree}; }
get_parent()      { git rev-parse HEAD^; }
get_author_name() { git log -1 --format='%an'; }
get_author_email(){ git log -1 --format='%ae'; }
get_timestamp()   { git log -1 --format='%at'; }
get_timezone()    { git log -1 --format='%ai' | awk '{print $3}'; }
get_author()      { echo "$(get_author_name) <$(get_author_email)>"; }

# =============================================================================
# Instance Management
# =============================================================================

get_instance_status() {
    gcloud compute instances describe "$INSTANCE" --zone="$ZONE" \
        --format='get(status)' 2>/dev/null || echo "NOT_FOUND"
}

resume_instance() {
    echo "🔄 Resuming instance..."
    gcloud compute instances resume "$INSTANCE" --zone="$ZONE" --quiet
    echo "⏳ Waiting for SSH..."
    sleep 15
}

ensure_instance_running() {
    local status=$(get_instance_status)
    
    case "$status" in
        RUNNING)   return ;;
        SUSPENDED) resume_instance ;;
        *)         echo "❌ Instance not available (status: $status)"; exit 1 ;;
    esac
}

# =============================================================================
# Mining
# =============================================================================

mine_vanity_message() {
    local template="$1"
    
    echo "⛏️  Mining..." >&2
    echo >&2
    
    local output=$(run_remote_miner "$template")
    
    validate_miner_output "$output"
    extract_message "$output"
}

run_remote_miner() {
    local template="$1"
    local tree=$(get_tree)
    local parent=$(get_parent)
    local author=$(get_author)
    local timestamp=$(get_timestamp)
    local timezone=$(get_timezone)
    
    gcloud compute ssh "$INSTANCE" --zone="$ZONE" \
        --command="./run-codeboss '$template' '$tree' '$parent' '$author' '$timestamp' '$timezone' '$TARGET'" 2>&1
}

validate_miner_output() {
    local output="$1"
    
    if echo "$output" | grep -q "not enough entropy"; then
        echo "$output" >&2
        exit 2
    fi
    
    if ! echo "$output" | grep -q "^Found in"; then
        echo "$output" >&2
        echo "❌ Mining failed" >&2
        exit 1
    fi
}

extract_message() {
    local output="$1"
    local message=$(echo "$output" | tail -1)
    
    if [[ -z "$message" ]]; then
        echo "❌ No message returned" >&2
        exit 1
    fi
    
    echo "$message"
}

# =============================================================================
# Git Operations
# =============================================================================

amend_commit() {
    local message="$1"
    local timestamp=$(get_timestamp)
    local timezone=$(get_timezone)
    
    echo
    echo "📝 Amending commit..."
    
    GIT_AUTHOR_DATE="$timestamp $timezone" \
    GIT_COMMITTER_DATE="$timestamp $timezone" \
    git commit --amend -m "$message"
}

verify_vanity_hash() {
    local new_hash=$(git rev-parse HEAD)
    
    echo
    echo "✅ Done!"
    echo "   Hash: $new_hash"
    
    if [[ "$new_hash" == "$TARGET"* ]]; then
        echo "   🎉 Vanity hash achieved!"
    else
        echo "   ⚠️  Hash doesn't match target (check timestamps)"
    fi
}

# =============================================================================
# CLI
# =============================================================================

print_job_info() {
    local template="$1"
    
    echo "🎯 Target: $TARGET"
    echo "📝 Template: $template"
    echo "🌳 Tree: $(get_tree)"
    echo "👆 Parent: $(get_parent)"
    echo "👤 Author: $(get_author)"
    echo "⏰ Time: $(get_timestamp) $(get_timezone)"
    echo
}

validate_args() {
    if [[ $# -lt 1 ]]; then
        echo "Usage: codeboss '<template>'"
        echo "Example: codeboss '{fix|Fix}: {typo|spelling} in README'"
        exit 1
    fi
}

# =============================================================================
# Entry
# =============================================================================

validate_args "$@"
main "$@"
