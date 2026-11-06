/**
 * The run-log kinds that mark something going wrong: what the debug panel lists as failures and
 * what flags a session as failing in the deployment's logs.
 */
export const failureKinds: ReadonlySet<string> = new Set([
  "agent_failed",
  "agent_refused",
  "projection_failed",
  "lock_deadline",
  "build_stall",
  "play_stall",
  "first_frame_stall",
  "deadline_missed",
  "clip_failed",
  "enqueue_failed",
  "enqueue_refused",
  "boxes_failed",
  "agent_aborted",
  "speculate_failed",
  "slot_failed",
  "upload_failed",
  "play_command_failed",
  "move_failed",
  "pop_failed",
  "command_error",
  "omni_error",
  "black_frame",
  "stall",
  "retry",
  "candidates_cut",
  "pass_refused",
]);
