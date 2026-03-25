/**
 * Normaliza `assignmentVersion` para um inteiro positivo.
 * @param {unknown} value
 * @returns {number | null}
 */
export const normalizeAssignmentVersion = (value) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
};

/**
 * @typedef {{
 *   allowed: boolean,
 *   ownerSessionId: string | null,
 *   assignmentVersion: number | null,
 *   reason: string
 * }} GroupOwnerWriteResolution
 */
/**
 * @typedef {{
 *   allowClaim?: boolean,
 *   bypassCache?: boolean,
 *   source?: string,
 *   expectedAssignmentVersion?: number | string | null,
 *   enforceFence?: boolean
 * }} GroupOwnerWriteResolverOptions
 */
/**
 * @typedef {{
 *   buildCacheKeyImpl: (groupJid: string, sessionId: string) => string,
 *   getOwnerImpl: (groupJid: string, options?: { bypassCache?: boolean }) => Promise<{ ownerSessionId?: string | null, assignmentVersion?: number | string | null } | null | undefined>,
 *   tryAcquireImpl: (options: {
 *     groupJid: string,
 *     sessionId: string,
 *     reason: string,
 *     changedBy: string,
 *     metadata?: Record<string, any>
 *   }) => Promise<{
 *     acquired?: boolean,
 *     reason?: string,
 *     assignmentVersion?: number | string | null,
 *     owner?: { ownerSessionId?: string | null, assignmentVersion?: number | string | null } | null
 *   } | null | undefined>,
 *   cacheImpl: { get: (key: string) => any, set: (key: string, value: any) => any },
 *   isGroupJidImpl: (jid: string) => boolean,
 *   normalizeSessionIdImpl: (sessionId: string | null | undefined) => string,
 *   loggerImpl: { warn: (message: string, meta?: Record<string, any>) => void },
 *   defaultAllowClaim?: boolean
 * }} GroupOwnerWriteResolverDeps
 */
/**
 * Cria um resolvedor de permissão de escrita por ownership de grupo.
 * @param {GroupOwnerWriteResolverDeps} [deps]
 * @returns {(groupJid: string, sessionId: string, options?: GroupOwnerWriteResolverOptions) => Promise<GroupOwnerWriteResolution>}
 */
export const createGroupOwnerWriteStateResolver =
  ({ buildCacheKeyImpl, getOwnerImpl, tryAcquireImpl, cacheImpl, isGroupJidImpl, normalizeSessionIdImpl, loggerImpl, defaultAllowClaim = true } = {}) =>
  async (groupJid, sessionId, { allowClaim = defaultAllowClaim, bypassCache = false, source = 'unknown', expectedAssignmentVersion = null, enforceFence = true } = {}) => {
    const safeGroupJid = String(groupJid || '').trim();
    const safeSessionId = normalizeSessionIdImpl(sessionId);
    if (!safeGroupJid || !isGroupJidImpl(safeGroupJid)) {
      return {
        allowed: true,
        ownerSessionId: null,
        assignmentVersion: null,
        reason: 'not_group',
      };
    }

    const safeExpectedAssignmentVersion = normalizeAssignmentVersion(expectedAssignmentVersion);
    const cacheKey = buildCacheKeyImpl(safeGroupJid, safeSessionId);
    const mustBypassCache = bypassCache || Boolean(enforceFence && safeExpectedAssignmentVersion);

    if (!mustBypassCache && cacheKey) {
      const cached = cacheImpl.get(cacheKey);
      if (cached && typeof cached === 'object') {
        return cached;
      }
    }

    try {
      const ownerState = await getOwnerImpl(safeGroupJid, { bypassCache: mustBypassCache });
      let ownerSessionId = String(ownerState?.ownerSessionId || '').trim() || null;
      let assignmentVersion = normalizeAssignmentVersion(ownerState?.assignmentVersion);
      let allowed = false;
      let reason = 'owned_by_other';

      if (!ownerSessionId && allowClaim) {
        const claimOutcome = await tryAcquireImpl({
          groupJid: safeGroupJid,
          sessionId: safeSessionId,
          reason: 'writer_gate_claim',
          changedBy: safeSessionId,
          metadata: {
            source,
            gate: 'group_write',
          },
        });

        ownerSessionId = String(claimOutcome?.owner?.ownerSessionId || '').trim() || null;
        assignmentVersion = normalizeAssignmentVersion(claimOutcome?.assignmentVersion ?? claimOutcome?.owner?.assignmentVersion);
        allowed = Boolean(claimOutcome?.acquired && ownerSessionId === safeSessionId);
        reason = claimOutcome?.reason || 'claim_attempt';
      } else {
        allowed = Boolean(ownerSessionId && ownerSessionId === safeSessionId);
        reason = !ownerSessionId ? 'owner_missing' : allowed ? 'owner_match' : 'owned_by_other';
      }

      if (allowed && enforceFence && safeExpectedAssignmentVersion && assignmentVersion && assignmentVersion !== safeExpectedAssignmentVersion) {
        allowed = false;
        reason = 'fence_token_mismatch';
      }

      const resolved = {
        allowed,
        ownerSessionId,
        assignmentVersion,
        reason,
      };

      if (cacheKey) {
        cacheImpl.set(cacheKey, resolved);
      }
      return resolved;
    } catch (error) {
      loggerImpl.warn('Falha ao resolver ownership para escrita de grupo.', {
        action: 'group_owner_write_state_failed',
        source,
        sessionId: safeSessionId,
        groupId: safeGroupJid,
        error: error?.message,
      });
      return {
        allowed: false,
        ownerSessionId: null,
        assignmentVersion: null,
        reason: 'owner_resolution_failed',
      };
    }
  };
