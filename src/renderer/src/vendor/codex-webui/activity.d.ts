export type ActivityDescription = {
  label: string; detail: string; category?: string; animation: string;
  active: boolean; tone: string;
};
export type ActivityRecord = Record<string, any>;
export function summarizeActivity(item: ActivityRecord): ActivityDescription;
export function joinActivityParts(parts: string[]): string;
export function completedActivitySummary(items: ActivityRecord[], describe?: (item: ActivityRecord) => ActivityDescription): string;
export function completedActivityPrimaryItem(items: ActivityRecord[], describe?: (item: ActivityRecord) => ActivityDescription): ActivityRecord | undefined;
