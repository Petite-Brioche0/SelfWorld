
const { ChannelType, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');

class TempGroupService {
	constructor(client, db) {
		this.client = client;
		this.db = db;
	}

	async createTempGroup(guild, name, userIds) {
		const category = await guild.channels.create({ name, type: ChannelType.GuildCategory });
		const text = await guild.channels.create({ name: 'discussion', type: ChannelType.GuildText, parent: category.id });
		const voice = await guild.channels.create({ name: 'vocal', type: ChannelType.GuildVoice, parent: category.id });

		const [res] = await this.db.query('INSERT INTO temp_groups (name, category_id, archived, created_at, expires_at) VALUES (?, ?, 0, NOW(), DATE_ADD(NOW(), INTERVAL 72 HOUR))',
			[name, category.id]);
		const id = res.insertId;

		for (const uid of userIds) {
			await this.db.query('INSERT INTO temp_group_members (temp_group_id, user_id) VALUES (?, ?)', [id, uid]);
		}

		const row = new ActionRowBuilder().addComponents(
			new ButtonBuilder().setCustomId(`temp:delete:${id}`).setStyle(ButtonStyle.Danger).setLabel('Supprimer'),
			new ButtonBuilder().setCustomId(`temp:extend:${id}`).setStyle(ButtonStyle.Secondary).setLabel('Prolonger')
		);

		const e = new EmbedBuilder().setTitle('Groupe temporaire').setDescription('Aucune activité → archivage auto après 72h.').setTimestamp();
		await text.send({ embeds: [e], components: [row] }).catch(()=>{});

		return { id, categoryId: category.id, textId: text.id, voiceId: voice.id };
	}

	async handleArchiveButtons(interaction) {
		const parts = interaction.customId.split(':');
		const action = parts[1];
		const groupId = Number(parts[2]);
		const [rows] = await this.db.query('SELECT * FROM temp_groups WHERE id=?', [groupId]);
		const g = rows?.[0];
                if (!g) return interaction.reply({ content: 'Groupe introuvable.', flags: MessageFlags.Ephemeral });

                const text = await this.client.channels.fetch(g.category_id).catch(()=>null);
                if (!text) return interaction.reply({ content: 'Catégorie introuvable.', flags: MessageFlags.Ephemeral });

                if (action === 'delete') {
                        await this._deleteGroup(g);
                        return interaction.reply({ content: 'Groupe supprimé.', flags: MessageFlags.Ephemeral });
                }
                if (action === 'extend') {
                        await this.db.query('UPDATE temp_groups SET expires_at = DATE_ADD(NOW(), INTERVAL 72 HOUR) WHERE id=?', [groupId]);
                        return interaction.reply({ content: 'Groupe prolongé de 72h.', flags: MessageFlags.Ephemeral });
                }
	}

	async _deleteGroup(g) {
		const cat = await this.client.channels.fetch(g.category_id).catch(()=>null);
		if (cat) await cat.delete().catch(()=>{});
		await this.db.query('DELETE FROM temp_group_members WHERE temp_group_id=?', [g.id]);
		await this.db.query('DELETE FROM temp_groups WHERE id=?', [g.id]);
	}

	/** Periodic check (call hourly on ready) */
	async sweepExpired() {
		const [rows] = await this.db.query('SELECT * FROM temp_groups WHERE archived=0 AND expires_at <= NOW()');
		for (const g of rows) {
			// Archive by locking category (convert to read-only) instead of deleting
			const cat = await this.client.channels.fetch(g.category_id).catch(()=>null);
			if (cat) {
				for (const ch of cat.children.cache.values()) {
					if (ch.type === 0) { // text
						await ch.permissionOverwrites.edit(ch.guild.roles.everyone, { SendMessages: false }).catch(()=>{});
					}
				}
			}
			await this.db.query('UPDATE temp_groups SET archived=1 WHERE id=?', [g.id]);
		}
	}
}

module.exports = { TempGroupService };
