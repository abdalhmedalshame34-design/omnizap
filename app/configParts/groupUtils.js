import { baileysGroupsLogger as logger } from './loggerConfig.js';
import { findById, findAll, TABLES } from '../../database/index.js';
import { isGroupJid, isLidJid, isSameJidUser, isWhatsAppJid, normalizeJid } from './baileysConfig.js';
import { parseParticipantsFromDb } from '../services/group/groupMetadataService.js';
import { extractUserIdInfo, resolveUserIdCached } from './baileysConfig.js';
import { getActiveSocket, runSocketMethod } from './baileysConfig.js';

/**
 * Comprimento mínimo de telefone válido para extração de usuário.
 * @type {number}
 */
const USER_ID_DIGITS_MIN = 10;
/**
 * Comprimento máximo de telefone válido para extração de usuário.
 * @type {number}
 */
const USER_ID_DIGITS_MAX = 15;
/**
 * Sufixo oficial de JID de grupos.
 * @type {string}
 */
const GROUP_ID_SUFFIX = '@g.us';

/**
 * Converte valor para string não vazia (trim), ou vazio.
 * @param {unknown} value
 * @returns {string}
 */
const _toNonEmptyString = (value) => {
  if (typeof value !== 'string') return '';
  return value.trim();
};

/**
 * Normaliza qualquer JID possível preservando entradas sem domínio.
 * @param {unknown} value
 * @returns {string}
 */
const _normalizeAnyJid = (value) => {
  const raw = _toNonEmptyString(value);
  if (!raw) return '';
  if (!raw.includes('@')) return raw;
  return normalizeJid(raw) || raw;
};

/**
 * Normaliza e valida ID de grupo.
 * @param {unknown} groupId
 * @returns {string}
 */
const _normalizeGroupId = (groupId) => {
  const normalized = _normalizeAnyJid(groupId);
  if (!normalized) return '';
  if (isGroupJid(normalized)) return normalized;
  if (normalized.endsWith(GROUP_ID_SUFFIX)) return normalized;
  return '';
};

/**
 * Normaliza candidatos de identidade de usuário (JID/LID/telefone).
 * @param {unknown} value
 * @returns {string}
 */
const _normalizeUserIdCandidate = (value) => {
  const raw = _toNonEmptyString(value);
  if (!raw) return '';

  const jidCandidate = _normalizeAnyJid(raw);
  if (jidCandidate && (isWhatsAppJid(jidCandidate) || isLidJid(jidCandidate))) {
    return jidCandidate;
  }

  const digits = _normalizeDigits(raw);
  if (digits.length >= USER_ID_DIGITS_MIN && digits.length <= USER_ID_DIGITS_MAX) {
    return normalizeJid(`${digits}@s.whatsapp.net`) || `${digits}@s.whatsapp.net`;
  }

  return jidCandidate;
};

/**
 * Coleta candidatos de identidade de usuário a partir de string/objeto.
 * @param {unknown} value
 * @returns {string[]}
 */
const _collectUserIdCandidates = (value) => {
  if (!value) return [];

  const candidates = [];
  /**
   * @param {unknown} candidate
   * @returns {void}
   */
  const pushCandidate = (candidate) => {
    const normalized = _normalizeUserIdCandidate(candidate);
    if (!normalized) return;
    if (candidates.some((existing) => _areUserIdsEquivalent(existing, normalized))) return;
    candidates.push(normalized);
  };

  const info = extractUserIdInfo(value);
  pushCandidate(resolveUserIdCached(info));
  pushCandidate(info.jid);
  pushCandidate(info.lid);
  pushCandidate(info.participantAlt);
  pushCandidate(info.raw);

  if (typeof value === 'object') {
    pushCandidate(value.id);
    pushCandidate(value.jid);
    pushCandidate(value.lid);
    pushCandidate(value.participant);
    pushCandidate(value.participantAlt);
    pushCandidate(value.remoteJid);
    pushCandidate(value.remoteJidAlt);
  } else {
    pushCandidate(value);
  }

  return candidates;
};

/**
 * Extrai candidatos de identidade a partir de um participante.
 * @param {unknown} participant
 * @returns {string[]}
 */
const _extractParticipantCandidates = (participant) => {
  if (!participant) return [];
  const raw = typeof participant === 'string' ? { id: participant } : participant;

  const info = extractUserIdInfo(raw);
  const candidates = [];
  /**
   * @param {unknown} candidate
   * @returns {void}
   */
  const pushCandidate = (candidate) => {
    const normalized = _normalizeUserIdCandidate(candidate);
    if (!normalized) return;
    if (candidates.some((existing) => _areUserIdsEquivalent(existing, normalized))) return;
    candidates.push(normalized);
  };

  pushCandidate(resolveUserIdCached(info));
  pushCandidate(raw.id);
  pushCandidate(raw.jid);
  pushCandidate(raw.lid);
  pushCandidate(raw.participant);
  pushCandidate(raw.participantAlt);
  pushCandidate(info.jid);
  pushCandidate(info.lid);
  pushCandidate(info.participantAlt);
  pushCandidate(info.raw);

  return candidates;
};

/**
 * Resolve versão canônica de usuário via cache LID/JID.
 * @param {unknown} value
 * @returns {string}
 */
const _resolveCanonicalCachedUserId = (value) => {
  const normalized = _normalizeUserIdCandidate(value);
  if (!normalized) return '';
  const resolved = resolveUserIdCached({
    jid: normalized,
    lid: normalized,
    participantAlt: normalized,
  });
  return _normalizeUserIdCandidate(resolved || normalized);
};

/**
 * Verifica equivalência entre dois identificadores de usuário.
 * @param {unknown} leftValue
 * @param {unknown} rightValue
 * @returns {boolean}
 */
const _areUserIdsEquivalent = (leftValue, rightValue) => {
  const left = _normalizeUserIdCandidate(leftValue);
  const right = _normalizeUserIdCandidate(rightValue);
  if (!left || !right) return false;
  if (left === right) return true;

  if (left.includes('@') && right.includes('@')) {
    try {
      if (isSameJidUser(left, right)) return true;
    } catch {
      // ignora erro de comparação em JID inválido e segue para os fallbacks
    }
  }

  const leftCanonical = _resolveCanonicalCachedUserId(left);
  const rightCanonical = _resolveCanonicalCachedUserId(right);
  if (leftCanonical && rightCanonical && leftCanonical === rightCanonical) return true;

  const leftDigits = _normalizeDigits(left);
  const rightDigits = _normalizeDigits(right);
  if (!leftDigits || !rightDigits) return false;

  return leftDigits === rightDigits || leftDigits.endsWith(rightDigits) || rightDigits.endsWith(leftDigits);
};

/**
 * Indica se um participante é admin/superadmin.
 * @param {any} participant
 * @returns {boolean}
 */
const _isParticipantAdmin = (participant) => Boolean(participant && (participant.admin === 'admin' || participant.admin === 'superadmin' || participant.isAdmin === true));

/**
 * Detecta se valor se comporta como socket Baileys.
 * @param {unknown} value
 * @param {string} [methodName]
 * @returns {boolean}
 */
const _isSocketLike = (value, methodName) => {
  if (!value || typeof value !== 'object') return false;
  if (methodName && typeof value[methodName] === 'function') return true;
  if (typeof value.sendMessage === 'function') return true;
  if (value.ws || value.ev) return true;
  return false;
};

/**
 * Resolve assinatura flexível `sock + args` para helpers de grupo.
 * @param {string} methodName
 * @param {any[]} [inputArgs=[]]
 * @returns {{sock: any, args: any[]}}
 */
const _resolveSocketAndArgs = (methodName, inputArgs = []) => {
  const [firstArg, ...remaining] = inputArgs;
  if (_isSocketLike(firstArg, methodName)) {
    return {
      sock: firstArg,
      args: remaining,
    };
  }

  return {
    sock: null,
    args: inputArgs,
  };
};

/**
 * Normaliza lista de participantes removendo duplicados equivalentes.
 * @param {any[]} [participants=[]]
 * @returns {string[]}
 */
const _normalizeParticipantsInput = (participants = []) => {
  if (!Array.isArray(participants)) return [];
  const normalized = [];
  for (const participant of participants) {
    const candidate = extractUserId(participant) || _normalizeUserIdCandidate(participant);
    if (!candidate) continue;
    if (normalized.some((existing) => _areUserIdsEquivalent(existing, candidate))) continue;
    normalized.push(candidate);
  }
  return normalized;
};

/**
 * Converte valor para número finito ou `null`.
 * @param {unknown} value
 * @returns {number|null}
 */
const _normalizeNumberOrNull = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * Valida um ID de grupo ou usuário.
 * @param {string} id - O ID a ser validado.
 * @param {string} type - O tipo de ID ('Grupo' ou 'Usuário').
 * @returns {boolean} True se o ID for válido, false caso contrário.
 */
export function _isValidId(id, type = 'ID') {
  const normalized = _toNonEmptyString(id);
  if (!normalized) {
    logger.warn(`Tentativa de operação com ${type} inválido.`, { id });
    return false;
  }

  if (type === 'Grupo' && !_normalizeGroupId(normalized)) {
    logger.warn('Tentativa de operação com ID de grupo inválido.', { id });
    return false;
  }

  return true;
}

/**
 * Retorna todos os dados de um grupo específico.
 * @param {string} groupId - O ID do grupo.
 * @returns {object|null} Os dados do grupo ou null se não encontrado ou se o ID for inválido.
 */
export async function getGroupInfo(groupId) {
  return await getGroupInfoAsync(groupId);
}

/**
 * Retorna o assunto (nome) de um grupo específico.
 * @param {string} groupId - O ID do grupo.
 * @returns {string|null} O assunto do grupo ou null se não encontrado.
 */
export async function getGroupSubject(groupId) {
  const group = await getGroupInfoAsync(groupId);
  return group?.subject || null;
}

/**
 * Retorna a lista de participantes de um grupo específico.
 * @param {string} groupId - O ID do grupo.
 * @returns {Array<object>|null} A lista de participantes ou null se não encontrado.
 */
export async function getGroupParticipants(groupId) {
  return await getGroupParticipantsAsync(groupId);
}

/**
 * Extrai o ID do usuário (canônico quando possível).
 * @param {object|string} userObj - Objeto de mensagem ou string do ID.
 * @returns {string|null} O ID do usuário ou null se não encontrado.
 */
export function extractUserId(userObj) {
  const candidates = _collectUserIdCandidates(userObj);
  return candidates[0] || null;
}

/**
 * Verifica se um usuário é administrador em um grupo específico.
 * Aceita tanto string quanto objeto de mensagem para userId.
 * @param {string} groupId - O ID do grupo.
 * @param {string|object} userIdOrObj - O ID do usuário ou objeto de mensagem.
 * @returns {boolean} True se o usuário for admin, false caso contrário.
 */
export async function isUserAdmin(groupId, userIdOrObj) {
  return await isUserAdminAsync(groupId, userIdOrObj);
}

/**
 * Mantém apenas dígitos de uma string.
 * @param {string} str
 * @returns {string}
 */
export function _normalizeDigits(str) {
  if (!str || typeof str !== 'string') return '';
  return str.replace(/\D/g, '');
}

/**
 * Verifica se o participante corresponde ao usuário informado.
 * @param {any} participant
 * @param {unknown} userIdOrObj
 * @returns {boolean}
 */
export function _matchesParticipantId(participant, userIdOrObj) {
  if (!participant || !userIdOrObj) return false;
  const participantCandidates = _extractParticipantCandidates(participant);
  if (!participantCandidates.length) return false;

  const userCandidates = _collectUserIdCandidates(userIdOrObj);
  if (!userCandidates.length) return false;

  return participantCandidates.some((participantId) => userCandidates.some((userId) => _areUserIdsEquivalent(participantId, userId)));
}

/**
 * Busca as informações do grupo no banco de dados.
 * @param {string} groupId
 * @returns {Promise<object|null>} objeto do grupo ou null
 */
export async function getGroupInfoAsync(groupId) {
  const normalizedGroupId = _normalizeGroupId(groupId);
  if (!_isValidId(normalizedGroupId, 'Grupo')) return null;

  try {
    const row = await findById(TABLES.GROUPS_METADATA, normalizedGroupId);
    if (!row) return null;
    const data = Array.isArray(row) ? row[0] : row;
    if (!data) return null;

    const participants = parseParticipantsFromDb(data.participants || data.participants_json || null);
    const creation = _normalizeNumberOrNull(data.creation);
    const ephemeralDuration = _normalizeNumberOrNull(data.ephemeral_duration ?? data.ephemeralDuration);
    const linkedParent = _normalizeGroupId(data.linked_parent_jid || data.linkedParent) || null;

    const group = {
      id: _normalizeGroupId(data.id) || normalizedGroupId,
      subject: data.subject || data.name || null,
      desc: data.description || data.desc || null,
      owner: _normalizeUserIdCandidate(data.owner_jid || data.owner) || null,
      creation,
      participants: Array.isArray(participants) ? participants : [],
      restrict: Boolean(data.restrict),
      announce: Boolean(data.announce),
      isCommunity: Boolean(data.is_community ?? data.isCommunity),
      isCommunityAnnounce: Boolean(data.is_community_announce ?? data.isCommunityAnnounce),
      linkedParent,
      memberAddMode: data.member_add_mode === null || data.member_add_mode === undefined ? null : Boolean(data.member_add_mode),
      joinApprovalMode: data.join_approval_mode === null || data.join_approval_mode === undefined ? null : Boolean(data.join_approval_mode),
      addressingMode: data.addressing_mode || data.addressingMode || null,
      ephemeralDuration,
    };
    group.size = group.participants.length;
    return group;
  } catch (error) {
    logger.error(`Erro ao buscar grupo do DB ${normalizedGroupId}: ${error.message}`, { error });
    return null;
  }
}

/**
 * Retorna participantes normalizados do grupo.
 * @param {string} groupId
 * @returns {Promise<Array<object>|null>}
 */
export async function getGroupParticipantsAsync(groupId) {
  const group = await getGroupInfoAsync(groupId);
  return group ? group.participants : null;
}

/**
 * Versão assíncrona de validação de admin no grupo.
 * @param {string} groupId
 * @param {string|object} userIdOrObj
 * @returns {Promise<boolean>}
 */
export async function isUserAdminAsync(groupId, userIdOrObj) {
  const normalizedGroupId = _normalizeGroupId(groupId);
  const userCandidates = _collectUserIdCandidates(userIdOrObj);
  if (!_isValidId(normalizedGroupId, 'Grupo') || userCandidates.length === 0) return false;

  const participants = await getGroupParticipantsAsync(normalizedGroupId);
  if (!participants || participants.length === 0) return false;

  return participants.some((participant) => _isParticipantAdmin(participant) && userCandidates.some((candidate) => _matchesParticipantId(participant, candidate)));
}

/**
 * Retorna administradores normalizados de um grupo.
 * @param {string} groupId
 * @returns {Promise<string[]>}
 */
export async function getGroupAdminsAsync(groupId) {
  const normalizedGroupId = _normalizeGroupId(groupId);
  if (!_isValidId(normalizedGroupId, 'Grupo')) return [];
  const participants = await getGroupParticipantsAsync(normalizedGroupId);
  if (!participants || participants.length === 0) return [];

  const admins = [];
  return participants
    .filter((participant) => _isParticipantAdmin(participant))
    .map((participant) => participant.id || participant.jid || participant.lid || null)
    .reduce((acc, candidate) => {
      const normalized = _normalizeUserIdCandidate(candidate);
      if (!normalized) return acc;
      if (acc.some((existing) => _areUserIdsEquivalent(existing, normalized))) return acc;
      acc.push(normalized);
      return acc;
    }, admins);
}

/**
 * Retorna todos os IDs de grupo disponíveis.
 * @returns {Array<string>} Uma lista de IDs de grupo.
 */
export async function getAllGroupIds() {
  try {
    const rows = await findAll(TABLES.GROUPS_METADATA, 10000, 0);
    if (!rows || !Array.isArray(rows)) return [];
    const ids = [];
    for (const row of rows) {
      const candidate = row?.id || row?.[Object.keys(row || {})[0]];
      const normalized = _normalizeGroupId(candidate);
      if (!normalized) continue;
      if (ids.includes(normalized)) continue;
      ids.push(normalized);
    }
    return ids;
  } catch (error) {
    logger.error('Erro ao buscar todos os IDs de grupos do DB', { error });
    return [];
  }
}

/**
 * Retorna o proprietário de um grupo específico.
 * @param {string} groupId - O ID do grupo.
 * @returns {string|null} O ID do proprietário do grupo ou null se não encontrado.
 */
export async function getGroupOwner(groupId) {
  const group = await getGroupInfoAsync(groupId);
  return group?.owner || null;
}

/**
 * Retorna o timestamp de criação de um grupo específico.
 * @param {string} groupId - O ID do grupo.
 * @returns {number|null} O timestamp de criação do grupo ou null se não encontrado.
 */
export async function getGroupCreationTime(groupId) {
  const group = await getGroupInfoAsync(groupId);
  return group?.creation || null;
}

/**
 * Retorna a descrição de um grupo específico.
 * @param {string} groupId - O ID do grupo.
 * @returns {string|null} A descrição do grupo ou null se não encontrado.
 */
export async function getGroupDescription(groupId) {
  const group = await getGroupInfoAsync(groupId);
  return group?.desc || null;
}

/**
 * Retorna o número de participantes de um grupo específico.
 * @param {string} groupId - O ID do grupo.
 * @returns {number|null} O número de participantes do grupo ou null se não encontrado.
 */
export async function getGroupSize(groupId) {
  const group = await getGroupInfoAsync(groupId);
  return group?.size || null;
}

/**
 * Verifica se um grupo é restrito.
 * @param {string} groupId - O ID do grupo.
 * @returns {boolean} True se o grupo for restrito, false caso contrário.
 */
export async function isGroupRestricted(groupId) {
  const group = await getGroupInfoAsync(groupId);
  return !!group?.restrict;
}

/**
 * Verifica se um grupo é apenas para anúncios.
 * @param {string} groupId - O ID do grupo.
 * @returns {boolean} True se o grupo for apenas para anúncios, false caso contrário.
 */
export async function isGroupAnnounceOnly(groupId) {
  const group = await getGroupInfoAsync(groupId);
  return !!group?.announce;
}

/**
 * Verifica se um grupo é uma comunidade.
 * @param {string} groupId - O ID do grupo.
 * @returns {boolean} True se o grupo for uma comunidade, false caso contrário.
 */
export async function isGroupCommunity(groupId) {
  const group = await getGroupInfoAsync(groupId);
  return !!group?.isCommunity;
}

/**
 * Retorna uma lista de IDs dos administradores de um grupo específico.
 * @param {string} groupId - O ID do grupo.
 * @returns {Array<string>} Uma lista de IDs dos administradores do grupo.
 */
export async function getGroupAdmins(groupId) {
  return await getGroupAdminsAsync(groupId);
}

/**
 * Executa uma função de grupo de forma segura, validando os parâmetros e tratando erros.
 * @param {object} sock - A instância do socket Baileys.
 * @param {string} functionName - O nome da função a ser executada.
 * @param {Array} args - Os argumentos para a função.
 * @param {string} errorMessage - A mensagem de erro a ser registrada.
 */
export async function _safeGroupApiCall(sock, functionName, args, errorMessage) {
  const safeFunctionName = _toNonEmptyString(functionName);
  const safeArgs = Array.isArray(args) ? args : [];
  const socket = _isSocketLike(sock, safeFunctionName) ? sock : getActiveSocket();

  if (!safeFunctionName) {
    throw new Error('Nome da função de grupo inválido.');
  }

  try {
    if (socket?.ws) {
      return await runSocketMethod(socket, safeFunctionName, ...safeArgs);
    }

    const directMethod = socket?.[safeFunctionName];
    if (typeof directMethod !== 'function') {
      throw new Error(`Método "${safeFunctionName}" não disponível no socket informado.`);
    }

    return await directMethod.apply(socket, safeArgs);
  } catch (error) {
    logger.error(errorMessage, {
      function: safeFunctionName,
      args: safeArgs,
      socketProvided: Boolean(sock),
      error: error.message,
      stack: error.stack,
    });
    throw error;
  }
}

/**
 * Cria grupo no WhatsApp.
 * Aceita assinatura flexível com ou sem socket explícito.
 * @param {any} sockOrTitle
 * @param {string|Array<any>} titleOrParticipants
 * @param {Array<any>} [participantsMaybe]
 * @returns {Promise<any>}
 */
export async function createGroup(sockOrTitle, titleOrParticipants, participantsMaybe) {
  const { sock, args } = _resolveSocketAndArgs('groupCreate', [sockOrTitle, titleOrParticipants, participantsMaybe]);
  const [title, participants] = args;
  if (typeof title !== 'string' || title.trim() === '' || !Array.isArray(participants)) {
    throw new Error('Título ou participantes inválidos.');
  }

  const normalizedParticipants = _normalizeParticipantsInput(participants);
  if (normalizedParticipants.length === 0) {
    throw new Error('Nenhum participante válido informado para criar grupo.');
  }

  const cleanTitle = title.trim();
  const result = await _safeGroupApiCall(sock, 'groupCreate', [cleanTitle, normalizedParticipants], 'Erro ao criar grupo');
  logger.info(`Grupo "${cleanTitle}" criado com sucesso.`, { id: result?.id || null });
  return result;
}

/**
 * Atualiza participantes de grupo (add/remove/promote/demote).
 * @param {any} sockOrGroupId
 * @param {string|Array<any>} groupIdOrParticipants
 * @param {Array<any>|string} participantsOrAction
 * @param {string} [actionMaybe]
 * @returns {Promise<any>}
 */
export async function updateGroupParticipants(sockOrGroupId, groupIdOrParticipants, participantsOrAction, actionMaybe) {
  const { sock, args } = _resolveSocketAndArgs('groupParticipantsUpdate', [sockOrGroupId, groupIdOrParticipants, participantsOrAction, actionMaybe]);
  const [groupId, participants, action] = args;

  const normalizedGroupId = _normalizeGroupId(groupId);
  const normalizedParticipants = _normalizeParticipantsInput(participants);
  const normalizedAction = _toNonEmptyString(action).toLowerCase();

  if (!_isValidId(normalizedGroupId, 'Grupo') || normalizedParticipants.length === 0 || !normalizedAction) {
    throw new Error('Argumentos inválidos para atualizar participantes.');
  }

  return _safeGroupApiCall(sock, 'groupParticipantsUpdate', [normalizedGroupId, normalizedParticipants, normalizedAction], `Erro ao ${normalizedAction} participantes no grupo ${normalizedGroupId}`);
}

/**
 * Atualiza assunto do grupo.
 * @param {any} sockOrGroupId
 * @param {string} groupIdOrSubject
 * @param {string} [subjectMaybe]
 * @returns {Promise<any>}
 */
export async function updateGroupSubject(sockOrGroupId, groupIdOrSubject, subjectMaybe) {
  const { sock, args } = _resolveSocketAndArgs('groupUpdateSubject', [sockOrGroupId, groupIdOrSubject, subjectMaybe]);
  const [groupId, subject] = args;

  const normalizedGroupId = _normalizeGroupId(groupId);
  const normalizedSubject = _toNonEmptyString(subject);

  if (!_isValidId(normalizedGroupId, 'Grupo') || !normalizedSubject) {
    throw new Error('Argumentos inválidos para atualizar assunto do grupo.');
  }

  return _safeGroupApiCall(sock, 'groupUpdateSubject', [normalizedGroupId, normalizedSubject], `Erro ao atualizar assunto do grupo ${normalizedGroupId}`);
}

/**
 * Atualiza descrição do grupo.
 * @param {any} sockOrGroupId
 * @param {string} groupIdOrDescription
 * @param {string} [descriptionMaybe]
 * @returns {Promise<any>}
 */
export async function updateGroupDescription(sockOrGroupId, groupIdOrDescription, descriptionMaybe) {
  const { sock, args } = _resolveSocketAndArgs('groupUpdateDescription', [sockOrGroupId, groupIdOrDescription, descriptionMaybe]);
  const [groupId, description] = args;

  const normalizedGroupId = _normalizeGroupId(groupId);
  if (!_isValidId(normalizedGroupId, 'Grupo') || typeof description !== 'string') {
    throw new Error('ID de grupo inválido.');
  }

  return _safeGroupApiCall(sock, 'groupUpdateDescription', [normalizedGroupId, description], `Erro ao atualizar descrição do grupo ${normalizedGroupId}`);
}

/**
 * Atualiza configuração geral do grupo.
 * @param {any} sockOrGroupId
 * @param {string} groupIdOrSetting
 * @param {string} [settingMaybe]
 * @returns {Promise<any>}
 */
export async function updateGroupSettings(sockOrGroupId, groupIdOrSetting, settingMaybe) {
  const { sock, args } = _resolveSocketAndArgs('groupSettingUpdate', [sockOrGroupId, groupIdOrSetting, settingMaybe]);
  const [groupId, setting] = args;

  const normalizedGroupId = _normalizeGroupId(groupId);
  const normalizedSetting = _toNonEmptyString(setting);

  if (!_isValidId(normalizedGroupId, 'Grupo') || !normalizedSetting) {
    throw new Error('Argumentos inválidos para atualizar configurações do grupo.');
  }

  return _safeGroupApiCall(sock, 'groupSettingUpdate', [normalizedGroupId, normalizedSetting], `Erro ao atualizar configurações do grupo ${normalizedGroupId}`);
}

/**
 * Sai de um grupo.
 * @param {any} sockOrGroupId
 * @param {string} [groupIdMaybe]
 * @returns {Promise<any>}
 */
export async function leaveGroup(sockOrGroupId, groupIdMaybe) {
  const { sock, args } = _resolveSocketAndArgs('groupLeave', [sockOrGroupId, groupIdMaybe]);
  const [groupId] = args;
  const normalizedGroupId = _normalizeGroupId(groupId);

  if (!_isValidId(normalizedGroupId, 'Grupo')) {
    throw new Error('ID de grupo inválido.');
  }

  return _safeGroupApiCall(sock, 'groupLeave', [normalizedGroupId], `Erro ao sair do grupo ${normalizedGroupId}`);
}

/**
 * Obtém código de convite do grupo.
 * @param {any} sockOrGroupId
 * @param {string} [groupIdMaybe]
 * @returns {Promise<any>}
 */
export async function getGroupInviteCode(sockOrGroupId, groupIdMaybe) {
  const { sock, args } = _resolveSocketAndArgs('groupInviteCode', [sockOrGroupId, groupIdMaybe]);
  const [groupId] = args;
  const normalizedGroupId = _normalizeGroupId(groupId);

  if (!_isValidId(normalizedGroupId, 'Grupo')) {
    throw new Error('ID de grupo inválido.');
  }

  return _safeGroupApiCall(sock, 'groupInviteCode', [normalizedGroupId], `Erro ao obter código de convite do grupo ${normalizedGroupId}`);
}

/**
 * Revoga o código de convite atual do grupo.
 * @param {any} sockOrGroupId
 * @param {string} [groupIdMaybe]
 * @returns {Promise<any>}
 */
export async function revokeGroupInviteCode(sockOrGroupId, groupIdMaybe) {
  const { sock, args } = _resolveSocketAndArgs('groupRevokeInvite', [sockOrGroupId, groupIdMaybe]);
  const [groupId] = args;
  const normalizedGroupId = _normalizeGroupId(groupId);

  if (!_isValidId(normalizedGroupId, 'Grupo')) {
    throw new Error('ID de grupo inválido.');
  }

  return _safeGroupApiCall(sock, 'groupRevokeInvite', [normalizedGroupId], `Erro ao revogar código de convite do grupo ${normalizedGroupId}`);
}

/**
 * Aceita convite de grupo via código.
 * @param {any} sockOrCode
 * @param {string} [codeMaybe]
 * @returns {Promise<any>}
 */
export async function acceptGroupInvite(sockOrCode, codeMaybe) {
  const { sock, args } = _resolveSocketAndArgs('groupAcceptInvite', [sockOrCode, codeMaybe]);
  const [code] = args;
  const normalizedCode = _toNonEmptyString(code);

  if (!normalizedCode) {
    throw new Error('Código de convite inválido.');
  }

  return _safeGroupApiCall(sock, 'groupAcceptInvite', [normalizedCode], 'Erro ao aceitar convite de grupo');
}

/**
 * Obtém metadados de convite de grupo.
 * @param {any} sockOrCode
 * @param {string} [codeMaybe]
 * @returns {Promise<any>}
 */
export async function getGroupInfoFromInvite(sockOrCode, codeMaybe) {
  const { sock, args } = _resolveSocketAndArgs('groupGetInviteInfo', [sockOrCode, codeMaybe]);
  const [code] = args;
  const normalizedCode = _toNonEmptyString(code);

  if (!normalizedCode) {
    throw new Error('Código de convite inválido.');
  }

  return _safeGroupApiCall(sock, 'groupGetInviteInfo', [normalizedCode], 'Erro ao obter informações do convite');
}

/**
 * Obtém metadados completos do grupo.
 * @param {any} sockOrGroupId
 * @param {string} [groupIdMaybe]
 * @returns {Promise<any>}
 */
export async function getGroupMetadata(sockOrGroupId, groupIdMaybe) {
  const { sock, args } = _resolveSocketAndArgs('groupMetadata', [sockOrGroupId, groupIdMaybe]);
  const [groupId] = args;
  const normalizedGroupId = _normalizeGroupId(groupId);

  if (!_isValidId(normalizedGroupId, 'Grupo')) {
    throw new Error('ID de grupo inválido.');
  }

  return _safeGroupApiCall(sock, 'groupMetadata', [normalizedGroupId], `Erro ao obter metadados do grupo ${normalizedGroupId}`);
}

/**
 * Lista solicitações pendentes de entrada no grupo.
 * @param {any} sockOrGroupId
 * @param {string} [groupIdMaybe]
 * @returns {Promise<any>}
 */
export async function getGroupRequestParticipantsList(sockOrGroupId, groupIdMaybe) {
  const { sock, args } = _resolveSocketAndArgs('groupRequestParticipantsList', [sockOrGroupId, groupIdMaybe]);
  const [groupId] = args;
  const normalizedGroupId = _normalizeGroupId(groupId);

  if (!_isValidId(normalizedGroupId, 'Grupo')) {
    throw new Error('ID de grupo inválido.');
  }

  return _safeGroupApiCall(sock, 'groupRequestParticipantsList', [normalizedGroupId], `Erro ao listar solicitações de entrada no grupo ${normalizedGroupId}`);
}

/**
 * Atualiza solicitações de entrada no grupo.
 * @param {any} sockOrGroupId
 * @param {string|Array<any>} groupIdOrParticipants
 * @param {Array<any>|string} participantsOrAction
 * @param {string} [actionMaybe]
 * @returns {Promise<any>}
 */
export async function updateGroupRequestParticipants(sockOrGroupId, groupIdOrParticipants, participantsOrAction, actionMaybe) {
  const { sock, args } = _resolveSocketAndArgs('groupRequestParticipantsUpdate', [sockOrGroupId, groupIdOrParticipants, participantsOrAction, actionMaybe]);
  const [groupId, participants, action] = args;

  const normalizedGroupId = _normalizeGroupId(groupId);
  const normalizedParticipants = _normalizeParticipantsInput(participants);
  const normalizedAction = _toNonEmptyString(action).toLowerCase();

  if (!_isValidId(normalizedGroupId, 'Grupo') || normalizedParticipants.length === 0 || !normalizedAction) {
    throw new Error('Argumentos inválidos para atualizar solicitações de entrada.');
  }

  return _safeGroupApiCall(sock, 'groupRequestParticipantsUpdate', [normalizedGroupId, normalizedParticipants, normalizedAction], `Erro ao atualizar solicitações de entrada no grupo ${normalizedGroupId}`);
}

/**
 * Busca todos os grupos participantes da conta conectada.
 * @param {any} [sock]
 * @returns {Promise<any>}
 */
export async function getAllParticipatingGroups(sock) {
  const socket = _isSocketLike(sock, 'groupFetchAllParticipating') ? sock : null;
  return _safeGroupApiCall(socket, 'groupFetchAllParticipating', [], 'Erro ao obter todos os grupos participantes');
}

/**
 * Ativa/desativa mensagens efêmeras no grupo.
 * @param {any} sockOrGroupId
 * @param {string|number} groupIdOrDuration
 * @param {number} [durationMaybe]
 * @returns {Promise<any>}
 */
export async function toggleEphemeral(sockOrGroupId, groupIdOrDuration, durationMaybe) {
  const { sock, args } = _resolveSocketAndArgs('groupToggleEphemeral', [sockOrGroupId, groupIdOrDuration, durationMaybe]);
  const [groupId, duration] = args;

  const normalizedGroupId = _normalizeGroupId(groupId);
  const normalizedDuration = Number(duration);

  if (!_isValidId(normalizedGroupId, 'Grupo') || !Number.isFinite(normalizedDuration)) {
    throw new Error('Argumentos inválidos para alternar mensagens efêmeras.');
  }

  return _safeGroupApiCall(sock, 'groupToggleEphemeral', [normalizedGroupId, normalizedDuration], `Erro ao alternar mensagens efêmeras no grupo ${normalizedGroupId}`);
}

/**
 * Atualiza modo de adição de membros no grupo.
 * @param {any} sockOrGroupId
 * @param {string} groupIdOrMode
 * @param {string} [modeMaybe]
 * @returns {Promise<any>}
 */
export async function updateGroupAddMode(sockOrGroupId, groupIdOrMode, modeMaybe) {
  const { sock, args } = _resolveSocketAndArgs('groupMemberAddMode', [sockOrGroupId, groupIdOrMode, modeMaybe]);
  const [groupId, mode] = args;

  const normalizedGroupId = _normalizeGroupId(groupId);
  const normalizedMode = _toNonEmptyString(mode);

  if (!_isValidId(normalizedGroupId, 'Grupo') || !normalizedMode) {
    throw new Error('Argumentos inválidos para atualizar modo de adição.');
  }

  return _safeGroupApiCall(sock, 'groupMemberAddMode', [normalizedGroupId, normalizedMode], `Erro ao atualizar modo de adição no grupo ${normalizedGroupId}`);
}
