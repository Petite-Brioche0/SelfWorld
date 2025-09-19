const { EmbedBuilder } = require('discord.js');

class PanelService {
	constructor(client, db, logger = null) {
		this.client = client;
		this.db = db;
		this.logger = logger;
		this.#schemaReady = false;
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

		if (!zoneRow?.id || !zoneRow?.text_panel_id) {
			throw new Error('Zone data incomplete for panel ensure');
		}

		const channel = await this.#fetchPanelChannel(zoneRow.text_panel_id);
		if (!channel) {
			throw new Error('Panel channel introuvable');
		}

		let [rows] = await this.db.query('SELECT * FROM panel_messages WHERE zone_id = ?', [zoneRow.id]);
		let record = rows?.[0];
		if (!record) {
			await this.db.query('INSERT INTO panel_messages (zone_id) VALUES (?)', [zoneRow.id]);
			[rows] = await this.db.query('SELECT * FROM panel_messages WHERE zone_id = ?', [zoneRow.id]);
			record = rows?.[0] || { zone_id: zoneRow.id };
		}

		const guild = await this.#fetchGuild(zoneRow.guild_id);

		const sections = {
			members: {
				column: 'members_msg_id',
				render: () => this.renderMembers(zoneRow, guild)
			},
			roles: {
				column: 'roles_msg_id',
				render: () => this.renderRoles(zoneRow, guild)
			},
			channels: {
				column: 'channels_msg_id',
				render: () => this.renderChannels(zoneRow, guild)
			},
			policy: {
				column: 'policy_msg_id',
				render: () => this.renderPolicy(zoneRow, guild)
			}
		};

		const messages = {};

		for (const [key, meta] of Object.entries(sections)) {
			let msgId = record?.[meta.column];
			let message = null;
			if (msgId) {
				message = await channel.messages.fetch(msgId).catch(() => null);
			}
			if (!message) {
				const rendered = await meta.render();
				const payload = this.#buildMessagePayload(rendered);
				message = await channel.send(payload);
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

		const [zoneRows] = await this.db.query('SELECT * FROM zones WHERE id = ?', [zoneId]);
		const zoneRow = zoneRows?.[0];
		if (!zoneRow) {
			this.logger?.warn({ zoneId }, 'panel.refresh missing zone');
			return;
		}

		const requested = Array.isArray(sections) && sections.length
			? new Set(sections)
			: new Set(['members', 'roles', 'channels', 'policy']);

		const guild = await this.#fetchGuild(zoneRow.guild_id);
		const ensureResult = await this.ensurePanel(zoneRow);
		const channel = ensureResult.channel;

		const sectionMeta = {
			members: {
				column: 'members_msg_id',
				render: () => this.renderMembers(zoneRow, guild)
			},
			roles: {
				column: 'roles_msg_id',
				render: () => this.renderRoles(zoneRow, guild)
			},
			channels: {
				column: 'channels_msg_id',
				render: () => this.renderChannels(zoneRow, guild)
			},
			policy: {
				column: 'policy_msg_id',
				render: () => this.renderPolicy(zoneRow, guild)
			}
		};

		for (const section of requested) {
			const meta = sectionMeta[section];
			if (!meta) continue;

			const rendered = await meta.render();
			const payload = this.#buildMessagePayload(rendered);
			const current = ensureResult.messages?.[section];
			let message = current?.message;
			let msgId = current?.id;

			if (!message && msgId) {
				message = await channel.messages.fetch(msgId).catch(() => null);
			}

			if (!message) {
				message = await channel.send(payload);
				msgId = message.id;
				await this.db.query(`UPDATE panel_messages SET ${meta.column} = ? WHERE zone_id = ?`, [msgId, zoneId]);
			} else {
				await message.edit(payload).catch(async () => {
					try {
						message = await channel.send(payload);
						msgId = message.id;
						await this.db.query(`UPDATE panel_messages SET ${meta.column} = ? WHERE zone_id = ?`, [msgId, zoneId]);
					} catch (err) {
						this.logger?.error({ err, zoneId, section }, 'panel.refresh edit failed');
					}
				});
			}
		}

		await this.db.query('UPDATE panel_messages SET updated_at = CURRENT_TIMESTAMP WHERE zone_id = ?', [zoneId]);
	}

	async renderMembers(zoneRow) {
		const [rows] = await this.db.query('SELECT user_id, role FROM zone_members WHERE zone_id = ? ORDER BY role DESC, user_id', [zoneRow.id]);
		const owners = new Set();
		const members = [];

		if (zoneRow.owner_user_id) owners.add(String(zoneRow.owner_user_id));

		for (const row of rows || []) {
			if (row.role === 'owner') {
				owners.add(String(row.user_id));
			} else {
				members.push(String(row.user_id));
			}
		}

		const embed = new EmbedBuilder()
			.setTitle('Membres de la zone')
			.setDescription('Utilise `/zone member` pour inviter ou retirer des membres de ta zone.')
			.addFields(
				{ name: 'Owner·s', value: this.#formatMentionList([...owners], 'Aucun owner défini.'), inline: false },
				{
					name: `Membres (${members.length})`,
					value: members.length ? this.#formatMentionList(members) : 'Aucun membre enregistré.',
					inline: false
				}
			)
			.setFooter({ text: 'Les membres ajoutés reçoivent automatiquement le rôle membre.' })
			.setTimestamp();

		return { embed, components: [] };
	}

	async renderRoles(zoneRow) {
		const [rows] = await this.db.query('SELECT role_id, name FROM zone_roles WHERE zone_id = ? ORDER BY name ASC', [zoneRow.id]);
		const embed = new EmbedBuilder()
			.setTitle('Rôles de la zone')
			.setDescription('Vue d’ensemble des rôles attribués dans ta zone.')
			.addFields(
				{ name: 'Owner', value: zoneRow.role_owner_id ? `<@&${zoneRow.role_owner_id}>` : '—', inline: true },
				{ name: 'Membres', value: zoneRow.role_member_id ? `<@&${zoneRow.role_member_id}>` : '—', inline: true }
			)
			.setTimestamp();

		if (rows?.length) {
			const lines = this.#formatRoleLines(rows);
			embed.addFields({ name: `Rôles personnalisés (${rows.length})`, value: lines, inline: false });
		} else {
			embed.addFields({ name: 'Rôles personnalisés', value: 'Aucun rôle personnalisé enregistré.', inline: false });
		}

		embed.setFooter({ text: 'Crée, renomme ou supprime des rôles avec `/zone role`.' });

		return { embed, components: [] };
	}

	async renderChannels(zoneRow) {
		const embed = new EmbedBuilder()
			.setTitle('Salons de la zone')
			.setDescription('Résumé des salons gérés automatiquement par ta zone.')
			.addFields(
				{ name: 'Panel', value: zoneRow.text_panel_id ? `<#${zoneRow.text_panel_id}>` : '—', inline: true },
				{ name: 'Réception', value: zoneRow.text_reception_id ? `<#${zoneRow.text_reception_id}>` : '—', inline: true },
				{ name: 'Général', value: zoneRow.text_general_id ? `<#${zoneRow.text_general_id}>` : '—', inline: true },
				{ name: 'Chuchotement', value: zoneRow.text_anon_id ? `<#${zoneRow.text_anon_id}>` : '—', inline: true },
				{ name: 'Vocal', value: zoneRow.voice_id ? `<#${zoneRow.voice_id}>` : '—', inline: true },
				{ name: 'Catégorie', value: zoneRow.category_id ? `<#${zoneRow.category_id}>` : '—', inline: true }
			)
			.setFooter({ text: 'Ajoute ou renomme des salons avec `/zone channel`.' })
			.setTimestamp();

		return { embed, components: [] };
	}

	async renderPolicy(zoneRow) {
		const policyLabels = {
			closed: 'Fermée',
			ask: 'Sur demande',
			invite: 'Sur invitation',
			open: 'Ouverte'
		};

		const policyDescriptions = {
			closed: 'Seul l’owner peut inviter de nouveaux membres.',
			ask: 'Les visiteurs peuvent demander l’accès via le bot.',
			invite: 'Les membres peuvent inviter d’autres utilisateurs avec un code.',
			open: 'Tout le monde peut rejoindre librement la zone.'
		};

		const policyKey = zoneRow.policy || 'closed';
		const embed = new EmbedBuilder()
			.setTitle('Politique d’entrée')
			.setDescription(`Politique actuelle : **${policyLabels[policyKey] || policyKey}**`)
			.addFields({
				name: 'Description',
				value: policyDescriptions[policyKey] || 'Politique personnalisée.'
			})
			.setFooter({ text: 'Modifie la politique avec `/zone policy set`.' })
			.setTimestamp();

		return { embed, components: [] };
	}

	async #ensureSchema() {
		if (this.#schemaReady) return;
		await this.db.query(
			`CREATE TABLE IF NOT EXISTS panel_messages (
				zone_id INT NOT NULL PRIMARY KEY,
				members_msg_id VARCHAR(32) NULL,
				roles_msg_id VARCHAR(32) NULL,
				channels_msg_id VARCHAR(32) NULL,
				policy_msg_id VARCHAR(32) NULL,
				updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
			) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`
		);
		this.#schemaReady = true;
	}

	async #fetchPanelChannel(panelChannelId) {
		if (!panelChannelId) return null;
		return await this.client.channels.fetch(panelChannelId).catch(() => null);
	}

	async #fetchGuild(guildId) {
		if (!guildId) return null;
		return this.client.guilds.cache.get(guildId) || await this.client.guilds.fetch(guildId).catch(() => null);
	}

	#buildMessagePayload(rendered) {
		const payload = {};
		if (rendered?.embed) {
			payload.embeds = [rendered.embed];
		} else {
			payload.embeds = [];
		}
		if (Array.isArray(rendered?.components) && rendered.components.length) {
			payload.components = rendered.components;
		} else {
			payload.components = [];
		}
		return payload;
	}

	#formatMentionList(list, empty = 'Aucun élément.') {
			if (!Array.isArray(list) || !list.length) return empty;
			const limited = list.slice(0, 20);
			let value = limited.map((id) => `<@${id}>`).join(', ');
			if (list.length > limited.length) {
				const remaining = list.length - limited.length;
				value += ` et ${remaining} autre${remaining > 1 ? 's' : ''}…`;
			}
			return value;
	}

	#formatRoleLines(rows) {
		if (!Array.isArray(rows) || !rows.length) return 'Aucun rôle personnalisé enregistré.';
		const limited = rows.slice(0, 10);
		let lines = limited.map((row) => `• ${row.name} — <@&${row.role_id}>`).join('\n');
		if (rows.length > limited.length) {
			const remaining = rows.length - limited.length;
			lines += `\n… et ${remaining} autre${remaining > 1 ? 's' : ''}.`;
		}
		return lines;
	}
}

module.exports = { PanelService };
