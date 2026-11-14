import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { settings } from "../db/schema.js";

interface SettingDefault {
  key: string;
  value: string;
  log: string;
}

const SETTING_DEFAULTS: SettingDefault[] = [
  { key: "github_issue_repos", value: "[]", log: "Seeded github_issue_repos setting" },
  { key: "backup_retention_days", value: "30", log: "Seeded backup_retention_days setting" },
];

export function seedDefaultSettings(): void {
  for (const def of SETTING_DEFAULTS) {
    const existing = db.select().from(settings).where(eq(settings.key, def.key)).get();
    if (existing) continue;

    db.insert(settings).values({ key: def.key, value: def.value }).run();
    console.log(def.log);
  }
}
