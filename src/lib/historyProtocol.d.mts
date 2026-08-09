export type HistoryFingerprint = {
  v: number;
  c: number;
  u: number;
  h: number;
};

export function fingerprintHistory(
  history: readonly unknown[],
  undoneCount?: number,
  windowSize?: number,
): { fp: HistoryFingerprint; keys: string[] };
