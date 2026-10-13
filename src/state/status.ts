import { OLD_AFTER_MS, STALE_AFTER_MS } from '../config.ts';
import type { Snapshot } from '../types/contracts.ts';

/** Freshness of a snapshot by Hypixel's lastUpdated. */
export function ageStatus(snap: Snapshot | null, now: number): 'live' | 'stale' | 'old' | null {
  if (!snap) return null;
  const age = now - snap.lastUpdated;
  return age < STALE_AFTER_MS ? 'live' : age < OLD_AFTER_MS ? 'stale' : 'old';
}
