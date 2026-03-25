import pino from 'pino';
import { criarInstanciaLogger } from '@kaikybrofc/logger-module';
import baseLogger from '#logger';

/**
 * Label padrão para logger do Baileys.
 * @type {string}
 */
const DEFAULT_BAILEYS_LABEL = 'baileys';
/**
 * Modo padrão de logger raiz.
 * @type {'child'|'instance'}
 */
const DEFAULT_BAILEYS_LOGGER_MODE = 'child';
/**
 * Modos aceitos de logger raiz.
 * @type {Set<string>}
 */
const BAILEYS_LOGGER_MODES = new Set(['child', 'instance']);
/**
 * Modo padrão do logger de socket.
 * @type {'silent'|'pino'|'bridge'}
 */
const DEFAULT_BAILEYS_SOCKET_LOGGER_MODE = 'silent';
/**
 * Modos aceitos de logger de socket.
 * @type {Set<string>}
 */
const BAILEYS_SOCKET_LOGGER_MODES = new Set(['silent', 'pino', 'bridge']);
/**
 * Nível padrão para pino.
 * @type {string}
 */
const DEFAULT_PINO_LEVEL = 'info';
/**
 * Nível pino para suprimir logs.
 * @type {string}
 */
const DEFAULT_PINO_SILENT_LEVEL = 'silent';
/**
 * Conjunto de níveis pino válidos.
 * @type {Set<string>}
 */
const PINO_LEVELS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']);
/**
 * Prioridade numérica dos níveis pino.
 * @type {Readonly<Record<string, number>>}
 */
const PINO_LEVEL_PRIORITY = Object.freeze({
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  silent: Number.POSITIVE_INFINITY,
});
/**
 * Mapeamento de níveis do bridge pino->winston.
 * @type {Readonly<Record<string, string>>}
 */
const BAILEYS_TO_WINSTON_LEVEL = Object.freeze({
  trace: 'debug',
  debug: 'debug',
  info: 'info',
  warn: 'warn',
  error: 'error',
});
/**
 * Prioridade por método de log esperado pelo Baileys.
 * @type {Readonly<Record<string, number>>}
 */
const BAILEYS_LOG_METHOD_PRIORITY = Object.freeze({
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
});

/**
 * Interpreta valor de ambiente booleano.
 * @param {unknown} value
 * @param {boolean} fallback
 * @returns {boolean}
 */
const parseEnvBool = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
};

/**
 * Faz parse de JSON objeto com fallback seguro.
 * @param {unknown} value
 * @param {Record<string, any>} [fallback={}]
 * @param {string} [context='JSON']
 * @returns {Record<string, any>}
 */
const parseJsonObject = (value, fallback = {}, context = 'JSON') => {
  if (value === undefined || value === null || String(value).trim() === '') {
    return { ...fallback };
  }

  try {
    const parsed = JSON.parse(String(value));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
    return { ...fallback };
  } catch (error) {
    baseLogger.warn(`Valor inválido em ${context}. Usando fallback.`, {
      errorMessage: error?.message,
    });
    return { ...fallback };
  }
};

/**
 * Faz parse de definições de transportes customizados.
 * @param {unknown} value
 * @returns {Array<{type: string, options: Record<string, any>}>|undefined}
 */
const parseTransportDefinitions = (value) => {
  if (value === undefined || value === null || String(value).trim() === '') {
    return undefined;
  }

  try {
    const parsed = JSON.parse(String(value));
    if (!Array.isArray(parsed)) return undefined;

    const validDefinitions = parsed.filter((entry) => entry && typeof entry === 'object' && typeof entry.type === 'string' && entry.options && typeof entry.options === 'object');
    return validDefinitions.length > 0 ? validDefinitions : undefined;
  } catch (error) {
    baseLogger.warn('Valor inválido em BAILEYS_LOGGER_TRANSPORT_DEFINITIONS_JSON. Ignorando customização de transportes.', {
      errorMessage: error?.message,
    });
    return undefined;
  }
};

/**
 * Normaliza modo do logger raiz.
 * @param {unknown} value
 * @param {'child'|'instance'} [fallback=DEFAULT_BAILEYS_LOGGER_MODE]
 * @returns {'child'|'instance'}
 */
const normalizeLoggerMode = (value, fallback = DEFAULT_BAILEYS_LOGGER_MODE) => {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  return BAILEYS_LOGGER_MODES.has(normalized) ? normalized : fallback;
};

/**
 * Normaliza modo do logger de socket.
 * @param {unknown} value
 * @param {'silent'|'pino'|'bridge'} [fallback=DEFAULT_BAILEYS_SOCKET_LOGGER_MODE]
 * @returns {'silent'|'pino'|'bridge'}
 */
const normalizeSocketLoggerMode = (value, fallback = DEFAULT_BAILEYS_SOCKET_LOGGER_MODE) => {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  return BAILEYS_SOCKET_LOGGER_MODES.has(normalized) ? normalized : fallback;
};

/**
 * Normaliza label de logger.
 * @param {unknown} value
 * @param {string} [fallback=DEFAULT_BAILEYS_LABEL]
 * @returns {string}
 */
const normalizeLabel = (value, fallback = DEFAULT_BAILEYS_LABEL) => {
  const normalized = String(value || '')
    .trim()
    .replace(/\s+/g, '_');
  return normalized || fallback;
};

/**
 * Normaliza nível pino para um valor aceito.
 * @param {unknown} value
 * @param {string} [fallback=DEFAULT_PINO_LEVEL]
 * @returns {string}
 */
const normalizePinoLevel = (value, fallback = DEFAULT_PINO_LEVEL) => {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  return PINO_LEVELS.has(normalized) ? normalized : fallback;
};

/**
 * Converte nível estilo winston para nível pino.
 * @param {unknown} value
 * @returns {string}
 */
const mapWinstonLevelToPinoLevel = (value) => {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();

  if (['fatal', 'emerg', 'alert', 'crit'].includes(normalized)) return 'fatal';
  if (normalized === 'error') return 'error';
  if (['warn', 'notice'].includes(normalized)) return 'warn';
  if (['info', 'success', 'http'].includes(normalized)) return 'info';
  if (['debug', 'verbose'].includes(normalized)) return 'debug';
  if (normalized === 'silly') return 'trace';

  return DEFAULT_PINO_LEVEL;
};

/**
 * Verifica se um método de log deve ser emitido no nível atual.
 * @param {string} level
 * @param {string} method
 * @returns {boolean}
 */
const shouldEmitByPinoLevel = (level, method) => {
  const normalizedLevel = normalizePinoLevel(level, DEFAULT_PINO_LEVEL);
  const threshold = PINO_LEVEL_PRIORITY[normalizedLevel] ?? PINO_LEVEL_PRIORITY[DEFAULT_PINO_LEVEL];
  const methodPriority = BAILEYS_LOG_METHOD_PRIORITY[method] ?? BAILEYS_LOG_METHOD_PRIORITY.info;
  return methodPriority >= threshold;
};

/**
 * Resolve nome-base de serviço para metadados de logger.
 * @returns {string}
 */
const resolveBaseServiceName = () => {
  const raw = String(process.env.name || process.env.ECOSYSTEM_NAME || '').trim();
  return raw || 'sistema';
};

/**
 * Cria child logger quando suportado.
 * @param {any} logger
 * @param {Record<string, any>} defaultMeta
 * @returns {any}
 */
const createLoggerChild = (logger, defaultMeta) => {
  if (logger && typeof logger.child === 'function') {
    return logger.child(defaultMeta);
  }
  return logger || baseLogger;
};

/**
 * Resolve configuração do logger raiz do Baileys.
 * @param {Record<string, any>} [overrides={}]
 * @returns {{
 *   mode: 'child'|'instance',
 *   level?: string,
 *   label: string,
 *   service: string,
 *   defaultMeta: Record<string, any>,
 *   transportDefinitions?: Array<{type: string, options: Record<string, any>}>,
 *   transports?: any[],
 *   format?: any
 * }}
 */
const resolveBaileysLoggerConfig = (overrides = {}) => {
  const mode = normalizeLoggerMode(overrides.mode ?? process.env.BAILEYS_LOGGER_MODE, DEFAULT_BAILEYS_LOGGER_MODE);
  const level = String(overrides.level ?? process.env.BAILEYS_LOGGER_LEVEL ?? '').trim() || undefined;
  const label = normalizeLabel(overrides.label ?? process.env.BAILEYS_LOGGER_LABEL, DEFAULT_BAILEYS_LABEL);
  const service = String(overrides.service ?? process.env.BAILEYS_LOGGER_SERVICE ?? '').trim() || `${resolveBaseServiceName()}-baileys`;
  const enableCustomMeta = parseEnvBool(process.env.BAILEYS_LOGGER_ENABLE_META_JSON, true);
  const envMeta = enableCustomMeta ? parseJsonObject(process.env.BAILEYS_LOGGER_META_JSON, {}, 'BAILEYS_LOGGER_META_JSON') : {};
  const overrideMeta = overrides.defaultMeta && typeof overrides.defaultMeta === 'object' ? overrides.defaultMeta : {};
  const defaultMeta = {
    ...envMeta,
    ...overrideMeta,
    label,
    service,
  };

  const transportDefinitions = overrides.transportDefinitions || parseTransportDefinitions(process.env.BAILEYS_LOGGER_TRANSPORT_DEFINITIONS_JSON);
  const transports = Array.isArray(overrides.transports) ? overrides.transports : undefined;
  const format = overrides.format;

  return {
    mode,
    level,
    label,
    service,
    defaultMeta,
    transportDefinitions,
    transports,
    format,
  };
};

/**
 * Resolve configuração do logger de socket do Baileys.
 * @param {Record<string, any>} [overrides={}]
 * @returns {{mode: 'silent'|'pino'|'bridge', level: string, base: Record<string, any>, options: Record<string, any>}}
 */
const resolveBaileysSocketLoggerConfig = (overrides = {}) => {
  const mode = normalizeSocketLoggerMode(overrides.mode ?? process.env.BAILEYS_SOCKET_LOGGER_MODE, DEFAULT_BAILEYS_SOCKET_LOGGER_MODE);
  const fallbackLevel = mode === 'silent' ? DEFAULT_PINO_SILENT_LEVEL : DEFAULT_PINO_LEVEL;
  const level = normalizePinoLevel(overrides.level ?? process.env.BAILEYS_SOCKET_LOGGER_LEVEL, fallbackLevel);
  const enableCustomMeta = parseEnvBool(process.env.BAILEYS_SOCKET_LOGGER_ENABLE_META_JSON, true);
  const envBase = enableCustomMeta ? parseJsonObject(process.env.BAILEYS_SOCKET_LOGGER_META_JSON, {}, 'BAILEYS_SOCKET_LOGGER_META_JSON') : {};
  const overrideBase = overrides.base && typeof overrides.base === 'object' ? overrides.base : {};
  const base = {
    ...envBase,
    ...overrideBase,
  };
  const envOptions = parseJsonObject(process.env.BAILEYS_SOCKET_LOGGER_OPTIONS_JSON, {}, 'BAILEYS_SOCKET_LOGGER_OPTIONS_JSON');
  const overrideOptions = overrides.options && typeof overrides.options === 'object' ? overrides.options : {};
  const options = {
    ...envOptions,
    ...overrideOptions,
  };

  return {
    mode,
    level,
    base,
    options,
  };
};

/**
 * Cria logger raiz conforme configuração resolvida.
 * @param {Record<string, any>} [overrides={}]
 * @returns {any}
 */
const createConfiguredBaileysLogger = (overrides = {}) => {
  const config = resolveBaileysLoggerConfig(overrides);

  if (config.mode === 'instance') {
    return criarInstanciaLogger({
      level: config.level,
      defaultMeta: config.defaultMeta,
      transportDefinitions: config.transportDefinitions,
      transports: config.transports,
      format: config.format,
    });
  }

  const childLogger = createLoggerChild(baseLogger, config.defaultMeta);
  if (config.level && typeof childLogger === 'object' && childLogger) {
    childLogger.level = config.level;
  }
  return childLogger;
};

/**
 * Serializa erro para metadados seguros de log.
 * @param {any} error
 * @returns {{errorName: string, errorMessage: string, errorStack: string|undefined}}
 */
const serializeError = (error) => ({
  errorName: error?.name || 'Error',
  errorMessage: error?.message || String(error),
  errorStack: error?.stack,
});

/**
 * Resolve mensagem e metadados de uma chamada de log.
 * @param {any} obj
 * @param {any} msg
 * @returns {{message: string, metadata?: Record<string, any>}}
 */
const resolveLogEntry = (obj, msg) => {
  const providedMessage = typeof msg === 'string' ? msg.trim() : '';
  let message = providedMessage;
  let metadata;

  if (obj instanceof Error) {
    metadata = serializeError(obj);
    if (!message) message = obj.message || 'erro_em_logger_baileys';
  } else if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    metadata = { ...obj };
    if (!message && typeof obj.msg === 'string') {
      message = obj.msg.trim();
    }
    if (!message && typeof obj.message === 'string') {
      message = obj.message.trim();
    }
  } else if (obj !== undefined && obj !== null) {
    if (!message && typeof obj === 'string') {
      message = obj.trim();
    } else {
      metadata = { value: obj };
    }
  }

  if (!message) {
    message = 'baileys_socket_event';
  }

  return {
    message,
    metadata: metadata && Object.keys(metadata).length > 0 ? metadata : undefined,
  };
};

/**
 * Escreve log no logger alvo mapeando níveis do Baileys.
 * @param {any} targetLogger
 * @param {string} method
 * @param {any} obj
 * @param {any} msg
 * @returns {void}
 */
const writeBridgeLog = (targetLogger, method, obj, msg) => {
  const methodName = BAILEYS_TO_WINSTON_LEVEL[method] || 'info';
  const { message, metadata } = resolveLogEntry(obj, msg);
  const targetMethod = typeof targetLogger?.[methodName] === 'function' ? targetLogger[methodName].bind(targetLogger) : null;

  if (targetMethod) {
    if (metadata) {
      targetMethod(message, metadata);
    } else {
      targetMethod(message);
    }
    return;
  }

  if (typeof targetLogger?.log === 'function') {
    if (metadata) {
      targetLogger.log(methodName, message, metadata);
    } else {
      targetLogger.log(methodName, message);
    }
  }
};

/**
 * Cria adaptador estilo pino sobre logger base (bridge).
 * @param {any} rootLogger
 * @param {string} level
 * @returns {any}
 */
const createBaileysSocketBridgeLogger = (rootLogger, level) => {
  const sharedState = {
    level: normalizePinoLevel(level, mapWinstonLevelToPinoLevel(rootLogger?.level)),
  };

  /**
   * @param {any} targetLogger
   * @returns {any}
   */
  const createAdapter = (targetLogger) => ({
    get level() {
      return sharedState.level;
    },
    set level(nextLevel) {
      sharedState.level = normalizePinoLevel(nextLevel, sharedState.level);
    },
    child(bindings = {}) {
      const normalizedBindings = bindings && typeof bindings === 'object' ? bindings : {};
      const childLogger = createLoggerChild(targetLogger, normalizedBindings);
      return createAdapter(childLogger);
    },
    trace(obj, msg) {
      if (!shouldEmitByPinoLevel(sharedState.level, 'trace')) return;
      writeBridgeLog(targetLogger, 'trace', obj, msg);
    },
    debug(obj, msg) {
      if (!shouldEmitByPinoLevel(sharedState.level, 'debug')) return;
      writeBridgeLog(targetLogger, 'debug', obj, msg);
    },
    info(obj, msg) {
      if (!shouldEmitByPinoLevel(sharedState.level, 'info')) return;
      writeBridgeLog(targetLogger, 'info', obj, msg);
    },
    warn(obj, msg) {
      if (!shouldEmitByPinoLevel(sharedState.level, 'warn')) return;
      writeBridgeLog(targetLogger, 'warn', obj, msg);
    },
    error(obj, msg) {
      if (!shouldEmitByPinoLevel(sharedState.level, 'error')) return;
      writeBridgeLog(targetLogger, 'error', obj, msg);
    },
  });

  return createAdapter(rootLogger || baseLogger);
};

let cachedBaileysRootLogger = null;
let cachedBaileysSocketLogger = null;

/**
 * Retorna logger raiz default com cache por processo.
 * @returns {any}
 */
const getDefaultBaileysRootLogger = () => {
  if (!cachedBaileysRootLogger) {
    cachedBaileysRootLogger = createConfiguredBaileysLogger();
  }
  return cachedBaileysRootLogger;
};

/**
 * Cria logger de socket configurado.
 * @param {Record<string, any>} [overrides={}]
 * @returns {any}
 */
const createConfiguredBaileysSocketLogger = (overrides = {}) => {
  const config = resolveBaileysSocketLoggerConfig(overrides);
  const mergedBase = {
    ...(config.options?.base && typeof config.options.base === 'object' ? config.options.base : {}),
    ...config.base,
  };

  if (config.mode === 'bridge') {
    const bridgeLogger = createBaileysScopedLogger('socket', mergedBase);
    return createBaileysSocketBridgeLogger(bridgeLogger, config.level);
  }

  const level = config.mode === 'silent' ? DEFAULT_PINO_SILENT_LEVEL : config.level;
  const pinoOptions = {
    ...config.options,
    level,
  };
  if (Object.keys(mergedBase).length > 0) {
    pinoOptions.base = mergedBase;
  }
  return pino(pinoOptions);
};

/**
 * Retorna logger raiz do Baileys.
 * @param {Record<string, any>} [overrides={}]
 * @returns {any}
 */
export const createBaileysLogger = (overrides = {}) => {
  if (!overrides || Object.keys(overrides).length === 0) {
    return getDefaultBaileysRootLogger();
  }
  return createConfiguredBaileysLogger(overrides);
};

/**
 * Cria logger filho com escopo e metadados adicionais.
 * @param {string} scope
 * @param {Record<string, any>} [metadata={}]
 * @returns {any}
 */
export const createBaileysScopedLogger = (scope, metadata = {}) => {
  const rootLogger = getDefaultBaileysRootLogger();
  const rootLabel = resolveBaileysLoggerConfig().label;
  const normalizedScope = normalizeLabel(scope, '');
  const scopedLabel = normalizedScope ? `${rootLabel}.${normalizedScope}` : rootLabel;
  const scopedMeta = {
    ...metadata,
    label: scopedLabel,
  };
  return createLoggerChild(rootLogger, scopedMeta);
};

/**
 * Retorna logger de socket do Baileys.
 * @param {Record<string, any>} [overrides={}]
 * @returns {any}
 */
export const createBaileysSocketLogger = (overrides = {}) => {
  if (!overrides || Object.keys(overrides).length === 0) {
    if (!cachedBaileysSocketLogger) {
      cachedBaileysSocketLogger = createConfiguredBaileysSocketLogger();
    }
    return cachedBaileysSocketLogger;
  }
  return createConfiguredBaileysSocketLogger(overrides);
};

export const baileysLogger = createBaileysScopedLogger('');
export const baileysConnectionLogger = createBaileysScopedLogger('connection');
export const baileysConfigLogger = createBaileysScopedLogger('config');
export const baileysAuthLogger = createBaileysScopedLogger('auth');
export const baileysGroupsLogger = createBaileysScopedLogger('groups');
export const baileysSocketLogger = createBaileysSocketLogger();
