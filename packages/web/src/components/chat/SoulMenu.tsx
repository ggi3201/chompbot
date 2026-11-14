/** A soul is a persona added to the system prompt; the model picker chooses it. */
export interface SoulOption {
  id: string;
  name: string;
  description: string;
  isDefault: boolean;
}
