#!/bin/sh
# kernel-memory pre-push hook — finance-leak prevention, LAYER (b) of the 4-layer stack (FIN-04).
#
# WHY THIS REPO: kernel-memory/ is its OWN git repo (separate from the project root). Finance data
# only ever lives here, so the hook MUST live here — never in the project-root .git/hooks (Pitfall
# 2). The matching deliberate-abort test (daemon/test/finance-leakguard.test.ts) targets a TEMP
# kernel-memory-style repo, never the project root.
#
# WHAT IT DOES: per the git pre-push protocol, git feeds lines on STDIN:
#     <local ref> <local sha> <remote ref> <remote sha>
# For each ref about to be pushed we compute the commit RANGE and scan the ADDED CONTENT bytes
# being pushed — the `+` lines of the diff ONLY, never git metadata (commit/blob hashes, index
# lines, @@ hunks). Scanning metadata caused false positives: a 40-hex commit sha can contain a
# 12+ digit run by chance and trip the account/card heuristic, intermittently aborting clean
# pushes. Content-only scanning keeps detection exact and the gate trustworthy (a gate that
# randomly blocks clean pushes gets disabled — the worst outcome for a finance guard).
# It ABORTS (exit non-zero) if EITHER:
#   - a finance-shaped PATH appears (anything matching /finance/i), OR
#   - a finance-shaped VALUE appears in the content — a dollar amount ($1,234.56) or an
#     account/card-number-shaped digit run (12+ consecutive digits, or 13-19 with separators) —
#     even in a file whose path is NOT under finance/.
#
# POLICY: bypassing this gate at push time is FORBIDDEN by project policy. This hook only READS
# (it never stages); it contains no skip-verification flag and no blanket add.
#
# IMPLEMENTATION NOTE: all scanning runs WITHOUT pipes into the loop / detector, because a POSIX
# `sh` pipe runs its right-hand side in a SUBSHELL whose variable writes are lost to the parent.
# We accumulate findings in a temp file and read it back; the abort decision is the file's
# non-emptiness, so it survives across the (necessary) command substitutions.

set -eu

ZERO="0000000000000000000000000000000000000000"
# git's canonical empty-tree object — diffing against it yields a brand-new branch's full content
# as pure additions, with NO commit-header metadata (unlike `git log -p`).
EMPTY_TREE="4b825dc642cb6eb9a060e54bf8d69288fbee4904"

# Extract ONLY added content lines from a diff: `+` lines minus the `+++ b/file` header lines.
# This is what makes the value-scan see real content and not commit/blob hashes or hunk headers.
added_content() { grep '^+' | grep -v '^+++' || true; }

# Patterns (grep -E). Kept as named vars so they are auditable.
PATH_RX='finance'
# A dollar amount: $ then digits with optional thousands separators / decimals.
DOLLAR_RX='\$[0-9][0-9,]*(\.[0-9]{2})?'
# An account/card-number-shaped run: 12+ contiguous digits, OR 13-19 digits split by - or space.
ACCT_RX='[0-9]{12,}|([0-9]{4}[ -]){3}[0-9]{1,7}'

FINDINGS="$(mktemp -t kernel-prepush-findings.XXXXXX)"
trap 'rm -f "$FINDINGS"' EXIT

emit() { printf '%s\n' "$*" >&2; }
note() { printf '%s\n' "$*" >> "$FINDINGS"; }

while read -r local_ref local_sha remote_ref remote_sha; do
  # nothing to push for this ref (deletion) — skip.
  [ "$local_sha" = "$ZERO" ] && continue

  if [ "$remote_sha" = "$ZERO" ]; then
    # brand-new remote branch: diff against the empty tree → the full content as additions, with
    # NO commit-header metadata. (git log -p would inject `commit <40hex>` lines whose digit runs
    # false-trip the account/card heuristic.)
    range="new-branch:$local_sha"
    name_only="$(git diff --name-only "$EMPTY_TREE" "$local_sha" 2>/dev/null || true)"
    content="$(git diff --no-color "$EMPTY_TREE" "$local_sha" 2>/dev/null | added_content)"
  else
    range="${remote_sha}..${local_sha}"
    name_only="$(git diff --name-only "$range" 2>/dev/null || true)"
    content="$(git diff --no-color "$range" 2>/dev/null | added_content)"
  fi

  # (1) finance-shaped PATH check (the existential one).
  offending_paths="$(printf '%s\n' "$name_only" | grep -Ei "$PATH_RX" || true)"
  if [ -n "$offending_paths" ]; then
    emit "pre-push ABORT: a finance-pathed file is in the push range ($range)."
    emit "  Offending paths:"
    printf '%s\n' "$offending_paths" | sed 's/^/    /' >&2
    note "path:$range"
  fi

  # (2) finance-shaped VALUE check over the pushed CONTENT bytes (not just filenames).
  if printf '%s' "$content" | grep -Eq "$DOLLAR_RX"; then
    emit "pre-push ABORT: a dollar-amount (finance-shaped value) was found in $range."
    note "dollar:$range"
  fi
  if printf '%s' "$content" | grep -Eq "$ACCT_RX"; then
    emit "pre-push ABORT: an account/card-number-shaped value was found in $range."
    note "acct:$range"
  fi
done

if [ -s "$FINDINGS" ]; then
  emit ""
  emit "REFUSING THE PUSH: finance data must NEVER leave this machine (FIN-04, spec §14)."
  emit "This is the kernel-memory pre-push gate; bypassing it at push time is forbidden by policy."
  exit 1
fi

exit 0
