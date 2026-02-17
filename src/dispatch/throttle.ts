/**
 * Throttle state tracking for scheduler dispatch control.
 * Prevents resource exhaustion by rate-limiting task dispatches.
 */

export interface ThrottleState {
  /** Timestamp of last dispatch (global). */
  lastDispatchAt: number;
  /** Timestamp of last dispatch per team. */
  lastDispatchByTeam: Map<string, number>;
}

/** Global throttle state (persists across poll cycles). */
const throttleState: ThrottleState = {
  lastDispatchAt: 0,
  lastDispatchByTeam: new Map(),
};

/** Reset throttle state (for testing). */
export function resetThrottleState(): void {
  throttleState.lastDispatchAt = 0;
  throttleState.lastDispatchByTeam.clear();
}

export interface ThrottleCheckParams {
  taskId: string;
  team?: string;
  currentInProgress: number;
  pendingDispatches: number;
  maxDispatches: number;
  teamInProgress?: number;
  teamMaxConcurrent?: number;
  minDispatchIntervalMs?: number;
  teamMinIntervalMs?: number;
  dispatchesThisPoll: number;
  maxDispatchesPerPoll: number;
}

export interface ThrottleCheckResult {
  allowed: boolean;
  reason?: string;
  waitTimeMs?: number;
}

/**
 * Check if dispatch is allowed based on throttle rules.
 * Returns { allowed: true } if dispatch can proceed, or { allowed: false, reason, waitTimeMs } if throttled.
 */
export function checkThrottle(params: ThrottleCheckParams): ThrottleCheckResult {
  const now = Date.now();

  // 1. Check global concurrency limit
  if (params.currentInProgress + params.pendingDispatches >= params.maxDispatches) {
    return {
      allowed: false,
      reason: `global concurrency ${params.currentInProgress + params.pendingDispatches}/${params.maxDispatches}`,
    };
  }

  // 2. Check per-team concurrency limit
  if (
    params.team &&
    params.teamInProgress !== undefined &&
    params.teamMaxConcurrent !== undefined &&
    params.teamInProgress >= params.teamMaxConcurrent
  ) {
    return {
      allowed: false,
      reason: `team ${params.team} concurrency ${params.teamInProgress}/${params.teamMaxConcurrent}`,
    };
  }

  // 3. Check global dispatch interval
  if (params.minDispatchIntervalMs !== undefined && params.minDispatchIntervalMs > 0) {
    const timeSinceLastDispatch = now - throttleState.lastDispatchAt;
    if (throttleState.lastDispatchAt > 0 && timeSinceLastDispatch < params.minDispatchIntervalMs) {
      const waitTimeMs = params.minDispatchIntervalMs - timeSinceLastDispatch;
      return {
        allowed: false,
        reason: `global interval ${Math.round(timeSinceLastDispatch)}ms < ${params.minDispatchIntervalMs}ms, wait ${Math.round(waitTimeMs)}ms`,
        waitTimeMs,
      };
    }
  }

  // 4. Check per-team dispatch interval
  if (
    params.team &&
    params.teamMinIntervalMs !== undefined &&
    params.teamMinIntervalMs > 0
  ) {
    const teamLastDispatch = throttleState.lastDispatchByTeam.get(params.team) ?? 0;
    const teamTimeSinceLastDispatch = now - teamLastDispatch;
    if (teamLastDispatch > 0 && teamTimeSinceLastDispatch < params.teamMinIntervalMs) {
      const waitTimeMs = params.teamMinIntervalMs - teamTimeSinceLastDispatch;
      return {
        allowed: false,
        reason: `team ${params.team} interval ${Math.round(teamTimeSinceLastDispatch)}ms < ${params.teamMinIntervalMs}ms, wait ${Math.round(waitTimeMs)}ms`,
        waitTimeMs,
      };
    }
  }

  // 5. Check poll cycle dispatch limit
  if (params.dispatchesThisPoll >= params.maxDispatchesPerPoll) {
    return {
      allowed: false,
      reason: `poll cycle limit ${params.dispatchesThisPoll}/${params.maxDispatchesPerPoll}`,
    };
  }

  return { allowed: true };
}

/**
 * Update throttle state after a successful dispatch.
 */
export function updateThrottleState(team?: string): void {
  const dispatchTime = Date.now();
  throttleState.lastDispatchAt = dispatchTime;
  if (team) {
    throttleState.lastDispatchByTeam.set(team, dispatchTime);
  }
}

/**
 * Get current throttle state (for introspection/testing).
 */
export function getThrottleState(): Readonly<ThrottleState> {
  return {
    lastDispatchAt: throttleState.lastDispatchAt,
    lastDispatchByTeam: new Map(throttleState.lastDispatchByTeam),
  };
}
