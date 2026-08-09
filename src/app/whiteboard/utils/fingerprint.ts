import { fingerprintHistory } from "@/lib/historyProtocol.mjs";
import { HistoryEvent } from "../types";

export function computeFingerprintFromHistory(history: HistoryEvent[], undoneCount: number) {
  return fingerprintHistory(history, undoneCount).fp;
}
