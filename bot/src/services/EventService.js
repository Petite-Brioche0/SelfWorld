const { EmbedBuilder } = require('discord.js');

class EventService {
	constructor(client, pool, zoneService, activityService, logger) {
		this.client = client;
		this.pool = pool;
		this.zoneService = zoneService;
		this.activityService = activityService;
		this.logger = logger;
	}

	async handleComponent(interaction) {
		const parts = interaction.customId.split(':');
		const action = parts[1];
		if (action !== 'join') {
			await interaction.reply({ content: 'Action évènement inconnue.', ephemeral: true });
			return;
		}
		const eventId = Number(parts[2]);
		const zoneId = Number(parts[3]);
		await this.joinEvent(eventId, zoneId, interaction.user.id);
		await interaction.reply({ content: 'Participation enregistrée !', ephemeral: true });
	}

	async joinEvent(eventIdOrName, zoneId, userId) {
		let eventId = eventIdOrName;
		let event = null;
		if (Number.isNaN(Number(eventIdOrName))) {
			const [rows] = await this.pool.query('SELECT * FROM events WHERE name = ? ORDER BY id DESC LIMIT 1', [eventIdOrName]);
			if (!rows[0]) {
				const [insert] = await this.pool.query('INSERT INTO events (name, status) VALUES (?, ?)', [eventIdOrName, 'draft']);
				eventId = insert.insertId;
				event = { id: eventId, name: eventIdOrName };
			} else {
				event = rows[0];
				eventId = event.id;
			}
		} else {
			eventId = Number(eventIdOrName);
			const [rows] = await this.pool.query('SELECT * FROM events WHERE id = ?', [eventId]);
			event = rows[0];
		}
		if (!event) {
			throw new Error('Évènement introuvable');
		}
		const [existing] = await this.pool.query('SELECT * FROM event_participants WHERE event_id = ? AND user_id = ?', [eventId, userId]);
		if (existing[0]) {
			await this.pool.query('UPDATE event_participants SET zone_id = ?, joined_at = NOW() WHERE event_id = ? AND user_id = ?', [zoneId, eventId, userId]);
		} else {
			await this.pool.query('INSERT INTO event_participants (event_id, user_id, zone_id) VALUES (?, ?, ?)', [eventId, userId, zoneId]);
		}
		this.activityService.recordEventPoint(zoneId);
	}

	async announceInZone(zoneId, event) {
		const zone = await this.zoneService.getZoneById(zoneId);
		if (!zone) {
			return;
		}
		const guild = await this.client.guilds.fetch(zone.guild_id);
		const reception = guild.channels.cache.get(zone.text_reception_id);
		if (!reception) {
			return;
		}
		const embed = new EmbedBuilder()
		.setTitle(`Nouvel évènement : ${event.name}`)
		.setDescription("Rejoignez l'évènement avec `/public event join`.")
		.setTimestamp();
		await reception.send({ embeds: [embed] });
	}
}

module.exports = EventService;