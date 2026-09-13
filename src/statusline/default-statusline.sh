#!/usr/bin/env bash
# Default status line, embedded in the binary and used when settings.statusLine
# is not configured. Reads the StatusLineCommandInput JSON on stdin.
# Marks use plain ASCII (# % = @ |) so every terminal and font renders them.
# The cwd mark is @ (location, as in user@host:path), not ~: the path itself is
# home-abbreviated to ~/..., so a ~ mark would read as a doubled path prefix.
# Parses the JSON with awk (no jq). Key extraction relies on first-match
# order: context_window precedes rate_limits, so "used_percentage" resolves
# to the context_window field. See src/components/StatusLine.tsx for the
# producer.
set -u

input=$(cat)

# One awk pass emits all fields, separated by 0x1F. Order is fixed; the
# trailing guard absorbs empty tail fields so `read` cannot misalign them.
parsed=$(printf '%s' "$input" | awk '
BEGIN { RS = "\037END" }
{
  j = $0
  model = "?"
  cwd = "~"
  if (match(j, /"model":\{"id":"[^"]*"/)) {
    v = substr(j, RSTART, RLENGTH)
    sub(/^"model":\{"id":"/, "", v); sub(/"$/, "", v)
    if (v != "") model = v
  }
  if (match(j, /"cwd":"[^"]*"/)) {
    v = substr(j, RSTART, RLENGTH)
    sub(/^"cwd":"/, "", v); sub(/"$/, "", v)
    if (v != "") cwd = v
  }
  printf "%s\037%s\037%s\037%s\037%s\037%s\037%s\037%s\037guard\n",
    model, cwd,
    num(j, "used_percentage", ""), num(j, "context_window_size"),
    num(j, "total_input_tokens"), num(j, "total_output_tokens"),
    num(j, "total_cache_read_input_tokens"),
    num(j, "total_cache_creation_input_tokens")
}
function num(s, key, dflt, re, v) {
  re = "\"" key "\":-?[0-9.]+"
  if (match(s, re)) {
    v = substr(s, RSTART, RLENGTH)
    sub(/^"[^"]*":/, "", v)
    return v
  }
  return dflt
}
END { if (NR == 0) printf "?\037~\0370\0370\0370\0370\0370\0370\037guard\n" }
')

IFS=$'\037' read -r model cwd used ctx_size tot_in tot_out cache_rd cache_wr _guard <<EOF
$parsed
EOF

# Abbreviate cwd: replace $HOME with ~
cwd="${cwd/#$HOME/\~}"

# 1500000 -> 1.5M, 24000 -> 24k, 850 -> 850
fmt_num() {
  local n=${1:-0}
  if awk "BEGIN { exit !($n >= 1000000) }"; then
    awk "BEGIN { v = $n / 1000000; if (v == int(v)) printf \"%dM\", v; else printf \"%.1fM\", v }"
  elif awk "BEGIN { exit !($n >= 1000) }"; then
    awk "BEGIN { v = $n / 1000; if (v == int(v)) printf \"%dk\", v; else printf \"%.1fk\", v }"
  else
    awk "BEGIN { printf \"%.0f\", $n }"
  fi
}

ctx_size_fmt=$(fmt_num "$ctx_size")
in_fmt=$(fmt_num "$tot_in")
out_fmt=$(fmt_num "$tot_out")
cache_rd_fmt=$(fmt_num "$cache_rd")
cache_wr_fmt=$(fmt_num "$cache_wr")

denom=$(awk "BEGIN { printf \"%.0f\", $tot_in + $cache_rd + $cache_wr }")
if [ "$denom" = "0" ]; then
  ce_pct=0
else
  ce_pct=$(awk "BEGIN { printf \"%.0f\", ($cache_rd / ($tot_in + $cache_rd + $cache_wr)) * 100 }")
fi

if [ -n "$used" ]; then
  ctx_used_fmt=$(awk "BEGIN { printf \"%.0f\", $ctx_size * $used / 100 }")
  ctx_used_fmt=$(fmt_num "$ctx_used_fmt")
  used_pct=$(awk "BEGIN { printf \"%.0f\", $used }")
  ctx_part="${ctx_used_fmt}/${ctx_size_fmt} (${used_pct}%)"
else
  # No usage data (fresh session, post-compact): show an explicit zero rather
  # than a bare size. 0.0k is literal — fmt_num would print "0".
  ctx_part="0.0k/${ctx_size_fmt} (0%)"
fi

tok_part="${in_fmt} in ${out_fmt} out ${cache_rd_fmt} cr ${cache_wr_fmt} cw ${ce_pct}% ce"

C_RESET='\033[0m'
C_SEP='\033[90m'
C_TEXT='\033[2m'
C_MODEL='\033[36m'
C_CTX='\033[35m'
C_TOK='\033[33m'
C_CWD='\033[34m'
sep=" ${C_SEP}|${C_RESET} "

# Icons carry the color at full intensity; segment text is dimmed (the sep's
# color escape ends the dim, so it never leaks onto the next icon).
printf "${C_MODEL}#${C_RESET}${C_TEXT} %s${sep}${C_CTX}%%${C_RESET}${C_TEXT} %s${sep}${C_TOK}=${C_RESET}${C_TEXT} %s${sep}${C_CWD}@${C_RESET}${C_TEXT} %s${C_RESET}" \
  "$model" "$ctx_part" "$tok_part" "$cwd"
