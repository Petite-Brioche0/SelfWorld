const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

module.exports = {
	name: 'messageCreate',
	async execute(message, client) {
		if (!message.guild || message.author.bot) {
			return;
		}

		const services = client.context.services || {};
		const logger = client.context.logger;

		const anon = services.anon;
		let handledAnon = false;
		if (anon?.handleMessage) {
			try {
				handledAnon = await anon.handleMessage(message);
			} catch (error) {
				logger?.error({ err: error, messageId: message.id }, 'Anon relay failure');
			}
		}

		if (handledAnon && anon?.bumpAnonChannelCounter) {
			try {
				const res = await anon.bumpAnonChannelCounter({
					guildId: message.guild.id,
					channelId: message.channel.id
				});
				if (res?.notify) {
					const row = new ActionRowBuilder().addComponents(
						new ButtonBuilder()
							.setCustomId('anon:create:closed')
							.setLabel('Créer (fermé)')
							.setStyle(ButtonStyle.Primary),
						new ButtonBuilder()
							.setCustomId('anon:create:open')
							.setLabel('Créer (ouvert)')
							.setStyle(ButtonStyle.Secondary)
					);
					const content = `💬 Activité anonyme : palier atteint (**${res.count}** messages).\nVous pouvez créer un **groupe temporaire** pour regrouper les intéressés.`;
					await message.channel.send({
						content,
						components: [row]
					}).catch((error) => {
						logger?.warn({ err: error, channelId: message.channel.id }, 'Annonce de palier anonyme impossible');
					});
				}
			} catch (error) {
				logger?.warn({ err: error, channelId: message.channel.id }, 'Compteur de messages anonymes indisponible');
			}
		}

		const tempGroup = services.tempGroup;
		if (tempGroup?.setLastActivityByChannel) {
			try {
				await tempGroup.setLastActivityByChannel(message.channelId);
			} catch (error) {
				logger?.warn({ err: error, channelId: message.channelId }, 'Mise à jour de dernière activité du groupe échouée');
			}
		}

		const zoneService = services.zone;
		const activityService = services.activity;
		if (!zoneService?.resolveZoneContextForChannel || !activityService?.addMessage) {
			return;
		}

		try {
			const context = await zoneService.resolveZoneContextForChannel(message.channel);
			if (!context?.zone?.id) return;
			if (context.kind === 'panel') return; // ignore management panel traffic
			await activityService.addMessage(context.zone.id).catch((err) => {
				logger?.warn({ err, zoneId: context.zone.id }, 'Failed to record zone message activity');
			});
		} catch (err) {
			logger?.warn({ err, messageId: message.id }, 'Zone activity tracking failed');
		}
	}
};
