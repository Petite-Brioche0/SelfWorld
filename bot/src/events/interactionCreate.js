const { InteractionType, MessageFlags, DiscordAPIError } = require('discord.js');

const DEFAULT_THROTTLE_SECONDS = 4;

function isUnknownInteractionError(error) {
        if (!error) return false;
        if (error instanceof DiscordAPIError && error.code === 10062) return true;
        if (error?.code === 10062 || error?.rawError?.code === 10062) return true;
        return false;
}

function resolveCooldown(interaction) {
        if (!interaction) return null;

        if (interaction.isModalSubmit()) {
                const id = interaction.customId || '';
                if (id.startsWith('zone:request:') || id === 'welcome:request:modal') {
                        return { key: 'zone.request.create', seconds: 600 };
                }
                if (id.startsWith('req:editaccept:')) {
                        return { key: 'zone.request.review', seconds: 8 };
                }
                if (id.startsWith('panel:role:create')) {
                        return { key: 'zone.role.create', seconds: 60 };
                }
                if (id.startsWith('panel:ch:create')) {
                        return { key: 'panel.channels.edit', seconds: 25 };
                }
                if (id.startsWith('panel:')) {
                        return { key: 'panel.modal', seconds: 10 };
                }
                return { key: 'modal.generic', seconds: DEFAULT_THROTTLE_SECONDS };
        }

        if (interaction.isButton()) {
                const id = interaction.customId || '';
                if (id.startsWith('panel:refresh:')) {
                        return { key: 'panel.refresh', seconds: 10 };
                }
                if (id.startsWith('panel:role:')) {
                        return { key: 'panel.roles.edit', seconds: 25 };
                }
                if (id.startsWith('panel:ch:')) {
                        return { key: 'panel.channels.edit', seconds: 25 };
                }
                if (id.startsWith('panel:member:')) {
                        return { key: 'panel.members.manage', seconds: 15 };
                }
                if (id.startsWith('panel:policy:')) {
                        return { key: 'panel.policy', seconds: 12 };
                }
                if (id.startsWith('req:')) {
                        return { key: 'zone.request.review', seconds: 8 };
                }
                if (id.startsWith('zone:approve:') || id.startsWith('zone:reject:')) {
                        return { key: 'zone.request.review', seconds: 8 };
                }
                if (id.startsWith('welcome:')) {
                        return { key: 'welcome.flow', seconds: 5 };
                }
                return { key: 'button.generic', seconds: DEFAULT_THROTTLE_SECONDS };
        }

        if (interaction.isStringSelectMenu()) {
                const id = interaction.customId || '';
                if (id.startsWith('panel:policy:')) {
                        return { key: 'panel.policy', seconds: 10 };
                }
                if (id.startsWith('panel:')) {
                        return { key: 'panel.select', seconds: 6 };
                }
                if (id.startsWith('admin:zonecreate:')) {
                        return { key: 'zone.create.policy', seconds: 20 };
                }
                return { key: 'select.generic', seconds: DEFAULT_THROTTLE_SECONDS };
        }

        return null;
}

async function safeReply(interaction, payload) {
        if (!interaction) return;
        try {
                if (!interaction.deferred && !interaction.replied) {
                        await interaction.reply(payload);
                } else {
                        await interaction.followUp(payload);
                }
        } catch (err) {
                if (!isUnknownInteractionError(err)) throw err;
        }
}

async function ensureDeferred(interaction, payload) {
        if (!interaction) return;
        if (interaction.deferred || interaction.replied) return;
        try {
                await interaction.deferReply(payload);
        } catch (err) {
                if (!isUnknownInteractionError(err)) throw err;
        }
}

module.exports = {
        name: 'interactionCreate',
        once: false,
        async execute(interaction, client) {
                const ownerId =
                        client?.context?.config?.ownerUserId ||
                        process.env.OWNER_ID ||
                        process.env.OWNER_USER_ID;

                const commands = client.commands;
                const context = client.contextMenus;
                const services = client.context.services;

                const throttleService = services?.throttle || null;
                const isOwner = ownerId && interaction.user.id === String(ownerId);
                const cooldown = !isOwner ? resolveCooldown(interaction) : null;
                let throttleKey = null;

                try {
                        if (cooldown && throttleService) {
                                const result = await throttleService.begin(interaction.user.id, cooldown.key, cooldown.seconds);
                                if (!result.ok) {
                                        await safeReply(interaction, {
                                                content: `⏳ Calme :) Réessaie dans ${result.retrySec}s.`,
                                                flags: MessageFlags.Ephemeral
                                        });
                                        return;
                                }
                                throttleKey = cooldown.key;
                        }

                        if (interaction.isChatInputCommand()) {
                                const cmd = commands.get(interaction.commandName);
                                if (!cmd) return;
                                if (cmd.ownerOnly && interaction.user.id !== ownerId) {
                                        await safeReply(interaction, {
                                                content: 'Commande réservée à l’Owner.',
                                                flags: MessageFlags.Ephemeral
                                        });
                                        return;
                                }
                                await ensureDeferred(interaction, { flags: MessageFlags.Ephemeral });
                                await cmd.execute(interaction, client.context);
                                return;
                        }

                        if (interaction.isContextMenuCommand()) {
                                const cmd = context.get(interaction.commandName);
                                if (!cmd) return;
                                if (cmd.ownerOnly && interaction.user.id !== ownerId) {
                                        await safeReply(interaction, {
                                                content: 'Commande réservée à l’Owner.',
                                                flags: MessageFlags.Ephemeral
                                        });
                                        return;
                                }
                                await ensureDeferred(interaction, { flags: MessageFlags.Ephemeral });
                                await cmd.execute(interaction, client.context);
                                return;
                        }

                        const customId = 'customId' in interaction ? interaction.customId || '' : '';
                        const isReception = services.zone?.isReceptionChannel?.(interaction.channelId) === true;
                        if (customId.startsWith('welcome:') && isReception) {
                                interaction.forceWelcomeEphemeral = true;
                        }

                        if (interaction.isStringSelectMenu()) {
                                const id = customId;
                                if (id.startsWith('admin:zonecreate:')) {
                                        const cmd = commands.get('zone-create');
                                        if (cmd?.handlePolicySelect) {
                                                await cmd.handlePolicySelect(interaction, client.context);
                                                return;
                                        }
                                }
                                if (id.startsWith('panel:policy:set:')) {
                                        await services.policy.handlePolicySelect(interaction);
                                        return;
                                }
                                if (id.startsWith('panel:policy:askmode:')) {
                                        await services.policy.handleAskModeSelect(interaction);
                                        return;
                                }
                                if (id.startsWith('panel:policy:approver:')) {
                                        await services.policy.handleApproverSelect(interaction);
                                        return;
                                }
                                if (id.startsWith('panel:')) {
                                        await services.panel.handleSelectMenu(interaction);
                                        return;
                                }
                        }

                        if (interaction.isButton()) {
                                const id = customId;
                                if (id.startsWith('welcome:')) {
                                        await services.welcome.handleButton(interaction);
                                        return;
                                }
                                if (id.startsWith('panel:policy:profile:')) {
                                        await services.policy.handleProfileButton(interaction);
                                        return;
                                }
                                if (id.startsWith('panel:policy:code:gen:')) {
                                        await services.policy.handleGenerateCode(interaction);
                                        return;
                                }
                                if (id.startsWith('zone:approve:') || id.startsWith('zone:reject:')) {
                                        await services.policy.handleApprovalButton(interaction);
                                        return;
                                }
                                if (id.startsWith('req:')) {
                                        await services.policy.handleCreationRequestButton(interaction);
                                        return;
                                }
                                if (id.startsWith('temp:extend:') || id.startsWith('temp:delete:')) {
                                        await services.tempGroup.handleArchiveButtons(interaction);
                                        return;
                                }
                                if (id.startsWith('event:join:')) {
                                        await services.event.handleJoinButton(interaction);
                                        return;
                                }
                                if (id.startsWith('panel:')) {
                                        await services.panel.handleButton(interaction);
                                        return;
                                }
                        }

                        if (interaction.type === InteractionType.ModalSubmit) {
                                const id = customId;
                                if (id.startsWith('req:editaccept:')) {
                                        await services.policy.handleCreationRequestModal(interaction);
                                        return;
                                }
                                if (id.startsWith('zone:request:') || id === 'welcome:request:modal') {
                                        await services.policy.handleZoneRequestModal(interaction);
                                        return;
                                }
                                if (id.startsWith('panel:policy:profile:modal:')) {
                                        await services.policy.handleProfileModal(interaction);
                                        return;
                                }
                                if (id.startsWith('welcome:')) {
                                        await services.welcome.handleModal(interaction);
                                        return;
                                }
                                if (id.startsWith('panel:')) {
                                        await services.panel.handleModal(interaction);
                                        return;
                                }
                        }
                } catch (err) {
                        if (isUnknownInteractionError(err)) {
                                client?.context?.logger?.warn({ err }, 'Unknown interaction encountered');
                                return;
                        }
                        client?.context?.logger?.error({ err }, 'interactionCreate handler error');
                        await safeReply(interaction, {
                                content: 'Erreur lors du traitement.',
                                flags: MessageFlags.Ephemeral
                        });
                } finally {
                        if (throttleKey && throttleService) {
                                await throttleService.end(interaction.user.id, throttleKey);
                        }
                }
        }
};
