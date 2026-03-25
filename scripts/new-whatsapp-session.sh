#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$PROJECT_ROOT/.env}"

SESSION_ID_PATTERN='^[a-zA-Z0-9:_-]+$'
SESSION_ID_MAX_LENGTH=64

SESSION_ID=""
SESSION_PREFIX="work"
SESSION_WEIGHT=1
SET_PRIMARY=0
CONNECT_NOW=1
RESET_AUTH=0
CLEAR_AUTH_FILES=0
ALLOW_REUSE=0
PM2_SYNC=1
PM2_TARGET_APP=""
PM2_DRY_RUN=0
RUN_HEALTHCHECK=1
PM2_WAIT_TIMEOUT_SECONDS=45
PM2_WAIT_INTERVAL_SECONDS=3
HEALTHCHECK_WAIT_SECONDS=45
HEALTHCHECK_INTERVAL_SECONDS=3

log() {
  printf '[new-whatsapp-session] %s\n' "$*"
}

fail() {
  printf '[new-whatsapp-session] erro: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    fail "comando ausente: $1"
  fi
}

usage() {
  cat <<'EOF'
Uso:
  bash scripts/new-whatsapp-session.sh [opcoes]

Opcoes:
  --session <id>           Define o session_id manualmente.
  --prefix <valor>         Prefixo para gerar session_id automatico (padrao: work).
  --weight <1-1000>        Peso da sessao em BAILEYS_SESSION_WEIGHTS (padrao: 1).
  --primary                Define a nova sessao como BAILEYS_PRIMARY_SESSION_ID.
  --reuse                  Permite usar um session_id ja existente.
  --reset-auth             Limpa credenciais atuais da sessao no MySQL antes do QR.
  --clear-auth-files       Junto com --reset-auth, remove app/connection/auth/*.json.
  --no-connect             Apenas atualiza .env (nao abre conexao para QR agora).
  --no-pm2-sync            Nao sincroniza/reinicia app PM2 automaticamente.
  --pm2-app <nome>         Nome do app PM2 alvo (padrao: <PM2_APP_NAME>-production).
  --pm2-dry-run            Exibe a sincronizacao PM2 sem executar restart real.
  --no-healthcheck         Nao executa healthcheck HTTP apos sincronizar PM2.
  --help                   Mostra esta ajuda.

Exemplos:
  npm run new:work
  npm run new:work -- --session suporte_2 --primary
  bash scripts/new-whatsapp-session.sh --prefix operador --no-connect
  bash scripts/new-whatsapp-session.sh --no-connect --pm2-app omnizap-system-production
EOF
}

strip_wrapping_quotes() {
  local value="${1:-}"
  if [[ "$value" == \"*\" && "$value" == *\" ]]; then
    value="${value:1:${#value}-2}"
  elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
    value="${value:1:${#value}-2}"
  fi
  printf '%s' "$value"
}

read_env_value() {
  local key="$1"
  local raw=""

  if [[ -f "$ENV_FILE" ]]; then
    raw="$(grep -E "^${key}=" "$ENV_FILE" | tail -n 1 | cut -d'=' -f2- || true)"
  fi

  raw="${raw//$'\r'/}"
  strip_wrapping_quotes "$raw"
}

split_entries() {
  printf '%s' "${1:-}" | tr ',;\n' '\n' | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//' | awk 'NF'
}

validate_session_id() {
  local value="$1"
  [[ -n "$value" ]] || return 1
  [[ "${#value}" -le "$SESSION_ID_MAX_LENGTH" ]] || return 1
  [[ "$value" =~ $SESSION_ID_PATTERN ]] || return 1
  return 0
}

upsert_env_value() {
  local key="$1"
  local value="$2"
  local temp_file
  temp_file="$(mktemp)"

  awk -v key="$key" -v value="$value" '
    BEGIN {
      replaced = 0;
      prefix = key "=";
    }
    index($0, prefix) == 1 {
      if (replaced == 0) {
        print prefix value;
        replaced = 1;
      }
      next;
    }
    { print; }
    END {
      if (replaced == 0) {
        print prefix value;
      }
    }
  ' "$ENV_FILE" >"$temp_file"

  mv "$temp_file" "$ENV_FILE"
}

is_valid_weight() {
  local value="$1"
  [[ "$value" =~ ^[0-9]+$ ]] || return 1
  ((value >= 1 && value <= 1000)) || return 1
  return 0
}

normalize_bool() {
  local value
  value="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]' | xargs)"
  if [[ -z "$value" ]]; then
    printf 'unset'
    return 0
  fi
  case "$value" in
    1|true|yes|y|on)
      printf 'true'
      ;;
    0|false|no|n|off)
      printf 'false'
      ;;
    *)
      printf 'unknown'
      ;;
  esac
}

pm2_get_status() {
  local app_name="$1"
  pm2 jlist 2>/dev/null | node -e "
const appName = String(process.argv[1] || '').trim();
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  raw += chunk;
});
process.stdin.on('end', () => {
  try {
    const list = JSON.parse(raw || '[]');
    const target = Array.isArray(list) ? list.find((entry) => String(entry?.name || '') === appName) : null;
    if (!target) {
      process.stdout.write('missing');
      return;
    }
    const status = String(target?.pm2_env?.status || '').trim().toLowerCase();
    process.stdout.write(status || 'unknown');
  } catch {
    process.stdout.write('error');
  }
});
" "$app_name"
}

pm2_detect_app_name() {
  local preferred="$1"
  pm2 jlist 2>/dev/null | node -e "
const preferred = String(process.argv[1] || '').trim();
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  raw += chunk;
});
process.stdin.on('end', () => {
  try {
    const list = JSON.parse(raw || '[]');
    const names = (Array.isArray(list) ? list : [])
      .map((entry) => String(entry?.name || '').trim())
      .filter(Boolean);

    if (preferred && names.includes(preferred)) {
      process.stdout.write(preferred);
      return;
    }

    if (names.includes('omnizap-production')) {
      process.stdout.write('omnizap-production');
      return;
    }

    const omnizapProduction = names.find((name) => /omnizap.*-production$/i.test(name));
    if (omnizapProduction) {
      process.stdout.write(omnizapProduction);
      return;
    }

    const anyProduction = names.find((name) => /-production$/i.test(name));
    if (anyProduction) {
      process.stdout.write(anyProduction);
      return;
    }

    process.stdout.write('');
  } catch {
    process.stdout.write('');
  }
});
" "$preferred"
}

resolve_pm2_target_app() {
  if [[ -n "$PM2_TARGET_APP" ]]; then
    printf '%s' "$PM2_TARGET_APP"
    return 0
  fi

  local pm2_base_name
  pm2_base_name="${PM2_APP_NAME:-}"
  if [[ -z "$pm2_base_name" ]]; then
    pm2_base_name="$(read_env_value PM2_APP_NAME)"
  fi
  if [[ -n "$pm2_base_name" ]]; then
    printf '%s' "${pm2_base_name}-production"
    return 0
  fi

  printf '%s' "omnizap-production"
}

wait_pm2_online() {
  local app_name="$1"
  local waited=0

  while (( waited <= PM2_WAIT_TIMEOUT_SECONDS )); do
    local status
    status="$(pm2_get_status "$app_name")"
    if [[ "$status" == "online" ]]; then
      log "PM2 app '$app_name' online."
      return 0
    fi
    if [[ "$status" == "missing" ]]; then
      fail "PM2 app '$app_name' nao encontrada durante sincronizacao."
    fi
    if [[ "$status" == "error" ]]; then
      fail "Nao foi possivel consultar status do PM2 app '$app_name'."
    fi

    sleep "$PM2_WAIT_INTERVAL_SECONDS"
    waited=$((waited + PM2_WAIT_INTERVAL_SECONDS))
  done

  fail "Timeout aguardando PM2 app '$app_name' ficar online."
}

run_http_healthcheck() {
  local metrics_enabled_raw
  metrics_enabled_raw="$(read_env_value METRICS_ENABLED)"
  local metrics_enabled_state
  metrics_enabled_state="$(normalize_bool "$metrics_enabled_raw")"
  if [[ "$metrics_enabled_state" == "false" ]]; then
    log "Healthcheck ignorado: METRICS_ENABLED=false."
    return 0
  fi

  if ! command -v curl >/dev/null 2>&1; then
    log "Healthcheck ignorado: comando 'curl' nao encontrado."
    return 0
  fi

  local host port url
  host="$(read_env_value METRICS_HOST)"
  port="$(read_env_value METRICS_PORT)"
  [[ -n "$host" ]] || host="127.0.0.1"
  if [[ "$host" == "0.0.0.0" || "$host" == "::" ]]; then
    host="127.0.0.1"
  fi
  if [[ ! "$port" =~ ^[0-9]+$ ]]; then
    port="9102"
  fi
  url="http://${host}:${port}/healthz"

  local waited=0
  local last_code="000"
  while (( waited <= HEALTHCHECK_WAIT_SECONDS )); do
    local code
    code="$(curl --silent --show-error --max-time 5 --output /dev/null --write-out '%{http_code}' "$url" || true)"
    if [[ "$code" == "200" ]]; then
      log "Healthcheck HTTP ok em $url."
      return 0
    fi
    last_code="$code"
    sleep "$HEALTHCHECK_INTERVAL_SECONDS"
    waited=$((waited + HEALTHCHECK_INTERVAL_SECONDS))
  done

  fail "Healthcheck falhou em $url (ultimo HTTP: $last_code)."
}

sync_pm2_if_needed() {
  if [[ "$PM2_SYNC" != "1" ]]; then
    log "Sincronizacao PM2 desativada (--no-pm2-sync)."
    return 0
  fi

  if ! command -v pm2 >/dev/null 2>&1; then
    log "PM2 nao encontrado; sincronizacao automatica ignorada."
    return 0
  fi

  local preferred_target
  preferred_target="$(resolve_pm2_target_app)"
  local app_target
  app_target="$(pm2_detect_app_name "$preferred_target")"
  if [[ -z "$app_target" ]]; then
    log "Nenhum app PM2 de producao detectado para sincronizar."
    return 0
  fi

  if [[ "$PM2_DRY_RUN" == "1" ]]; then
    log "PM2 dry-run: executaria 'pm2 restart $app_target --update-env'."
    return 0
  fi

  log "Sincronizando PM2 app '$app_target'..."
  pm2 restart "$app_target" --update-env >/dev/null
  wait_pm2_online "$app_target"

  if [[ "$RUN_HEALTHCHECK" == "1" ]]; then
    run_http_healthcheck
  else
    log "Healthcheck desativado (--no-healthcheck)."
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --session)
      [[ $# -ge 2 ]] || fail "faltou valor para --session"
      SESSION_ID="$2"
      shift 2
      ;;
    --prefix)
      [[ $# -ge 2 ]] || fail "faltou valor para --prefix"
      SESSION_PREFIX="$2"
      shift 2
      ;;
    --weight)
      [[ $# -ge 2 ]] || fail "faltou valor para --weight"
      SESSION_WEIGHT="$2"
      shift 2
      ;;
    --primary)
      SET_PRIMARY=1
      shift
      ;;
    --reuse)
      ALLOW_REUSE=1
      shift
      ;;
    --reset-auth)
      RESET_AUTH=1
      shift
      ;;
    --clear-auth-files)
      CLEAR_AUTH_FILES=1
      shift
      ;;
    --no-connect)
      CONNECT_NOW=0
      shift
      ;;
    --no-pm2-sync)
      PM2_SYNC=0
      shift
      ;;
    --pm2-app)
      [[ $# -ge 2 ]] || fail "faltou valor para --pm2-app"
      PM2_TARGET_APP="$2"
      shift 2
      ;;
    --pm2-dry-run)
      PM2_DRY_RUN=1
      shift
      ;;
    --no-healthcheck)
      RUN_HEALTHCHECK=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "opcao invalida: $1 (use --help)"
      ;;
  esac
done

[[ -f "$ENV_FILE" ]] || fail "arquivo .env nao encontrado em: $ENV_FILE"
is_valid_weight "$SESSION_WEIGHT" || fail "peso invalido em --weight: $SESSION_WEIGHT (use 1..1000)"

if [[ -n "$SESSION_ID" ]]; then
  validate_session_id "$SESSION_ID" || fail "session_id invalido: \"$SESSION_ID\""
else
  validate_session_id "$SESSION_PREFIX" || fail "prefixo invalido para session_id: \"$SESSION_PREFIX\""
fi

declare -A SEEN_SESSION_IDS=()
declare -a SESSION_IDS=()

existing_session_ids_raw="$(read_env_value BAILEYS_SESSION_IDS)"
legacy_session_id_raw="$(read_env_value BAILEYS_AUTH_SESSION_ID)"
if [[ -z "$existing_session_ids_raw" ]]; then
  existing_session_ids_raw="$legacy_session_id_raw"
fi
if [[ -z "$existing_session_ids_raw" ]]; then
  existing_session_ids_raw="default"
fi

while IFS= read -r candidate; do
  [[ -n "$candidate" ]] || continue
  if ! validate_session_id "$candidate"; then
    log "ignorado session_id invalido no .env: $candidate"
    continue
  fi
  if [[ -z "${SEEN_SESSION_IDS[$candidate]+x}" ]]; then
    SEEN_SESSION_IDS["$candidate"]=1
    SESSION_IDS+=("$candidate")
  fi
done < <(split_entries "$existing_session_ids_raw")

if [[ "${#SESSION_IDS[@]}" -eq 0 ]]; then
  SESSION_IDS=("default")
  SEEN_SESSION_IDS["default"]=1
fi

if [[ -z "$SESSION_ID" ]]; then
  base_id="${SESSION_PREFIX}-$(date -u +%Y%m%d%H%M%S)"
  generated_id="$base_id"
  suffix=1
  while [[ -n "${SEEN_SESSION_IDS[$generated_id]+x}" ]]; do
    suffix=$((suffix + 1))
    generated_id="${base_id}-${suffix}"
  done
  SESSION_ID="$generated_id"
fi

if [[ -n "${SEEN_SESSION_IDS[$SESSION_ID]+x}" && "$ALLOW_REUSE" != "1" ]]; then
  fail "session_id \"$SESSION_ID\" ja existe. Use --reuse para permitir reutilizacao."
fi

if [[ -z "${SEEN_SESSION_IDS[$SESSION_ID]+x}" ]]; then
  SESSION_IDS+=("$SESSION_ID")
  SEEN_SESSION_IDS["$SESSION_ID"]=1
fi

current_primary_session_id="$(read_env_value BAILEYS_PRIMARY_SESSION_ID)"
if ! validate_session_id "$current_primary_session_id"; then
  current_primary_session_id="${SESSION_IDS[0]}"
fi
if [[ -z "${SEEN_SESSION_IDS[$current_primary_session_id]+x}" ]]; then
  current_primary_session_id="${SESSION_IDS[0]}"
fi

if [[ "$SET_PRIMARY" == "1" ]]; then
  current_primary_session_id="$SESSION_ID"
fi

declare -A SESSION_WEIGHTS=()
weights_raw="$(read_env_value BAILEYS_SESSION_WEIGHTS)"
while IFS= read -r raw_entry; do
  [[ -n "$raw_entry" ]] || continue
  separator='='
  if [[ "$raw_entry" == *":"* && "$raw_entry" != *"="* ]]; then
    separator=':'
  fi
  if [[ "$raw_entry" != *"$separator"* ]]; then
    continue
  fi

  raw_session="${raw_entry%%"$separator"*}"
  raw_weight="${raw_entry#*"$separator"}"
  if ! validate_session_id "$raw_session"; then
    continue
  fi
  if is_valid_weight "$raw_weight"; then
    SESSION_WEIGHTS["$raw_session"]="$raw_weight"
  fi
done < <(split_entries "$weights_raw")

SESSION_WEIGHTS["$SESSION_ID"]="$SESSION_WEIGHT"
for existing_session in "${SESSION_IDS[@]}"; do
  if [[ -z "${SESSION_WEIGHTS[$existing_session]+x}" ]]; then
    SESSION_WEIGHTS["$existing_session"]=1
  fi
done

session_ids_value="$(IFS=,; printf '%s' "${SESSION_IDS[*]}")"
declare -a weight_entries=()
for listed_session in "${SESSION_IDS[@]}"; do
  weight_entries+=("${listed_session}=${SESSION_WEIGHTS[$listed_session]}")
done
weights_value="$(IFS=,; printf '%s' "${weight_entries[*]}")"

upsert_env_value "BAILEYS_SESSION_IDS" "$session_ids_value"
upsert_env_value "BAILEYS_PRIMARY_SESSION_ID" "$current_primary_session_id"
upsert_env_value "BAILEYS_SESSION_WEIGHTS" "$weights_value"

legacy_auth_session_id="$(read_env_value BAILEYS_AUTH_SESSION_ID)"
if [[ -z "$legacy_auth_session_id" || "$SET_PRIMARY" == "1" ]]; then
  upsert_env_value "BAILEYS_AUTH_SESSION_ID" "$current_primary_session_id"
fi

if [[ "$RESET_AUTH" == "1" ]]; then
  reset_args=(--session "$SESSION_ID")
  if [[ "$CLEAR_AUTH_FILES" == "1" ]]; then
    reset_args+=(--clear-auth-files)
  fi
  bash "$PROJECT_ROOT/scripts/clear-whatsapp-session.sh" "${reset_args[@]}"
fi

log "Sessao preparada com sucesso."
log "session_id: $SESSION_ID"
log "BAILEYS_SESSION_IDS: $session_ids_value"
log "BAILEYS_PRIMARY_SESSION_ID: $current_primary_session_id"
sync_pm2_if_needed

if [[ "$CONNECT_NOW" == "1" ]]; then
  require_cmd node
  log "Inicializando schema do banco..."
  node "$PROJECT_ROOT/database/init.js"

  log "Abrindo conexao da sessao '$SESSION_ID' para leitura do QR Code..."
  export BAILEYS_SESSION_IDS="$SESSION_ID"
  export BAILEYS_PRIMARY_SESSION_ID="$SESSION_ID"
  export BAILEYS_AUTH_SESSION_ID="$SESSION_ID"

  log "Apos conectar no WhatsApp, use Ctrl+C para encerrar."
  exec node "$PROJECT_ROOT/app/connection/socketController.js"
fi

log "Concluido sem abrir conexao. Para abrir QR agora use:"
log "  BAILEYS_SESSION_IDS=$SESSION_ID BAILEYS_PRIMARY_SESSION_ID=$SESSION_ID BAILEYS_AUTH_SESSION_ID=$SESSION_ID node app/connection/socketController.js"
