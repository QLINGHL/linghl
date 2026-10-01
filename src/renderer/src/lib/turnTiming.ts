/** The history endpoint may omit the final-answer timestamp. Keep only observed
 * timing metadata so reopening a turn does not include answer-streaming time. */
type Timing = { startedAtMs?: number; completedAtMs?: number; finalAssistantStartedAtMs?: number };
const key = "codex.flowTiming.v1";
const finiteTime = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;
function read(): Record<string, Timing> {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}
export function savedTurnTiming(threadId: string, turnId: string): Timing {
  const value = read()[threadId + ":" + turnId];
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value).filter(([field, time]) =>
    ["startedAtMs", "completedAtMs", "finalAssistantStartedAtMs"].includes(field) && finiteTime(time)));
}
export function saveTurnTiming(threadId: string, turn: Timing & { id: string }): void {
  if (!finiteTime(turn.startedAtMs)) return;
  const timing = Object.fromEntries(Object.entries(turn).filter(([field, time]) =>
    ["startedAtMs", "completedAtMs", "finalAssistantStartedAtMs"].includes(field) && finiteTime(time)));
  try {
    const cache = read();
    const id = threadId + ":" + turn.id;
    delete cache[id];
    cache[id] = timing;
    localStorage.setItem(key, JSON.stringify(Object.fromEntries(Object.entries(cache).slice(-500))));
  } catch { /* Storage is optional; live timing still works. */ }
}
