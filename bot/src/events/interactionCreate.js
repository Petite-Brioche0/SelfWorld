// src/events/interactionCreate.js
const { InteractionType } = require('discord.js');

module.exports = {
	name: 'interactionCreate',
	once: false,
	async execute(interaction, client) {
		try {
			const ownerId =
				client?.context?.config?.ownerUserId ||
				process.env.OWNER_ID ||
				process.env.OWNER_USER_ID;

			const commands = client.commands;       // Map des slash
			const context  = client.contextMenus;   // Map des context menus
			const services = client.context.services; // { zone, policy, anon, event, activity, tempGroup }

			// Slash commands
			if (interaction.isChatInputCommand()) {
				const cmd = commands.get(interaction.commandName);
				if (!cmd) return;
				if (cmd.ownerOnly && interaction.user.id !== ownerId) {
					return interaction.reply({ content: 'Commande réservée à l’Owner.', ephemeral: true });
				}
				return cmd.execute(interaction, client.context);
			}

			// Context menu
			if (interaction.isContextMenuCommand()) {
				const cmd = context.get(interaction.commandName);
				if (!cmd) return;
				if (cmd.ownerOnly && interaction.user.id !== ownerId) {
					return interaction.reply({ content: 'Commande réservée à l’Owner.', ephemeral: true });
				}
				return cmd.execute(interaction, client.context);
			}

			// Boutons
			if (interaction.isButton()) {
				const id = interaction.customId || '';
				if (id.startsWith('zone:approve:') || id.startsWith('zone:reject:')) {
					return services.policy.handleApprovalButton(interaction);
				}
				if (id.startsWith('temp:extend:') || id.startsWith('temp:delete:')) {
					return services.tempGroup.handleArchiveButtons(interaction);
				}
				if (id.startsWith('event:join:')) {
					return services.event.handleJoinButton(interaction);
				}
			}

			// Modales
			if (interaction.type === InteractionType.ModalSubmit) {
				const id = interaction.customId || '';
				if (id.startsWith('zone:request:')) {
					return services.zone.handleZoneRequestModal(interaction);
				}
			}
		} catch (err) {
			console.error('[interactionCreate] error:', err);
			if (interaction && !interaction.replied) {
				try { await interaction.reply({ content: 'Erreur lors du traitement.', ephemeral: true }); } catch {}
			}
		}
	}
};
