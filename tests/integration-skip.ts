/**
 * Honest placeholder for `bun run test:integration`.
 *
 * The real isolated OpenCode loading harness (pack to a temp tarball, temp
 * config home, startup/config resolution, live-config hash guard) is owned by
 * Todo 6. Until then this script reports the skip and exits 0 so the script
 * never lies about running the real harness. CI must not mistake this skip for
 * integration coverage — see .omo/evidence/task-2-antigravity-task-plugin.txt.
 */
console.log("SKIP: test:integration - real isolated OpenCode loading harness is implemented in Todo 6.");
