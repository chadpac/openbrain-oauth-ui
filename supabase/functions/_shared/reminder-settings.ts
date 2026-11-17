import type { SupabaseClient } from "npm:@supabase/supabase-js@2.119.0";
import { quietHoursActive, type QuietHoursPreference } from "./quiet-hours.ts";

export type ReminderSettingsContext = { client: Pick<SupabaseClient, "from">; userId: string; householdId: string };

export async function readPersonalReminderSettings({ client, userId, householdId }: ReminderSettingsContext) {
  const [member, devices, preference, household] = await Promise.all([
    client.from("household_members").select("display_name,telegram_enabled,telegram_chat_id").eq("user_id", userId).eq("household_id", householdId).single(),
    client.from("push_subscriptions").select("id").eq("user_id", userId).eq("enabled", true).eq("task_notifications", true).limit(100),
    client.from("notification_preferences").select("owner_user_id,quiet_hours_enabled,quiet_start,quiet_end,timezone").eq("owner_user_id", userId).maybeSingle(),
    client.from("households").select("timezone").eq("id", householdId).single(),
  ]);
  if (member.error || devices.error || preference.error || household.error || !member.data || !household.data) {
    throw new Error("Could not verify your reminder settings. Nothing was scheduled; check Open Brain Settings and try again with the same request_id.");
  }
  const zone = household.data.timezone;
  try { new Intl.DateTimeFormat("en", { timeZone: zone }).format(); } catch { throw new Error("Your household timezone needs to be corrected in Open Brain before scheduling."); }
  if (!zone) throw new Error("Your household timezone is missing. Choose it in Open Brain before scheduling.");
  const pref = preference.data as QuietHoursPreference | null;
  // Validate enabled quiet hours even when the requested reminder is not due yet.
  const quietNow = quietHoursActive(pref ?? undefined);
  const phone = (devices.data?.length ?? 0) > 0;
  const telegram = Boolean(member.data.telegram_enabled && member.data.telegram_chat_id);
  return {
    member: member.data,
    preference: pref,
    public: {
      timezone: zone as string,
      channels: { phone_or_browser: phone, telegram },
      delivery_configured: phone || telegram,
      quiet_hours: pref?.quiet_hours_enabled ? { enabled: true, start: pref.quiet_start, end: pref.quiet_end, timezone: pref.timezone, quiet_now: quietNow } : { enabled: false },
      delivery_note: "Open Brain checks due reminders about once a minute, even with the dashboard closed. Quiet hours can defer delivery. Provider acceptance does not prove a device displayed an alert; permissions and connectivity still matter.",
    },
  };
}

