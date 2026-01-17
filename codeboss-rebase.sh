#!/bin/bash
# codeboss-rebase.sh - Make any commit in the chain bossy
#
# Usage: codeboss-rebase.sh <commit> '<template>'
#
# This is an interactive-rebase-like operation:
# 1. Creates a temp worktree at the target commit
# 2. Makes it bossy with codeboss (runs in worktree)
# 3. Replays all commits that were on top
#
# All commits after the target will have new hashes. That's expected.
#
# Prerequisites:
# - Must be on a branch (not detached HEAD)
# - Target commit must be an ancestor of HEAD (or HEAD itself)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# =============================================================================
# Main
# =============================================================================

main() {
    local target_ref="$1"
    local template="$2"
    
    local branch
    branch=$(current_branch) || exit $?
    
    local target_sha
    target_sha=$(resolve_commit "$target_ref") || exit $?
    
    local commits_to_replay
    commits_to_replay=$(get_commits_to_replay "$target_sha")
    
    print_plan "$target_ref" "$target_sha" "$template" "$commits_to_replay"
    
    local new_target_sha
    new_target_sha=$(boss_in_worktree "$target_sha" "$template") || exit $?
    
    replay_and_update_branch "$branch" "$new_target_sha" "$commits_to_replay"
    
    print_done "$commits_to_replay"
}

# =============================================================================
# Validation
# =============================================================================

validate_args() {
    if [[ $# -lt 2 ]]; then
        echo "Usage: codeboss-rebase.sh <commit> '<template>'"
        echo "Example: codeboss-rebase.sh HEAD~ '{fix|Fix}: typo'"
        exit 1
    fi
}

current_branch() {
    git symbolic-ref --short HEAD 2>/dev/null || {
        echo "❌ Must be on a branch (not detached HEAD)" >&2
        exit 1
    }
}

validate_is_ancestor() {
    local target_sha="$1"
    
    if ! git merge-base --is-ancestor "$target_sha" HEAD; then
        echo "❌ Target is not an ancestor of HEAD" >&2
        exit 1
    fi
}

resolve_commit() {
    local ref="$1"
    
    local sha
    sha=$(git rev-parse "$ref" 2>/dev/null) || {
        echo "❌ Cannot resolve commit: $ref" >&2
        exit 1
    }
    
    validate_is_ancestor "$sha"
    echo "$sha"
}

# =============================================================================
# Worktree Operations
# =============================================================================

boss_in_worktree() {
    local target_sha="$1"
    local template="$2"
    
    local worktree
    worktree=$(mktemp -d)
    trap "cleanup_worktree '$worktree'" EXIT
    
    echo "📁 Creating worktree at $worktree" >&2
    git worktree add "$worktree" "$target_sha" --detach --quiet
    
    echo "⛏️  Making target commit bossy..." >&2
    echo >&2
    
    # Run codeboss in the worktree
    (cd "$worktree" && "$SCRIPT_DIR/codeboss.sh" "$template")
    local codeboss_exit=$?
    
    if [[ $codeboss_exit -ne 0 ]]; then
        cleanup_worktree "$worktree"
        trap - EXIT
        return $codeboss_exit
    fi
    
    # Get the new (bossed) commit SHA
    local new_sha
    new_sha=$(git -C "$worktree" rev-parse HEAD)
    
    echo >&2
    echo "📁 Cleaning up worktree" >&2
    cleanup_worktree "$worktree"
    trap - EXIT
    
    echo "$new_sha"
}

cleanup_worktree() {
    local worktree="$1"
    if [[ -d "$worktree" ]]; then
        git worktree remove "$worktree" --force 2>/dev/null || rm -rf "$worktree"
    fi
}

# =============================================================================
# Git Operations
# =============================================================================

get_commits_to_replay() {
    local target_sha="$1"
    
    # Commits after target, in chronological order (oldest first)
    git rev-list --reverse "${target_sha}..HEAD"
}

replay_and_update_branch() {
    local branch="$1"
    local new_base="$2"
    local commits="$3"
    
    if [[ -z "$commits" ]]; then
        # No commits to replay, just update the branch
        echo "🔀 Updating branch to point to bossed commit"
        git checkout --quiet "$new_base"
        git branch -f "$branch" HEAD
        git checkout --quiet "$branch"
        return
    fi
    
    local count
    count=$(echo "$commits" | wc -w)
    echo "🔀 Replaying $count commit(s) on new base..."
    
    # Detach at the new base
    git checkout --quiet --detach "$new_base"
    
    # Cherry-pick each commit
    for commit in $commits; do
        local msg
        msg=$(git log -1 --format='%s' "$commit")
        echo "   cherry-pick: $msg"
        git cherry-pick "$commit" --quiet
    done
    
    # Update the branch to point here
    git branch -f "$branch" HEAD
    git checkout --quiet "$branch"
}

# =============================================================================
# Output
# =============================================================================

print_plan() {
    local target_ref="$1"
    local target_sha="$2"
    local template="$3"
    local commits="$4"
    
    local count=0
    if [[ -n "$commits" ]]; then
        count=$(echo "$commits" | wc -w)
    fi
    
    echo "🎯 Target: $target_ref (${target_sha:0:7})"
    echo "📝 Template: $template"
    echo "🔀 Commits to replay: $count"
    echo
}

print_done() {
    local commits="$1"
    
    echo
    echo "✅ Done!"
    
    if [[ -n "$commits" ]]; then
        local count
        count=$(echo "$commits" | wc -w)
        echo "   $count commit(s) replayed with new hashes"
    fi
    
    echo "   Run codeboss.sh to boss the new HEAD if needed"
}

# =============================================================================
# Entry
# =============================================================================

validate_args "$@"
main "$@"
