#!/usr/bin/env bash
set -euo pipefail

PROFILE="${1:-${VLLM_PRUNING_PROFILE:-baseline}}"
MODEL="${VLLM_MODEL:-Qwen/Qwen3-VL-4B-Instruct}"
EXPECTED_VERSION="${VLLM_VERSION:-0.28.0}"
HOST="${VLLM_HOST:-127.0.0.1}"
PORT="${VLLM_PORT:-8000}"
MAX_MODEL_LEN="${VLLM_MAX_MODEL_LEN:-32768}"

case "$PROFILE" in
  baseline) PRUNING_ARGS=() ;;
  evs-conservative) PRUNING_ARGS=(--video-pruning-rate 0.25 --video-pruning-method evs) ;;
  evs-medium) PRUNING_ARGS=(--video-pruning-rate 0.5 --video-pruning-method evs) ;;
  evs-aggressive) PRUNING_ARGS=(--video-pruning-rate 0.75 --video-pruning-method evs) ;;
  vidcom2-conservative) PRUNING_ARGS=(--video-pruning-rate 0.25 --video-pruning-method vidcom2) ;;
  vidcom2-medium) PRUNING_ARGS=(--video-pruning-rate 0.5 --video-pruning-method vidcom2) ;;
  vidcom2-aggressive) PRUNING_ARGS=(--video-pruning-rate 0.75 --video-pruning-method vidcom2) ;;
  *) echo "Unknown pruning profile: $PROFILE" >&2; exit 2 ;;
esac

if [[ "$PROFILE" == vidcom2-* ]] && [[ ! "$MODEL" =~ [Qq]wen3[-_/\ ]?[Vv][Ll] ]]; then
  echo "VidCom2 profiles require Qwen3-VL; got: $MODEL" >&2
  exit 2
fi

ACTUAL_VERSION=$(python - <<'PY'
import vllm
print(vllm.__version__)
PY
)
if [[ "$ACTUAL_VERSION" != "$EXPECTED_VERSION" ]]; then
  echo "Refusing unpinned benchmark: expected vLLM $EXPECTED_VERSION, found $ACTUAL_VERSION" >&2
  exit 2
fi

export VLLM_VIDEO_FETCH_TIMEOUT="${VLLM_VIDEO_FETCH_TIMEOUT:-120}"

echo "ForgeDirector vLLM pruning experiment"
echo "profile=$PROFILE model=$MODEL vllm=$ACTUAL_VERSION host=$HOST port=$PORT"
printf 'pruning_args='; printf '%q ' "${PRUNING_ARGS[@]}"; echo

exec vllm serve "$MODEL" \
  --host "$HOST" \
  --port "$PORT" \
  --max-model-len "$MAX_MODEL_LEN" \
  --limit-mm-per-prompt '{"video":1}' \
  "${PRUNING_ARGS[@]}"
