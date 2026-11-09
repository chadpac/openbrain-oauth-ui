import { createClient } from "npm:@supabase/supabase-js@2.119.0";

Deno.serve(async (req) => {
  if(req.method!=="POST")return new Response("Method not allowed",{status:405});
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const telegramToken = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
  const webhookSecret = Deno.env.get("TELEGRAM_WEBHOOK_SECRET")!;

  const receivedSecret = req.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (receivedSecret !== webhookSecret) {
    return new Response("Unauthorized", { status: 401 });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey);
  const update = await req.json();

  if (!update.callback_query) return new Response("ok");

  const callback = update.callback_query;
  const callbackId = callback.id;
  const chatId = callback.message?.chat?.id;
  const messageId = callback.message?.message_id;
  const data = callback.data ?? "";

  if (!chatId || !messageId) return new Response("ok");

  const [action, taskId] = data.split(":");
  if (!taskId) return new Response("ok");

  const { data: member, error: memberError } = await supabase
    .from("household_members")
    .select("user_id, household_id, display_name")
    .eq("telegram_chat_id", chatId)
    .eq("telegram_enabled", true)
    .maybeSingle();

  if (memberError || !member) {
    await answerCallback(
      telegramToken,
      callbackId,
      "This Telegram account is not linked to Open Brain."
    );
    return new Response("ok");
  }

  const { data: task, error: taskError } = await supabase
    .from("family_tasks")
    .select(`
      id,
      title,
      household_id,
      assigned_to_user_id,
      status,
      remind_at
    `)
    .eq("id", taskId)
    .maybeSingle();

  if (taskError || !task) {
    await answerCallback(telegramToken, callbackId, "Task not found.");
    return new Response("ok");
  }

  if (
    task.household_id !== member.household_id ||
    task.assigned_to_user_id !== member.user_id
  ) {
    await answerCallback(
      telegramToken,
      callbackId,
      "You aren't assigned to this task."
    );
    return new Response("ok");
  }

  if (["completed", "cancelled", "paused"].includes(task.status)) {
    await answerCallback(
      telegramToken,
      callbackId,
      "This reminder is no longer active."
    );
    return new Response("ok");
  }

  if (action === "d") {
    const now = new Date().toISOString();

    const { data:updated, error: updateError } = await supabase
      .from("family_tasks")
      .update({
        status: "completed",
        completed_at: now,
        updated_at: now,
      })
      .eq("id", task.id).eq("assigned_to_user_id",member.user_id)
      .in("status",["pending","in_progress"]).eq("remind_at",task.remind_at)
      .select("id").maybeSingle();

    if (updateError || !updated) {
      console.error("Complete task error:", updateError);
      await answerCallback(
        telegramToken,
        callbackId,
        "I couldn't complete that task."
      );
      return new Response("ok");
    }

    await answerCallback(telegramToken, callbackId, "Task completed ✅");
    await editMessage(
      telegramToken,
      chatId,
      messageId,
      `✅ Completed\n\n${task.title}`
    );
  } else if (action === "s30" || action === "s60") {
    const minutes = action === "s30" ? 30 : 60;
    const nextReminder = new Date(
      Date.now() + minutes * 60 * 1000
    ).toISOString();

    const { data:updated, error: updateError } = await supabase
      .from("family_tasks")
      .update({
        remind_at: nextReminder,
        reminder_sent_at: null,
        reminder_error: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", task.id).eq("assigned_to_user_id",member.user_id)
      .in("status",["pending","in_progress"]).eq("remind_at",task.remind_at)
      .select("id").maybeSingle();

    if (updateError || !updated) {
      console.error("Snooze task error:", updateError);
      await answerCallback(
        telegramToken,
        callbackId,
        "I couldn't snooze that reminder."
      );
      return new Response("ok");
    }

    await answerCallback(
      telegramToken,
      callbackId,
      `Snoozed for ${minutes} minutes 😴`
    );
    await editMessage(
      telegramToken,
      chatId,
      messageId,
      `😴 Snoozed ${minutes} minutes\n\n${task.title}`
    );
  }

  return new Response("ok");
});

async function answerCallback(
  token: string,
  callbackQueryId: string,
  text: string,
) {
  await fetch(
    `https://api.telegram.org/bot${token}/answerCallbackQuery`,
    {
      method: "POST",
      signal: AbortSignal.timeout(10000),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        callback_query_id: callbackQueryId,
        text,
      }),
    }
  );
}

async function editMessage(
  token: string,
  chatId: number,
  messageId: number,
  text: string,
) {
  await fetch(
    `https://api.telegram.org/bot${token}/editMessageText`,
    {
      method: "POST",
      signal: AbortSignal.timeout(10000),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text,
      }),
    }
  );
}
