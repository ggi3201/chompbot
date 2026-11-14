export interface Skill {
  id: string;
  name: string;
  description: string;
  content: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export type NewSkill = Omit<Skill, "id" | "createdAt" | "updatedAt">;
