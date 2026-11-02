#!/bin/sh
# flow-guard.sh — Forge fixed-branch-model commit guard (RFC-1486).
#
# Installed by `flow.install` into hooks/flow-guard.sh and invoked from the
# managed blocks in hooks/pre-commit and hooks/pre-merge-commit:
#
#   # >>> forge flow guard (managed by flow.install) >>>
#   sh "$(git rev-parse --show-toplevel)/hooks/flow-guard.sh" <mode> || exit 1
#   # <<< forge flow guard <<<
#
# POSIX sh only — no node, no pnpm, no bashisms — so it runs in a fresh
# worktree before `pnpm install` and on Windows Git Bash. The guard never
# commits, never writes files and never reads network state.
#
# The branch-name grammar MUST stay byte-identical to FLOW_BRANCH_PATTERN in
# packages/forge/os/flow/branch-name.ts — flow-guard-parity.test.ts compares
# the literal text and the verdicts.

set -eu

refuse() {
  # $1 rule id, $2 message, $3 remedy — stderr, one line per field.
  printf '%s\n' "$1: $2" >&2
  printf 'remedy: %s\n' "$3" >&2
  exit 1
}

# Modes: pre-commit (regular commits), pre-merge-commit (merge commits) and
# pre-push (git passes remote name + URL — the guard ignores its extra
# arguments and stdin). Unknown modes are not ours.
mode="${1:-}"
case "$mode" in
  pre-commit) ;;
  pre-merge-commit) ;;
  pre-push) ;;
  *) exit 0 ;;
esac

# 1. Generated repositories are exempt: forge.generated.yaml at the top
#    level marks a generator-owned repository (extract mirror, deployment
#    repository) — never blocked by this guard.
top=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
[ -f "$top/forge.generated.yaml" ] && exit 0

# 2. FORGE_FLOW_OP — closed vocabulary per mode, only Forge flow commands
#    set it. pre-commit accepts `install` (the adoption commit); the
#    pre-merge-commit vocabulary is empty — no flow operation may create a
#    merge commit directly (back-merges go through a port branch under the
#    gate, RFC-1490); pre-push accepts `push` (flow.push). `backmerge` is
#    retired (RFC-1490) and `push` outside pre-push refuses — both with
#    FLOW-GUARD-04.
op_vocabulary="install"
[ "$mode" = "pre-merge-commit" ] && op_vocabulary="<none>"
[ "$mode" = "pre-push" ] && op_vocabulary="push"
case "${FORGE_FLOW_OP:-}" in
  "")
    [ "$mode" != "pre-push" ] || {
      refuse "FLOW-GUARD-05" \
        "pushes go through flow.push (outbound only by operator command, RFC-1491)." \
        "read the risk digest first — pnpm exec forge flow.digest"
    }
    ;;
  install)
    [ "$mode" = "pre-commit" ] || {
      refuse "FLOW-GUARD-04" \
        "FORGE_FLOW_OP='${FORGE_FLOW_OP}' is not a forge flow operation in mode '$mode' (closed vocabulary: $op_vocabulary; RFC-1486/1490)." \
        "unset FORGE_FLOW_OP — only forge flow commands set it"
    }
    exit 0 ;;
  push)
    [ "$mode" = "pre-push" ] || {
      refuse "FLOW-GUARD-04" \
        "FORGE_FLOW_OP='${FORGE_FLOW_OP}' is not a forge flow operation in mode '$mode' (closed vocabulary: $op_vocabulary; RFC-1486/1490)." \
        "unset FORGE_FLOW_OP — only forge flow commands set it"
    }
    exit 0 ;;
  *)
    refuse "FLOW-GUARD-04" \
      "FORGE_FLOW_OP='${FORGE_FLOW_OP}' is not a forge flow operation in mode '$mode' (closed vocabulary: $op_vocabulary; RFC-1486/1490)." \
      "unset FORGE_FLOW_OP — only forge flow commands set it"
    ;;
esac

# pre-push guards outbound transport only — branch rules below are commit rules.
[ "$mode" = "pre-push" ] && exit 0

# 3./4. Resolve the branch — an empty symbolic ref means detached HEAD.
branch=$(git symbolic-ref --short -q HEAD 2>/dev/null) || branch=""
if [ -z "$branch" ]; then
  gitdir=$(git rev-parse --git-dir 2>/dev/null) || gitdir=""
  if [ -n "$gitdir" ] && {
    [ -d "$gitdir/rebase-merge" ] || [ -d "$gitdir/rebase-apply" ] || [ -f "$gitdir/CHERRY_PICK_HEAD" ]
  }; then
    exit 0
  fi
  refuse "FLOW-GUARD-03" \
    "commits on a detached HEAD outside a rebase or cherry-pick are refused (fixed branch model, RFC-1486)." \
    "work on an auto branch — pnpm exec forge flow.open --kind session --slug <slug>"
fi

# Unborn HEAD: only an unborn develop may carry the repository's first
# commit (flow.install points new repositories at develop).
if ! git rev-parse --verify -q HEAD >/dev/null 2>&1; then
  [ "$branch" = "develop" ] && exit 0
fi

# 5. Protected integration branches receive integrations only.
case "$branch" in
  develop|main)
    refuse "FLOW-GUARD-01" \
      "direct commits on '$branch' are refused (fixed branch model, RFC-1486)." \
      "work on an auto branch — pnpm exec forge flow.open --kind session --slug <slug>"
    ;;
esac

# 6. FI-1 grammar — the literal below is the same text as FLOW_BRANCH_PATTERN
#    in packages/forge/os/flow/branch-name.ts (do not diverge).
flow_branch_pattern='^auto/(task|session|fix)-[0-9]{6}-[0-9]{2}-[a-z0-9]+(-[a-z0-9]+)*$'
if ! printf '%s' "$branch" | grep -Eq "$flow_branch_pattern"; then
  refuse "FLOW-GUARD-02" \
    "branch '$branch' is outside the fixed branch model grammar auto/<kind>-<YYMMDD>-<NN>-<slug> (RFC-1486)." \
    "work on an auto branch — pnpm exec forge flow.open --kind session --slug <slug>"
fi

# The regex cannot express: NN 01–99 (never 00), slug length 3–48, YYMMDD a
# real calendar date. Enforce them exactly as parseFlowBranch does.
tail=${branch#auto/}           # <kind>-<YYMMDD>-<NN>-<slug>
tail=${tail#*-}                # <YYMMDD>-<NN>-<slug>
yymmdd=${tail%%-*}
tail=${tail#*-}                # <NN>-<slug>
nn=${tail%%-*}
slug=${tail#*-}

if [ "$nn" = "00" ]; then
  refuse "FLOW-GUARD-02" \
    "branch '$branch' is outside the fixed branch model grammar auto/<kind>-<YYMMDD>-<NN>-<slug> (RFC-1486)." \
    "work on an auto branch — pnpm exec forge flow.open --kind session --slug <slug>"
fi

slug_len=${#slug}
if [ "$slug_len" -lt 3 ] || [ "$slug_len" -gt 48 ]; then
  refuse "FLOW-GUARD-02" \
    "branch '$branch' is outside the fixed branch model grammar auto/<kind>-<YYMMDD>-<NN>-<slug> (RFC-1486)." \
    "work on an auto branch — pnpm exec forge flow.open --kind session --slug <slug>"
fi

# YYMMDD as a real date. ${var#0} strips one leading zero so the numbers stay
# decimal without non-POSIX base prefixes.
yy=${yymmdd%????}
mdpart=${yymmdd#??}
mm=${mdpart%??}
dd=${mdpart#??}
yy_n=${yy#0}
mm_n=${mm#0}
dd_n=${dd#0}
case "$mm_n" in
  1|3|5|7|8|10|12) dim=31 ;;
  4|6|9|11) dim=30 ;;
  2)
    if [ $((yy_n % 4)) -eq 0 ]; then dim=29; else dim=28; fi
    ;;
  *) dim=0 ;;
esac
if [ "$dim" -eq 0 ] || [ "$dd_n" -lt 1 ] || [ "$dd_n" -gt "$dim" ]; then
  refuse "FLOW-GUARD-02" \
    "branch '$branch' is outside the fixed branch model grammar auto/<kind>-<YYMMDD>-<NN>-<slug> (RFC-1486)." \
    "work on an auto branch — pnpm exec forge flow.open --kind session --slug <slug>"
fi

exit 0
