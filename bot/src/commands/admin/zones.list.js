const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

function formatDate(value) {
	if (!value) return 'n/a';
	if (value instanceof Date) {
		return value.toISOString().replace('T', ' ').slice(0, 19);
	}
	const parsed = new Date(value);
	if (!Number.isNaN(parsed.getTime())) {
		return parsed.toISOString().replace('T', ' ').slice(0, 19);
	}
	return String(value);
}

function buildTable(zones) {
	const columns = [
		{ key: 'id', label: 'id' },
		{ key: 'name', label: 'name' },
		{ key: 'slug', label: 'slug' },
		{ key: 'owner_user_id', label: 'owner_user_id' },
		{ key: 'policy', label: 'policy' },
		{ key: 'created_at', label: 'created_at' }
	];

	const rows = zones.map((zone) => ({
		id: String(zone.id),
		name: String(zone.name),
		slug: String(zone.slug),
		owner_user_id: String(zone.owner_user_id),
		policy: String(zone.policy),
		created_at: formatDate(zone.created_at)
	}));

	const widths = columns.reduce((acc, col) => {
		const maxRow = rows.reduce((max, row) => Math.max(max, row[col.key].length), col.label.length);
		acc[col.key] = maxRow;
		return acc;
	}, {});

	const lines = [];
	lines.push(columns.map((col) => col.label.padEnd(widths[col.key])).join(' | '));
	lines.push(columns.map((col) => '-'.repeat(widths[col.key])).join('-+-'));
	for (const row of rows) {
		lines.push(columns.map((col) => row[col.key].padEnd(widths[col.key])).join(' | '));
	}

	const pages = [];
	let buffer = '';
	for (const line of lines) {
		if ((buffer + line + '\n').length > 1800) {
			pages.push(buffer.trimEnd());
			buffer = '';
		}
		buffer += `${line}\n`;
	}
	if (buffer.trim().length) {
		pages.push(buffer.trimEnd());
	}
	return pages.map((content) => `\`\`\`\n${content}\n\`\`\``);
}

module.exports = {
	ownerOnly: true,
	data: new SlashCommandBuilder().setName('zones-list').setDescription('Lister toutes les zones existantes.'),
	async execute(interaction, ctx) {
		await interaction.deferReply({ ephemeral: true });
		try {
			const zones = await ctx.services.zone.listZones(interaction.guildId);
			if (!zones.length) {
				const embed = new EmbedBuilder()
					.setColor(0x5865f2)
					.setTitle('Zones enregistrées')
					.setDescription('Aucune zone enregistrée pour ce serveur.')
					.setTimestamp();
				return interaction.editReply({ embeds: [embed] });
			}

			const tablePages = buildTable(zones);
			const embeds = tablePages.map((page, index) => new EmbedBuilder()
				.setColor(0x5865f2)
				.setTitle('Zones enregistrées')
				.setDescription(page)
				.setFooter({ text: `Page ${index + 1}/${tablePages.length} • Total ${zones.length}` })
				.setTimestamp());

			return interaction.editReply({ embeds });
		} catch (err) {
			ctx.logger.error({ err }, 'zones-list failed');
			const embed = new EmbedBuilder()
				.setColor(0xed4245)
				.setTitle('Erreur lors de la récupération des zones')
				.setDescription('❌ Une erreur est survenue en listant les zones.')
				.setTimestamp();
			return interaction.editReply({ embeds: [embed] });
		}
	}
};
