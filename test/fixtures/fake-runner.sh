#!/bin/sh
mode=claude
[ "$1" = "exec" ] && mode=codex
out=""
previous=""
for argument in "$@"; do
  [ "$previous" = "--output-last-message" ] && out="$argument"
  previous="$argument"
done
if [ "$mode" = "claude" ]; then
  echo '{"type":"system","session_id":"11111111-1111-1111-1111-111111111111"}'
  echo '{"type":"result","session_id":"11111111-1111-1111-1111-111111111111","result":"fake claude done"}'
else
  echo '{"type":"thread.started","thread_id":"22222222-2222-2222-2222-222222222222"}'
  echo '{"type":"item.completed","item":{"type":"agent_message","text":"fake codex done"}}'
  [ -n "$out" ] && echo 'fake codex done' > "$out"
fi
