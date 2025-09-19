const {
	EmbedBuilder,
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	StringSelectMenuBuilder,
	UserSelectMenuBuilder,
	RoleSelectMenuBuilder,
	ChannelSelectMenuBuilder,
	PermissionFlagsBits
} = require('discord.js');

class PanelService {
	#schemaReady = false;
	constructor(client, db, logger = null) {
		this.client = client;
		this.db = db;
		this.logger = logger;
	}

	async renderInitialPanel({ zone }) {
		if (!zone?.id) return;
		try {
			await this.refresh(zone.id, ['members', 'roles', 'channels', 'policy']);
		} catch (err) {
			this.logger?.warn({ err, zoneId: zone?.id }, 'Failed to render initial panel');
		}
	}

	async ensurePanel(zoneRow) {
		await this.#ensureSchema();
		const channel = await this.#fetchChannel(zoneRow.text_panel_id);
		if (!channel) throw new Error('panel channel missing');

		// ensure record
		let [rows] = await this.db.query('SELECT * FROM panel_messages WHERE zone_id=?', [zoneRow.id]);
		if (!rows.length) {
			await this.db.query('INSERT INTO panel_messages(zone_id) VALUES (?)', [zoneRow.id]);
			[rows] = await this.db.query('SELECT * FROM panel_messages WHERE zone_id=?', [zoneRow.id]);
		}
		let record = rows[0];

		const map = {
			members: { column: 'members_msg_id', render: () => this.renderMembers(zoneRow) },
			roles:   { column: 'roles_msg_id', render: () => this.renderRoles(zoneRow) },
			channels:{ column: 'channels_msg_id', render: () => this.renderChannels(zoneRow) },
			policy:  { column: 'policy_msg_id', render: () => this.renderPolicy(zoneRow) }
		};

		const messages = {};

		for (const [key, meta] of Object.entries(map)) {
			const { embed, components } = await meta.render();
			let msgId = record[meta.column];
			let message = null;

			if (msgId) {
				try {
					message = await channel.messages.fetch(msgId);
					await message.edit({ embeds: [embed], components });
				} catch {
					message = await channel.send({ embeds: [embed], components });
				}
			} else {
				message = await channel.send({ embeds: [embed], components });
				msgId = message.id;
				await this.db.query(`UPDATE panel_messages SET ${meta.column} = ? WHERE zone_id = ?`, [msgId, zoneRow.id]);
				record = { ...record, [meta.column]: msgId };
			}
			messages[key] = { message, id: msgId };
		}

		return { channel, record, messages };
	}

	async refresh(zoneId, sections = []) {
		await this.#ensureSchema();
		const zoneRow = await this.#getZone(zoneId);
		if (!zoneRow) throw new Error('zone not found');
		const channel = await this.#fetchChannel(zoneRow.text_panel_id);
		if (!channel) throw new Error('panel channel missing');

		let [recordRows] = await this.db.query('SELECT * FROM panel_messages WHERE zone_id=?', [zoneRow.id]);
		if (!recordRows.length) {
			await this.db.query('INSERT INTO panel_messages(zone_id) VALUES (?)', [zoneRow.id]);
			[recordRows] = await this.db.query('SELECT * FROM panel_messages WHERE zone_id=?', [zoneRow.id]);
		}
		const record = recordRows[0];

		if (!sections.length) sections = ['members','roles','channels','policy'];

		const map = {
			members: { column: 'members_msg_id', render: () => this.renderMembers(zoneRow) },
			roles:   { column: 'roles_msg_id', render: () => this.renderRoles(zoneRow) },
			channels:{ column: 'channels_msg_id', render: () => this.renderChannels(zoneRow) },
			policy:  { column: 'policy_msg_id', render: () => this.renderPolicy(zoneRow) }
		};

		for (const key of sections) {
			const meta = map[key];
			if (!meta) continue;
			const { embed, components } = await meta.render();
			let msgId = record[meta.column];
			if (!msgId) {
				const m = await channel.send({ embeds: [embed], components });
				msgId = m.id;
				await this.db.query(`UPDATE panel_messages SET ${meta.column}=? WHERE zone_id=?`, [msgId, zoneRow.id]);
				continue;
			}
			try {
				const msg = await channel.messages.fetch(msgId);
				await msg.edit({ embeds: [embed], components });
			} catch {
				const m = await channel.send({ embeds: [embed], components });
				await this.db.query(`UPDATE panel_messages SET ${meta.column}=? WHERE zone_id=?`, [m.id, zoneRow.id]);
			}
		}
	}

	// ===== Renderers

	async renderMembers(zoneRow) {
		const guild = await this.client.guilds.fetch(zoneRow.guild_id);
		const roleMemberId = zoneRow.role_member_id;

		let members = [];
		try {
			const role = await guild.roles.fetch(roleMemberId);
			if (role) members = [...role.members.values()];
		} catch {}

		const total = members.length;
		const lines = total
			? members.slice(0, 30).map(m => `• <@${m.id}>`).join('\n') + (total > 30 ? `\n… et ${total-30} autre(s)` : '')
			: 'Aucun membre.';

		const embed = new EmbedBuilder()
			.setColor(0x5865f2)
			.setTitle('👥 Membres de la zone')
			.setDescription(lines)
			.setFooter({ text: `Total: ${total}` });

		const viewRow = new ActionRowBuilder().addComponents(
			new UserSelectMenuBuilder()
				.setCustomId(`panel:member:view:${zoneRow.id}`)
				.setPlaceholder('Voir le profil d’un membre')
				.setMinValues(1)
				.setMaxValues(1)
		);

		const actionsRow = new ActionRowBuilder().addComponents(
			new ButtonBuilder()
				.setCustomId(`panel:member:kick:${zoneRow.id}`)
				.setLabel('Exclure')
				.setStyle(ButtonStyle.Danger),
			new ButtonBuilder()
				.setCustomId(`panel:member:assign:${zoneRow.id}`)
				.setLabel('Attribuer un rôle')
				.setStyle(ButtonStyle.Primary)
		);

		return { embed, components: [viewRow, actionsRow] };
	}

	async renderRoles(zoneRow) {
		const guild = await this.client.guilds.fetch(zoneRow.guild_id);
		const ownerRole = await guild.roles.fetch(zoneRow.role_owner_id).catch(()=>null);
		const memberRole = await guild.roles.fetch(zoneRow.role_member_id).catch(()=>null);

		let [customs] = await this.db.query(
			'SELECT role_id, name, color FROM zone_roles WHERE zone_id = ? ORDER BY name ASC', [zoneRow.id]
		);

		const coreLines = [
			ownerRole ? `• Owner — <@&${ownerRole.id}>` : '• Owner — (introuvable)',
			memberRole ? `• Member — <@&${memberRole.id}>` : '• Member — (introuvable)'
		].join('\n');

		const customLines = (customs && customs.length)
			? customs.slice(0, 10).map(r => `• ${r.name} — <@&${r.role_id}>${r.color ? ' \`${r.color}\`' : ''}`).join('\n')
			: 'Aucun rôle personnalisé.';

		const embed = new EmbedBuilder()
			.setColor(0x2ecc71)
			.setTitle('🎭 Rôles de la zone')
			.setDescription(coreLines + '\n\n__Rôles personnalisés__\n' + customLines)
			.setFooter({ text: 'Max 10 rôles personnalisés' });

		const rowAdd = new ActionRowBuilder().addComponents(
			new ButtonBuilder()
				.setCustomId(`panel:role:add:${zoneRow.id}`)
				.setLabel('Ajouter un rôle')
				.setStyle(ButtonStyle.Success)
		);
		const rowEdit = new ActionRowBuilder().addComponents(
			new RoleSelectMenuBuilder()
				.setCustomId(`panel:role:edit:${zoneRow.id}`)
				.setPlaceholder('Modifier un rôle (sélectionne-en un)')
				.setMinValues(1)
				.setMaxValues(1)
		);
		const rowDelete = new ActionRowBuilder().addComponents(
			new RoleSelectMenuBuilder()
				.setCustomId(`panel:role:delete:${zoneRow.id}`)
				.setPlaceholder('Supprimer un rôle (custom uniquement)')
				.setMinValues(1)
				.setMaxValues(1)
		);
		const rowAssign = new ActionRowBuilder().addComponents(
			new RoleSelectMenuBuilder()
				.setCustomId(`panel:role:assign:role:${zoneRow.id}`)
				.setPlaceholder('Choisir un rôle à attribuer')
				.setMinValues(1)
				.setMaxValues(1)
		);

		return { embed, components: [rowAdd, rowEdit, rowDelete, rowAssign] };
	}

	async renderChannels(zoneRow) {
		const guild = await this.client.guilds.fetch(zoneRow.guild_id);
		const category = await this.#fetchChannel(zoneRow.category_id);
		let children = [];
		try {
			if (category) {
				children = guild.channels.cache.filter(c => c.parentId === category.id).map(c => c);
			}
		} catch {}

		const list = children.length
			? children.map(c => `• ${c.type === 2 ? '🔊' : '#'}${c.name} — \`${c.id}\``).join('\n')
			: 'Aucun salon dans cette catégorie (hors panel).';

		const embed = new EmbedBuilder()
			.setColor(0xf1c40f)
			.setTitle('🧭 Salons de la zone')
			.setDescription(list)
			.setFooter({ text: 'Ajoute, modifie ou supprime des salons (hors salons principaux)' });

		const rowAdd = new ActionRowBuilder().addComponents(
			new ButtonBuilder()
				.setCustomId(`panel:ch:add:${zoneRow.id}`)
				.setLabel('Ajouter un salon')
				.setStyle(ButtonStyle.Success)
		);
		const rowEdit = new ActionRowBuilder().addComponents(
			new ChannelSelectMenuBuilder()
				.setCustomId(`panel:ch:edit:${zoneRow.id}`)
				.setPlaceholder('Modifier un salon')
				.setMinValues(1)
				.setMaxValues(1)
		);
		const rowDelete = new ActionRowBuilder().addComponents(
			new ChannelSelectMenuBuilder()
				.setCustomId(`panel:ch:del:${zoneRow.id}`)
				.setPlaceholder('Supprimer un salon')
				.setMinValues(1)
				.setMaxValues(1)
		);

		return { embed, components: [rowAdd, rowEdit, rowDelete] };
	}

	async renderPolicy(zoneRow) {
		const embed = new EmbedBuilder()
			.setColor(0x3498db)
			.setTitle('🔐 Politique d’entrée')
			.setDescription(`Politique actuelle : **${zoneRow.policy || 'closed'}**\nTypes: \`closed\`, \`ask\`, \`invite\`, \`open\``);

		const row = new ActionRowBuilder().addComponents(
			new StringSelectMenuBuilder()
				.setCustomId(`panel:policy:set:${zoneRow.id}`)
				.setPlaceholder('Changer la politique…')
				.addOptions([
					{ label: 'closed', value: 'closed' },
					{ label: 'ask', value: 'ask' },
					{ label: 'invite', value: 'invite' },
					{ label: 'open', value: 'open' }
				])
		);

		return { embed, components: [row] };
	}

	// ===== helpers

	async #getZone(zoneId) {
		const [rows] = await this.db.query('SELECT * FROM zones WHERE id=?', [zoneId]);
		return rows?.[0] || null;
	}

	async #fetchChannel(id) {
		if (!id) return null;
		try { return await this.client.channels.fetch(id); } catch { return null; }
	}

	async #ensureSchema() {
		if (this.#schemaReady) return;
		await this.db.query(`CREATE TABLE IF NOT EXISTS panel_messages (
			zone_id INT NOT NULL PRIMARY KEY,
			members_msg_id VARCHAR(32) NULL,
			roles_msg_id VARCHAR(32) NULL,
			channels_msg_id VARCHAR(32) NULL,
			policy_msg_id VARCHAR(32) NULL,
			updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`);
		await this.db.query(`CREATE TABLE IF NOT EXISTS zone_roles (
			id INT AUTO_INCREMENT PRIMARY KEY,
			zone_id INT NOT NULL,
			role_id VARCHAR(20) NOT NULL,
			name VARCHAR(64) NOT NULL,
			color VARCHAR(7) NULL,
			UNIQUE KEY uq_zone_role (zone_id, role_id),
			INDEX ix_zone (zone_id)
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`);
		this.#schemaReady = true;
	}
}

module.exports = { PanelService };
