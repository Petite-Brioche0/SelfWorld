
const { ChannelType, PermissionFlagsBits } = require('discord.js');

async function applyZoneOverwrites(category, { everyoneRole, zoneMemberRole, zoneOwnerRole }, botRole, channels = {}) {
        const baseCategory = [
                { id: everyoneRole.id, deny: [PermissionFlagsBits.ViewChannel] },
                { id: zoneMemberRole.id, allow: [PermissionFlagsBits.ViewChannel] },
                {
                        id: zoneOwnerRole.id,
                        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]
                }
        ];

        if (botRole) {
                baseCategory.push({
                        id: botRole.id,
                        allow: [
                                PermissionFlagsBits.ViewChannel,
                                PermissionFlagsBits.SendMessages,
                                PermissionFlagsBits.ManageChannels,
                                PermissionFlagsBits.ManageMessages,
                                PermissionFlagsBits.ManageWebhooks
                        ]
                });
        }

        await category.permissionOverwrites.set(baseCategory);

        let children = new Map();
        const childrenManager = category?.children;
        if (childrenManager?.fetch) {
                const fetched = childrenManager.cache?.size ? childrenManager.cache : await childrenManager.fetch();
                children = new Map(fetched);
        } else if (category.guild?.channels?.cache) {
                children = new Map(
                        [...category.guild.channels.cache.values()].filter((ch) => ch.parentId === category.id).map((ch) => [ch.id, ch])
                );
        }

        const panelChannel = channels.panel || [...children.values()].find((ch) => ch.name === 'panel');
        const receptionChannel = channels.reception || [...children.values()].find((ch) => ch.name === 'reception');
        const chuchotementChannel = channels.chuchotement || [...children.values()].find((ch) => ch.name === 'chuchotement');

        if (panelChannel) {
                const panelOverwrites = [
                        { id: everyoneRole.id, deny: [PermissionFlagsBits.ViewChannel] },
                        { id: zoneMemberRole.id, deny: [PermissionFlagsBits.ViewChannel] },
                        {
                                id: zoneOwnerRole.id,
                                allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
                                deny: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels]
                        }
                ];

                if (botRole) {
                        panelOverwrites.push({
                                id: botRole.id,
                                allow: [
                                        PermissionFlagsBits.ViewChannel,
                                        PermissionFlagsBits.SendMessages,
                                        PermissionFlagsBits.ManageChannels,
                                        PermissionFlagsBits.ManageMessages,
                                        PermissionFlagsBits.ManageWebhooks,
                                        PermissionFlagsBits.ReadMessageHistory
                                ]
                        });
                }

                await panelChannel.permissionOverwrites.set(panelOverwrites);
        }

        if (receptionChannel) {
                const overwrites = [
                        { id: everyoneRole.id, deny: [PermissionFlagsBits.ViewChannel] },
                        {
                                id: zoneMemberRole.id,
                                allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
                                deny: [PermissionFlagsBits.SendMessages]
                        },
                        {
                                id: zoneOwnerRole.id,
                                allow: [
                                        PermissionFlagsBits.ViewChannel,
                                        PermissionFlagsBits.SendMessages,
                                        PermissionFlagsBits.ReadMessageHistory
                                ]
                        }
                ];

                if (botRole) {
                        overwrites.push({
                                id: botRole.id,
                                allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory]
                        });
                }

                await receptionChannel.permissionOverwrites.set(overwrites);
        }

        for (const channel of children.values()) {
                if (!channel || !channel.permissionOverwrites) continue;
                if (panelChannel && channel.id === panelChannel.id) continue;
                if (receptionChannel && channel.id === receptionChannel.id) continue;

                if (channel.type === ChannelType.GuildText) {
                        const overwrites = [
                                { id: everyoneRole.id, deny: [PermissionFlagsBits.ViewChannel] },
                                {
                                        id: zoneMemberRole.id,
                                        allow: [
                                                PermissionFlagsBits.ViewChannel,
                                                PermissionFlagsBits.SendMessages,
                                                PermissionFlagsBits.ReadMessageHistory
                                        ]
                                },
                        {
                                id: zoneOwnerRole.id,
                                allow: [
                                        PermissionFlagsBits.ViewChannel,
                                        PermissionFlagsBits.SendMessages,
                                        PermissionFlagsBits.ReadMessageHistory
                                ]
                        }
                        ];

                        if (botRole) {
                                const botPerms = [
                                        PermissionFlagsBits.ViewChannel,
                                        PermissionFlagsBits.SendMessages,
                                        PermissionFlagsBits.ReadMessageHistory,
                                        PermissionFlagsBits.ManageChannels,
                                        PermissionFlagsBits.ManageMessages
                                ];
                                if (chuchotementChannel && channel.id === chuchotementChannel.id) {
                                        botPerms.push(PermissionFlagsBits.ManageWebhooks);
                                }
                                overwrites.push({ id: botRole.id, allow: botPerms });
                        }

                        await channel.permissionOverwrites.set(overwrites);
                }

                if (channel.type === ChannelType.GuildVoice) {
                        const overwrites = [
                                {
                                        id: everyoneRole.id,
                                        deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect]
                                },
                                {
                                        id: zoneMemberRole.id,
                                        allow: [
                                                PermissionFlagsBits.ViewChannel,
                                                PermissionFlagsBits.Connect,
                                                PermissionFlagsBits.Speak
                                        ]
                                },
                        {
                                id: zoneOwnerRole.id,
                                allow: [
                                        PermissionFlagsBits.ViewChannel,
                                        PermissionFlagsBits.Connect,
                                        PermissionFlagsBits.Speak
                                ]
                        }
                        ];

                        if (botRole) {
                                overwrites.push({
                                        id: botRole.id,
                                        allow: [
                                                PermissionFlagsBits.ViewChannel,
                                                PermissionFlagsBits.Connect,
                                                PermissionFlagsBits.Speak,
                                                PermissionFlagsBits.MoveMembers,
                                                PermissionFlagsBits.MuteMembers,
                                                PermissionFlagsBits.DeafenMembers,
                                                PermissionFlagsBits.ManageChannels
                                        ]
                                });
                        }

                        await channel.permissionOverwrites.set(overwrites);
                }
        }
}

async function applyPanelOverrides(panelChannel, { everyoneRole, zoneMemberRole, zoneOwnerRole }, botRole) {
        if (!panelChannel?.permissionOverwrites) return;

        const overwrites = [];

        if (everyoneRole) {
                overwrites.push({ id: everyoneRole.id, deny: [PermissionFlagsBits.ViewChannel] });
        }

        if (zoneMemberRole) {
                overwrites.push({ id: zoneMemberRole.id, deny: [PermissionFlagsBits.ViewChannel] });
        }

        if (zoneOwnerRole) {
                overwrites.push({
                        id: zoneOwnerRole.id,
                        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
                        deny: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels]
                });
        }

        if (botRole) {
                overwrites.push({
                        id: botRole.id,
                        allow: [
                                PermissionFlagsBits.ViewChannel,
                                PermissionFlagsBits.SendMessages,
                                PermissionFlagsBits.ManageChannels,
                                PermissionFlagsBits.ManageMessages,
                                PermissionFlagsBits.ManageWebhooks,
                                PermissionFlagsBits.ReadMessageHistory
                        ]
                });
        }

        await panelChannel.permissionOverwrites.set(overwrites);
}

module.exports = { applyZoneOverwrites, applyPanelOverrides };
