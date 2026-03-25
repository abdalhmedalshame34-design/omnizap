import { initAuthCreds, makeCacheableSignalKeyStore, proto } from '@whiskeysockets/baileys';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { baileysAuthLogger as logger } from '../config/index.js';
import { TABLES, executeQuery, pool } from '../../database/index.js';

/**
 * Nome da tabela que persiste o estado de autenticação do Baileys.
 * @type {string}
 */
const AUTH_TABLE = TABLES.BAILEYS_AUTH_STATE;
/**
 * Categoria usada para armazenar as credenciais principais.
 * @type {string}
 */
const CREDS_CATEGORY = 'creds';
/**
 * Identificador fixo da linha de credenciais.
 * @type {string}
 */
const CREDS_ITEM_ID = 'default';
/**
 * Extensão esperada para arquivos de bootstrap de auth state.
 * @type {string}
 */
const AUTH_FILE_EXTENSION = '.json';
/**
 * Tipos conhecidos de signal keys persistidos no auth state.
 * @type {string[]}
 */
const KNOWN_SIGNAL_KEY_TYPES = ['pre-key', 'session', 'sender-key', 'sender-key-memory', 'app-state-sync-key', 'app-state-sync-version', 'lid-mapping', 'device-list', 'tctoken'];
/**
 * Tipos ordenados por tamanho (desc) para priorizar match de prefixo mais específico.
 * @type {string[]}
 */
const KNOWN_SIGNAL_KEY_TYPES_SORTED = [...KNOWN_SIGNAL_KEY_TYPES].sort((left, right) => right.length - left.length);
/**
 * Interpreta uma variável de ambiente booleana com fallback.
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
 * Habilita cache em memória do key store do Baileys.
 * @type {boolean}
 */
const BAILEYS_AUTH_KEYS_CACHE_ENABLED = parseEnvBool(process.env.BAILEYS_AUTH_KEYS_CACHE_ENABLED, true);

/**
 * Promise compartilhada para inicialização idempotente da tabela.
 * @type {Promise<void> | null}
 */
let ensureTablePromise = null;

/**
 * Helpers de serialização JSON que preservam Buffers/Uint8Array.
 * @type {{replacer: (key: string, value: any) => any, reviver: (key: string, value: any) => any}}
 */
const BufferJSON = {
  replacer: (_, value) => {
    if (Buffer.isBuffer(value) || value instanceof Uint8Array || value?.type === 'Buffer') {
      return { type: 'Buffer', data: Buffer.from(value?.data || value).toString('base64') };
    }
    return value;
  },
  reviver: (_, value) => {
    if (typeof value === 'object' && value !== null && value.type === 'Buffer' && typeof value.data === 'string') {
      return Buffer.from(value.data, 'base64');
    }
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const keys = Object.keys(value);
      if (keys.length > 0 && keys.every((key) => !Number.isNaN(Number.parseInt(key, 10)))) {
        const values = Object.values(value);
        if (values.every((entry) => typeof entry === 'number')) {
          return Buffer.from(values);
        }
      }
    }
    return value;
  },
};

/**
 * Monta placeholder SQL para cláusula `IN`.
 * @param {number} count
 * @returns {string}
 */
const buildInClause = (count) => new Array(count).fill('?').join(', ');

/**
 * Normaliza o ID de sessão do auth state.
 * @param {string | null | undefined} sessionId
 * @returns {string}
 */
const normalizeSessionId = (sessionId) => {
  const normalized = String(sessionId || '').trim();
  return normalized || 'default';
};

/**
 * Normaliza o identificador de item para armazenamento no banco.
 * @param {string | null | undefined} value
 * @returns {string}
 */
const normalizeStorageId = (value) =>
  String(value || '')
    .replace(/\//g, '__')
    .replace(/:/g, '-');

/**
 * Serializa payload para coluna JSON com suporte a Buffer.
 * @param {any} value
 * @returns {string}
 */
const toJsonPayload = (value) => JSON.stringify(value, BufferJSON.replacer);

/**
 * Faz parse de payload JSON persistido no banco.
 * @param {unknown} rawPayload
 * @returns {any | null}
 */
const parseJsonPayload = (rawPayload) => {
  if (rawPayload === null || rawPayload === undefined) return null;
  try {
    return JSON.parse(String(rawPayload), BufferJSON.reviver);
  } catch (error) {
    logger.warn('Falha ao interpretar payload do auth state no banco.', {
      table: AUTH_TABLE,
      errorMessage: error?.message,
    });
    return null;
  }
};

/**
 * @typedef {{
 *   totalRows: number,
 *   credsRows: number,
 *   signalKeyRows: number,
 *   categories: Record<string, number>
 * }} SessionAuthStateStats
 */
/**
 * Lê estatísticas agregadas do auth state para a sessão.
 * @param {string} sessionId
 * @returns {Promise<SessionAuthStateStats>}
 */
const readSessionAuthStateStats = async (sessionId) => {
  const rows = await executeQuery(
    `
      SELECT category, COUNT(*) AS total
        FROM \`${AUTH_TABLE}\`
       WHERE session_id = ?
       GROUP BY category
    `,
    [sessionId],
  );

  const stats = {
    totalRows: 0,
    credsRows: 0,
    signalKeyRows: 0,
    categories: {},
  };

  for (const row of rows || []) {
    const category = String(row?.category || '').trim();
    const total = Number(row?.total || 0);
    if (!category || total <= 0) continue;

    stats.totalRows += total;
    stats.categories[category] = total;
    if (category === CREDS_CATEGORY) {
      stats.credsRows += total;
    } else {
      stats.signalKeyRows += total;
    }
  }

  return stats;
};

/**
 * Garante a existência da tabela de auth state no banco.
 * @returns {Promise<void>}
 */
const ensureAuthStateTable = async () => {
  if (ensureTablePromise) {
    return ensureTablePromise;
  }

  ensureTablePromise = (async () => {
    try {
      await executeQuery(`
        CREATE TABLE IF NOT EXISTS \`${AUTH_TABLE}\` (
          \`session_id\` varchar(64) NOT NULL,
          \`category\` varchar(64) NOT NULL,
          \`item_id\` varchar(191) NOT NULL,
          \`payload\` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(\`payload\`)),
          \`created_at\` timestamp NOT NULL DEFAULT current_timestamp(),
          \`updated_at\` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
          PRIMARY KEY (\`session_id\`, \`category\`, \`item_id\`),
          KEY \`idx_baileys_auth_state_category_updated\` (\`category\`, \`updated_at\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);
    } catch (error) {
      try {
        await executeQuery(`SELECT 1 FROM \`${AUTH_TABLE}\` LIMIT 1`);
      } catch {
        throw error;
      }
    }
  })().catch((error) => {
    ensureTablePromise = null;
    throw error;
  });

  return ensureTablePromise;
};

/**
 * Insere ou atualiza uma linha de auth state.
 * @param {string} sessionId
 * @param {string} category
 * @param {string} itemId
 * @param {any} value
 * @param {import('mysql2/promise').PoolConnection | null} [connection=null]
 * @returns {Promise<void>}
 */
const upsertAuthRow = async (sessionId, category, itemId, value, connection = null) => {
  const payload = toJsonPayload(value);
  await executeQuery(
    `
      INSERT INTO \`${AUTH_TABLE}\` (session_id, category, item_id, payload)
      VALUES (?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE payload = VALUES(payload), updated_at = current_timestamp()
    `,
    [sessionId, category, itemId, payload],
    connection,
  );
};

/**
 * Remove uma linha de auth state.
 * @param {string} sessionId
 * @param {string} category
 * @param {string} itemId
 * @param {import('mysql2/promise').PoolConnection | null} [connection=null]
 * @returns {Promise<void>}
 */
const deleteAuthRow = async (sessionId, category, itemId, connection = null) => {
  await executeQuery(`DELETE FROM \`${AUTH_TABLE}\` WHERE session_id = ? AND category = ? AND item_id = ?`, [sessionId, category, itemId], connection);
};

/**
 * Lê as credenciais salvas para uma sessão.
 * @param {string} sessionId
 * @returns {Promise<import('@whiskeysockets/baileys').AuthenticationCreds | null>}
 */
const readCredsFromDb = async (sessionId) => {
  const rows = await executeQuery(`SELECT payload FROM \`${AUTH_TABLE}\` WHERE session_id = ? AND category = ? AND item_id = ? LIMIT 1`, [sessionId, CREDS_CATEGORY, CREDS_ITEM_ID]);
  const payload = rows?.[0]?.payload;
  const parsed = parseJsonPayload(payload);
  return parsed || null;
};

/**
 * @typedef {{category: string, itemId: string}} AuthFileMetadata
 */
/**
 * Extrai categoria e itemId de um arquivo legado de auth state.
 * @param {string} fileName
 * @returns {AuthFileMetadata | null}
 */
const parseAuthFileMetadata = (fileName) => {
  if (!fileName || typeof fileName !== 'string' || !fileName.endsWith(AUTH_FILE_EXTENSION)) {
    return null;
  }

  const stem = fileName.slice(0, -AUTH_FILE_EXTENSION.length);
  if (stem === 'creds') {
    return {
      category: CREDS_CATEGORY,
      itemId: CREDS_ITEM_ID,
    };
  }

  for (const type of KNOWN_SIGNAL_KEY_TYPES_SORTED) {
    const prefix = `${type}-`;
    if (stem.startsWith(prefix)) {
      const itemId = stem.slice(prefix.length);
      if (!itemId) return null;
      return {
        category: type,
        itemId,
      };
    }
  }

  return null;
};

/**
 * Migra auth state legado de arquivos para MySQL, quando necessário.
 * @param {string} sessionId
 * @param {string | null} bootstrapFromDir
 * @returns {Promise<boolean>} `true` quando houve importação de ao menos uma linha.
 */
const migrateSessionFromFiles = async (sessionId, bootstrapFromDir) => {
  if (!bootstrapFromDir) return false;

  const authStatsBeforeMigration = await readSessionAuthStateStats(sessionId);
  const hasSessionData = authStatsBeforeMigration.totalRows > 0;
  const hasSignalKeyRows = authStatsBeforeMigration.signalKeyRows > 0;
  if (hasSessionData && hasSignalKeyRows) return false;

  if (hasSessionData && !hasSignalKeyRows) {
    logger.warn('Auth state do Baileys está parcial (somente creds) e tentará bootstrap via arquivos.', {
      action: 'baileys_auth_db_partial_state_detected',
      sessionId,
      credsRows: authStatsBeforeMigration.credsRows,
      signalKeyRows: authStatsBeforeMigration.signalKeyRows,
      totalRows: authStatsBeforeMigration.totalRows,
      bootstrapFromDir,
      table: AUTH_TABLE,
    });
  }

  let directoryEntries = [];
  try {
    directoryEntries = await readdir(bootstrapFromDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return false;
    }
    throw error;
  }

  const candidateFiles = directoryEntries.filter((entry) => entry.isFile() && entry.name.endsWith(AUTH_FILE_EXTENSION));
  if (!candidateFiles.length) return false;

  const connection = await pool.getConnection();
  let importedRows = 0;
  let skippedRows = 0;

  try {
    await connection.beginTransaction();
    for (const fileEntry of candidateFiles) {
      const meta = parseAuthFileMetadata(fileEntry.name);
      if (!meta) {
        skippedRows += 1;
        continue;
      }

      const filePath = path.join(bootstrapFromDir, fileEntry.name);
      let payload = null;
      try {
        const raw = await readFile(filePath, 'utf8');
        payload = JSON.parse(raw, BufferJSON.reviver);
      } catch (error) {
        skippedRows += 1;
        logger.warn('Falha ao migrar arquivo de auth para MySQL.', {
          filePath,
          errorMessage: error?.message,
        });
        continue;
      }

      if (payload === null || payload === undefined) {
        await deleteAuthRow(sessionId, meta.category, meta.itemId, connection);
        continue;
      }

      await upsertAuthRow(sessionId, meta.category, meta.itemId, payload, connection);
      importedRows += 1;
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  if (importedRows > 0) {
    logger.info('Auth state do Baileys migrado do disco para MySQL.', {
      action: 'baileys_auth_db_migration',
      sessionId,
      importedRows,
      skippedRows,
      hadPartialState: hasSessionData && !hasSignalKeyRows,
      bootstrapFromDir,
      table: AUTH_TABLE,
    });
  }

  return importedRows > 0;
};

/**
 * Cria implementação de SignalKeyStore persistida em MySQL.
 * @param {string} sessionId
 * @returns {{
 *   get: (type: string, ids: string[]) => Promise<Record<string, any>>,
 *   set: (data: Record<string, Record<string, any>>) => Promise<void>
 * }}
 */
const createDbSignalKeyStore = (sessionId) => ({
  /**
   * @param {string} type
   * @param {string[]} ids
   * @returns {Promise<Record<string, any>>}
   */
  async get(type, ids) {
    if (!Array.isArray(ids) || ids.length === 0) {
      return {};
    }

    const normalizedIds = ids.map((id) => String(id));
    const storageIds = normalizedIds.map((id) => normalizeStorageId(id));
    const storageIdToRaw = new Map(storageIds.map((storageId, index) => [storageId, normalizedIds[index]]));

    const rows = await executeQuery(`SELECT item_id, payload FROM \`${AUTH_TABLE}\` WHERE session_id = ? AND category = ? AND item_id IN (${buildInClause(storageIds.length)})`, [sessionId, type, ...storageIds]);

    const data = {};
    for (const row of rows || []) {
      const rawId = storageIdToRaw.get(String(row?.item_id || ''));
      if (!rawId) continue;

      let value = parseJsonPayload(row?.payload);
      if (type === 'app-state-sync-key' && value) {
        value = proto.Message.AppStateSyncKeyData.fromObject(value);
      }

      if (value !== null && value !== undefined) {
        data[rawId] = value;
      }
    }

    return data;
  },
  /**
   * @param {Record<string, Record<string, any>>} data
   * @returns {Promise<void>}
   */
  async set(data) {
    if (!data || typeof data !== 'object') return;

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      for (const category of Object.keys(data)) {
        const categoryEntries = data[category];
        if (!categoryEntries || typeof categoryEntries !== 'object') continue;

        for (const id of Object.keys(categoryEntries)) {
          const value = categoryEntries[id];
          const itemId = normalizeStorageId(id);
          if (value) {
            await upsertAuthRow(sessionId, category, itemId, value, connection);
          } else {
            await deleteAuthRow(sessionId, category, itemId, connection);
          }
        }
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  },
});

/**
 * Cria um AuthenticationState compatível com o Baileys usando MySQL.
 *
 * @param {{
 *   sessionId?: string,
 *   bootstrapFromDir?: string|null,
 *   bootstrapFromFiles?: boolean
 * }} [options]
 * @returns {Promise<{state: import('@whiskeysockets/baileys').AuthenticationState, saveCreds: () => Promise<void>}>}
 */
export async function useDbAuthState(options = {}) {
  const sessionId = normalizeSessionId(options.sessionId);
  const bootstrapFromDir = typeof options.bootstrapFromDir === 'string' ? options.bootstrapFromDir : null;
  const bootstrapFromFiles = options.bootstrapFromFiles !== false;

  await ensureAuthStateTable();

  if (bootstrapFromFiles) {
    try {
      await migrateSessionFromFiles(sessionId, bootstrapFromDir);
    } catch (error) {
      logger.warn('Falha ao executar bootstrap de auth state do Baileys para MySQL.', {
        action: 'baileys_auth_db_bootstrap_error',
        sessionId,
        bootstrapFromDir,
        errorMessage: error?.message,
      });
    }
  }

  const authStats = await readSessionAuthStateStats(sessionId);
  if (authStats.totalRows > 0 && authStats.signalKeyRows === 0) {
    logger.warn('Auth state do Baileys sem signal keys; sessão pode ficar instável até novo pareamento.', {
      action: 'baileys_auth_db_missing_signal_keys',
      sessionId,
      credsRows: authStats.credsRows,
      signalKeyRows: authStats.signalKeyRows,
      totalRows: authStats.totalRows,
      categories: authStats.categories,
      table: AUTH_TABLE,
    });
  }

  const creds = (await readCredsFromDb(sessionId)) || initAuthCreds();
  const keyStore = createDbSignalKeyStore(sessionId);
  const wrappedKeyStore = BAILEYS_AUTH_KEYS_CACHE_ENABLED ? makeCacheableSignalKeyStore(keyStore, logger) : keyStore;

  return {
    state: {
      creds,
      keys: wrappedKeyStore,
    },
    saveCreds: async () => {
      await upsertAuthRow(sessionId, CREDS_CATEGORY, CREDS_ITEM_ID, creds);
    },
  };
}
