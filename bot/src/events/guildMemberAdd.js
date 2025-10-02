const { ChannelType, PermissionFlagsBits } = require('discord.js');
const { shortId } = require('../utils/ids');

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

async function createFallbackChannel(member, logger = null) {
        const guild = member.guild;
        const category = await ensureOnboardingCategory(guild, logger);
        const channelName = `onboard-${shortId()}`;

        try {
                const overwrites = [
                        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
                        { id: member.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
                        { id: guild.members.me?.id || guild.client.user.id, allow: [PermissionFlagsBits.ViewChannel] }
                ];

                const channel = await guild.channels.create({
                        name: channelName,
                        type: ChannelType.GuildText,
                        parent: category.id,
                        reason: 'Fallback onboarding channel',
                        permissionOverwrites: overwrites,
                        topic: `onboarding:user:${member.id}`
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
                        await welcomeService.sendWizardToUser(member, { guildId: member.guild.id });
                        return;
                } catch (err) {
                        logger?.info({ err, guildId: member.guild.id, userId: member.id }, 'Direct message welcome failed');
                }

                const channel = await createFallbackChannel(member, logger);
                if (!channel) return;

                try {
                        await welcomeService.sendWizardToUser(channel, { mentionId: member.id, guildId: member.guild.id });
                } catch (err) {
                        logger?.warn({ err, channelId: channel.id }, 'Failed to send fallback welcome message');
                }
        }
};
