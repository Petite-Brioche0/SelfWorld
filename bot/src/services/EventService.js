
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ChannelType, MessageFlags } = require('discord.js');

class EventService {
	constructor(client, db) {
		this.client = client;
		this.db = db;
	}

	async announceToAllZones(eventId, title, description) {
		const [zones] = await this.db.query('SELECT id, text_reception_id FROM zones');
		for (const z of zones) {
			const ch = await this.client.channels.fetch(z.text_reception_id).catch(()=>null);
			if (!ch) continue;
			const row = new ActionRowBuilder().addComponents(
				new ButtonBuilder().setCustomId(`event:join:${eventId}:${z.id}`).setStyle(ButtonStyle.Primary).setLabel('Rejoindre')
			);
			const e = new EmbedBuilder().setTitle(title).setDescription(description).setFooter({ text: `Zone ${z.id}` });
			await ch.send({ embeds: [e], components: [row] }).catch(()=>{});
		}
	}

	async handleJoinButton(interaction) {
		const parts = interaction.customId.split(':');
		if (parts[0] !== 'event' || parts[1] !== 'join') return;
		const eventId = Number(parts[2]);
		const zoneId = Number(parts[3]);

		const [rows] = await this.db.query('SELECT zone_id FROM event_participants WHERE event_id=? AND user_id=?', [eventId, interaction.user.id]);
                if (rows.length && rows[0].zone_id !== zoneId) {
                        return interaction.reply({ content: 'Tu es déjà inscrit via une autre zone. Re-clique pour changer de team.', flags: MessageFlags.Ephemeral });
                }

                await this.db.query('REPLACE INTO event_participants (event_id, user_id, zone_id, joined_at) VALUES (?, ?, ?, NOW())', [eventId, interaction.user.id, zoneId]);
                return interaction.reply({ content: 'Inscription enregistrée pour cet événement.', flags: MessageFlags.Ephemeral });
        }

	async startEvent(guild, eventId, name='event') {
		const category = await guild.channels.create({ name, type: ChannelType.GuildCategory });
		const text = await guild.channels.create({ name: 'briefing', type: ChannelType.GuildText, parent: category.id });
		await guild.channels.create({ name: 'scores', type: ChannelType.GuildText, parent: category.id });
		await guild.channels.create({ name: 'vocal-a', type: ChannelType.GuildVoice, parent: category.id });
		await guild.channels.create({ name: 'vocal-b', type: ChannelType.GuildVoice, parent: category.id });

		await this.db.query('UPDATE events SET status="running" WHERE id=?', [eventId]);
		await text.send('Événement démarré.').catch(()=>{});
		return { categoryId: category.id };
	}
}

module.exports = { EventService };
