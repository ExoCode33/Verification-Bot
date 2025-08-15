const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');
const { Pool } = require('pg');
const cron = require('node-cron');

// Database setup with Railway-specific configuration
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { 
        rejectUnauthorized: false 
    } : false,
    // Railway specific configurations
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
});

// Parse verified roles from environment variable (using role IDs)
function getVerifiedRoleIds() {
    const rolesEnv = process.env.VERIFIED_ROLE_IDS || '';
    return rolesEnv.split(',').map(id => id.trim()).filter(id => id.length > 0);
}

// Get unverified role ID from environment variable
function getUnverifiedRoleId() {
    return process.env.UNVERIFIED_ROLE_ID || '';
}

// Get verification channel ID from environment variable
function getVerificationChannelId() {
    return process.env.VERIFICATION_CHANNEL_ID || '';
}

// Check and fix role assignments for all members
async function auditAndFixRoles(guild) {
    console.log(`Starting role audit for guild: ${guild.name}`);
    
    try {
        const members = await guild.members.fetch();
        const client_db = await pool.connect();
        
        try {
            // Get all verified users for this guild
            const verifiedResult = await client_db.query(
                'SELECT user_id FROM verified_users WHERE guild_id = $1',
                [guild.id]
            );
            const verifiedUserIds = new Set(verifiedResult.rows.map(row => row.user_id));
            
            // Get all unverified users for this guild  
            const unverifiedResult = await client_db.query(
                'SELECT user_id FROM unverified_users WHERE guild_id = $1',
                [guild.id]
            );
            const unverifiedUserIds = new Set(unverifiedResult.rows.map(row => row.user_id));
            
            let fixedCount = 0;
            
            for (const [userId, member] of members) {
                // Skip bots
                if (member.user.bot) continue;
                
                const isVerified = verifiedUserIds.has(userId);
                const isInUnverifiedDB = unverifiedUserIds.has(userId);
                
                if (isVerified) {
                    // User should have verified roles and no unverified role
                    await removeUnverifiedRole(member);
                    
                    // Ensure they have all verified roles
                    const verifiedRoleIds = getVerifiedRoleIds();
                    for (const roleId of verifiedRoleIds) {
                        const role = guild.roles.cache.get(roleId);
                        if (role && !member.roles.cache.has(roleId)) {
                            await member.roles.add(role);
                            console.log(`Fixed: Added missing verified role "${role.name}" to ${member.user.tag}`);
                            fixedCount++;
                        }
                    }
                    
                    // Remove from unverified database if present
                    if (isInUnverifiedDB) {
                        await removeUnverifiedUser(userId, guild.id);
                    }
                } else {
                    // User should have unverified role and no verified roles
                    await giveUnverifiedRole(member);
                    
                    // Add to unverified database if not present
                    if (!isInUnverifiedDB) {
                        await addUnverifiedUser(userId, guild.id);
                        fixedCount++;
                    }
                    
                    // Remove any verified roles they shouldn't have
                    const verifiedRoleIds = getVerifiedRoleIds();
                    for (const roleId of verifiedRoleIds) {
                        if (member.roles.cache.has(roleId)) {
                            const role = guild.roles.cache.get(roleId);
                            await member.roles.remove(role);
                            console.log(`Fixed: Removed incorrect verified role "${role?.name}" from ${member.user.tag}`);
                            fixedCount++;
                        }
                    }
                }
            }
            
            console.log(`Role audit completed for ${guild.name}. Fixed ${fixedCount} role assignments.`);
            
        } finally {
            client_db.release();
        }
    } catch (error) {
        console.error(`Error during role audit for guild ${guild.name}:`, error);
    }
}

// Initialize database with retry logic
async function initializeDatabase() {
    let retries = 5;
    
    while (retries > 0) {
        try {
            console.log('Attempting to connect to PostgreSQL database...');
            const client = await pool.connect();
            
            try {
                // Test connection
                await client.query('SELECT NOW()');
                console.log('✅ Database connection successful!');
                
                // Create tables
                await client.query(`
                    CREATE TABLE IF NOT EXISTS verified_users (
                        id SERIAL PRIMARY KEY,
                        user_id VARCHAR(20) UNIQUE NOT NULL,
                        guild_id VARCHAR(20) NOT NULL,
                        verified_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        last_activity TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    );
                    
                    CREATE TABLE IF NOT EXISTS pending_verifications (
                        id SERIAL PRIMARY KEY,
                        user_id VARCHAR(20) UNIQUE NOT NULL,
                        guild_id VARCHAR(20) NOT NULL,
                        captcha_answer VARCHAR(10) NOT NULL,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    );
                    
                    CREATE TABLE IF NOT EXISTS unverified_users (
                        id SERIAL PRIMARY KEY,
                        user_id VARCHAR(20) NOT NULL,
                        guild_id VARCHAR(20) NOT NULL,
                        joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        UNIQUE(user_id, guild_id)
                    );
                    
                    CREATE INDEX IF NOT EXISTS idx_user_guild ON verified_users(user_id, guild_id);
                    CREATE INDEX IF NOT EXISTS idx_pending_user ON pending_verifications(user_id);
                    CREATE INDEX IF NOT EXISTS idx_unverified_user_guild ON unverified_users(user_id, guild_id);
                `);
                
                console.log('✅ Database tables created/verified successfully');
                return; // Success, exit the retry loop
                
            } finally {
                client.release();
            }
            
        } catch (error) {
            retries--;
            console.error(`❌ Database connection failed. Retries left: ${retries}`);
            console.error('Error details:', error.message);
            
            if (retries === 0) {
                console.error('🚨 CRITICAL: Could not connect to PostgreSQL after 5 attempts');
                console.error('Please check your DATABASE_URL environment variable');
                console.error('Make sure PostgreSQL service is running on Railway');
                throw error;
            }
            
            // Wait before retrying
            console.log('⏳ Waiting 5 seconds before retry...');
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
}

// Discord bot setup with full intents
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.MessageContent
    ]
});

// Generate math captcha with multiple choice answers
function generateCaptchaWithChoices() {
    const num1 = Math.floor(Math.random() * 10) + 1;
    const num2 = Math.floor(Math.random() * 10) + 1;
    const operations = ['+', '-', '*'];
    const operation = operations[Math.floor(Math.random() * operations.length)];
    
    let correctAnswer;
    let question;
    
    switch (operation) {
        case '+':
            correctAnswer = num1 + num2;
            question = `${num1} + ${num2}`;
            break;
        case '-':
            correctAnswer = Math.max(num1, num2) - Math.min(num1, num2);
            question = `${Math.max(num1, num2)} - ${Math.min(num1, num2)}`;
            break;
        case '*':
            correctAnswer = num1 * num2;
            question = `${num1} × ${num2}`;
            break;
    }
    
    // Generate 4 wrong answers that are close to the correct answer
    const wrongAnswers = new Set();
    while (wrongAnswers.size < 4) {
        let wrongAnswer;
        const variation = Math.floor(Math.random() * 6) + 1; // 1-6 difference
        const isHigher = Math.random() > 0.5;
        
        if (isHigher) {
            wrongAnswer = correctAnswer + variation;
        } else {
            wrongAnswer = Math.max(1, correctAnswer - variation); // Ensure positive
        }
        
        // Don't add the correct answer as a wrong answer
        if (wrongAnswer !== correctAnswer && wrongAnswer > 0) {
            wrongAnswers.add(wrongAnswer);
        }
    }
    
    // Create array of all choices and shuffle
    const choices = [correctAnswer, ...Array.from(wrongAnswers)];
    
    // Fisher-Yates shuffle
    for (let i = choices.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [choices[i], choices[j]] = [choices[j], choices[i]];
    }
    
    return { question, correctAnswer, choices };
}

// Add user to unverified database
async function addUnverifiedUser(userId, guildId) {
    const client = await pool.connect();
    try {
        await client.query(
            'INSERT INTO unverified_users (user_id, guild_id) VALUES ($1, $2) ON CONFLICT (user_id, guild_id) DO NOTHING',
            [userId, guildId]
        );
    } catch (error) {
        console.error('Error adding unverified user:', error);
    } finally {
        client.release();
    }
}

// Remove user from unverified database
async function removeUnverifiedUser(userId, guildId) {
    const client = await pool.connect();
    try {
        await client.query(
            'DELETE FROM unverified_users WHERE user_id = $1 AND guild_id = $2',
            [userId, guildId]
        );
    } catch (error) {
        console.error('Error removing unverified user:', error);
    } finally {
        client.release();
    }
}

// Give unverified role to user
async function giveUnverifiedRole(member) {
    const unverifiedRoleId = getUnverifiedRoleId();
    if (!unverifiedRoleId) return;

    try {
        const role = member.guild.roles.cache.get(unverifiedRoleId);
        if (role && !member.roles.cache.has(unverifiedRoleId)) {
            await member.roles.add(role);
            console.log(`Added unverified role "${role.name}" to user ${member.user.id}`);
        }
    } catch (error) {
        console.error(`Error adding unverified role to user ${member.user.id}:`, error);
    }
}

// Remove unverified role from user
async function removeUnverifiedRole(member) {
    const unverifiedRoleId = getUnverifiedRoleId();
    if (!unverifiedRoleId) return;

    try {
        const role = member.guild.roles.cache.get(unverifiedRoleId);
        if (role && member.roles.cache.has(unverifiedRoleId)) {
            await member.roles.remove(role);
            console.log(`Removed unverified role "${role.name}" from user ${member.user.id}`);
        }
    } catch (error) {
        console.error(`Error removing unverified role from user ${member.user.id}:`, error);
    }
}
async function updateUserActivity(userId, guildId) {
    const client = await pool.connect();
    try {
        await client.query(
            'UPDATE verified_users SET last_activity = CURRENT_TIMESTAMP WHERE user_id = $1 AND guild_id = $2',
            [userId, guildId]
        );
    } catch (error) {
        console.error('Error updating user activity:', error);
    } finally {
        client.release();
    }
}

// Check if user is verified
async function isUserVerified(userId, guildId) {
    const client = await pool.connect();
    try {
        const result = await client.query(
            'SELECT * FROM verified_users WHERE user_id = $1 AND guild_id = $2',
            [userId, guildId]
        );
        return result.rows.length > 0;
    } catch (error) {
        console.error('Error checking verification status:', error);
        return false;
    } finally {
        client.release();
    }
}

client.once('ready', async () => {
    console.log(`Ahoy! The navigation system is ready to test new seafarers! Logged in as ${client.user.tag}`);
    
    try {
        await initializeDatabase();
        
        // Audit and fix roles for all guilds
        console.log('Starting comprehensive role audit for all guilds...');
        for (const [guildId, guild] of client.guilds.cache) {
            await auditAndFixRoles(guild);
        }
        console.log('🎯 Complete role audit finished for all guilds.');
        
        console.log('🌊 Full navigation system online with all features enabled!');
        console.log('⚓ Monitoring: Member joins, role management, activity tracking, and verification');
        
    } catch (error) {
        console.error('❌ Failed to initialize bot systems:', error);
        console.error('Bot will continue but some features may not work properly');
    }
});

// Handle new member joins
client.on('guildMemberAdd', async (member) => {
    // Skip bots
    if (member.user.bot) return;
    
    console.log(`New member joined: ${member.user.tag} in ${member.guild.name}`);
    
    // Check if they're already verified (in case of rejoin)
    const alreadyVerified = await isUserVerified(member.user.id, member.guild.id);
    
    if (alreadyVerified) {
        // Give them back their verified roles
        const verifiedRoleIds = getVerifiedRoleIds();
        for (const roleId of verifiedRoleIds) {
            const role = member.guild.roles.cache.get(roleId);
            if (role) {
                await member.roles.add(role);
                console.log(`Restored verified role "${role.name}" to returning member ${member.user.tag}`);
            }
        }
        
        // Update their activity timestamp
        await updateUserActivity(member.user.id, member.guild.id);
    } else {
        // Give them unverified role and add to database
        await giveUnverifiedRole(member);
        await addUnverifiedUser(member.user.id, member.guild.id);
        console.log(`Added unverified role to new member: ${member.user.tag}`);
    }
});
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return;

    if (interaction.customId === 'verify_button') {
        const userId = interaction.user.id;
        const guildId = interaction.guild.id;

        // Check if already verified
        const alreadyVerified = await isUserVerified(userId, guildId);
        if (alreadyVerified) {
            return interaction.reply({
                content: '🧭 You\'ve already proven your worth as a navigator! No need to chart the same course twice.',
                ephemeral: true
            });
        }

        // Generate captcha with multiple choice answers
        const captcha = generateCaptchaWithChoices();
        
        // Store pending verification
        const client_db = await pool.connect();
        try {
            await client_db.query(
                'INSERT INTO pending_verifications (user_id, guild_id, captcha_answer) VALUES ($1, $2, $3) ON CONFLICT (user_id) DO UPDATE SET captcha_answer = $3, created_at = CURRENT_TIMESTAMP',
                [userId, guildId, captcha.correctAnswer.toString()]
            );
        } catch (error) {
            console.error('Error storing pending verification:', error);
            return interaction.reply({
                content: '❌ An error occurred. Please try again.',
                ephemeral: true
            });
        } finally {
            client_db.release();
        }

        const captchaEmbed = new EmbedBuilder()
            .setTitle('🧭 Navigator\'s Challenge')
            .setDescription(`To navigate the treacherous Grand Line, you must prove your mathematical prowess! Log Pose calculations require precision.\n\n**Navigation Calculation:**\n**${captcha.question} = ?**\n\nSelect the correct answer from the course options below. A skilled navigator never guesses blindly!`)
            .setColor(0x8B5CF6) // Purple color
            .setFooter({ text: 'You have 5 minutes to complete this navigation test!' })
            .setTimestamp();

        // Create answer buttons
        const buttons = captcha.choices.map((choice, index) => 
            new ButtonBuilder()
                .setCustomId(`captcha_answer_${choice}`)
                .setLabel(choice.toString())
                .setStyle(ButtonStyle.Secondary)
        );

        const row = new ActionRowBuilder().addComponents(buttons);

        await interaction.reply({
            embeds: [captchaEmbed],
            components: [row],
            ephemeral: true
        });

        // Set timeout to clean up pending verification
        setTimeout(async () => {
            const client_cleanup = await pool.connect();
            try {
                await client_cleanup.query(
                    'DELETE FROM pending_verifications WHERE user_id = $1 AND guild_id = $2',
                    [userId, guildId]
                );
            } catch (error) {
                console.error('Error cleaning up pending verification:', error);
            } finally {
                client_cleanup.release();
            }
        }, 5 * 60 * 1000); // 5 minutes
    }

    // Handle captcha answer buttons
    if (interaction.customId.startsWith('captcha_answer_')) {
        const userId = interaction.user.id;
        const guildId = interaction.guild.id;
        const selectedAnswer = interaction.customId.replace('captcha_answer_', '');

        // Check if user has pending verification
        const client_db = await pool.connect();
        try {
            const result = await client_db.query(
                'SELECT * FROM pending_verifications WHERE user_id = $1 AND guild_id = $2',
                [userId, guildId]
            );

            if (result.rows.length === 0) {
                return interaction.reply({
                    content: '❌ No pending verification found. Please start the verification process again.',
                    ephemeral: true
                });
            }

            const pendingVerification = result.rows[0];

            if (selectedAnswer === pendingVerification.captcha_answer) {
                // Correct answer - verify user
                await client_db.query('BEGIN');
                
                // Add to verified users
                await client_db.query(
                    'INSERT INTO verified_users (user_id, guild_id) VALUES ($1, $2)',
                    [userId, guildId]
                );
                
                // Remove from pending
                await client_db.query(
                    'DELETE FROM pending_verifications WHERE user_id = $1 AND guild_id = $2',
                    [userId, guildId]
                );
                
                // Remove from unverified users
                await client_db.query(
                    'DELETE FROM unverified_users WHERE user_id = $1 AND guild_id = $2',
                    [userId, guildId]
                );
                
                await client_db.query('COMMIT');

                // Add verified roles and remove unverified role
                const member = await interaction.guild.members.fetch(userId);
                
                // Remove unverified role
                await removeUnverifiedRole(member);
                
                // Add all verified roles
                const verifiedRoleIds = getVerifiedRoleIds();
                for (const roleId of verifiedRoleIds) {
                    const role = interaction.guild.roles.cache.get(roleId);
                    if (role) {
                        await member.roles.add(role);
                        console.log(`Added verified role "${role.name}" to user ${userId}`);
                    }
                }

                const successEmbed = new EmbedBuilder()
                    .setTitle('⚓ Navigation Successful!')
                    .setDescription('Outstanding seamanship! You\'ve proven your worth as a capable navigator and earned your place among the crew. Your Log Pose is now calibrated - set sail toward adventure!')
                    .setColor(0x00FF00) // Bright green color
                    .setFooter({ text: 'Welcome aboard, fellow adventurer! • This message will vanish like sea mist in 5 minutes' })
                    .setTimestamp();

                const response = await interaction.update({
                    embeds: [successEmbed],
                    components: []
                });

                // Delete success message after 5 minutes
                setTimeout(async () => {
                    try {
                        await response.delete();
                    } catch (error) {
                        // Message might already be deleted, ignore error
                        console.log('Success message already deleted or expired');
                    }
                }, 5 * 60 * 1000); // 5 minutes
                
            } else {
                // Wrong answer
                await client_db.query(
                    'DELETE FROM pending_verifications WHERE user_id = $1 AND guild_id = $2',
                    [userId, guildId]
                );

                const failEmbed = new EmbedBuilder()
                    .setTitle('❌ Navigation Error!')
                    .setDescription('Your calculations were off course! Even the most experienced navigators face magnetic storms that disrupt their Log Pose. Recalibrate your instruments and attempt the navigation test again.')
                    .setColor(0xFF0000) // Red color
                    .setFooter({ text: 'Every master navigator learned from failed attempts!' })
                    .setTimestamp();

                await interaction.update({
                    embeds: [failEmbed],
                    components: []
                });
            }
        } catch (error) {
            console.error('Error handling captcha answer:', error);
            await client_db.query('ROLLBACK');
            
            return interaction.reply({
                content: '❌ A magnetic storm disrupted your verification process. Please attempt the navigation test again.',
                ephemeral: true
            });
        } finally {
            client_db.release();
        }
    }
});

// Handle messages - only update activity for verified users
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    const userId = message.author.id;
    const guildId = message.guild.id;

    // Update activity for verified users
    const verified = await isUserVerified(userId, guildId);
    if (verified) {
        await updateUserActivity(userId, guildId);
    }
});

// Handle voice state updates
client.on('voiceStateUpdate', async (oldState, newState) => {
    const userId = newState.member.user.id;
    const guildId = newState.guild.id;

    // Only update activity if user joined a voice channel
    if (!oldState.channel && newState.channel) {
        const verified = await isUserVerified(userId, guildId);
        if (verified) {
            await updateUserActivity(userId, guildId);
        }
    }
});

// Handle reactions (update activity)
client.on('messageReactionAdd', async (reaction, user) => {
    if (user.bot) return;
    
    const userId = user.id;
    const guildId = reaction.message.guild?.id;
    if (!guildId) return;
    
    const verified = await isUserVerified(userId, guildId);
    if (verified) {
        await updateUserActivity(userId, guildId);
    }
});

// Slash command to create verification message
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'force-inactivity-check') {
        // Check permissions - Admin only
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
            return interaction.reply({
                content: '❌ You need **Administrator** permission to force inactivity checks.',
                ephemeral: true
            });
        }

        await interaction.reply({
            content: '🕛 Starting manual inactivity check... This may take a moment.',
            ephemeral: true
        });

        try {
            console.log('🔧 Manual inactivity check triggered by admin');
            
            const client_db = await pool.connect();
            try {
                // For testing, you can adjust this query to check shorter periods
                // Change '30 days' to '1 minute' for immediate testing
                const result = await client_db.query(`
                    SELECT user_id, guild_id, last_activity
                    FROM verified_users 
                    WHERE guild_id = $1 AND last_activity < NOW() - INTERVAL '30 days'
                `, [interaction.guild.id]);

                if (result.rows.length === 0) {
                    await interaction.followUp({
                        content: '✅ No inactive users found. All verified seafarers remain active!',
                        ephemeral: true
                    });
                    return;
                }

                console.log(`⚠️ Manual check found ${result.rows.length} inactive users in ${interaction.guild.name}`);

                let processedCount = 0;
                for (const user of result.rows) {
                    try {
                        const member = await interaction.guild.members.fetch(user.user_id);
                        
                        // Remove all verified roles and restore unverified role
                        const verifiedRoleIds = getVerifiedRoleIds();
                        let rolesRemoved = [];
                        
                        for (const roleId of verifiedRoleIds) {
                            const role = interaction.guild.roles.cache.get(roleId);
                            if (role && member.roles.cache.has(roleId)) {
                                await member.roles.remove(role);
                                rolesRemoved.push(role.name);
                            }
                        }
                        
                        // Give them back unverified role
                        await giveUnverifiedRole(member);
                        await addUnverifiedUser(user.user_id, user.guild_id);
                        
                        // Remove from verified database
                        await client_db.query(
                            'DELETE FROM verified_users WHERE user_id = $1 AND guild_id = $2',
                            [user.user_id, user.guild_id]
                        );
                        
                        processedCount++;
                        console.log(`🔄 Manually revoked privileges from: ${member.user.tag} (inactive since ${user.last_activity})`);
                        
                    } catch (error) {
                        console.error(`❌ Error processing user ${user.user_id}:`, error);
                    }
                }
                
                await interaction.followUp({
                    content: `🎯 Manual inactivity check completed!\n📊 Processed **${processedCount}** inactive users\n⚓ Removed verification and restored unverified status`,
                    ephemeral: true
                });
                
            } finally {
                client_db.release();
            }
            
        } catch (error) {
            console.error('Error during manual inactivity check:', error);
            await interaction.followUp({
                content: '❌ An error occurred during the inactivity check. Please check the logs.',
                ephemeral: true
            });
        }
    }

    if (interaction.commandName === 'setup-verification') {
        // Check permissions - Admin only
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
            return interaction.reply({
                content: '❌ You need **Administrator** permission to set up the navigator testing system.',
                ephemeral: true
            });
        }

        // Get verification channel ID from environment variable
        const verificationChannelId = getVerificationChannelId();
        
        if (!verificationChannelId) {
            return interaction.reply({
                content: '❌ No verification channel configured. Please set `VERIFICATION_CHANNEL_ID` in environment variables.',
                ephemeral: true
            });
        }

        // Get the verification channel
        const verificationChannel = interaction.guild.channels.cache.get(verificationChannelId);
        
        if (!verificationChannel) {
            return interaction.reply({
                content: `❌ Verification channel not found. Please check that channel ID \`${verificationChannelId}\` exists in this server.`,
                ephemeral: true
            });
        }

        // Check if bot can send messages in verification channel
        if (!verificationChannel.permissionsFor(interaction.guild.members.me).has([PermissionFlagsBits.SendMessages, PermissionFlagsBits.ViewChannel])) {
            return interaction.reply({
                content: `❌ I don't have permission to send messages in ${verificationChannel}. Please check my permissions.`,
                ephemeral: true
            });
        }

        try {
            // Get role names for display in embed
            const verifiedRoleIds = getVerifiedRoleIds();
            let roleDisplayNames = [];
            
            for (const roleId of verifiedRoleIds) {
                const role = interaction.guild.roles.cache.get(roleId);
                if (role) {
                    roleDisplayNames.push(role.name);
                }
            }
            
            const roleDisplayText = roleDisplayNames.length > 0 
                ? `🎖️ Receive verified roles: **${roleDisplayNames.join(', ')}**\n\n`
                : '';

            const embed = new EmbedBuilder()
                .setTitle('🧭 Server Verification Required')
                .setDescription(`Ahoy there, aspiring seafarer! Welcome to these treacherous yet magnificent waters!\n\n⚓ **This is a verification system** - you must complete this process to access the server.\n\n**Ready to brave the Grand Line?** Prove your worth as a navigator by completing the verification challenge below!\n\n**What awaits verified crew members:**\n🏴‍☠️ Access to all ship channels and hidden coves\n🗺️ Participate in legendary treasure hunts\n🎵 Join voice channels for strategic planning\n💬 React and interact with fellow adventurers\n💎 Share in the spoils of exploration\n${roleDisplayText}**⚓ Navigator\'s Code:** Your verification may be revoked if you remain inactive (no messages, reactions, or voice activity) for more than 30 days. Even the most skilled navigators must chart their course regularly!`)
                .setColor(0x8B5CF6) // Purple color
                .setFooter({ text: 'Complete verification to gain full server access • Click below to start' })
                .setTimestamp();

            const button = new ButtonBuilder()
                .setCustomId('verify_button')
                .setLabel('🧭 Verify')
                .setStyle(ButtonStyle.Success); // Green button

            const row = new ActionRowBuilder().addComponents(button);

            // Send to verification channel
            await verificationChannel.send({
                embeds: [embed],
                components: [row]
            });

            // Confirm to admin
            await interaction.reply({
                content: `✅ Verification message posted successfully in ${verificationChannel}!`,
                ephemeral: true
            });

        } catch (error) {
            console.error('Error setting up verification:', error);
            await interaction.reply({
                content: '❌ An error occurred while setting up verification. Please check the logs.',
                ephemeral: true
            });
        }
    }
});

// Daily cleanup job - remove inactive users
// Daily navigation privilege review - remove inactive users and restore unverified status
cron.schedule('0 0 * * *', async () => { // Runs at midnight every day
    console.log('🕛 Running daily navigation privilege review...');
    
    const client_db = await pool.connect();
    try {
        // Find users inactive for more than 30 days
        const result = await client_db.query(`
            SELECT user_id, guild_id 
            FROM verified_users 
            WHERE last_activity < NOW() - INTERVAL '30 days'
        `);

        if (result.rows.length === 0) {
            console.log('✅ All verified seafarers remain active. No privilege revocations needed.');
            return;
        }

        console.log(`⚠️  Found ${result.rows.length} inactive seafarers. Processing privilege revocations...`);

        for (const user of result.rows) {
            try {
                const guild = await client.guilds.fetch(user.guild_id);
                const member = await guild.members.fetch(user.user_id);
                
                // Remove all verified roles and restore unverified role
                const verifiedRoleIds = getVerifiedRoleIds();
                let rolesRemoved = [];
                
                for (const roleId of verifiedRoleIds) {
                    const role = guild.roles.cache.get(roleId);
                    if (role && member.roles.cache.has(roleId)) {
                        await member.roles.remove(role);
                        rolesRemoved.push(role.name);
                        console.log(`🔄 Removed role "${role.name}" (${roleId}) from inactive user ${user.user_id}`);
                    }
                }
                
                // Give them back unverified role
                await giveUnverifiedRole(member);
                await addUnverifiedUser(user.user_id, user.guild_id);
                
                // Remove from verified database
                await client_db.query(
                    'DELETE FROM verified_users WHERE user_id = $1 AND guild_id = $2',
                    [user.user_id, user.guild_id]
                );
                
                console.log(`⚓ Navigation privileges revoked from inactive seafarer: ${user.user_id} (${rolesRemoved.length} roles removed: ${rolesRemoved.join(', ')}, restored to unverified status)`);
                
            } catch (error) {
                console.error(`❌ Error revoking navigation privileges from seafarer ${user.user_id}:`, error);
            }
        }
        
        console.log(`🎯 Navigation review completed. Processed ${result.rows.length} inactive seafarers.`);
        
    } catch (error) {
        console.error('❌ Error during navigation privilege review:', error);
    } finally {
        client_db.release();
    }
});

// Register slash commands
client.once('ready', async () => {
    const commands = [
        {
            name: 'setup-verification',
            description: 'Establish the navigator testing system in the designated verification channel (Admin Only)',
            default_member_permissions: '8' // Administrator permission bitfield
        },
        {
            name: 'force-inactivity-check',
            description: 'Manually trigger the 30-day inactivity cleanup (Admin Only)',
            default_member_permissions: '8' // Administrator permission bitfield
        }
    ];

    try {
        await client.application.commands.set(commands);
        console.log('Slash commands registered successfully');
    } catch (error) {
        console.error('Error registering slash commands:', error);
    }
});

// Enhanced error handling and process management
process.on('unhandledRejection', (error) => {
    console.error('⚠️  Unhandled promise rejection detected:', error);
    console.error('Bot continuing operation but this should be investigated');
});

process.on('uncaughtException', (error) => {
    console.error('🚨 Critical uncaught exception:', error);
    console.error('Bot may need to restart');
});

// Graceful shutdown handling
process.on('SIGINT', async () => {
    console.log('📡 Received SIGINT signal - beginning graceful shutdown...');
    try {
        await pool.end();
        console.log('🗄️ Database connections closed');
        client.destroy();
        console.log('🤖 Discord client disconnected');
        console.log('⚓ Bot shutdown complete - fair winds and following seas!');
        process.exit(0);
    } catch (error) {
        console.error('❌ Error during shutdown:', error);
        process.exit(1);
    }
});

process.on('SIGTERM', async () => {
    console.log('📡 Received SIGTERM signal - beginning graceful shutdown...');
    try {
        await pool.end();
        console.log('🗄️ Database connections closed');  
        client.destroy();
        console.log('🤖 Discord client disconnected');
        console.log('⚓ Bot shutdown complete - fair winds and following seas!');
        process.exit(0);
    } catch (error) {
        console.error('❌ Error during shutdown:', error);
        process.exit(1);
    }
});

// Start the bot with enhanced error handling
console.log('🌊 Initializing One Piece Navigator Bot...');
client.login(process.env.DISCORD_TOKEN).catch(error => {
    console.error('🚨 Failed to login to Discord:', error);
    console.error('Please check your DISCORD_TOKEN environment variable');
    process.exit(1);
});
