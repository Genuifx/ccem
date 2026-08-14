#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
LOG_DIR="${ROOT_DIR}/logs/runtime-protocol"
mkdir -p "${LOG_DIR}"

STAMP="$(date +%Y%m%d-%H%M%S)"
HELP_LOG="${LOG_DIR}/claude-help-${STAMP}.txt"
AUTH_LOG="${LOG_DIR}/claude-auth-${STAMP}.json"
CONFIG_LOG="${LOG_DIR}/ccem-env-${STAMP}.json"

echo "[runtime-spike] root: ${ROOT_DIR}"
echo "[runtime-spike] logs: ${LOG_DIR}"

if ! command -v claude >/dev/null 2>&1; then
  echo "[runtime-spike] claude CLI not found"
  exit 1
fi

echo "[runtime-spike] version: $(claude -v)"
claude --help > "${HELP_LOG}"

if claude auth status > "${AUTH_LOG}" 2>&1; then
  echo "[runtime-spike] auth status written: ${AUTH_LOG}"
else
  echo "[runtime-spike] auth status command failed; see ${AUTH_LOG}"
fi

CCEM_CONFIG="${HOME}/.ccem/config.json"
CURRENT_ENV=""
BASE_URL=""
MODEL=""
API_KEY=""
AUTH_TOKEN=""

if command -v jq >/dev/null 2>&1 && [ -f "${CCEM_CONFIG}" ]; then
  jq '{
    current,
    base_url: (.registries[.current].ANTHROPIC_BASE_URL // null),
    model: (.registries[.current].ANTHROPIC_MODEL // null),
    has_api_key: (.registries[.current].ANTHROPIC_API_KEY != null),
    has_auth_token: (.registries[.current].ANTHROPIC_AUTH_TOKEN != null)
  }' "${CCEM_CONFIG}" > "${CONFIG_LOG}" || true

  CURRENT_ENV="$(jq -r '.current // empty' "${CCEM_CONFIG}" 2>/dev/null || true)"
  BASE_URL="$(jq -r --arg env "${CURRENT_ENV}" '.registries[$env].ANTHROPIC_BASE_URL // empty' "${CCEM_CONFIG}" 2>/dev/null || true)"
  MODEL="$(jq -r --arg env "${CURRENT_ENV}" '.registries[$env].ANTHROPIC_MODEL // empty' "${CCEM_CONFIG}" 2>/dev/null || true)"
  API_KEY="$(jq -r --arg env "${CURRENT_ENV}" '.registries[$env].ANTHROPIC_API_KEY // empty' "${CCEM_CONFIG}" 2>/dev/null || true)"
  AUTH_TOKEN="$(jq -r --arg env "${CURRENT_ENV}" '.registries[$env].ANTHROPIC_AUTH_TOKEN // empty' "${CCEM_CONFIG}" 2>/dev/null || true)"

  if [ -n "${CURRENT_ENV}" ]; then
    echo "[runtime-spike] current CCEM env: ${CURRENT_ENV}"
    echo "[runtime-spike] CCEM env summary written: ${CONFIG_LOG}"
  fi
fi

RUN_LOG="${LOG_DIR}/stream-json-${STAMP}.log"
echo "[runtime-spike] running minimal stream-json probe..."

if grep -q '"loggedIn": false' "${AUTH_LOG}" 2>/dev/null; then
  echo "[runtime-spike] Claude CLI is not logged in via official auth."
  echo "[runtime-spike] probing with current CCEM environment instead."
fi

if [ -n "${BASE_URL}" ]; then
  export ANTHROPIC_BASE_URL="${BASE_URL}"
fi
if [ -n "${MODEL}" ]; then
  export ANTHROPIC_MODEL="${MODEL}"
fi
if [ -n "${API_KEY}" ] && [ "${API_KEY#enc:}" != "${API_KEY}" ]; then
  export ANTHROPIC_API_KEY="${API_KEY#enc:}"
fi
if [ -n "${AUTH_TOKEN}" ] && [ "${AUTH_TOKEN#enc:}" != "${AUTH_TOKEN}" ]; then
  export ANTHROPIC_AUTH_TOKEN="${AUTH_TOKEN#enc:}"
fi

claude -p \
  --output-format stream-json \
  --verbose \
  "Reply with exactly OK" | tee "${RUN_LOG}"

echo "[runtime-spike] probe log written: ${RUN_LOG}"
