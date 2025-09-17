const {
	ModalBuilder,
	TextInputBuilder,
	TextInputStyle,
	ActionRowBuilder,
	ChannelType,
	PermissionFlagsBits
} = require('discord.js');

class TempGroupService {
	constructor(client, pool, zoneService, activityService, logger) {
		this.client = client;
		this.pool = pool;
		this.zoneService = zoneService;
		this.activityService = activityService;
		this.logger = logger;
		this.scheduleCleanup();
	}

	scheduleCleanup() {
		setInterval(() => {
			this.autoArchive().catch((error) => this.logger.error({ err: error }, 'Temp group cleanup failed'));
		}, 60 * 60 * 1000).unref();
	}

	async handleComponent(interaction) {
		if (interaction.customId === 'temp:request') {
			const modal = new ModalBuilder()
			.setCustomId('temp:create')
			.setTitle('Créer un groupe temporaire');
			modal.addComponents(
				new ActionRowBuilder().addComponents(
					new TextInputBuilder()
					.setCustomId('temp-name')
					.setLabel('Nom du groupe')
					.setMaxLength(100)
					.setStyle(TextInputStyle.Short)
					.setRequired(true)
				),
				new ActionRowBuilder().addComponents(
					new TextInputBuilder()
					.setCustomId('temp-members')
					.setLabel('Membres (IDs séparés par des virgules)')
					.setStyle(TextInputStyle.Paragraph)
				)
			);
			await interaction.showModal(modal);
		}
	}

	async handleModal(interaction) {
		if (interaction.customId !== 'temp:create') {
			return;
		}
		const guild = interaction.guild;
		const name = interaction.fields.getTextInputValue('temp-name').slice(0, 100);
		const memberInput = interaction.fields.getTextInputValue('temp-members');
		const members = memberInput.split(',').map((value) => value.trim()).filter(Boolean);
		members.push(interaction.user.id);
		const uniqueMembers = [...new Set(members)];
		const category = await guild.channels.create({ name: `temp-${Date.now()}`, type: ChannelType.GuildCategory });
		const textChannel = await guild.channels.create({ name: 'salon-temp', type: ChannelType.GuildText, parent: category });
		const voiceChannel = await guild.channels.create({ name: 'vocal-temp', type: ChannelType.GuildVoice, parent: category });
		const overwrites = [
			{ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
			...uniqueMembers.map((userId) => ({
				id: userId,
				allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak]
			}))
		];
		await category.permissionOverwrites.set(overwrites);
		await textChannel.permissionOverwrites.set(overwrites);
		await voiceChannel.permissionOverwrites.set(overwrites);
		const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000);
		const [result] = await this.pool.query('INSERT INTO temp_groups (name, category_id, archived, expires_at) VALUES (?, ?, ?, ?)', [name, category.id, false, expiresAt]);
		const groupId = result.insertId;
		for (const memberId of uniqueMembers) {
			await this.pool.query('INSERT INTO temp_group_members (temp_group_id, user_id) VALUES (?, ?)', [groupId, memberId]);
		}
		await interaction.reply({ content: 'Groupe temporaire créé.', ephemeral: true });
		this.logger.info({ groupId }, 'Temp group created');
	}

	async autoArchive() {
		const [groups] = await this.pool.query('SELECT * FROM temp_groups WHERE archived = FALSE AND expires_at < NOW()');
		for (const group of groups) {
			await this.pool.query('UPDATE temp_groups SET archived = TRUE WHERE id = ?', [group.id]);
			const category = await this.client.channels.fetch(group.category_id).catch(() => null);
			if (category) {
				await category.permissionOverwrites.set([]);
			}
		}
	}
}

module.exports = TempGroupService;