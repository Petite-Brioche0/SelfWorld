
const { ChannelType, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const { applyZoneOverwrites } = require('../utils/permissions');

class ZoneService {
	constructor(client, db, ownerId) {
		this.client = client;
		this.db = db;
		this.ownerId = ownerId;
	}

	#slugify(name) {
		return String(name).toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9\-]/g, '').slice(0, 32);
	}

	async handleZoneRequestModal(interaction) {
		await interaction.reply({ content: 'Reçu. Ta demande a été transmise à l’Owner.', ephemeral: true });
		// Post into #zone-requests should be implemented in your admin command / wiring.
	}

	async createZone(guild, { name, ownerUserId, policy }) {
		const slug = this.#slugify(name);
		// Create roles
		const roleOwner = await guild.roles.create({ name: `ZoneOwner-${slug}`, mentionable: false, permissions: [] });
		const roleMember = await guild.roles.create({ name: `ZoneMember-${slug}`, mentionable: false, permissions: [] });
		const roleMuted = await guild.roles.create({ name: `ZoneMuted-${slug}`, mentionable: false, permissions: [] });

		// Category + channels
		const category = await guild.channels.create({ name: `zone-${slug}`, type: ChannelType.GuildCategory });
		const panel = await guild.channels.create({ name: 'panel', type: ChannelType.GuildText, parent: category.id });
		const reception = await guild.channels.create({ name: 'reception', type: ChannelType.GuildText, parent: category.id });
		const general = await guild.channels.create({ name: 'general', type: ChannelType.GuildText, parent: category.id });
		const anon = await guild.channels.create({ name: 'anon-agora', type: ChannelType.GuildText, parent: category.id });
		const voice = await guild.channels.create({ name: 'vocal', type: ChannelType.GuildVoice, parent: category.id });

		// Overwrites
		await applyZoneOverwrites(category, {
			everyoneRole: guild.roles.everyone,
			zoneMemberRole: roleMember,
			zoneOwnerRole: roleOwner
		});

		// Persist
		const [res] = await this.db.query(
			`INSERT INTO zones (guild_id, name, slug, owner_user_id, category_id, text_panel_id, text_reception_id, text_general_id, text_anon_id, voice_id, role_owner_id, role_member_id, role_muted_id, policy, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
			[guild.id, name, slug, ownerUserId, category.id, panel.id, reception.id, general.id, anon.id, voice.id, roleOwner.id, roleMember.id, roleMuted.id, policy]
		);

		const zoneId = res.insertId;

		// Link anon channel row
		await this.db.query(
			`INSERT INTO anon_channels (zone_id, source_channel_id) VALUES (?, ?)`,
			[zoneId, anon.id]
		);

		// Grant owner roles
		const member = await guild.members.fetch(ownerUserId).catch(()=>null);
		if (member) await member.roles.add([roleOwner, roleMember]).catch(()=>{});

		// Panel
		const embed = new EmbedBuilder()
			.setTitle(`Panneau de la zone ${name}`)
			.setDescription('Utilise les menus/boutons pour configurer la politique, gérer les membres, rôles et salons.\nToutes les opérations sensibles passent par le bot.')
			.addFields(
				{ name: 'Politique', value: policy, inline: true },
				{ name: 'Owner', value: `<@${ownerUserId}>`, inline: true }
			)
			.setTimestamp();

		await panel.send({ content: `<@${ownerUserId}>`, embeds: [embed] }).catch(()=>{});

		return { zoneId, ids: { category, panel, reception, general, anon, voice, roleOwner, roleMember, roleMuted } };
	}
}

module.exports = { ZoneService };
