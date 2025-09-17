
const { InteractionType, PermissionFlagsBits } = require('discord.js');

module.exports = {
	name: 'interactionCreate',
	once: false,
	async execute(interaction, deps) {
		try {
			const { ownerId, commands, context, services } = deps;

			// Slash commands
			if (interaction.isChatInputCommand()) {
				const cmd = commands.get(interaction.commandName);
				if (!cmd) return;

				// Owner-only guard (admin absolu)
				if (cmd.ownerOnly && interaction.user.id !== ownerId) {
					return interaction.reply({ content: 'Commande réservée à l’Owner.', ephemeral: true });
				}

				// Execute
				return await cmd.execute(interaction, deps);
			}

			// Context menu commands
			if (interaction.isContextMenuCommand && interaction.isContextMenuCommand()) {
				const cmd = context.get(interaction.commandName);
				if (!cmd) return;
				if (cmd.ownerOnly && interaction.user.id !== ownerId) {
					return interaction.reply({ content: 'Commande réservée à l’Owner.', ephemeral: true });
				}
				return await cmd.execute(interaction, deps);
			}

			// Buttons & modals for policies / temp groups / approvals
			if (interaction.isButton()) {
				// We route by customId prefixes
				const id = interaction.customId || '';
				if (id.startsWith('zone:approve:') || id.startsWith('zone:reject:')) {
					return services.PolicyService.handleApprovalButton(interaction);
				}
				if (id.startsWith('temp:extend:') || id.startsWith('temp:delete:')) {
					return services.TempGroupService.handleArchiveButtons(interaction);
				}
			}

			if (interaction.type === InteractionType.ModalSubmit) {
				const id = interaction.customId || '';
				if (id.startsWith('zone:request:')) {
					return services.ZoneService.handleZoneRequestModal(interaction);
				}
			}
		} catch (err) {
			console.error('[interactionCreate] error:', err);
			if (interaction && !interaction.replied) {
				try {
					await interaction.reply({ content: 'Erreur lors du traitement.', ephemeral: true });
				} catch {}
			}
		}
	}
};
