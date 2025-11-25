// bot.js
import express from "express";
import { Telegraf, Markup } from "telegraf";
import { MongoClient } from "mongodb";

// ---------------- CONFIG ----------------
const BOT_TOKEN = process.env.BOT_TOKEN || "8425235782:AAFBr5g-3su_csO0ySlqH0VVIf_DT4lgdR0";
const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://alyakiranxer:Kiranxer123@cluster0.zunxtbg.mongodb.net/?appName=Cluster0";
const DB_NAME = process.env.DB_NAME || "Cluster0";
const GROUP_ID = Number(process.env.GROUP_ID || "-1003379258261"); // override with env if you want
const OWNER_ID = Number(process.env.OWNER_ID || "8264793035");
let MIN_REFERRALS = Number(process.env.MIN_REFERRALS || 3);

if (!BOT_TOKEN) {
  console.error("ERROR: BOT_TOKEN env var is required");
  process.exit(1);
}

// ---------------- INIT BOT & MONGO ----------------
const bot = new Telegraf(BOT_TOKEN);
const mongoClient = new MongoClient(MONGO_URI, {});

let db, usersCol, invitesCol, refsCol, configCol;

async function initMongo() {
  await mongoClient.connect();
  db = mongoClient.db(DB_NAME);

  usersCol = db.collection("users");
  invitesCol = db.collection("invites");
  refsCol = db.collection("referrals");
  configCol = db.collection("config");

  // load config or create default
  const cfg = await configCol.findOne({ _id: "config" });
  if (!cfg) {
    await config_col_insert_default();
  } else {
    MIN_REFERRALS = cfg.min_referrals || MIN_REFERRALS;
    console.log("Loaded config. MIN_REFERRALS =", MIN_REFERRALS);
  }
}

async function config_col_insert_default() {
  await configCol.insertOne({
    _id: "config",
    min_referrals: MIN_REFERRALS,
    start_message:
      "Welcome! Use /ref in DM to create your personal invite link. Invite friends and get unlocked!",
  });
  console.log("Inserted default config.");
}

// ---------------- HELPERS ----------------
function isOwner(id) {
  return Number(id) === Number(OWNER_ID);
}

function formatStartMessage() {
  return `✨ Welcome!\nInvite ${MIN_REFERRALS} people using your personal link to unlock media. Use /ref in DM to get your link.`;
}

function textOnlyPermissions() {
  // unified fields (works for Telegraf / Telegram)
  return {
    can_send_messages: true,
    can_send_media_messages: false,
    can_send_polls: false,
    can_send_other_messages: false,
    can_add_web_page_previews: false,
    can_change_info: false,
    can_invite_users: true,
    can_pin_messages: false,
  };
}

function fullMediaPermissions() {
  return {
    can_send_messages: true,
    can_send_media_messages: true,
    can_send_polls: true,
    can_send_other_messages: true,
    can_add_web_page_previews: true,
    can_change_info: false,
    can_invite_users: true,
    can_pin_messages: false,
  };
}

// ---------------- COMMANDS ----------------

// /start : mark user as started and show message (if private)
bot.start(async (ctx) => {
  const userId = ctx.from.id;
  await usersCol.updateOne({ _id: userId }, { $set: { started: true } }, { upsert: true });

  // If there's an arg (referrer id) that came via t.me/BOT?start=ID
  const args = ctx.message && ctx.message.text ? ctx.message.text.split(" ") : [];
  if (args.length > 1) {
    const refId = Number(args[1]) || null;
    if (refId && refId !== userId) {
      // store referral (legacy)
      const existing = await refsCol.findOne({ _id: userId });
      if (!existing) {
        await refsCol.insertOne({ _id: userId, referrer_id: refId, created_at: new Date() });
      }
    }
  }

  if (ctx.chat.type === "private") {
    await ctx.reply(formatStartMessage());
  }
});

// /ref : create or return personal chat invite link (bot must be admin in group)
bot.command("ref", async (ctx) => {
  if (ctx.chat.type !== "private") {
    return ctx.reply("Use /ref in a private chat with me.");
  }

  const userId = ctx.from.id;

  try {
    // return existing active invite if present
    const existing = await invitesCol.findOne({ inviter_id: userId, completed: { $ne: true } });
    if (existing && existing.link) {
      const uses = existing.uses || 0;
      return ctx.reply(`🔗 Your referral link:\n${existing.link}\n\nInvites: ${uses}/${MIN_REFERRALS}`);
    }

    // create new invite link for the group
    // name helps identify link owner in Telegram UI
    const inviteObj = await ctx.telegram.createChatInviteLink(GROUP_ID, {
      name: `invite_${userId}`,
    });

    const link = inviteObj?.invite_link || inviteObj?.link || inviteObj?.url || inviteObj;

    await invitesCol.insertOne({
      inviter_id: userId,
      link,
      uses: 0,
      created_at: new Date(),
      completed: false,
    });

    await ctx.reply(`🔗 Your referral link:\n${link}\n\nShare it — when ${MIN_REFERRALS} people join via it you'll be unlocked.`);
  } catch (err) {
    console.error("create invite link error:", err);
    await ctx.reply("⚠️ I couldn't create an invite link. Make sure I'm admin in the group and have invite permission.");
  }
});

// /mystats - show your invite/refs
bot.command("mystats", async (ctx) => {
  const userId = ctx.from.id;
  const invite = await invitesCol.findOne({ inviter_id: userId });
  const uses = invite ? invite.uses || 0 : 0;
  const link = invite ? invite.link : "Not created yet. Use /ref";
  const referredCount = await refsCol.countDocuments({ referrer_id: userId });
  await ctx.reply(`Your link: ${link}\nInvites: ${uses}\nReferrals recorded: ${referredCount}/${MIN_REFERRALS}`);
});

// /unlock - user requests manual unlock in group (validates counts)
bot.command("unlock", async (ctx) => {
  if (ctx.chat.id !== GROUP_ID) {
    return ctx.reply("Please use /unlock inside the group.");
  }

  const userId = ctx.from.id;

  if (isOwner(userId)) {
    // owner bypass
    try {
      await ctx.telegram.restrictChatMember(GROUP_ID, userId, fullMediaPermissions());
      return ctx.reply("✅ Owner unlocked.");
    } catch (e) {
      console.error("unlock error for owner:", e);
      return ctx.reply("⚠️ Failed to unlock owner.");
    }
  }

  // check invitesCol uses or refsCol count
  const invite = await invitesCol.findOne({ inviter_id: userId });
  const inviteUses = invite ? invite.uses || 0 : 0;
  const refCount = await refsCol.countDocuments({ referrer_id: userId });

  const effectiveCount = Math.max(inviteUses, refCount);

  if (effectiveCount >= MIN_REFERRALS) {
    try {
      await ctx.telegram.restrictChatMember(GROUP_ID, userId, fullMediaPermissions());
      await ctx.reply("✅ You are unlocked! Enjoy sending media.");
    } catch (err) {
      console.error("unlock error:", err);
      await ctx.reply("⚠️ I tried to unlock you but failed. Make sure I'm admin.");
    }
  } else {
    // reply with instructions and a deep link to open DM/start
    const me = await ctx.telegram.getMe();
    const botUsername = me.username;
    await ctx.replyWithMarkdown(
      `❌ Not enough referrals yet. You have *${effectiveCount}/${MIN_REFERRALS}*.\n\nGet your invite: send me /ref in DM → https://t.me/${botUsername}`
    );
  }
});

// ---------------- ADMIN / OWNER COMMANDS ----------------

// /admin - show admin panel (owner only)
bot.command("admin", async (ctx) => {
  if (!isOwner(ctx.from.id)) return ctx.reply("You are not allowed.");
  if (ctx.chat.type !== "private") return ctx.reply("Use /admin in private chat with the bot.");

  await ctx.reply(
    "🔐 Admin Panel",
    Markup.inlineKeyboard([
      [Markup.button.callback("📊 Stats", "admin_stats")],
      [Markup.button.callback("⚙️ Set Refs", "admin_setrefs")],
      [Markup.button.callback("✉️ Broadcast", "admin_broadcast")],
    ])
  );
});

// setrefs - owner-only
bot.command("setrefs", async (ctx) => {
  if (!isOwner(ctx.from.id)) return ctx.reply("Only owner.");
  const args = ctx.message.text.split(" ").slice(1);
  const num = Number(args[0]);
  if (!num || num < 1) return ctx.reply("Usage: /setrefs <number>");
  MIN_REFERRALS = num;
  await configCol.updateOne({ _id: "config" }, { $set: { min_referrals: MIN_REFERRALS } }, { upsert: true });
  await ctx.reply(`✅ MIN_REFERRALS updated to ${MIN_REFERRALS}`);
});

// broadcast - owner-only
bot.command("broadcast", async (ctx) => {
  if (!isOwner(ctx.from.id)) return ctx.reply("Only owner.");
  const text = ctx.message.text.replace("/broadcast", "").trim();
  if (!text) return ctx.reply("Usage: /broadcast <message>");
  let sent = 0;
  for await (const u of usersCol.find({}, { projection: { _id: 1 } })) {
    try {
      await ctx.telegram.sendMessage(u._id, text);
      sent++;
    } catch (e) {
      // ignore
    }
  }
  await ctx.reply(`Broadcast sent to ${sent} users.`);
});

// admin button handlers
bot.action("admin_stats", async (ctx) => {
  if (!isOwner(ctx.from.id)) return ctx.answerCbQuery("No.");
  const totalUsers = await usersCol.countDocuments();
  const totalInviters = await invitesCol.countDocuments({ uses: { $gt: 0 } });
  const top = [];
  const agg = invitesCol.aggregate([
    { $group: { _id: "$inviter_id", uses: { $sum: "$uses" } } },
    { $sort: { uses: -1 } },
    { $limit: 5 },
  ]);
  for await (const doc of agg) {
    top.push(`${doc._id}: ${doc.uses}`);
  }
  await ctx.editMessageText(
    `📊 Stats\nUsers: ${totalUsers}\nInviters with >0 uses: ${totalInviters}\nMin refs: ${MIN_REFERRALS}\nTop:\n${top.join("\n") || "none"}`
  );
});
bot.action("admin_setrefs", async (ctx) => {
  if (!isOwner(ctx.from.id)) return ctx.answerCbQuery("No.");
  await ctx.editMessageText("Send /setrefs <number>");
});
bot.action("admin_broadcast", async (ctx) => {
  if (!isOwner(ctx.from.id)) return ctx.answerCbQuery("No.");
  await ctx.editMessageText("Send /broadcast <message> to broadcast to all started users.");
});

// ---------------- NEW MEMBER HANDLER ----------------
bot.on("new_chat_members", async (ctx) => {
  try {
    const newMembers = ctx.message.new_chat_members || [];
    const chatId = ctx.chat.id;

    const viaInvite = ctx.message.via_chat_invite_link;
    const joinLink = viaInvite ? (viaInvite.invite_link || viaInvite.link || viaInvite.url) : null;

    for (const member of newMembers) {
      if (member.is_bot) continue;

      // restrict new member to text-only
      try {
        await ctx.telegram.restrictChatMember(chatId, member.id, textOnlyPermissions());
      } catch (err) {
        console.warn("restrict failed:", err?.description || err);
      }

      // If joined via an invite link we saved earlier, increment uses
      if (joinLink) {
        const inviteDoc = await invitesCol.findOne({ link: joinLink });
        if (inviteDoc) {
          // don't count self-join
          if (inviteDoc.inviter_id !== member.id) {
            const updated = await invitesCol.findOneAndUpdate(
              { link: joinLink },
              { $inc: { uses: 1 } },
              { returnDocument: "after" }
            );
            const uses = updated.value.uses || 0;

            // optional: also add a refsCol entry
            await refsCol.insertOne({ _id: member.id, referrer_id: inviteDoc.inviter_id, created_at: new Date() });

            // notify inviter
            try {
              await ctx.telegram.sendMessage(
                inviteDoc.inviter_id,
                `✅ Someone joined using your link! (${uses}/${MIN_REFERRALS})`
              );
            } catch (e) {
              // ignore if can't DM
            }

            // unlock inviter automatically if threshold hit
            if (uses >= MIN_REFERRALS && !inviteDoc.completed) {
              try {
                await ctx.telegram.restrictChatMember(GROUP_ID, inviteDoc.inviter_id, fullMediaPermissions());
                await ctx.telegram.sendMessage(inviteDoc.inviter_id, `🎉 Congrats — you've been unlocked in the group!`);
                await ctx.telegram.sendMessage(chatId, `🎉 <a href="tg://user?id=${inviteDoc.inviter_id}">Inviter</a> has been unlocked!`, { parse_mode: "HTML" });
              } catch (err) {
                console.error("unlock inviter error:", err);
              }
              await invitesCol.updateOne({ link: joinLink }, { $set: { completed: true } });
            }
          } // end not self-join
        } // end inviteDoc
      } // end joinLink

      // Send welcome message with Unlock button
      const welcomeText = `✨ Welcome ${member.first_name}!\n\nThis group is text-only until you unlock media.\nGet your personal invite with /ref (DM me) and invite friends. When you're ready, press Unlock.`;
      try {
        await ctx.telegram.sendMessage(chatId, welcomeText, {
          reply_to_message_id: ctx.message.message_id,
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [[{ text: "🔓 Unlock", callback_data: "btn_unlock" }]],
          },
        });
      } catch (err) {
        console.warn("send welcome failed:", err);
      }
    }
  } catch (err) {
    console.error("new_chat_members handler error:", err);
  }
});

// ---------------- CALLBACK: Unlock button ----------------
bot.action("btn_unlock", async (ctx) => {
  try {
    await ctx.answerCbQuery(); // immediate ack
    const userId = ctx.from.id;

    // Only allow unlocking for the pressing user or inform them
    // Check counts
    if (isOwner(userId)) {
      try {
        await ctx.telegram.restrictChatMember(GROUP_ID, userId, fullMediaPermissions());
        return ctx.reply("✅ Owner unlocked.");
      } catch (e) {
        return ctx.reply("⚠️ Failed to unlock owner.");
      }
    }

    const invite = await invitesCol.findOne({ inviter_id: userId });
    const inviteUses = invite ? invite.uses || 0 : 0;
    const refCount = await refsCol.countDocuments({ referrer_id: userId });
    const effectiveCount = Math.max(inviteUses, refCount);

    if (effectiveCount >= MIN_REFERRALS) {
      try {
        await ctx.telegram.restrictChatMember(GROUP_ID, userId, fullMediaPermissions());
        return ctx.reply("✅ You are unlocked! Enjoy media.");
      } catch (err) {
        console.error("btn unlock error:", err);
        return ctx.reply("⚠️ I couldn't unlock you. Make sure I'm admin.");
      }
    } else {
      // give instructions: open DM to get invite
      const me = await ctx.telegram.getMe();
      const username = me.username;
      return ctx.replyWithMarkdown(
        `❌ You have *${effectiveCount}/${MIN_REFERRALS}* referrals.\nGet your invite link by sending /ref in private: https://t.me/${username}`
      );
    }
  } catch (err) {
    console.error("btn_unlock handler error:", err);
    try {
      await ctx.reply("⚠️ Error processing unlock. Try again later.");
    } catch {}
  }
});

// ---------------- TINY EXPRESS HEALTH SERVER ----------------
const appWeb = express();
appWeb.get("/", (req, res) => res.send("OK"));
const PORT = Number(process.env.PORT || 3000);
appWeb.listen(PORT, () => console.log(`Health server listening on ${PORT}`));

// ---------------- STARTUP ----------------
(async () => {
  try {
    await initMongo();
    await bot.launch();
    console.log("Bot launched");
  } catch (err) {
    console.error("Startup error:", err);
    process.exit(1);
  }
})();

// ---------------- GRACEFUL STOP ----------------
process.once("SIGINT", () => {
  console.log("SIGINT");
  bot.stop();
  mongoClient.close();
});
process.once("SIGTERM", () => {
  console.log("SIGTERM");
  bot.stop();
  mongoClient.close();
});
