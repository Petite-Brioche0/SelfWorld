const {
EmbedBuilder,
ActionRowBuilder,
ButtonBuilder,
ButtonStyle,
StringSelectMenuBuilder
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

	async renderMembers(zoneRow, selectedMemberId = null) {
	        const { guild, members } = await this.#collectZoneMembers(zoneRow);
	        let selectedMember = null;
	        if (selectedMemberId) {
	                selectedMember = members.find((m) => m.id === selectedMemberId) || null;
	        }
	
	        const total = members.length;
	        const preview = total
	                ? members
	                        .slice(0, 30)
	                        .map((m) => `• <@${m.id}>`)
	                        .join('\n') + (total > 30 ? `\n… et ${total - 30} autre(s)` : '')
	                : 'Aucun membre.';
	
	        const embed = new EmbedBuilder()
	                .setColor(await this.#resolveZoneColor(zoneRow, guild))
	                .setTitle('👥 Membres de la zone')
	                .setDescription(`${preview}\n\nSélectionne un membre pour afficher les actions.`)
	                .setFooter({ text: `Total: ${total}` });
	
	        if (selectedMember) {
	                embed.addFields({ name: 'Membre sélectionné', value: `<@${selectedMember.id}>`, inline: false });
	        }
	
	        const select = new StringSelectMenuBuilder()
	                .setCustomId(`panel:member:view:${zoneRow.id}`)
	                .setPlaceholder('Choisis un membre à gérer')
	                .setMinValues(1)
	                .setMaxValues(1);
	
	        const options = members.slice(0, 25).map((member) => ({
	                label: member.displayName?.slice(0, 100) || member.user?.username?.slice(0, 100) || member.id,
	                value: member.id,
	                description: member.user?.tag?.slice(0, 100) || undefined,
	                default: selectedMember ? member.id === selectedMember.id : false
	        }));
	
	        if (options.length) {
	                select.addOptions(options);
	        } else {
	                select.setPlaceholder('Aucun membre disponible').setDisabled(true);
	        }
	
	        const rows = [new ActionRowBuilder().addComponents(select)];
	
	        if (selectedMember) {
	                rows.push(
	                        new ActionRowBuilder().addComponents(
	                                new ButtonBuilder()
	                                        .setCustomId(`panel:member:kick:${zoneRow.id}:${selectedMember.id}`)
	                                        .setLabel('Exclure')
	                                        .setStyle(ButtonStyle.Danger),
	                                new ButtonBuilder()
	                                        .setCustomId(`panel:member:assign:${zoneRow.id}:${selectedMember.id}`)
	                                        .setLabel('Attribuer un rôle')
	                                        .setStyle(ButtonStyle.Primary)
	                        )
	                );
	        }
	
	        return { embed, components: rows };
	}

async renderRoles(zoneRow) {
const { guild, coreRoles, customRoles } = await this.#collectZoneRoles(zoneRow);

const coreLines = [
coreRoles.owner ? `• Owner — <@&${coreRoles.owner.id}>` : '• Owner — (introuvable)',
coreRoles.member ? `• Member — <@&${coreRoles.member.id}>` : '• Member — (introuvable)'
].join('\n');

const customLines = customRoles.length
? customRoles.map((r) => `• ${r.role.name} — <@&${r.role.id}>${r.color ? ` \`${r.color}\`` : ''}`).join('\n')
: 'Aucun rôle personnalisé.';

const embed = new EmbedBuilder()
.setColor(await this.#resolveZoneColor(zoneRow, guild))
.setTitle('🎭 Rôles de la zone')
.setDescription(`${coreLines}\n\n__Rôles personnalisés__\n${customLines}`)
.setFooter({ text: 'Max 10 rôles personnalisés' });

const allZoneRoles = [];
if (coreRoles.owner) {
allZoneRoles.push({
id: coreRoles.owner.id,
label: coreRoles.owner.name,
description: 'Rôle Owner de la zone',
type: 'core'
});
}
if (coreRoles.member) {
allZoneRoles.push({
id: coreRoles.member.id,
label: coreRoles.member.name,
description: 'Rôle Member de la zone',
type: 'core'
});
}
for (const entry of customRoles) {
allZoneRoles.push({
id: entry.role.id,
label: entry.role.name,
description: entry.row?.name ? `Personnalisé — ${entry.row.name}` : 'Rôle personnalisé',
type: 'custom'
});
}

const editOptions = allZoneRoles.slice(0, 25).map((role) => ({
label: role.label.slice(0, 100),
value: role.id,
description: role.description.slice(0, 100)
}));

const deleteOptions = customRoles.slice(0, 25).map((entry) => ({
label: entry.role.name.slice(0, 100),
value: entry.role.id,
description: entry.row?.name ? entry.row.name.slice(0, 100) : 'Rôle personnalisé'
}));

const assignOptions = allZoneRoles.slice(0, 25).map((role) => ({
label: role.label.slice(0, 100),
value: role.id,
description: role.description.slice(0, 100)
}));

const rowAdd = new ActionRowBuilder().addComponents(
new ButtonBuilder()
.setCustomId(`panel:role:add:${zoneRow.id}`)
.setLabel('Ajouter un rôle')
.setStyle(ButtonStyle.Success)
);

const editSelect = new StringSelectMenuBuilder()
.setCustomId(`panel:role:edit:${zoneRow.id}`)
.setPlaceholder('Modifier un rôle de la zone')
.setMinValues(1)
.setMaxValues(1);
if (editOptions.length) {
editSelect.addOptions(editOptions);
} else {
editSelect.setPlaceholder('Aucun rôle à modifier').setDisabled(true);
}

const deleteSelect = new StringSelectMenuBuilder()
.setCustomId(`panel:role:delete:${zoneRow.id}`)
.setPlaceholder('Supprimer un rôle personnalisé')
.setMinValues(1)
.setMaxValues(1);
if (deleteOptions.length) {
deleteSelect.addOptions(deleteOptions);
} else {
deleteSelect.setPlaceholder('Aucun rôle personnalisé').setDisabled(true);
}

const assignSelect = new StringSelectMenuBuilder()
.setCustomId(`panel:role:assign:role:${zoneRow.id}`)
.setPlaceholder('Choisir un rôle à attribuer')
.setMinValues(1)
.setMaxValues(1);
if (assignOptions.length) {
assignSelect.addOptions(assignOptions);
} else {
assignSelect.setPlaceholder('Aucun rôle disponible').setDisabled(true);
}

return {
embed,
components: [
rowAdd,
new ActionRowBuilder().addComponents(editSelect),
new ActionRowBuilder().addComponents(deleteSelect),
new ActionRowBuilder().addComponents(assignSelect)
]
};
}

	async renderChannels(zoneRow) {
	const { guild, channels } = await this.#collectZoneChannels(zoneRow);
	const list = channels.length
	? channels
	.map((channel) => `• ${channel.type === 2 ? '🔊' : '#'}${channel.name} — \`${channel.id}\``)
	.join('\n')
	: 'Aucun salon dans cette catégorie (hors salons principaux).';
	
	const embed = new EmbedBuilder()
	.setColor(await this.#resolveZoneColor(zoneRow, guild))
	.setTitle('🧭 Salons de la zone')
	.setDescription(list)
	.setFooter({ text: 'Ajoute, modifie ou supprime des salons (hors salons principaux)' });
	
	const rowAdd = new ActionRowBuilder().addComponents(
	new ButtonBuilder()
	.setCustomId(`panel:ch:add:${zoneRow.id}`)
	.setLabel('Ajouter un salon')
	.setStyle(ButtonStyle.Success)
	);
	
	const options = channels.slice(0, 25).map((channel) => ({
	label: channel.name.slice(0, 100),
	value: channel.id,
	description: channel.type === 2 ? 'Salon vocal de la zone' : 'Salon textuel de la zone'
	}));
	
	const editSelect = new StringSelectMenuBuilder()
	.setCustomId(`panel:ch:edit:${zoneRow.id}`)
	.setPlaceholder('Modifier un salon de la zone')
	.setMinValues(1)
	.setMaxValues(1);
	if (options.length) {
	editSelect.addOptions(options);
	} else {
	editSelect.setPlaceholder('Aucun salon disponible').setDisabled(true);
	}
	
	const deleteSelect = new StringSelectMenuBuilder()
	.setCustomId(`panel:ch:del:${zoneRow.id}`)
	.setPlaceholder('Supprimer un salon de la zone')
	.setMinValues(1)
	.setMaxValues(1);
	if (options.length) {
	deleteSelect.addOptions(options);
	} else {
	deleteSelect.setPlaceholder('Aucun salon disponible').setDisabled(true);
	}
	
	return {
	embed,
	components: [
	rowAdd,
	new ActionRowBuilder().addComponents(editSelect),
	new ActionRowBuilder().addComponents(deleteSelect)
	]
	};
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

	async #collectZoneMembers(zoneRow) {
	const guild = await this.client.guilds.fetch(zoneRow.guild_id);
	const memberIds = new Map();
	
	const collect = async (roleId) => {
	if (!roleId) return;
	const role = await guild.roles.fetch(roleId).catch(() => null);
	if (!role) return;
	for (const member of role.members.values()) {
	memberIds.set(member.id, member);
	}
	};
	
	await collect(zoneRow.role_member_id);
	await collect(zoneRow.role_owner_id);
	
	const members = [...memberIds.values()].sort((a, b) => {
	const nameA = a.displayName?.toLowerCase?.() || a.user?.username?.toLowerCase?.() || '';
	const nameB = b.displayName?.toLowerCase?.() || b.user?.username?.toLowerCase?.() || '';
	return nameA.localeCompare(nameB, 'fr', { sensitivity: 'base' });
	});
	
	return { guild, members };
	}

	async #collectZoneRoles(zoneRow) {
	const guild = await this.client.guilds.fetch(zoneRow.guild_id);
	const ownerRole = await guild.roles.fetch(zoneRow.role_owner_id).catch(() => null);
	const memberRole = await guild.roles.fetch(zoneRow.role_member_id).catch(() => null);
	
	let [customRows] = await this.db.query(
	'SELECT role_id, name, color FROM zone_roles WHERE zone_id = ? ORDER BY name ASC',
	[zoneRow.id]
	);
	customRows = Array.isArray(customRows) ? customRows : [];
	
	const customRoles = [];
	for (const row of customRows) {
	const role = await guild.roles.fetch(row.role_id).catch(() => null);
	if (!role) continue;
	customRoles.push({ role, row });
	}
	
	return {
	guild,
	coreRoles: {
	owner: ownerRole,
	member: memberRole
	},
	customRoles
	};
	}

	async #collectZoneChannels(zoneRow) {
	const guild = await this.client.guilds.fetch(zoneRow.guild_id);
	const category = await this.#fetchChannel(zoneRow.category_id);
	if (!category) {
	return { guild, channels: [] };
	}
	
	const excludedIds = new Set([
	zoneRow.text_panel_id,
	zoneRow.text_reception_id,
	zoneRow.text_anon_id
	]);
	
	const fetched = await guild.channels.fetch();
	const channels = [...fetched.values()]
	.filter((channel) => channel.parentId === category.id)
	.filter((channel) => !excludedIds.has(channel.id))
	.sort((a, b) => a.rawPosition - b.rawPosition);
	
	return { guild, channels };
	}

	async #resolveZoneColor(zoneRow, guild = null) {
	try {
	const g = guild || (await this.client.guilds.fetch(zoneRow.guild_id));
	if (zoneRow.role_owner_id) {
	const ownerRole = await g.roles.fetch(zoneRow.role_owner_id).catch(() => null);
	if (ownerRole?.color) return ownerRole.color;
	}
	if (zoneRow.role_member_id) {
	const memberRole = await g.roles.fetch(zoneRow.role_member_id).catch(() => null);
	if (memberRole?.color) return memberRole.color;
	}
	} catch {}
	return 0x5865f2;
	}

	async handleSelectMenu(interaction) {
	const id = interaction.customId || '';
	if (!id.startsWith('panel:')) return false;
	
	const parts = id.split(':');
	const zoneId = Number(parts.at(-1));
	if (!zoneId) {
	await interaction.reply({ content: 'Zone invalide.', ephemeral: true }).catch(() => {});
	return true;
	}
	
	const zoneRow = await this.#getZone(zoneId);
	if (!zoneRow) {
	await interaction.reply({ content: 'Zone introuvable.', ephemeral: true }).catch(() => {});
	return true;
	}
	
	if (interaction.user.id !== String(zoneRow.owner_user_id)) {
	await interaction.reply({ content: 'Tu ne peux pas gérer cette zone.', ephemeral: true }).catch(() => {});
	return true;
	}
	
	if (parts[1] === 'member' && parts[2] === 'view') {
	const selectedId = interaction.values?.[0];
	const { embed, components } = await this.renderMembers(zoneRow, selectedId);
	await interaction.update({ embeds: [embed], components }).catch(() => {});
	return true;
	}
	
	await interaction.deferUpdate().catch(() => {});
	return true;
	}

	async handleButton(interaction) {
	const id = interaction.customId || '';
	if (!id.startsWith('panel:')) return false;
	const parts = id.split(':');
	const zoneId = Number(parts[3] || parts.at(-1));
	if (!zoneId) {
	await interaction.reply({ content: 'Zone invalide.', ephemeral: true }).catch(() => {});
	return true;
	}
	const zoneRow = await this.#getZone(zoneId);
	if (!zoneRow) {
	await interaction.reply({ content: 'Zone introuvable.', ephemeral: true }).catch(() => {});
	return true;
	}
	if (interaction.user.id !== String(zoneRow.owner_user_id)) {
	await interaction.reply({ content: 'Tu ne peux pas gérer cette zone.', ephemeral: true }).catch(() => {});
	return true;
	}
	await interaction.reply({ content: 'Action de panneau enregistrée.', ephemeral: true }).catch(() => {});
	return true;
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
