const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');
const { Pool } = require('pg');
const cron = require('node-cron');

// Database setup
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Parse verified roles from environment variable (using role IDs)
function getVerifiedRoleIds() {
    const rolesEnv = process.env.VERIFIED_ROLE_IDS || '';
    return rolesEnv.split(',').map(id => id.trim()).filter(id => id.length > 0);
}

// Initialize database
async function initializeDatabase() {
    const client = await pool.connect();
    try {
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
            
            CREATE INDEX IF NOT EXISTS idx_user_guild ON verified_users(user_id, guild_id);
            CREATE INDEX IF NOT EXISTS idx_pending_user ON pending_verifications(user_id);
        `);
        console.log('Database initialized successfully');
    } catch (error) {
        console.error('Database initialization error:', error);
    } finally {
        client.release();
    }
}

// Discord bot setup
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

// Update user activity
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
    await initializeDatabase();
});

// Handle verification button click
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
            .setColor(0x0F172A) // Deep sea navigation blue
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
                
                await client_db.query('COMMIT');

                // Add verified role
                const verifiedRoleName = process.env.VERIFIED_ROLE_NAME || 'Verified';
                const role = interaction.guild.roles.cache.find(r => r.name === verifiedRoleName);
                
                if (role) {
                    const member = await interaction.guild.members.fetch(userId);
                    await member.roles.add(role);
                }

                const successEmbed = new EmbedBuilder()
                    .setTitle('⚓ Navigation Successful!')
                    .setDescription('Outstanding seamanship! You\'ve proven your worth as a capable navigator and earned your place among the crew. Your Log Pose is now calibrated - set sail toward adventure!')
                    .setColor(0x059669) // Emerald sea green
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
                    .setColor(0xDC2626) // Warning red
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
    const guildId = reaction.message.guild.id;
    
    const verified = await isUserVerified(userId, guildId);
    if (verified) {
        await updateUserActivity(userId, guildId);
    }
});

// Slash command to create verification message
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'setup-navigator-test') {
        // Check permissions
        if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
            return interaction.reply({
                content: '❌ You need "Manage Server" permission to establish the navigator testing system.',
                ephemeral: true
            });
        }

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
            .setTitle('🧭 Chart Your Course to Adventure!')
            .setDescription(`Ahoy there, aspiring seafarer! Welcome to these treacherous yet magnificent waters!\n\n🌊 **Ready to brave the Grand Line?** Prove your worth as a navigator by completing the challenge below!\n\n**What awaits worthy crew members:**\n⚓ Access to all ship channels and hidden coves\n🗺️ Participate in legendary treasure hunts\n🎵 Join voice channels for strategic planning\n🏴‍☠️ React and interact with fellow adventurers\n💎 Share in the spoils of exploration\n${roleDisplayText}**⚠️ Navigator\'s Code:** Your passage may be revoked if you remain inactive (no messages, reactions, or voice activity) for more than 30 days. Even the most skilled navigators must chart their course regularly!`)
            .setColor(0x1E3A8A) // Deep ocean blue
            .setFooter({ text: 'Every great adventure begins with courage • Click below to start your journey' })
            .setTimestamp();

        const button = new ButtonBuilder()
            .setCustomId('verify_button')
            .setLabel('🧭 Begin Navigation Test')
            .setStyle(ButtonStyle.Primary)
            .setEmoji('⚓');

        const row = new ActionRowBuilder().addComponents(button);

        await interaction.reply({
            embeds: [embed],
            components: [row]
        });
    }
});

// Daily cleanup job - remove inactive users
cron.schedule('0 0 * * *', async () => { // Runs at midnight every day
    console.log('Running daily navigation privilege review...');
    
    const client_db = await pool.connect();
    try {
        // Find users inactive for more than 30 days
        const result = await client_db.query(`
            SELECT user_id, guild_id 
            FROM verified_users 
            WHERE last_activity < NOW() - INTERVAL '30 days'
        `);

        for (const user of result.rows) {
            try {
                const guild = await client.guilds.fetch(user.guild_id);
                const member = await guild.members.fetch(user.user_id);
                
                // Remove all verified roles
                const verifiedRoleIds = getVerifiedRoleIds();
                let rolesRemoved = [];
                
                for (const roleId of verifiedRoleIds) {
                    const role = guild.roles.cache.get(roleId);
                    if (role && member.roles.cache.has(roleId)) {
                        await member.roles.remove(role);
                        rolesRemoved.push(role.name);
                        console.log(`Removed role "${role.name}" (${roleId}) from inactive user ${user.user_id}`);
                    }
                }
                
                // Remove from database
                await client_db.query(
                    'DELETE FROM verified_users WHERE user_id = $1 AND guild_id = $2',
                    [user.user_id, user.guild_id]
                );
                
                console.log(`Navigation privileges revoked from inactive seafarer: ${user.user_id} (${rolesRemoved.length} roles removed: ${rolesRemoved.join(', ')})`);
                
            } catch (error) {
                console.error(`Error revoking navigation privileges from seafarer ${user.user_id}:`, error);
            }
        }
        
        console.log(`Navigation review completed. Processed ${result.rows.length} inactive seafarers.`);
        
    } catch (error) {
        console.error('Error during navigation privilege review:', error);
    } finally {
        client_db.release();
    }
});

// Register slash commands
client.once('ready', async () => {
    const commands = [
        {
            name: 'setup-navigator-test',
            description: 'Establish the navigator testing system for new seafarers in this channel'
        }
    ];

    try {
        await client.application.commands.set(commands);
        console.log('Slash commands registered successfully');
    } catch (error) {
        console.error('Error registering slash commands:', error);
    }
});

// Error handling
client.on('error', console.error);

process.on('unhandledRejection', (error) => {
    console.error('Unhandled promise rejection:', error);
});

// Start the bot
client.login(process.env.DISCORD_TOKEN);
