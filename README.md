# Discord Verification Bot

A professional Discord verification bot with PostgreSQL database, captcha system, and automatic inactive user cleanup.

## Features

- 🔐 Professional verification system with button interface
- 🧮 Math captcha protection
- 📊 Activity tracking (messages, reactions, voice channels)
- 🧹 Automatic removal of inactive users (30+ days)
- ⚡ Built for Railway deployment with PostgreSQL

## Quick Start

1. Clone this repository
2. Deploy to Railway with PostgreSQL
3. Set environment variables
4. Invite bot to server with proper permissions
5. Run `/setup-verification` command

See full deployment guide in the project files.

## Environment Variables

```
DISCORD_TOKEN=your_bot_token
DATABASE_URL=${{Postgres.DATABASE_URL}}
VERIFIED_ROLE_NAME=Verified
NODE_ENV=production
```

## Bot Permissions Required

- Send Messages
- Use Slash Commands
- Manage Roles
- View Channels
- Read Message History
- Add Reactions
- Connect (Voice)
