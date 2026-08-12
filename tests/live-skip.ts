/**
 * Honest placeholder for `bun run test:live`.
 *
 * The real opt-in agy smoke (ANTIGRAVITY_SMOKE=1 gate, plan-mode PONG in an
 * isolated temp worktree, sanitized NDJSON evidence) is owned by Todo 7. Until
 * then this script reports the skip and exits 0 without spawning agy. CI must
 * not mistake this skip for live coverage — see
 * .omo/evidence/task-2-antigravity-task-plugin.txt.
 */
console.log("SKIP: test:live - real opt-in agy smoke is implemented in Todo 7.");
