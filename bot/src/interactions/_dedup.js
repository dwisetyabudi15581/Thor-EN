/**
 * Interaction dedup helper — prevents double-processing of the same interaction.
 *
 * P1-6 FIX: track processed interactions to avoid double-processing.
 * Previously modal submits slipped past the `replied/deferred` guard → could double-reply.
 *
 * v3.9.8 FIX: replace the bulk-clear with a per-entry TTL. Previously the Set was
 * fully cleared every 5 minutes, so the 5-15 minute window (Discord interaction
 * tokens are valid for 15 minutes) could re-process the same interaction
 * (duplicate key/DM race).
 * Now: store { id, ts }, prune entries older than 15 minutes.
 *
 * v3.9.9 refactor: moved from handlers/interactionHandler.js to here so it is
 * shared by the router (src/interactions/index.js) and all domain handlers.
 * Previously the dedup Map lived inside the old module; it is now a singleton
 * shared across domains.
 */

const processedInteractions = new Map();
const PROCESSED_TTL_MS = 15 * 60 * 1000; // 15 minutes — matches the Discord interaction token lifetime

// Periodic cleanup so the Map doesn't bloat
setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    for (const [id, ts] of processedInteractions) {
        if (now - ts > PROCESSED_TTL_MS) {
            processedInteractions.delete(id);
            cleaned++;
        }
    }
    if (cleaned > 0 && processedInteractions.size > 100) {
        // Only log when cleanup removed a lot (defensive)
        console.log(`🧹 processedInteractions: ${cleaned} entries pruned.`);
    }
}, 60 * 1000).unref?.();

/**
 * Check whether an interaction ID was processed within the TTL window.
 *
 * v3.9.38 FIX: split into `check` + `mark` (mark is now called by the router
 * AFTER handler success — previously checkAndMark marked BEFORE the handler
 * ran, so if the handler crashed/errored, the gateway replay from Discord for
 * the same interaction got swallowed → the user's action silently vanished).
 *
 * @param {string} interactionId - interaction.id from Discord
 * @returns {boolean} true if ALREADY processed within the TTL (the caller must skip).
 */
function check(interactionId) {
    if (!interactionId) return false;
    const now = Date.now();
    const prevTs = processedInteractions.get(interactionId);
    return !!(prevTs && now - prevTs < PROCESSED_TTL_MS);
}

/**
 * Mark an interaction ID as processed (with a fresh timestamp now).
 * Idempotent — marking the same id twice only refreshes the timestamp.
 * @param {string} interactionId - interaction.id from Discord
 */
function mark(interactionId) {
    if (!interactionId) return;
    processedInteractions.set(interactionId, Date.now());
}

/**
 * Check + mark in one go (combination of check() then mark()).
 * Backward compat — kept for callers outside the router.
 *
 * @param {string} interactionId - interaction.id from Discord
 * @returns {boolean} true if ALREADY processed (the caller must skip),
 *                    false if NOT YET (and now marked).
 *
 * v3.9.8: if an entry exists but is older than the TTL, treat it as unprocessed
 * (return false) and overwrite its timestamp with `now`.
 */
function checkAndMark(interactionId) {
    if (check(interactionId)) {
        return true; // already processed — skip
    }
    mark(interactionId);
    return false;
}

module.exports = {
    checkAndMark,
    // v3.9.38: granular — check without mark, mark without check
    check,
    mark,
    processedInteractions, // exposed for testing/debug
    PROCESSED_TTL_MS
};
