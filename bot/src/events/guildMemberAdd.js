const { ChannelType, PermissionFlagsBits } = require('discord.js');

async function ensureOnboardingCategory(guild, logger = null) {
        const existing = guild.channels.cache.find(
                (channel) => channel.type === ChannelType.GuildCategory && channel.name.toLowerCase() === 'onboarding'
        );
        if (existing) return existing;
        try {
                return await guild.channels.create({
                        name: 'Onboarding',
                        type: ChannelType.GuildCategory,
                        reason: 'Canal privé de bienvenue (fallback)'
                });
        } catch (err) {
                logger?.warn({ err, guildId: guild.id }, 'Failed to create onboarding category');
                throw err;
        }
}

async function createFallbackChannel(member, logger = null, ownerId = null) {
        const guild = member.guild;
        const category = await ensureOnboardingCategory(guild, logger);
        const channelName = `welcome-${member.user.username}`
                .toLowerCase()
                .replace(/[^a-z0-9-]/g, '-')
                .replace(/-{2,}/g, '-')
                .slice(0, 90);

        try {
                const overwrites = [
                        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
                        { id: member.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
                        { id: guild.members.me?.id || guild.client.user.id, allow: [PermissionFlagsBits.ViewChannel] }
                ];
                if (ownerId) {
                        overwrites.push({ id: ownerId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] });
                }

                const channel = await guild.channels.create({
                        name: channelName || `welcome-${member.id}`,
                        type: ChannelType.GuildText,
                        parent: category.id,
                        reason: 'Fallback onboarding channel',
                        permissionOverwrites: overwrites
                });
                return channel;
        } catch (err) {
                logger?.warn({ err, guildId: guild.id }, 'Failed to create onboarding fallback channel');
                return null;
        }
}

module.exports = {
        name: 'guildMemberAdd',
        once: false,
        async execute(member, client) {
                const logger = client?.context?.logger || null;
                const services = client?.context?.services;
                const welcomeService = services?.welcome;
                if (!welcomeService) return;

                try {
                        await welcomeService.sendWizardToUser(member);
                        return;
                } catch (err) {
                        logger?.info({ err, guildId: member.guild.id, userId: member.id }, 'Direct message welcome failed');
                }

                const ownerId = client?.context?.config?.ownerUserId || process.env.OWNER_ID || process.env.OWNER_USER_ID || null;
                const channel = await createFallbackChannel(member, logger, ownerId);
                if (!channel) return;

                try {
                        await welcomeService.sendWizardToUser(channel, { mentionId: member.id });
                } catch (err) {
                        logger?.warn({ err, channelId: channel.id }, 'Failed to send fallback welcome message');
                }
        }
};
