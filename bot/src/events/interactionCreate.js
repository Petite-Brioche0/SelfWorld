const {
	InteractionType,
	MessageFlags,
	DiscordAPIError,
	ModalBuilder,
	TextInputBuilder,
	TextInputStyle,
	ActionRowBuilder
} = require('discord.js');

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
               if (id.startsWith('temp:panel:')) {
                       return { key: 'temp.panel.invite', seconds: 12 };
               }
               if (id.startsWith('panel:')) {
                       return { key: 'panel.modal', seconds: 10 };
               }
               return { key: 'modal.generic', seconds: DEFAULT_THROTTLE_SECONDS };
       }

       if (interaction.isButton()) {
               const id = interaction.customId || '';
               if (id === 'temp:fromAnon:create:closed' || id === 'temp:fromAnon:create:open') {
                       return { key: 'anon.temp.create', seconds: 10 };
               }
               if (id.startsWith('temp:open:join:') || id.startsWith('temp:open:spectate:')) {
                       return { key: 'anon.temp.participate', seconds: 6 };
               }
               if (id.startsWith('temp:panel:')) {
                       return { key: 'temp.panel.button', seconds: 6 };
               }
               if (id.startsWith('temp:join:') || id.startsWith('temp:spectate:') || id.startsWith('temp:leave:')) {
                       return { key: 'temp.membership', seconds: 6 };
               }
               if (id.startsWith('temp:vote:')) {
                       return { key: 'temp.vote', seconds: 10 };
               }
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
               if (id === 'temp:fromAnon:closed:select') {
                       return { key: 'anon.temp.select', seconds: 12 };
               }
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
                                if (id === 'temp:fromAnon:closed:select') {
                                        if (!services.anon) {
                                                await safeReply(interaction, {
                                                        content: 'Service indisponible.',
                                                        flags: MessageFlags.Ephemeral
                                                });
                                                return;
                                        }
                                        await services.anon.handleFromAnonClosedSelect(interaction);
                                        return;
                                }
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
                                if (id === 'temp:fromAnon:create:closed') {
                                        if (!services.anon) {
                                                await safeReply(interaction, {
                                                        content: 'Service indisponible.',
                                                        flags: MessageFlags.Ephemeral
                                                });
                                                return;
                                        }
                                        await services.anon.handleFromAnonCreateClosed(interaction);
                                        return;
                                }
                                if (id === 'temp:fromAnon:create:open') {
                                        if (!services.anon) {
                                                await safeReply(interaction, {
                                                        content: 'Service indisponible.',
                                                        flags: MessageFlags.Ephemeral
                                                });
                                                return;
                                        }
                                        await services.anon.handleFromAnonCreateOpen(interaction);
                                        return;
                                }
                                if (id.startsWith('temp:open:join:')) {
                                        if (!services.anon) {
                                                await safeReply(interaction, {
                                                        content: 'Service indisponible.',
                                                        flags: MessageFlags.Ephemeral
                                                });
                                                return;
                                        }
                                        const groupId = Number(id.split(':')[3]);
                                        if (!Number.isFinite(groupId)) {
                                                await safeReply(interaction, {
                                                        content: 'Identifiant de groupe invalide.',
                                                        flags: MessageFlags.Ephemeral
                                                });
                                                return;
                                        }
                                        await services.anon.handleOpenJoin(interaction, groupId);
                                        return;
                                }
                                if (id.startsWith('temp:open:spectate:')) {
                                        if (!services.anon) {
                                                await safeReply(interaction, {
                                                        content: 'Service indisponible.',
                                                        flags: MessageFlags.Ephemeral
                                                });
                                                return;
                                        }
                                        const groupId = Number(id.split(':')[3]);
                                        if (!Number.isFinite(groupId)) {
                                                await safeReply(interaction, {
                                                        content: 'Identifiant de groupe invalide.',
                                                        flags: MessageFlags.Ephemeral
                                                });
                                                return;
                                        }
                                        await services.anon.handleOpenSpectate(interaction, groupId);
                                        return;
                                }
                                const tempGroupService = services.tempGroup;
                                if (id.startsWith('temp:panel:')) {
                                        if (!tempGroupService) {
                                                await safeReply(interaction, {
                                                        content: 'Service des groupes indisponible.',
                                                        flags: MessageFlags.Ephemeral
                                                });
                                                return;
                                        }
                                        const match = id.match(/^temp:panel:(\d+):(refresh|invite)$/);
                                        if (!match) {
                                                await safeReply(interaction, {
                                                        content: 'Action du panneau inconnue.',
                                                        flags: MessageFlags.Ephemeral
                                                });
                                                return;
                                        }
                                        const tempGroupId = Number(match[1]);
                                        if (!Number.isFinite(tempGroupId)) {
                                                await safeReply(interaction, {
                                                        content: 'Identifiant de groupe invalide.',
                                                        flags: MessageFlags.Ephemeral
                                                });
                                                return;
                                        }
                                        if (match[2] === 'refresh') {
                                                const ok = await tempGroupService.updatePanel(tempGroupId);
                                                await safeReply(interaction, {
                                                        content: ok ? 'Panneau rafraîchi.' : 'Groupe introuvable.',
                                                        flags: MessageFlags.Ephemeral
                                                });
                                                return;
                                        }
                                        if (match[2] === 'invite') {
                                                const group = await tempGroupService.getGroup(tempGroupId);
                                                if (!group) {
                                                        await safeReply(interaction, {
                                                                content: 'Groupe introuvable.',
                                                                flags: MessageFlags.Ephemeral
                                                        });
                                                        return;
                                                }
                                                if (group.archived) {
                                                        await safeReply(interaction, {
                                                                content: 'Ce groupe est archivé.',
                                                                flags: MessageFlags.Ephemeral
                                                        });
                                                        return;
                                                }
                                                const role = await tempGroupService.getMemberRole(tempGroupId, interaction.user.id);
                                                if (role !== 'member') {
                                                        await safeReply(interaction, {
                                                                content: 'Seuls les membres peuvent inviter.',
                                                                flags: MessageFlags.Ephemeral
                                                        });
                                                        return;
                                                }
                                                const modal = new ModalBuilder()
                                                        .setCustomId(`temp:panel:${tempGroupId}:inviteModal`)
                                                        .setTitle('Inviter des membres');
                                                const input = new TextInputBuilder()
                                                        .setCustomId('user_ids')
                                                        .setLabel('IDs séparés par des espaces')
                                                        .setStyle(TextInputStyle.Paragraph)
                                                        .setRequired(true)
                                                        .setPlaceholder('1234567890 0987654321');
                                                modal.addComponents(new ActionRowBuilder().addComponents(input));
                                                await interaction.showModal(modal);
                                                return;
                                        }
                                }
                                if (id.startsWith('temp:join:')) {
                                        if (!tempGroupService?.joinGroup) {
                                                await safeReply(interaction, {
                                                        content: 'Service des groupes indisponible.',
                                                        flags: MessageFlags.Ephemeral
                                                });
                                                return;
                                        }
                                        const tempGroupId = Number(id.split(':')[2]);
                                        if (!Number.isFinite(tempGroupId)) {
                                                await safeReply(interaction, {
                                                        content: 'Identifiant de groupe invalide.',
                                                        flags: MessageFlags.Ephemeral
                                                });
                                                return;
                                        }
                                        const result = await tempGroupService.joinGroup(tempGroupId, interaction.user.id);
                                        await safeReply(interaction, {
                                                content: result?.message || (result?.ok ? 'Inscription enregistrée.' : 'Action impossible.'),
                                                flags: MessageFlags.Ephemeral
                                        });
                                        return;
                                }
                                if (id.startsWith('temp:spectate:')) {
                                        if (!tempGroupService?.spectateGroup) {
                                                await safeReply(interaction, {
                                                        content: 'Service des groupes indisponible.',
                                                        flags: MessageFlags.Ephemeral
                                                });
                                                return;
                                        }
                                        const tempGroupId = Number(id.split(':')[2]);
                                        if (!Number.isFinite(tempGroupId)) {
                                                await safeReply(interaction, {
                                                        content: 'Identifiant de groupe invalide.',
                                                        flags: MessageFlags.Ephemeral
                                                });
                                                return;
                                        }
                                        const result = await tempGroupService.spectateGroup(tempGroupId, interaction.user.id);
                                        await safeReply(interaction, {
                                                content: result?.message || (result?.ok ? 'Mode spectateur activé.' : 'Action impossible.'),
                                                flags: MessageFlags.Ephemeral
                                        });
                                        return;
                                }
                                if (id.startsWith('temp:leave:')) {
                                        if (!tempGroupService?.leaveGroup) {
                                                await safeReply(interaction, {
                                                        content: 'Service des groupes indisponible.',
                                                        flags: MessageFlags.Ephemeral
                                                });
                                                return;
                                        }
                                        const tempGroupId = Number(id.split(':')[2]);
                                        if (!Number.isFinite(tempGroupId)) {
                                                await safeReply(interaction, {
                                                        content: 'Identifiant de groupe invalide.',
                                                        flags: MessageFlags.Ephemeral
                                                });
                                                return;
                                        }
                                        const result = await tempGroupService.leaveGroup(tempGroupId, interaction.user.id);
                                        await safeReply(interaction, {
                                                content: result?.message || (result?.ok ? 'Groupe quitté.' : 'Action impossible.'),
                                                flags: MessageFlags.Ephemeral
                                        });
                                        return;
                                }
                                if (id.startsWith('temp:vote:')) {
                                        if (!tempGroupService?.handleVote) {
                                                await safeReply(interaction, {
                                                        content: 'Service des groupes indisponible.',
                                                        flags: MessageFlags.Ephemeral
                                                });
                                                return;
                                        }
                                        const match = id.match(/^temp:vote:(remove|keep):(\d+)$/);
                                        if (!match) {
                                                await safeReply(interaction, {
                                                        content: 'Vote invalide.',
                                                        flags: MessageFlags.Ephemeral
                                                });
                                                return;
                                        }
                                        const action = match[1];
                                        const tempGroupId = Number(match[2]);
                                        if (!Number.isFinite(tempGroupId)) {
                                                await safeReply(interaction, {
                                                        content: 'Identifiant de groupe invalide.',
                                                        flags: MessageFlags.Ephemeral
                                                });
                                                return;
                                        }
                                        const result = await tempGroupService.handleVote(tempGroupId, interaction.user.id, action);
                                        let content = result?.message || 'Vote enregistré.';
                                        if (result?.ok) {
                                                if (result.status === 'archived') {
                                                        content = 'Vote enregistré. Le groupe a été archivé.';
                                                } else if (result.status === 'unfrozen') {
                                                        content = 'Vote enregistré. Le gel est levé.';
                                                } else if (result.status === 'vote-recorded') {
                                                        const votes = Number(result.votes || 0);
                                                        content = `Vote enregistré. ${votes}/3 pour la suppression.`;
                                                }
                                        }
                                        await safeReply(interaction, {
                                                content,
                                                flags: MessageFlags.Ephemeral
                                        });
                                        return;
                                }
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
                                if (id.startsWith('temp:panel:')) {
                                        const tempGroupService = services.tempGroup;
                                        if (!tempGroupService?.inviteMembers) {
                                                await safeReply(interaction, {
                                                        content: 'Service des groupes indisponible.',
                                                        flags: MessageFlags.Ephemeral
                                                });
                                                return;
                                        }
                                        const match = id.match(/^temp:panel:(\d+):inviteModal$/);
                                        if (!match) {
                                                await safeReply(interaction, {
                                                        content: 'Action du panneau inconnue.',
                                                        flags: MessageFlags.Ephemeral
                                                });
                                                return;
                                        }
                                        const tempGroupId = Number(match[1]);
                                        if (!Number.isFinite(tempGroupId)) {
                                                await safeReply(interaction, {
                                                        content: 'Identifiant de groupe invalide.',
                                                        flags: MessageFlags.Ephemeral
                                                });
                                                return;
                                        }
                                        const raw = interaction.fields.getTextInputValue('user_ids') || '';
                                        const ids = raw
                                                .split(/\s+/)
                                                .map((part) => part.replace(/[^0-9]/g, ''))
                                                .filter(Boolean);
                                        const result = await tempGroupService.inviteMembers(tempGroupId, interaction.user.id, ids);
                                        await safeReply(interaction, {
                                                content:
                                                        result?.message ||
                                                        (result?.ok
                                                                ? 'Invitations traitées.'
                                                                : 'Impossible de traiter les invitations.'),
                                                flags: MessageFlags.Ephemeral
                                        });
                                        return;
                                }
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
