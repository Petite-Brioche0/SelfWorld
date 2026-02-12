// Ensures proper welcome for new members by creating a hub channel with panels
const { ChannelType, PermissionFlagsBits } = require('discord.js');
const { shortId } = require('../utils/ids');

async function ensureHubCategory(guild, logger = null) {
        const existing = guild.channels.cache.find(
                (channel) => channel.type === ChannelType.GuildCategory && channel.name.toLowerCase() === 'hub'
        );
        if (existing) return existing;
        try {
                return await guild.channels.create({
                        name: 'Hub',
                        type: ChannelType.GuildCategory,
                        reason: 'Canal hub privé (fallback)'
                });
        } catch (err) {
                logger?.warn({ err, guildId: guild.id }, 'Failed to create hub category');
                throw err;
        }
}

async function createFallbackChannel(member, logger = null) {
        const guild = member.guild;
        const category = await ensureHubCategory(guild, logger);
        const channelName = `hub-${shortId()}`;

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
                        reason: 'Fallback hub channel',
                        permissionOverwrites: overwrites,
                        topic: 'Hub'
                });
                return channel;
        } catch (err) {
                logger?.warn({ err, guildId: guild.id }, 'Failed to create hub fallback channel');
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
                const hubService = services?.hub;
                if (!welcomeService && !hubService) return;

                try {
                        if (hubService?.ensureHubChannelForMember) {
                                const channel = await hubService.ensureHubChannelForMember(member);
                                if (channel) return;
                        }
                } catch (err) {
                        logger?.warn({ err, guildId: member.guild.id, userId: member.id }, 'Failed to create hub channel');
                }

                if (!welcomeService) return;

                const ownerId =
                        client?.context?.config?.ownerUserId ||
                        process.env.OWNER_ID ||
                        process.env.OWNER_USER_ID;
                const isOwner = ownerId && String(member.id) === String(ownerId);

                if (isOwner) {
                        try {
                                await welcomeService.sendWizardToUser(member, { guildId: member.guild.id });
                                return;
                        } catch (err) {
                                logger?.info({ err, guildId: member.guild.id, userId: member.id }, 'Direct message welcome failed');
                        }
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
