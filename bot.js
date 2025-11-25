import express from "express";
import { Telegraf, Markup } from "telegraf";
import { MongoClient } from "mongodb";

// ==================== CONFIG ====================
const BOT_TOKEN = process.env.BOT_TOKEN || "8425235782:AAFBr5g-3su_csO0ySlqH0VVIf_DT4lgdR0";
const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://alyakiranxer:Kiranxer123@cluster0.zunxtbg.mongodb.net/?appName=Cluster0";

const OWNER_ID = 8264793035;
const GROUP_ID = -1003379258261;

// Default (will load from DB)
let MIN_REFERRALS = 3;
let startMessage = `
✨ Welcome to the group unlock bot!

1️⃣ Get your referral link with /ref  
2️⃣ Invite friends  
3️⃣ Once you reach {min_refs} referrals, use /unlock in the group  
to enable sending photos & media.
`;

// ==================== BOT ====================
const bot = new Telegraf(BOT_TOKEN);

// ==================== MONGO ====================
let db, usersCol, refsCol, configCol;

async function initMongo() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  db = client.db("unlocker_bot_db");

  usersCol = db.collection("users");
  refsCol = db.collection("referrals");
  configCol = db.collection("config");

  // Load config
  let cfg = await configCol.findOne({ _id: "config" });
  if (!cfg) {
    await configCol.insertOne({
      _id: "config",
      min_refs: MIN_REFERRALS,
      start_msg: startMessage,
    });
  } else {
    MIN_REFERRALS = cfg.min_refs;
    startMessage = cfg.start_msg;
  }
  console.log("MongoDB connected. Config loaded.");
}

// ================ HELPERS ===================
function formatStart() {
  return startMessage.replace("{min_refs}", MIN_REFERRALS);
}

function isOwner(id) {
  return id == OWNER_ID;
}

// ================ BOT COMMANDS =================

// /start with referral support
bot.start(async (ctx) => {
  const userId = ctx.from.id;

  await usersCol.updateOne(
    { _id: userId },
    { $set: { started: true } },
    { upsert: true }
  );

  let text = "";

  const args = ctx.message.text.split(" ");
  if (args[1]) {
    const referrerId = parseInt(args[1]);

    if (referrerId && referrerId !== userId) {
      const exists = await refsCol.findOne({ _id: userId });

      if (!exists) {
        await refsCol.insertOne({
          _id: userId,
          referrer_id: referrerId,
        });
        text += "✅ Referred successfully! Your join is counted.\n\n";
      } else {
        text += "ℹ️ You already have a referrer.\n\n";
      }
    }
  }

  text += formatStart();
  ctx.reply(text);
});

// /ref command
bot.command("ref", async (ctx) => {
  const userId = ctx.from.id;
  const username = ctx.botInfo.username;

  const link = `https://t.me/${username}?start=${userId}`;

  const count = await refsCol.countDocuments({ referrer_id: userId });

  ctx.reply(
    `🔗 *Your Referral Link:*\n\`${link}\`\n\nYou have *${count}/${MIN_REFERRALS}* referrals.`,
    { parse_mode: "Markdown" }
  );
});

// /unlock command
bot.command("unlock", async (ctx) => {
  if (ctx.chat.id !== GROUP_ID) {
    return ctx.reply("❌ Use /unlock in the main group.");
  }

  const userId = ctx.from.id;

  // Owner always unlocked
  let count = await refsCol.countDocuments({ referrer_id: userId });

  if (!isOwner(userId) && count < MIN_REFERRALS) {
    return ctx.reply(
      `❌ Not enough referrals.\nYou have *${count}/${MIN_REFERRALS}*`,
      { parse_mode: "Markdown" }
    );
  }

  try {
    await ctx.telegram.restrictChatMember(GROUP_ID, userId, {
      can_send_messages: true,
      can_send_photos: true,
      can_send_videos: true,
      can_send_documents: true,
      can_send_voice_notes: true,
      can_send_video_notes: true,
      can_send_audios: true,
      can_send_polls: true,
      can_add_web_page_previews: true,
    });

    ctx.reply(`✅ ${ctx.from.first_name}, you are unlocked!`);
  } catch (e) {
    console.error(e);
    ctx.reply("⚠️ Error while unlocking. Ensure bot is admin.");
  }
});

// /admin panel
bot.command("admin", async (ctx) => {
  if (!isOwner(ctx.from.id)) return;

  await ctx.reply(
    "🔐 *Admin Panel*",
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("📊 Stats", "stats")],
        [Markup.button.callback("⚙️ Set Referrals", "setrefs")],
        [Markup.button.callback("✉️ Broadcast", "broad")],
      ]),
    }
  );
});

// ===== ADMIN BUTTON ACTIONS =====

bot.action("stats", async (ctx) => {
  if (!isOwner(ctx.from.id)) return;

  let totalUsers = await usersCol.countDocuments({});
  let totalReferrers = await refsCol.distinct("referrer_id");

  ctx.editMessageText(
    `📊 *Bot Stats*\n\nUsers: *${totalUsers}*\nReferrers: *${totalReferrers.length}*\nRequired: *${MIN_REFERRALS}*`,
    { parse_mode: "Markdown" }
  );
});

bot.action("setrefs", async (ctx) => {
  if (!isOwner(ctx.from.id)) return;

  ctx.editMessageText(
    "Send new referral number:\nExample: `/setrefs 5`",
    { parse_mode: "Markdown" }
  );
});

// /setrefs
bot.command("setrefs", async (ctx) => {
  if (!isOwner(ctx.from.id)) return;

  const args = ctx.message.text.split(" ");
  const val = parseInt(args[1]);

  if (!val || val < 1) return ctx.reply("Invalid number.");

  MIN_REFERRALS = val;

  await configCol.updateOne(
    { _id: "config" },
    { $set: { min_refs: MIN_REFERRALS } }
  );

  ctx.reply(`✅ Updated to ${MIN_REFERRALS} referrals.`);
});

// Broadcast
bot.action("broad", (ctx) => {
  ctx.editMessageText("Send broadcast:\n`/broadcast your message`", {
    parse_mode: "Markdown",
  });
});

bot.command("broadcast", async (ctx) => {
  if (!isOwner(ctx.from.id)) return;

  const msg = ctx.message.text.replace("/broadcast", "").trim();
  if (!msg) return ctx.reply("Send text.");

  let users = usersCol.find({});
  let sent = 0;

  for await (const u of users) {
    try {
      await ctx.telegram.sendMessage(u._id, msg);
      sent++;
    } catch {}
  }

  ctx.reply(`Broadcast sent to ${sent} users.`);
});

// =============== TINY WEB SERVER FOR KOYEB =================
const appWeb = express();

appWeb.get("/", (req, res) => {
  res.send("OK");
});

appWeb.listen(3000, () => {
  console.log("Health server running on :3000");
});

// =============== START EVERYTHING =================
await initMongo();

bot.launch();
console.log("Bot started successfully.");

// Graceful stop
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
