# 🧭 One Piece Navigator Discord Bot

A One Piece world-themed Discord verification bot with PostgreSQL database, navigator's challenge system, and automatic inactive seafarer cleanup. Features lore-accurate terminology that remains neutral to all crews and factions.

## ⚓ Features

- 🧭 One Piece world-themed navigation testing system for new seafarers
- 🌊 Navigator's Challenge with multiple choice Log Pose calculations (no typing required!)
- 📊 Activity tracking for verified navigators (messages, reactions, voice channels)
- 🧹 Automatic removal of inactive seafarers (30+ days)
- ⚡ Built for Railway deployment with PostgreSQL
- 🗺️ Lore-accurate One Piece terminology without crew-specific references

## 🚀 Quick Start

1. Clone this repository
2. Deploy to Railway with PostgreSQL
3. Set environment variables
4. Invite bot to server with proper permissions
5. Run `/setup-navigator-test` command

See full deployment guide in the project files.

## 🧭 Bot Features

### Navigator's Challenge
- Users click "🧭 Begin Navigation Test" button
- Solve Log Pose calculation challenges to prove navigation skills
- 5 clickable answer buttons (no typing needed)
- Success messages auto-delete after 5 minutes like sea mist

### Seafarer Activity Tracking
- Monitors messages, reactions, and voice channel joins
- Updates last activity for verified navigators
- Automatic cleanup removes inactive seafarers after 30 days

### One Piece World Theming
- Authentic terminology: Grand Line, Log Pose, Sea Kings, navigation
- Neutral to all crews - focuses on universal pirate world concepts
- Professional maritime language with adventure themes

## Environment Variables

```
DISCORD_TOKEN=your_bot_token
DATABASE_URL=${{Postgres.DATABASE_URL}}
VERIFIED_ROLE_IDS=1234567890123456789,9876543210987654321,1111222233334444555
NODE_ENV=production
```

**Note**: `VERIFIED_ROLE_IDS` accepts multiple Discord role IDs separated by commas. All specified roles will be assigned upon verification and removed after 30 days of inactivity.

## Bot Permissions Required

- Send Messages
- Use Slash Commands
- Manage Roles
- View Channels
- Read Message History
- Add Reactions
- Connect (Voice)
