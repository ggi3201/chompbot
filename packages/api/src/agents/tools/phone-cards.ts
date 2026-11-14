import { db } from "../../db/index.js";
import { devicePushTokens } from "../../db/schema.js";
import { sendAlertPush, sendSilentPush, type PushTarget, type SilentPushResult } from "../../lib/apns.js";
import { listPhoneCards, publishPhoneCards, publishSchema, removePhoneCards } from "../../phone-cards/store.js";

const NOT_REACHED = "It picks up the change when the widget refreshes or the app opens.";

/** One push per registered phone. Returns why none was reached, or null. */
export async function pushToPhones(send: (phone: PushTarget) => Promise<SilentPushResult>): Promise<string | null> {
  // Older app versions registered a new device id on each launch, so one token can have many rows.
  const rows = db.select().from(devicePushTokens).all();
  const phones = [...new Map(rows.map((row) => [row.apnsToken, row])).values()];
  if (phones.length === 0) return "no phone has registered for push";

  const results = await Promise.all(phones.map(({ apnsToken, environment }) => send({
    deviceToken: apnsToken,
    environment: environment === "development" ? "development" : "production",
  })));
  if (results.some((result) => result.ok)) return null;
  return results.map((result) => result.error ?? "push failed").join("; ");
}

/** Tells every registered phone to fetch the cards. Returns why none was reached, or null. */
export function tellPhones(announcement: string | null): Promise<string | null> {
  return pushToPhones((phone) => {
    const target = { ...phone, collapseId: "phone-cards" };
    return announcement ? sendAlertPush({ ...target, title: "Time changed", body: announcement }) : sendSilentPush(target);
  });
}

export async function execPublishPhoneCards(args: Record<string, unknown>): Promise<string> {
  const parsed = publishSchema.safeParse(args);
  if (!parsed.success) {
    return `ERROR: Invalid cards: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`;
  }

  const { group, board, cards } = parsed.data;
  const announcement = publishPhoneCards(parsed.data);
  const failure = await tellPhones(announcement);
  if (failure) return `ERROR: Cards saved, but the phone was not reached: ${failure}. ${NOT_REACHED}`;
  const announced = announcement ? " A countdown moved, so the phone also got a visible notification." : "";
  return `Published ${cards.length} card(s) to group "${group}" on board "${board}".${announced}`;
}

export async function execRemovePhoneCards(args: { group?: unknown }): Promise<string> {
  if (typeof args.group !== "string" || !args.group) return "ERROR: group required";
  const removed = removePhoneCards(args.group);
  if (removed === 0) return `ERROR: No cards in group "${args.group}".`;
  const failure = await tellPhones(null);
  if (failure) return `ERROR: Group removed, but the phone was not reached: ${failure}. ${NOT_REACHED}`;
  return `Removed ${removed} card(s) from group "${args.group}".`;
}

export function execListPhoneCards(): string {
  return JSON.stringify(listPhoneCards(), null, 2);
}
