import logging
import os
from typing import List

from telegram import (
    Update,
    ChatPermissions,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
)
from telegram.ext import (
    ApplicationBuilder,
    CommandHandler,
    ContextTypes,
    CallbackQueryHandler,
)
from motor.motor_asyncio import AsyncIOMotorClient

# =============== CONFIG ===============

# ⚠️ Set these as environment variables in production!
BOT_TOKEN = os.getenv("BOT_TOKEN", "8425235782:AAFBr5g-3su_csO0ySlqH0VVIf_DT4lgdR0")
MONGO_URI = os.getenv("MONGO_URI", "mongodb+srv://alyakiranxer:Kiranxer123@cluster0.zunxtbg.mongodb.net/?appName=Cluster0")
DB_NAME = "Cluster0"

OWNER_ID = 8264793035           # your Telegram user id
GROUP_ID = -1003379258261       # your group id

# Defaults (can be overridden from Mongo config)
MIN_REFERRALS = 3
start_message = (
    "✨ Welcome to the group unlock bot!\n\n"
    "1️⃣ Get your referral link with /ref (in bot DM).\n"
    "2️⃣ Invite friends using that link.\n"
    "3️⃣ Once you reach {min_refs} referrals, use /unlock in the group "
    "to enable sending photos & media."
)

# =============== LOGGING ===============
logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger(__name__)

# =============== MONGO CLIENT ===============
mongo_client = AsyncIOMotorClient(MONGO_URI)
db = mongo_client[DB_NAME]

users_col = db["users"]         # { _id: user_id, started: bool }
referrals_col = db["referrals"] # { _id: child_id, referrer_id: user_id }
config_col = db["config"]       # { _id: "config", min_referrals: int, start_message: str }


# =============== HELPERS ===============
def is_owner(user_id: int) -> bool:
    return user_id == OWNER_ID


def format_start_message() -> str:
    return start_message.replace("{min_refs}", str(MIN_REFERRALS))


async def load_config(app=None):
    """
    Load MIN_REFERRALS and start_message from Mongo on startup.
    If not found, insert defaults.
    """
    global MIN_REFERRALS, start_message

    cfg = await config_col.find_one({"_id": "config"})
    if not cfg:
        await config_col.insert_one(
            {
                "_id": "config",
                "min_referrals": MIN_REFERRALS,
                "start_message": start_message,
            }
        )
        logger.info("Config not found. Inserted defaults.")
    else:
        MIN_REFERRALS = cfg.get("min_referrals", MIN_REFERRALS)
        start_message = cfg.get("start_message", start_message)
        logger.info("Loaded config from DB: MIN_REFERRALS=%s", MIN_REFERRALS)


async def set_min_referrals_in_db(value: int):
    global MIN_REFERRALS
    MIN_REFERRALS = value
    await config_col.update_one(
        {"_id": "config"},
        {"$set": {"min_referrals": MIN_REFERRALS}},
        upsert=True,
    )


# =============== COMMAND HANDLERS ===============

# /start – in private chat, with optional referral param
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    chat = update.effective_chat

    # Mark user as "started"
    await users_col.update_one(
        {"_id": user.id},
        {"$set": {"started": True}},
        upsert=True,
    )

    # Only show full info in private chat
    if chat.type != "private":
        return

    text_parts: List[str] = []

    # Handle referral: /start <referrer_id>
    if context.args:
        try:
            referrer_id = int(context.args[0])
        except ValueError:
            referrer_id = None

        if referrer_id and referrer_id != user.id:
            # Check if this user already has a referrer in DB
            existing = await referrals_col.find_one({"_id": user.id})
            if not existing:
                # save referral
                await referrals_col.insert_one(
                    {
                        "_id": user.id,
                        "referrer_id": referrer_id,
                    }
                )
                text_parts.append(
                    "✅ You opened the bot using a referral link!\n"
                    "Your join will count towards your friend's unlock progress."
                )
            else:
                text_parts.append(
                    "ℹ️ You were already linked to a referrer earlier, "
                    "so this referral won't be counted again."
                )
        else:
            text_parts.append(
                "ℹ️ Referral code invalid or self-referral. "
                "You can still use the bot normally."
            )

    text_parts.append(format_start_message())
    await update.message.reply_text("\n\n".join(text_parts))


# /ref – get referral link & count
async def ref_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    chat = update.effective_chat

    if chat.type != "private":
        await update.message.reply_text("Use /ref in a private chat with me.")
        return

    me = await context.bot.get_me()
    bot_username = me.username

    ref_link = f"https://t.me/{bot_username}?start={user.id}"
    my_refs = await referrals_col.count_documents({"referrer_id": user.id})

    text = (
        "🔗 *Your Referral Link:*\n"
        f"`{ref_link}`\n\n"
        f"Invite friends using this link.\n"
        f"You currently have *{my_refs}/{MIN_REFERRALS}* referrals.\n"
        "Once you reach the required number, go to the group and use /unlock."
    )
    await update.message.reply_text(text, parse_mode="Markdown")


# /setup – configure group permissions (only in main group, owner only)
async def setup_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    chat = update.effective_chat

    if chat.id != GROUP_ID:
        await update.message.reply_text("❌ This command is only for the main group.")
        return

    if not is_owner(user.id):
        await update.message.reply_text("❌ Only the bot owner can run /setup.")
        return

    perms = ChatPermissions(
        can_send_messages=True,
        can_send_audios=False,
        can_send_documents=False,
        can_send_photos=False,
        can_send_videos=False,
        can_send_video_notes=False,
        can_send_voice_notes=False,
        can_send_polls=False,
        can_add_web_page_previews=False,
        can_change_info=False,
        can_invite_users=True,
        can_pin_messages=False,
    )

    try:
        await context.bot.set_chat_permissions(chat_id=chat.id, permissions=perms)
        await update.message.reply_text(
            "✅ Group configured!\n\n"
            "• Everyone can send *text only*.\n"
            "• Photos & media are blocked by default.\n"
            f"• Users must get *{MIN_REFERRALS}* referrals and then use /unlock to send media.",
            parse_mode="Markdown",
        )
    except Exception as e:
        logger.error("Error in /setup: %s", e)
        await update.message.reply_text(
            "⚠️ I couldn't change permissions.\n"
            "Make sure I'm an *admin* with permission to manage chat members.",
            parse_mode="Markdown",
        )


# /unlock – user tries to unlock media permissions in group
async def unlock_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    chat = update.effective_chat

    if chat.id != GROUP_ID:
        await update.message.reply_text("❌ Use /unlock in the main group.")
        return

    # Owner always unlocked
    if is_owner(user.id):
        enough_refs = True
        user_refs = MIN_REFERRALS
    else:
        user_refs = await referrals_col.count_documents({"referrer_id": user.id})
        enough_refs = user_refs >= MIN_REFERRALS

    if not enough_refs:
        await update.message.reply_text(
            f"❌ You don't have enough referrals yet.\n"
            f"You have *{user_refs}/{MIN_REFERRALS}*.\n"
            "Use /ref in my DM, share your link, and try again when you reach the target.",
            parse_mode="Markdown",
        )
        return

    perms = ChatPermissions(
        can_send_messages=True,
        can_send_audios=True,
        can_send_documents=True,
        can_send_photos=True,
        can_send_videos=True,
        can_send_video_notes=True,
        can_send_voice_notes=True,
        can_send_polls=True,
        can_add_web_page_previews=True,
        can_change_info=False,
        can_invite_users=True,
        can_pin_messages=False,
    )

    try:
        await context.bot.restrict_chat_member(
            chat_id=chat.id,
            user_id=user.id,
            permissions=perms,
        )
    except Exception as e:
        logger.error("Error in /unlock restrict_chat_member: %s", e)
        await update.message.reply_text(
            "⚠️ I tried to update your permissions but failed.\n"
            "Make sure I'm admin with permission to restrict members.",
        )
        return

    await update.message.reply_text(
        f"✅ {user.mention_html()} you’re unlocked!\n"
        "You can now send photos, videos and other media.",
        parse_mode="HTML",
    )


# /help – basic usage info
async def help_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    text = (
        "📚 *Bot Help*\n\n"
        "*In the group:*\n"
        "• /unlock – unlock photo/media sending if you have enough referrals.\n\n"
        "*In private chat with the bot:*\n"
        "• /ref – get your referral link.\n\n"
        "*Owner only (admin panel):*\n"
        "• /admin – open admin panel.\n"
    )
    await update.message.reply_text(text, parse_mode="Markdown")


# =============== ADMIN PANEL ===============

# /admin – owner-only control panel
async def admin_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    chat = update.effective_chat

    if not is_owner(user.id):
        await update.message.reply_text("❌ You are not allowed to use /admin.")
        return

    if chat.type != "private":
        await update.message.reply_text("ℹ️ Use /admin in private chat with the bot.")
        return

    keyboard = [
        [
            InlineKeyboardButton("📊 Stats", callback_data="admin_stats"),
            InlineKeyboardButton("✉️ Broadcast", callback_data="admin_broadcast"),
        ],
        [
            InlineKeyboardButton("⚙️ Set Referrals", callback_data="admin_set_refs"),
        ],
        [
            InlineKeyboardButton("📝 View /start Message", callback_data="admin_view_start"),
        ],
    ]
    reply_markup = InlineKeyboardMarkup(keyboard)

    await update.message.reply_text(
        "🔐 *Admin Panel* – choose an option:",
        parse_mode="Markdown",
        reply_markup=reply_markup,
    )


# Handle inline button presses
async def admin_buttons(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    user = query.from_user

    if not is_owner(user.id):
        await query.edit_message_text("❌ You are not allowed to use this.")
        return

    data = query.data

    if data == "admin_stats":
        await handle_admin_stats(query, context)
    elif data == "admin_broadcast":
        await handle_admin_broadcast(query, context)
    elif data == "admin_set_refs":
        await handle_admin_set_refs(query, context)
    elif data == "admin_view_start":
        await handle_admin_view_start(query, context)


async def handle_admin_stats(query, context):
    # total users who started the bot
    total_started = await users_col.count_documents({})
    # how many users ever referred someone
    referrer_ids = await referrals_col.distinct("referrer_id")
    total_referrers = len(referrer_ids)

    top_lines = []

    pipeline = [
        {"$group": {"_id": "$referrer_id", "count": {"$sum": 1}}},
        {"$sort": {"count": -1}},
        {"$limit": 5},
    ]

    async for doc in referrals_col.aggregate(pipeline):
        rid = doc["_id"]
        cnt = doc["count"]
        top_lines.append(f"- {rid}: {cnt} referrals")

    text = (
        "📊 *Bot Stats*\n\n"
        f"• Users who started bot: *{total_started}*\n"
        f"• Users who referred someone: *{total_referrers}*\n"
        f"• Referrals required to unlock: *{MIN_REFERRALS}*\n"
    )

    if top_lines:
        text += "\n*Top Referrers:*\n" + "\n".join(top_lines)

    await query.edit_message_text(text, parse_mode="Markdown")


async def handle_admin_broadcast(query, context):
    text = (
        "✉️ *Broadcast Mode*\n\n"
        "Send a message using:\n"
        "`/broadcast Your message here`\n\n"
        "It will be sent to everyone who has started the bot."
    )
    await query.edit_message_text(text, parse_mode="Markdown")


async def handle_admin_set_refs(query, context):
    text = (
        "⚙️ *Change Required Referrals*\n\n"
        "Send:\n"
        "`/setrefs <number>`\n\n"
        "Example: `/setrefs 5`"
    )
    await query.edit_message_text(text, parse_mode="Markdown")


async def handle_admin_view_start(query, context):
    text = "📝 */start Message Preview:*\n\n" + format_start_message()
    await query.edit_message_text(text, parse_mode="Markdown")


# /broadcast – owner sends message to all started users
async def broadcast_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user

    if not is_owner(user.id):
        await update.message.reply_text("❌ Only owner can use /broadcast.")
        return

    if not context.args:
        await update.message.reply_text("Usage: /broadcast Your message text")
        return

    msg = " ".join(context.args)
    sent = 0
    failed = 0

    async for doc in users_col.find({}, {"_id": 1}):
        uid = doc["_id"]
        try:
            await context.bot.send_message(chat_id=uid, text=msg)
            sent += 1
        except Exception as e:
            logger.warning("Broadcast fail to %s: %s", uid, e)
            failed += 1

    await update.message.reply_text(
        f"✅ Broadcast finished.\nSent: {sent}\nFailed: {failed}"
    )


# /setrefs – change required referral count (owner only)
async def setrefs_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user

    if not is_owner(user.id):
        await update.message.reply_text("❌ Only owner can use /setrefs.")
        return

    if not context.args:
        await update.message.reply_text("Usage: /setrefs <number>")
        return

    try:
        new_val = int(context.args[0])
        if new_val <= 0:
            raise ValueError
    except ValueError:
        await update.message.reply_text(
            "Please provide a positive number. Example: /setrefs 3"
        )
        return

    await set_min_referrals_in_db(new_val)

    await update.message.reply_text(
        f"✅ Referrals needed updated to: *{MIN_REFERRALS}*",
        parse_mode="Markdown",
    )


# =============== MAIN ===============
def main():
    if BOT_TOKEN == "PUT_YOUR_BOT_TOKEN_HERE":
        raise RuntimeError("Please set BOT_TOKEN (env or in code) before running the bot.")

    app = (
        ApplicationBuilder()
        .token(BOT_TOKEN)
        .post_init(load_config)
        .build()
    )

    # Basic commands
    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("ref", ref_cmd))
    app.add_handler(CommandHandler("setup", setup_cmd))
    app.add_handler(CommandHandler("unlock", unlock_cmd))
    app.add_handler(CommandHandler("help", help_cmd))

    # Admin
    app.add_handler(CommandHandler("admin", admin_cmd))
    app.add_handler(CallbackQueryHandler(admin_buttons, pattern="^admin_"))
    app.add_handler(CommandHandler("broadcast", broadcast_cmd))
    app.add_handler(CommandHandler("setrefs", setrefs_cmd))

    app.run_polling()


if __name__ == "__main__":
    main()
