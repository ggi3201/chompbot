export interface ScheduleContext {
  services: string[];
  prompt?: string;
}

export interface Schedule {
  id: string;
  naturalLanguage: string;
  cronExpression: string;
  enabled: boolean;
  lastRun?: string;
  lastResult?: string;
  context: ScheduleContext;
  createdAt: string;
  updatedAt: string;
}

export type NewSchedule = Omit<Schedule, "id" | "createdAt" | "updatedAt" | "lastRun" | "lastResult">;
