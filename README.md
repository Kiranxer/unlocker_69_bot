# Unlocker Telegram Bot

Telegram bot for your group that:

- Lets **everyone text**
- Unlocks **photo & media sending** only for users who get enough **referrals**
- Uses **MongoDB** to store users & referrals
- Has an **admin panel** for the owner

## Features

- Referral system with unique links (`/ref`)
- Required referrals (default: `3`, change with `/setrefs`)
- `/unlock` in group unlocks media permissions for qualified users
- Admin panel (`/admin`) with:
  - Stats
  - Broadcast to all users
  - Change required referrals
  - View `/start` message

## Requirements

- Python 3.10+
- MongoDB (local or Atlas)

## Setup

1. Clone this repo:

   ```bash
   git clone https://github.com/yourname/unlocker_69_bot.git
   cd unlocker_69_bot
