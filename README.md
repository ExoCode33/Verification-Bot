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

### Automatic Role Management
- **New members** automatically receive the unverified role
- **Upon verification** unverified role is removed and verified roles are assigned
- **After 30 days of inactivity** verified roles are removed and unverified role is restored
- **Bot startup** audits all members and fixes any missing role assignments

### Navigator's Challenge
- Users click "🧭 Begin Navigation Test" button
- Solve Log Pose calculation challenges to prove navigation skills
- 5 clickable answer buttons (no typing needed)
- Success messages auto-delete after 5 minutes like sea mist

### Complete Database Tracking
- Tracks verified users with activity timestamps
- Tracks unverified users for role management
- Handles member joins/leaves with automatic cleanup
- Persistent state across bot restarts

### One Piece World Theming
- Authentic terminology: Grand Line, Log Pose, Sea Kings, navigation
- Neutral to all crews - focuses on universal pirate world concepts
- Professional maritime language with adventure themes

## Environment Variables

```
DISCORD_TOKEN=your_bot_token
DATABASE_URL=${{Postgres.DATABASE_URL}}
VERIFIED_ROLE_IDS=1234567890123456789,9876543210987654321,1111222233334444555
UNVERIFIED_ROLE_ID=9999888877776666555
VERIFICATION_CHANNEL_ID=1234567890123456789
NODE_ENV=production
```

**Note**: 
- `VERIFIED_ROLE_IDS` accepts multiple Discord role IDs separated by commas
- `UNVERIFIED_ROLE_ID` is the single role given to all new members until they verify
- `VERIFICATION_CHANNEL_ID` is where the bot will post verification messages when using `/setup-navigator-test`
- All verified roles are assigned upon verification and removed after 30 days of inactivity
- Unverified role is automatically managed (added to new members, removed when verified, restored when verification expires)

## Bot Permissions Required

- Send Messages
- Use Slash Commands
- Manage Roles
- View Channels
- Read Message History
- Add Reactions
- Connect (Voice)
