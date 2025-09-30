
const { InteractionType, MessageFlags } = require('discord.js');

module.exports = {
	name: 'interactionCreate',
	once: false,
        async execute(interaction, client) {
                try {
                        const ownerId =
                                client?.context?.config?.ownerUserId ||
                                process.env.OWNER_ID ||
                                process.env.OWNER_USER_ID;

                        const commands = client.commands;
                        const context = client.contextMenus;
                        const services = client.context.services;

                        if (interaction.isChatInputCommand()) {
                                const cmd = commands.get(interaction.commandName);
                                if (!cmd) return;
                                if (cmd.ownerOnly && interaction.user.id !== ownerId) {
                                        return interaction.reply({ content: 'Commande réservée à l’Owner.', flags: MessageFlags.Ephemeral });
                                }
				return cmd.execute(interaction, client.context);
			}

			if (interaction.isContextMenuCommand()) {
				const cmd = context.get(interaction.commandName);
				if (!cmd) return;
                                if (cmd.ownerOnly && interaction.user.id !== ownerId) {
                                        return interaction.reply({ content: 'Commande réservée à l’Owner.', flags: MessageFlags.Ephemeral });
                                }
                                return cmd.execute(interaction, client.context);
                        }

                        const throttleService = services?.throttle || null;
                        const isOwner = ownerId && interaction.user.id === String(ownerId);
                        let weight = null;
                        let customId = '';

                        if (interaction.isModalSubmit()) {
                                weight = 3;
                                customId = interaction.customId || '';
                        } else if (interaction.isButton()) {
                                weight = 1;
                                customId = interaction.customId || '';
                        } else if (interaction.isStringSelectMenu()) {
                                weight = 1;
                                customId = interaction.customId || '';
                        } else if ('customId' in interaction) {
                                customId = interaction.customId || '';
                        }

                        if (customId.startsWith('zone:request:')) {
                                weight = 5;
                        }
                        if (customId.startsWith('welcome:browse:next') || customId.startsWith('welcome:browse:prev')) {
                                weight = 1;
                        }

                        if (weight != null && throttleService && !isOwner) {
                                const result = await throttleService.consume(interaction.user.id, weight, 'interaction');
                                if (!result.ok) {
                                        const secs = Math.ceil(result.retryMs / 1000);
                                        const payload = interaction.inGuild()
                                                ? { content: `⏳ Calme :) Réessaie dans ${secs}s.`, flags: MessageFlags.Ephemeral }
                                                : { content: `⏳ Calme :) Réessaie dans ${secs}s.` };
                                        await interaction.reply(payload).catch(() => {});
                                        return;
                                }
                        }

                        const isReception = services.zone?.isReceptionChannel?.(interaction.channelId) === true;
                        if (customId.startsWith('welcome:') && isReception) {
                                interaction.forceWelcomeEphemeral = true;
                        }

                        if (interaction.isStringSelectMenu()) {
                                const id = interaction.customId || '';
                                if (id.startsWith('panel:policy:set:')) {
                                        return services.policy.handlePolicySelect(interaction);
                                }
                                if (id.startsWith('panel:policy:askmode:')) {
                                        return services.policy.handleAskModeSelect(interaction);
                                }
                                if (id.startsWith('panel:policy:approver:')) {
                                        return services.policy.handleApproverSelect(interaction);
                                }
                                if (id.startsWith('panel:')) {
                                        return services.panel.handleSelectMenu(interaction);
                                }
                        }

                        if (interaction.isButton()) {
                                const id = interaction.customId || '';
                                if (id.startsWith('welcome:')) {
                                        return services.welcome.handleButton(interaction);
                                }
                                if (id.startsWith('panel:policy:profile:')) {
                                        return services.policy.handleProfileButton(interaction);
                                }
                                if (id.startsWith('panel:policy:code:gen:')) {
                                        return services.policy.handleGenerateCode(interaction);
                                }
                                if (id.startsWith('zone:approve:') || id.startsWith('zone:reject:')) {
                                        return services.policy.handleApprovalButton(interaction);
                                }
                                if (id.startsWith('temp:extend:') || id.startsWith('temp:delete:')) {
                                        return services.tempGroup.handleArchiveButtons(interaction);
                                }
                                if (id.startsWith('event:join:')) {
                                        return services.event.handleJoinButton(interaction);
                                }
                                if (id.startsWith('panel:')) {
                                        return services.panel.handleButton(interaction);
                                }
                        }

                        if (interaction.type === InteractionType.ModalSubmit) {
                                const id = interaction.customId || '';
                                if (id.startsWith('zone:request:')) {
                                        return services.zone.handleZoneRequestModal(interaction);
                                }
                                if (id.startsWith('panel:policy:profile:modal:')) {
                                        return services.policy.handleProfileModal(interaction);
                                }
                                if (id.startsWith('welcome:')) {
                                        return services.welcome.handleModal(interaction);
                                }
                                if (id.startsWith('panel:')) {
                                        return services.panel.handleModal(interaction);
                                }
                        }
		} catch (err) {
			console.error('[interactionCreate] error:', err);
                        if (interaction && !interaction.replied) {
                                try { await interaction.reply({ content: 'Erreur lors du traitement.', flags: MessageFlags.Ephemeral }); } catch {}
                        }
		}
	}
};
