const { InteractionType } = require('discord.js');
const { makeKey } = require('../utils/commandLoader');

module.exports = {
	name: 'interactionCreate',
	async execute(interaction, client) {
		const { logger, rateLimiter, services, config } = client.context;

		try {
			if (interaction.isChatInputCommand()) {
				await rateLimiter.consume(interaction.user.id).catch(() => {
					throw new Error('Veuillez patienter avant de réutiliser cette commande.');
				});
				const entry = client.commands.get(interaction.commandName);
				if (!entry) {
					return interaction.reply({ content: 'Commande introuvable.', ephemeral: true });
				}
				const group = interaction.options.getSubcommandGroup(false);
				const sub = interaction.options.getSubcommand();
				const fragment = entry.fragments.get(makeKey(group, sub));
				if (!fragment) {
					return interaction.reply({ content: 'Sous-commande inconnue.', ephemeral: true });
				}
				if (fragment.globalOwnerOnly && interaction.user.id !== config.ownerUserId) {
					return interaction.reply({ content: 'Cette commande est réservée au propriétaire.', ephemeral: true });
				}
				await fragment.execute(interaction, client.context);
			} else if (interaction.isContextMenuCommand()) {
				const command = client.contextMenus.get(interaction.commandName);
				if (!command) {
					return interaction.reply({ content: 'Contexte introuvable.', ephemeral: true });
				}
				await command.execute(interaction, client.context);
			} else if (interaction.isButton()) {
				if (interaction.customId.startsWith('policy:')) {
					await services.policy.handlePolicyButton(interaction);
				} else if (interaction.customId.startsWith('event:')) {
					await services.event.handleComponent(interaction);
				} else if (interaction.customId.startsWith('temp:')) {
					await services.tempGroup.handleComponent(interaction);
				} else {
					await interaction.reply({ content: 'Action inconnue.', ephemeral: true });
				}
			} else if (interaction.type === InteractionType.ModalSubmit) {
				if (interaction.customId.startsWith('zoneRequest:')) {
					await services.zone.handleRequestModal(interaction);
				} else if (interaction.customId.startsWith('temp:')) {
					await services.tempGroup.handleModal(interaction);
				} else {
					await interaction.reply({ content: 'Réponse de formulaire inattendue.', ephemeral: true });
				}
			}
		} catch (error) {
			logger.error({ err: error, userId: interaction.user?.id, guildId: interaction.guild?.id }, 'Interaction failure');
			if (interaction.deferred || interaction.replied) {
				await interaction.followUp({ content: 'Une erreur est survenue. L\'équipe a été informée.', ephemeral: true }).catch(() => undefined);
			} else {
				await interaction.reply({ content: 'Une erreur est survenue. L\'équipe a été informée.', ephemeral: true }).catch(() => undefined);
			}
		}
	}
};
