#!/usr/bin/env bash
set -euo pipefail

PROFILE="${1:-${VLLM_PRUNING_PROFILE:-baseline}}"
MODEL="${VLLM_MODEL:-Qwen/Qwen3-VL-8B-Instruct}"
EXPECTED_VERSION="${VLLM_VERSION:-0.29.0}"
HOST="${VLLM_HOST:-127.0.0.1}"
PORT="${VLLM_PORT:-8000}"
MAX_MODEL_LEN="${VLLM_MAX_MODEL_LEN:-32768}"
GPU_MEMORY_UTILIZATION="${VLLM_GPU_MEMORY_UTILIZATION:-0.90}"
MODEL_REVISION="${VLLM_MODEL_REVISION:-}"
API_KEY="${VLLM_API_KEY:-}"
ALLOWED_MEDIA_DOMAINS="${VLLM_ALLOWED_MEDIA_DOMAINS:-}"

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
export VLLM_MEDIA_URL_ALLOW_REDIRECTS=0

REVISION_ARGS=()
if [[ -n "$MODEL_REVISION" ]]; then
  REVISION_ARGS=(--revision "$MODEL_REVISION")
fi

AUTH_ARGS=()
if [[ -n "$API_KEY" ]]; then
  AUTH_ARGS=(--api-key "$API_KEY")
fi

MEDIA_ARGS=()
if [[ -n "$ALLOWED_MEDIA_DOMAINS" ]]; then
  read -r -a MEDIA_DOMAINS <<< "$ALLOWED_MEDIA_DOMAINS"
  MEDIA_ARGS=(--allowed-media-domains "${MEDIA_DOMAINS[@]}")
fi

echo "ForgeDirector vLLM pruning experiment"
echo "profile=$PROFILE model=$MODEL vllm=$ACTUAL_VERSION host=$HOST port=$PORT"
echo "model_revision=${MODEL_REVISION:-un-pinned-exploratory-run}"
printf 'pruning_args='; printf '%q ' "${PRUNING_ARGS[@]}"; echo
if [[ -z "$MODEL_REVISION" ]]; then
  echo "WARNING: set VLLM_MODEL_REVISION to an exact model commit for decision-grade evidence." >&2
fi

exec vllm serve "$MODEL" \
  --host "$HOST" \
  --port "$PORT" \
  --max-model-len "$MAX_MODEL_LEN" \
  --gpu-memory-utilization "$GPU_MEMORY_UTILIZATION" \
  --limit-mm-per-prompt '{"video":1}' \
  --compilation-config '{"cudagraph_mm_encoder": false}' \
  "${REVISION_ARGS[@]}" \
  "${AUTH_ARGS[@]}" \
  "${MEDIA_ARGS[@]}" \
  "${PRUNING_ARGS[@]}"
