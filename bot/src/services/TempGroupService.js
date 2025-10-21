const {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	ChannelType,
	PermissionFlagsBits
} = require('discord.js');

const DEFAULT_EXPIRY_DAYS = 14;
const FREEZE_DURATION_DAYS = 7;
const MAX_MEMBERS = Number(process.env.TEMP_GROUP_MAX_MEMBERS || 0);

class TempGroupService {
	constructor(client, db) {
		this.client = client;
		this.db = db;
		this._textChannelCache = new Map();
		this._columnCache = new Map();
	}

	#logger() {
		return this.client?.context?.logger || null;
	}

	#slugify(name) {
		return String(name || 'groupe-temp')
			.toLowerCase()
			.normalize('NFD')
			.replace(/\p{Diacritic}/gu, '')
			.replace(/[^a-z0-9\s-]/g, '')
			.trim()
			.replace(/\s+/g, '-')
			.slice(0, 50) || 'temp';
	}

	async #hasColumn(table, column) {
		const key = `${table}.${column}`;
		if (this._columnCache.has(key)) {
			return this._columnCache.get(key);
		}
		try {
			const [rows] = await this.db.query('SHOW COLUMNS FROM ?? LIKE ?', [table, column]);
			const exists = Array.isArray(rows) && rows.length > 0;
			this._columnCache.set(key, exists);
			return exists;
		} catch (err) {
			this._columnCache.set(key, false);
			this.#logger()?.warn({ err, table, column }, 'Failed to inspect table column');
			return false;
		}
	}

	#hydrateGroup(row) {
		if (!row) return null;
		return {
			...row,
			id: Number(row.id),
			archived: row.archived === true || row.archived === 1 || row.archived === '1',
			is_open: row.is_open === true || row.is_open === 1 || row.is_open === '1',
			frozen_until: row.frozen_until || null
		};
	}

	#isFrozen(group) {
		if (!group?.frozen_until) return false;
		const date = new Date(group.frozen_until);
		return Number.isFinite(date.getTime()) && date.getTime() > Date.now();
	}

	async #getGroup(groupId) {
		if (!groupId) return null;
		const [rows] = await this.db.query('SELECT * FROM temp_groups WHERE id = ?', [groupId]);
		return this.#hydrateGroup(rows?.[0] || null);
	}

	async #getGroupByTextChannel(channelId) {
		if (!channelId) return null;
		const key = String(channelId);
		if (this._textChannelCache.has(key)) {
			const cached = this._textChannelCache.get(key);
			if (!cached) return null;
			return this.#getGroup(cached);
		}
		const [rows] = await this.db.query('SELECT * FROM temp_groups WHERE text_channel_id = ?', [key]);
		const group = this.#hydrateGroup(rows?.[0] || null);
		this._textChannelCache.set(key, group?.id || null);
		return group;
	}

	async #getMemberLists(groupId) {
		const [rows] = await this.db.query('SELECT user_id, role FROM temp_group_members WHERE temp_group_id = ?', [groupId]);
		const members = new Set();
		const spectators = new Set();
		for (const row of rows || []) {
			const id = String(row.user_id);
			if (row.role === 'spectator') {
				spectators.add(id);
			} else {
				members.add(id);
			}
		}
		for (const id of members) {
			spectators.delete(id);
		}
		return { members: Array.from(members), spectators: Array.from(spectators) };
	}

	async #fetchChannel(channelId) {
		if (!channelId) return null;
		try {
			return await this.client.channels.fetch(channelId);
		} catch (err) {
			this.#logger()?.warn({ err, channelId }, 'Failed to fetch channel for temp group');
			return null;
		}
	}

	#buildCategoryOverwrites(guild, memberIds, spectatorIds) {
		const everyoneId = guild.roles.everyone.id;
		const botId = this.client.user.id;
		const overwrites = [
			{ id: everyoneId, deny: [PermissionFlagsBits.ViewChannel] },
			{
				id: botId,
				allow: [
					PermissionFlagsBits.ViewChannel,
					PermissionFlagsBits.ManageChannels,
					PermissionFlagsBits.ManageMessages,
					PermissionFlagsBits.ManageRoles
				]
			}
		];
		for (const id of memberIds) {
			overwrites.push({ id, allow: [PermissionFlagsBits.ViewChannel] });
		}
		for (const id of spectatorIds) {
			overwrites.push({ id, allow: [PermissionFlagsBits.ViewChannel] });
		}
		return overwrites;
	}

	#buildTextOverwrites(guild, memberIds, spectatorIds, isFrozen) {
		const everyoneId = guild.roles.everyone.id;
		const botId = this.client.user.id;
		const overwrites = [
			{ id: everyoneId, deny: [PermissionFlagsBits.ViewChannel] },
			{
				id: botId,
				allow: [
					PermissionFlagsBits.ViewChannel,
					PermissionFlagsBits.SendMessages,
					PermissionFlagsBits.ReadMessageHistory,
					PermissionFlagsBits.ManageChannels,
					PermissionFlagsBits.ManageMessages,
					PermissionFlagsBits.ManageThreads,
					PermissionFlagsBits.EmbedLinks,
					PermissionFlagsBits.AttachFiles
				]
			}
		];
		for (const id of memberIds) {
			const allow = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory];
			const overwrite = { id, allow };
			if (!isFrozen) {
				allow.push(PermissionFlagsBits.SendMessages);
			} else {
				overwrite.deny = [PermissionFlagsBits.SendMessages];
			}
			overwrites.push(overwrite);
		}
		for (const id of spectatorIds) {
			overwrites.push({
				id,
				allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]
			});
		}
		return overwrites;
	}

	#buildVoiceOverwrites(guild, memberIds, spectatorIds) {
		const everyoneId = guild.roles.everyone.id;
		const botId = this.client.user.id;
		const overwrites = [
			{
				id: everyoneId,
				deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect]
			},
			{
				id: botId,
				allow: [
					PermissionFlagsBits.ViewChannel,
					PermissionFlagsBits.Connect,
					PermissionFlagsBits.Speak,
					PermissionFlagsBits.MoveMembers,
					PermissionFlagsBits.ManageChannels
				]
			}
		];
		for (const id of memberIds) {
			overwrites.push({
				id,
				allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak]
			});
		}
		for (const id of spectatorIds) {
			overwrites.push({ id, allow: [PermissionFlagsBits.ViewChannel] });
		}
		return overwrites;
	}

	async #applyPermissions(group, memberIds, spectatorIds, { isFrozen = false } = {}) {
		const category = await this.#fetchChannel(group.category_id);
		if (category?.type === ChannelType.GuildCategory) {
			const overwrites = this.#buildCategoryOverwrites(category.guild, memberIds, spectatorIds);
			await category.permissionOverwrites.set(overwrites).catch((err) => {
				this.#logger()?.warn({ err, groupId: group.id }, 'Failed to update category overwrites');
			});
		}
		const text = await this.#fetchChannel(group.text_channel_id);
		if (text?.type === ChannelType.GuildText) {
			const overwrites = this.#buildTextOverwrites(text.guild, memberIds, spectatorIds, isFrozen);
			await text.permissionOverwrites.set(overwrites).catch((err) => {
				this.#logger()?.warn({ err, groupId: group.id }, 'Failed to update text overwrites');
			});
		}
		const voice = await this.#fetchChannel(group.voice_channel_id);
		if (voice?.type === ChannelType.GuildVoice) {
			const overwrites = this.#buildVoiceOverwrites(voice.guild, memberIds, spectatorIds);
			await voice.permissionOverwrites.set(overwrites).catch((err) => {
				this.#logger()?.warn({ err, groupId: group.id }, 'Failed to update voice overwrites');
			});
		}
	}

	#buildPanelContent(group, memberCount, spectatorCount, isFrozen) {
		const parts = [];
		parts.push(`**${group.name}**`);
		parts.push(`👥 Membres : ${memberCount}`);
		parts.push(`👀 Spectateurs : ${spectatorCount}`);
		parts.push(`🔓 Accès : ${group.is_open ? 'Ouvert' : 'Fermé'}`);
		if (isFrozen) {
			const until = new Date(group.frozen_until);
			const ts = Math.floor(until.getTime() / 1000);
			parts.push(`❄️ Gel : jusqu’au <t:${ts}:R>`);
		} else {
			parts.push('❄️ Gel : non');
		}
		const last = group.last_activity_at ? new Date(group.last_activity_at) : null;
		if (last) {
			const ts = Math.floor(last.getTime() / 1000);
			parts.push(`🕒 Dernière activité : <t:${ts}:R>`);
		} else {
			parts.push('🕒 Dernière activité : —');
		}
		if (group.expires_at) {
			const expire = new Date(group.expires_at);
			const ts = Math.floor(expire.getTime() / 1000);
			parts.push(`⏳ Archivage automatique : <t:${ts}:R>`);
		}
		if (group.archived) {
			parts.push('📁 Statut : archivé');
		}
		return parts.join('\n');
	}

	#buildPanelComponents(group, isFrozen) {
		if (group.archived) return [];
		const row = new ActionRowBuilder().addComponents(
			new ButtonBuilder()
				.setCustomId(`temp:panel:${group.id}:refresh`)
				.setStyle(ButtonStyle.Secondary)
				.setEmoji('👥')
				.setLabel('Rafraîchir'),
			new ButtonBuilder()
				.setCustomId(`temp:panel:${group.id}:invite`)
				.setStyle(ButtonStyle.Primary)
				.setEmoji('➕')
				.setLabel('Inviter'),
			new ButtonBuilder()
				.setCustomId(`temp:join:${group.id}`)
				.setStyle(ButtonStyle.Success)
				.setEmoji('👤')
				.setLabel('Devenir membre')
				.setDisabled(!group.is_open || isFrozen),
			new ButtonBuilder()
				.setCustomId(`temp:spectate:${group.id}`)
				.setStyle(ButtonStyle.Secondary)
				.setEmoji('👀')
				.setLabel('Devenir spectateur'),
			new ButtonBuilder()
				.setCustomId(`temp:leave:${group.id}`)
				.setStyle(ButtonStyle.Danger)
				.setEmoji('🚪')
				.setLabel('Quitter')
		);
		return [row];
	}

	async #ensurePanelMessage(group) {
		const text = await this.#fetchChannel(group.text_channel_id);
		if (!text || text.type !== ChannelType.GuildText) return null;
		let message = null;
		if (group.panel_message_id) {
			try {
				message = await text.messages.fetch(group.panel_message_id);
			} catch {
				message = null;
			}
		}
		if (!message) {
			message = await text.send({ content: 'Initialisation du panneau…' });
			await message.pin().catch(() => {});
			await this.db.query('UPDATE temp_groups SET panel_message_id = ? WHERE id = ?', [message.id, group.id]);
			group.panel_message_id = message.id;
		} else if (!message.pinned) {
			await message.pin().catch(() => {});
		}
		return message;
	}

	#getMaxMembers() {
		return MAX_MEMBERS > 0 ? MAX_MEMBERS : 0;
	}

	async createTempGroup(guild, { name, isOpen, participants = [], spectators = [], authorId = null, createdBy = null } = {}) {
		const sanitizedName = String(name || 'Groupe temporaire').trim().slice(0, 90) || 'Groupe temporaire';
		const slug = this.#slugify(sanitizedName);
		const memberSet = new Set((participants || []).map((id) => String(id)).filter(Boolean));
		const spectatorSet = new Set((spectators || []).map((id) => String(id)).filter(Boolean));
		for (const id of memberSet) {
			spectatorSet.delete(id);
		}
		const rawCreator = authorId || createdBy || memberSet.values().next().value || null;
		const creatorId = rawCreator ? String(rawCreator) : null;

		const botId = this.client.user.id;
		const everyoneId = guild.roles.everyone.id;

		const category = await guild.channels.create({
			name: sanitizedName,
			type: ChannelType.GuildCategory,
			permissionOverwrites: [
				{ id: everyoneId, deny: [PermissionFlagsBits.ViewChannel] },
				{
					id: botId,
					allow: [
						PermissionFlagsBits.ViewChannel,
						PermissionFlagsBits.ManageChannels,
						PermissionFlagsBits.ManageMessages,
						PermissionFlagsBits.ManageRoles
					]
				}
			]
		});

		const text = await guild.channels.create({
			name: `groupe-${slug}`,
			parent: category.id,
			type: ChannelType.GuildText
		});

		const voice = await guild.channels.create({
			name: 'vocal',
			parent: category.id,
			type: ChannelType.GuildVoice
		});

		await category.permissionOverwrites.set(
			this.#buildCategoryOverwrites(guild, Array.from(memberSet), Array.from(spectatorSet))
		).catch(() => {});
		await text.permissionOverwrites.set(
			this.#buildTextOverwrites(guild, Array.from(memberSet), Array.from(spectatorSet), false)
		).catch(() => {});
		await voice.permissionOverwrites.set(
			this.#buildVoiceOverwrites(guild, Array.from(memberSet), Array.from(spectatorSet))
		).catch(() => {});

		const columns = [
			'name',
			'category_id',
			'text_channel_id',
			'voice_channel_id',
			'is_open',
			'last_activity_at',
			'expires_at'
		];
		const values = [
			sanitizedName,
			category.id,
			text.id,
			voice.id,
			isOpen ? 1 : 0,
			new Date(),
			new Date(Date.now() + DEFAULT_EXPIRY_DAYS * 24 * 60 * 60 * 1000)
		];
		if (creatorId && (await this.#hasColumn('temp_groups', 'author_id'))) {
			columns.push('author_id');
			values.push(creatorId);
		}
		const placeholders = columns.map(() => '?').join(', ');
		const sql = `INSERT INTO temp_groups (${columns.join(', ')}) VALUES (${placeholders})`;
		const [res] = await this.db.query(sql, values);
		const groupId = res.insertId;

		const insertMember = async (userId, role) => {
			await this.db.query(
				'INSERT INTO temp_group_members (temp_group_id, user_id, role) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE role = VALUES(role)',
				[groupId, userId, role]
			);
		};
		for (const id of memberSet) {
			await insertMember(id, 'member');
		}
		for (const id of spectatorSet) {
			await insertMember(id, 'spectator');
		}

		this._textChannelCache.set(String(text.id), groupId);

		const group = await this.#getGroup(groupId);
		const panelMessage = await this.#ensurePanelMessage(group);
		if (panelMessage) {
			await this.updatePanel(groupId);
		}

		return {
			groupId,
			categoryId: category.id,
			textChannelId: text.id,
			voiceChannelId: voice.id
		};
	}

	async updatePanel(tempGroupId) {
		const group = await this.#getGroup(tempGroupId);
		if (!group) return false;
		const { members, spectators } = await this.#getMemberLists(tempGroupId);
		const isFrozen = this.#isFrozen(group);
		const message = await this.#ensurePanelMessage(group);
		if (!message) return false;
		const content = this.#buildPanelContent(group, members.length, spectators.length, isFrozen);
		const components = this.#buildPanelComponents(group, isFrozen);
		await message.edit({ content, components }).catch((err) => {
			this.#logger()?.warn({ err, groupId: group.id }, 'Failed to edit temp group panel');
		});
		return true;
	}

	async setLastActivity(tempGroupId) {
		if (!tempGroupId) return;
		await this.db.query('UPDATE temp_groups SET last_activity_at = NOW() WHERE id = ?', [tempGroupId]);
	}

	async setLastActivityByTextChannel(channelId) {
		const group = await this.#getGroupByTextChannel(channelId);
		if (!group || group.archived) return false;
		await this.setLastActivity(group.id);
		return true;
	}

	async getGroup(tempGroupId) {
		return this.#getGroup(tempGroupId);
	}

	async inviteMembers(tempGroupId, actorId, userIds) {
		const group = await this.#getGroup(tempGroupId);
		if (!group) return { ok: false, message: 'Groupe introuvable.' };
		if (group.archived) return { ok: false, message: 'Groupe archivé.' };
		const role = await this.getMemberRole(tempGroupId, actorId);
		if (role !== 'member') {
			return { ok: false, message: 'Seuls les membres peuvent inviter.' };
		}
		const ids = Array.from(new Set((userIds || []).map((id) => String(id)).filter(Boolean)));
		if (!ids.length) return { ok: false, message: 'Aucun identifiant fourni.' };
		const { members, spectators } = await this.#getMemberLists(tempGroupId);
		const memberSet = new Set(members);
		const spectatorSet = new Set(spectators);
		const added = [];
		for (const id of ids) {
			if (memberSet.has(id)) continue;
			await this.db.query(
				'INSERT INTO temp_group_members (temp_group_id, user_id, role) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE role = VALUES(role)',
				[tempGroupId, id, 'member']
			);
			memberSet.add(id);
			spectatorSet.delete(id);
			added.push(id);
		}
		await this.#applyPermissions(group, Array.from(memberSet), Array.from(spectatorSet), { isFrozen: this.#isFrozen(group) });
		await this.updatePanel(tempGroupId);
		if (!added.length) {
			return { ok: true, message: 'Aucune nouvelle personne ajoutée (déjà membres).' };
		}
		return { ok: true, message: `Invitations ajoutées : ${added.map((id) => `<@${id}>`).join(', ')}` };
	}

	async joinGroup(tempGroupId, userId) {
		const group = await this.#getGroup(tempGroupId);
		if (!group) return { ok: false, message: 'Groupe introuvable.' };
		if (group.archived) return { ok: false, message: 'Ce groupe est archivé.' };
		const isFrozen = this.#isFrozen(group);
		if (isFrozen) return { ok: false, message: 'Groupe gelé : votes en cours.' };
		if (!group.is_open) return { ok: false, message: 'Groupe fermé aux nouvelles inscriptions.' };
		const { members, spectators } = await this.#getMemberLists(tempGroupId);
		const memberSet = new Set(members);
		const spectatorSet = new Set(spectators);
		if (memberSet.has(String(userId))) {
			return { ok: false, message: 'Tu es déjà membre du groupe.' };
		}
		const maxMembers = this.#getMaxMembers();
		if (maxMembers > 0 && memberSet.size >= maxMembers) {
			return { ok: false, message: `Groupe complet (${maxMembers} membres).` };
		}
		await this.db.query(
			'INSERT INTO temp_group_members (temp_group_id, user_id, role) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE role = VALUES(role)',
			[tempGroupId, String(userId), 'member']
		);
		spectatorSet.delete(String(userId));
		memberSet.add(String(userId));
		await this.#applyPermissions(group, Array.from(memberSet), Array.from(spectatorSet), { isFrozen: false });
		await this.updatePanel(tempGroupId);
		return { ok: true, message: 'Bienvenue parmi les membres !' };
	}

	async spectateGroup(tempGroupId, userId) {
		const group = await this.#getGroup(tempGroupId);
		if (!group) return { ok: false, message: 'Groupe introuvable.' };
		if (group.archived) return { ok: false, message: 'Groupe archivé.' };
		const { members, spectators } = await this.#getMemberLists(tempGroupId);
		const memberSet = new Set(members);
		const spectatorSet = new Set(spectators);
		const id = String(userId);
		if (spectatorSet.has(id) && !memberSet.has(id)) {
			return { ok: false, message: 'Tu observes déjà le groupe.' };
		}
		await this.db.query(
			'INSERT INTO temp_group_members (temp_group_id, user_id, role) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE role = VALUES(role)',
			[tempGroupId, id, 'spectator']
		);
		memberSet.delete(id);
		spectatorSet.add(id);
		await this.#applyPermissions(group, Array.from(memberSet), Array.from(spectatorSet), {
			isFrozen: this.#isFrozen(group)
		});
		await this.updatePanel(tempGroupId);
		return { ok: true, message: 'Tu es désormais spectateur.' };
	}

	async leaveGroup(tempGroupId, userId) {
		const group = await this.#getGroup(tempGroupId);
		if (!group) return { ok: false, message: 'Groupe introuvable.' };
		const id = String(userId);
		const { members, spectators } = await this.#getMemberLists(tempGroupId);
		const wasMember = members.includes(id);
		const wasSpectator = spectators.includes(id);
		if (!wasMember && !wasSpectator) {
			return { ok: false, message: 'Tu ne participes pas à ce groupe.' };
		}
		await this.db.query('DELETE FROM temp_group_members WHERE temp_group_id = ? AND user_id = ?', [tempGroupId, id]);
		const newMembers = members.filter((m) => m !== id);
		const newSpectators = spectators.filter((s) => s !== id);
		await this.#applyPermissions(group, newMembers, newSpectators, { isFrozen: this.#isFrozen(group) });
		await this.updatePanel(tempGroupId);
		return {
			ok: true,
			message: wasMember ? 'Tu as quitté le groupe.' : 'Tu n’es plus spectateur.'
		};
	}

	async getMemberRole(tempGroupId, userId) {
		const [rows] = await this.db.query(
			'SELECT role FROM temp_group_members WHERE temp_group_id = ? AND user_id = ? LIMIT 1',
			[tempGroupId, String(userId)]
		);
		return rows?.[0]?.role || null;
	}

	async freezeIfInactive(hours = 72) {
		const [rows] = await this.db.query(
			`SELECT * FROM temp_groups
			WHERE archived = 0
			AND (frozen_until IS NULL OR frozen_until <= NOW())
			AND IFNULL(last_activity_at, created_at) <= DATE_SUB(NOW(), INTERVAL ? HOUR)`,
			[hours]
		);
		for (const raw of rows || []) {
			const group = this.#hydrateGroup(raw);
			await this.db.query('UPDATE temp_groups SET frozen_until = DATE_ADD(NOW(), INTERVAL ? DAY) WHERE id = ?', [
				FREEZE_DURATION_DAYS,
				group.id
			]);
			group.frozen_until = new Date(Date.now() + FREEZE_DURATION_DAYS * 24 * 60 * 60 * 1000);
			const { members, spectators } = await this.#getMemberLists(group.id);
			await this.#applyPermissions(group, members, spectators, { isFrozen: true });
			await this.#sendFreezeNotice(group, hours);
			await this.updatePanel(group.id);
		}
	}

	async #sendFreezeNotice(group, hours) {
		const text = await this.#fetchChannel(group.text_channel_id);
		if (!text || text.type !== ChannelType.GuildText) return;
		const row = new ActionRowBuilder().addComponents(
			new ButtonBuilder()
				.setCustomId(`temp:vote:remove:${group.id}`)
				.setStyle(ButtonStyle.Danger)
				.setLabel('Supprimer'),
			new ButtonBuilder()
				.setCustomId(`temp:vote:keep:${group.id}`)
				.setStyle(ButtonStyle.Success)
				.setLabel('Conserver')
		);
		await text.send({
			content: `⏸ Inactivité ${hours}h. Écriture suspendue. Vote : ‘Supprimer’ (3 votes) ou ‘Conserver’.`,
			components: [row]
		}).catch((err) => {
			this.#logger()?.warn({ err, groupId: group.id }, 'Failed to send freeze notice');
		});
	}

	async handleVote(tempGroupId, userId, action) {
		if (!['remove', 'keep'].includes(action)) {
			return { ok: false, message: 'Action invalide.' };
		}
		const group = await this.#getGroup(tempGroupId);
		if (!group) return { ok: false, message: 'Groupe introuvable.' };
		await this.db.query('DELETE FROM temp_group_freeze_votes WHERE temp_group_id = ? AND user_id = ? AND action <> ?', [
			tempGroupId,
			String(userId),
			action
		]);
		await this.db.query(
			'INSERT INTO temp_group_freeze_votes (temp_group_id, user_id, action) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE created_at = NOW()',
			[tempGroupId, String(userId), action]
		);
		if (action === 'keep') {
			await this.db.query('UPDATE temp_groups SET frozen_until = NULL WHERE id = ?', [tempGroupId]);
			await this.db.query('DELETE FROM temp_group_freeze_votes WHERE temp_group_id = ?', [tempGroupId]);
			group.frozen_until = null;
			const { members, spectators } = await this.#getMemberLists(tempGroupId);
			await this.#applyPermissions(group, members, spectators, { isFrozen: false });
			await this.updatePanel(tempGroupId);
			return { ok: true, status: 'unfrozen' };
		}
		const [rows] = await this.db.query(
			"SELECT COUNT(DISTINCT user_id) AS votes FROM temp_group_freeze_votes WHERE temp_group_id = ? AND action = 'remove'",
			[tempGroupId]
		);
		const votes = Number(rows?.[0]?.votes || 0);
		const hasAuthorColumn = await this.#hasColumn('temp_groups', 'author_id');
		const isCreator = hasAuthorColumn && group.author_id && String(group.author_id) === String(userId);
		if (votes >= 3 || isCreator) {
			await this.#archiveGroup(group);
			return { ok: true, status: 'archived', votes, isCreator };
		}
		await this.updatePanel(tempGroupId);
		return { ok: true, status: 'vote-recorded', votes };
	}

	async #archiveGroup(group) {
		await this.db.query('UPDATE temp_groups SET archived = 1, frozen_until = NULL WHERE id = ?', [group.id]);
		await this.db.query('DELETE FROM temp_group_freeze_votes WHERE temp_group_id = ?', [group.id]);
		group.archived = true;
		group.frozen_until = null;
		const text = await this.#fetchChannel(group.text_channel_id);
		if (text?.type === ChannelType.GuildText) {
			await text.permissionOverwrites.set([
				{ id: text.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
				{
					id: this.client.user.id,
					allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageMessages]
				}
			]).catch(() => {});
		}
		const voice = await this.#fetchChannel(group.voice_channel_id);
		if (voice?.type === ChannelType.GuildVoice) {
			await voice.permissionOverwrites.set([
				{ id: voice.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] },
				{
					id: this.client.user.id,
					allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.ManageChannels]
				}
			]).catch(() => {});
		}
		if (text) {
			this._textChannelCache.set(String(text.id), null);
		}
		await this.updatePanel(group.id);
	}

	async sweepExpired() {
		const [rows] = await this.db.query(
			'SELECT * FROM temp_groups WHERE expires_at <= NOW() OR archived = 1'
		);
		for (const raw of rows || []) {
			const group = this.#hydrateGroup(raw);
			await this.#archiveGroup(group);
		}
	}

	async enforceFreezePolicy(thresholdHours = 72) {
		await this.freezeIfInactive(thresholdHours);
	}

	async cleanupFreezeVotes() {
		await this.db.query(
			'DELETE FROM temp_group_freeze_votes WHERE temp_group_id IN (SELECT id FROM (SELECT id FROM temp_groups WHERE archived = 1) AS g)'
		);
	}
}

module.exports = { TempGroupService };
