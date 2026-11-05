/**
 * Where the answer to one input is, in order: the agent is thinking, writing its first change, the
 * clip is filming, or its first frame is arriving.
 */
export const phaseNames = ["thinking", "writing", "filming", "arriving"] as const;
export type PhaseName = (typeof phaseNames)[number];
