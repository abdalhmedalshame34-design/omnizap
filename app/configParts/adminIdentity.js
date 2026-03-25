import { encodeJid, getJidUser, isSameJidUser, normalizeJid } from './baileysConfig.js';
import { extractUserIdInfo, resolveUserId, resolveUserIdCached } from './baileysConfig.js';
import { normalizePhoneDigits, resolveAdminIdentityRawFromEnv, resolveAdminPhoneFromEnv } from '../../utils/whatsapp/contactEnv.js';

/**
 * Retorna o valor bruto configurado para identidade de admin.
 * @returns {string}
 */
export const getAdminRawValue = () => resolveAdminIdentityRawFromEnv();

/**
 * Resolve o JID do administrador com base no valor de ambiente.
 * Aceita JID completo ou telefone numérico.
 * @returns {string|null}
 */
export const getAdminJid = () => {
  const raw = getAdminRawValue();
  if (!raw) return null;

  let candidate = '';
  if (raw.includes('@')) {
    candidate = normalizeJid(raw) || raw;
  } else {
    const digits = normalizePhoneDigits(raw);
    if (!digits) return null;
    candidate = normalizeJid(encodeJid(digits, 's.whatsapp.net')) || '';
  }

  if (!candidate) return null;

  const resolvedCached = resolveUserIdCached(extractUserIdInfo(candidate));
  const normalizedResolved = normalizeJid(resolvedCached || candidate);
  return normalizedResolved || candidate;
};

/**
 * Resolve o telefone do administrador.
 * Prioriza `ADMIN_PHONE` explícito e faz fallback para JID/identidade.
 * @returns {string|null}
 */
export const getAdminPhone = () => {
  const explicitAdminPhone = resolveAdminPhoneFromEnv({ fallback: '' });
  if (explicitAdminPhone) return explicitAdminPhone;

  const adminJid = getAdminJid();
  if (!adminJid) return null;

  const user = getJidUser(adminJid);
  if (user) return user;

  const digits = normalizePhoneDigits(adminJid);
  return digits || null;
};

/**
 * Resolve o JID do admin consultando reconciliação LID/JID quando disponível.
 * @returns {Promise<string|null>}
 */
export const resolveAdminJid = async () => {
  const cached = getAdminJid();
  if (!cached) return null;

  try {
    const resolved = await resolveUserId(extractUserIdInfo(cached));
    return normalizeJid(resolved || cached) || cached;
  } catch {
    return cached;
  }
};

/**
 * Verifica se um JID de remetente corresponde ao administrador.
 * @param {string|null|undefined} senderJid
 * @returns {boolean}
 */
export const isAdminSender = (senderJid) => {
  const adminJid = getAdminJid();
  if (!adminJid || !senderJid) return false;

  const normalizedSender = normalizeJid(senderJid);
  if (!normalizedSender) return false;

  return isSameJidUser(normalizedSender, adminJid) || normalizedSender === adminJid;
};

/**
 * Verifica se a identidade do remetente corresponde ao administrador.
 * Considera candidatos `jid`, `lid`, `participantAlt` e resolução assíncrona.
 * @param {unknown} senderIdentity
 * @returns {Promise<boolean>}
 */
export const isAdminSenderAsync = async (senderIdentity) => {
  const senderInfo = extractUserIdInfo(senderIdentity);
  if (!senderInfo.raw && !senderInfo.jid && !senderInfo.lid && !senderInfo.participantAlt) return false;

  const normalizedSender = normalizeJid(senderInfo.jid || senderInfo.raw || '');
  const cachedSender = resolveUserIdCached(senderInfo);
  const normalizedCachedSender = normalizeJid(cachedSender || '');
  const resolvedSender = await resolveUserId(senderInfo).catch(() => null);
  const normalizedResolvedSender = normalizeJid(resolvedSender || '');
  const normalizedSenderLid = normalizeJid(senderInfo.lid || '');
  const normalizedSenderAlt = normalizeJid(senderInfo.participantAlt || '');
  const senderCandidates = new Set([normalizedSender, normalizedCachedSender, normalizedResolvedSender, normalizedSenderLid, normalizedSenderAlt].filter(Boolean));
  if (!senderCandidates.size) return false;

  const rawAdminValue = getAdminRawValue();
  const adminJid = getAdminJid();
  const resolvedAdminJid = await resolveAdminJid();
  const normalizedRawAdmin = rawAdminValue.includes('@') ? normalizeJid(rawAdminValue) || rawAdminValue : '';
  const adminCandidates = new Set([adminJid, resolvedAdminJid, normalizedRawAdmin].filter(Boolean).map((candidate) => normalizeJid(candidate) || candidate));
  if (!adminCandidates.size) return false;

  for (const senderCandidate of senderCandidates) {
    for (const adminCandidate of adminCandidates) {
      if (isSameJidUser(senderCandidate, adminCandidate) || senderCandidate === adminCandidate) {
        return true;
      }
    }
  }
  return false;
};
