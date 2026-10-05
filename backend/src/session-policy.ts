export const IDLE_MS = 60 * 60 * 1000;
export const ABSOLUTE_MS = 8 * IDLE_MS;
export const nextExpiry = (now: number, absolute: number) => Math.min(now + IDLE_MS, absolute);
