import logger from '#logger';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const parseEnvBool = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
};

const LIBSIGNAL_RUNTIME_PATCH_ENABLED = parseEnvBool(process.env.BAILEYS_LIBSIGNAL_RUNTIME_PATCH_ENABLED, true);
const PATCH_VERSION = '2026-03-25';
const PATCH_MARKER = Symbol.for('omnizap.libsignal.runtimePatch');
const CLOSED_SESSIONS_MAX = 40;

let patchAttempted = false;

const markPatched = (target, value = PATCH_VERSION) => {
  try {
    Object.defineProperty(target, PATCH_MARKER, {
      value,
      writable: false,
      enumerable: false,
      configurable: false,
    });
  } catch {
    // Ignora erros de marcação para não impactar inicialização.
  }
};

const isPatched = (target) => Boolean(target?.[PATCH_MARKER]);

const patchSessionRecordLogging = () => {
  const SessionRecord = require('libsignal/src/session_record.js');
  const prototype = SessionRecord?.prototype;
  if (!prototype || isPatched(prototype)) return false;

  prototype.closeSession = function patchedCloseSession(session) {
    if (!session || !session.indexInfo) return;
    if (this.isClosed(session)) return;
    session.indexInfo.closed = Date.now();
  };

  prototype.openSession = function patchedOpenSession(session) {
    if (!session || !session.indexInfo) return;
    session.indexInfo.closed = -1;
  };

  prototype.removeOldSessions = function patchedRemoveOldSessions() {
    while (Object.keys(this.sessions).length > CLOSED_SESSIONS_MAX) {
      let oldestKey;
      let oldestSession;
      for (const [key, session] of Object.entries(this.sessions)) {
        if (session.indexInfo.closed !== -1 && (!oldestSession || session.indexInfo.closed < oldestSession.indexInfo.closed)) {
          oldestKey = key;
          oldestSession = session;
        }
      }
      if (oldestKey) {
        delete this.sessions[oldestKey];
      } else {
        throw new Error('Corrupt sessions object');
      }
    }
  };

  markPatched(prototype);
  return true;
};

const patchSessionCipherNoise = () => {
  const SessionCipher = require('libsignal/src/session_cipher.js');
  const errors = require('libsignal/src/errors.js');
  const prototype = SessionCipher?.prototype;
  if (!prototype || isPatched(prototype)) return false;

  prototype.decryptWithSessions = async function patchedDecryptWithSessions(data, sessions) {
    if (!Array.isArray(sessions) || sessions.length === 0) {
      throw new errors.SessionError('No sessions available');
    }

    for (const session of sessions) {
      try {
        const plaintext = await this.doDecryptWhisperMessage(data, session);
        if (session?.indexInfo) {
          session.indexInfo.used = Date.now();
        }
        return {
          session,
          plaintext,
        };
      } catch {
        // Suprime ruído individual por sessão (Bad MAC esperado em rotação de ratchet).
      }
    }

    throw new errors.SessionError('No matching sessions found for message');
  };

  prototype.decryptWhisperMessage = async function patchedDecryptWhisperMessage(data) {
    if (!Buffer.isBuffer(data)) {
      throw new TypeError(`Expected Buffer instead of: ${data?.constructor?.name || typeof data}`);
    }
    return await this.queueJob(async () => {
      const record = await this.getRecord();
      if (!record) {
        throw new errors.SessionError('No session record');
      }
      const result = await this.decryptWithSessions(data, record.getSessions());
      const remoteIdentityKey = result?.session?.indexInfo?.remoteIdentityKey;
      if (!(await this.storage.isTrustedIdentity(this.addr.id, remoteIdentityKey))) {
        throw new errors.UntrustedIdentityKeyError(this.addr.id, remoteIdentityKey);
      }
      // Mantemos comportamento funcional original, apenas sem log verboso por mensagem.
      await this.storeRecord(record);
      return result.plaintext;
    });
  };

  markPatched(prototype);
  return true;
};

export const applyLibsignalRuntimePatch = () => {
  if (patchAttempted) return;
  patchAttempted = true;

  if (!LIBSIGNAL_RUNTIME_PATCH_ENABLED) {
    logger.info('Patch runtime do libsignal desativado por variável de ambiente.', {
      action: 'libsignal_runtime_patch_disabled',
    });
    return;
  }

  try {
    const recordPatched = patchSessionRecordLogging();
    const cipherPatched = patchSessionCipherNoise();

    if (!recordPatched && !cipherPatched) {
      logger.debug('Patch runtime do libsignal já aplicado previamente.', {
        action: 'libsignal_runtime_patch_already_applied',
      });
      return;
    }

    logger.info('Patch runtime do libsignal aplicado para reduzir ruído de sessão.', {
      action: 'libsignal_runtime_patch_applied',
      version: PATCH_VERSION,
      patchedSessionRecord: recordPatched,
      patchedSessionCipher: cipherPatched,
    });
  } catch (error) {
    logger.warn('Falha ao aplicar patch runtime do libsignal. Seguindo sem patch.', {
      action: 'libsignal_runtime_patch_failed',
      error: error?.message,
    });
  }
};
