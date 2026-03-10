const crypto = require('node:crypto');
const { MessageFlags } = require('discord.js');

// --- Module-local helpers ---

function _generateCode() {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
	let output = '';
	for (let i = 0; i < 6; i += 1) {
		const idx = crypto.randomInt(0, alphabet.length);
		output += alphabet[idx];
	}
	return output;
}

// --- Mixin methods ---

module.exports = {
	// PUBLIC: Handle invite code generation button
	async handleGenerateCode(interaction) {
		const zoneId = Number(interaction.customId.split(':').at(-1));
		if (!zoneId) {
			await interaction.reply({ content: 'Zone invalide.', flags: MessageFlags.Ephemeral }).catch((err) => {
				if (err?.code === 10062 || err?.rawError?.code === 10062) return;
				this.logger?.warn({ err, userId: interaction.user.id, customId: interaction.customId }, 'Failed to send invalid generate-code zone reply');
			});
			return true;
		}

		await this.ensureSchema();
		const zone = await this._getZone(zoneId);
		if (!zone) {
			await interaction.reply({ content: 'Zone introuvable.', flags: MessageFlags.Ephemeral }).catch((err) => {
				if (err?.code === 10062 || err?.rawError?.code === 10062) return;
				this.logger?.warn({ err, userId: interaction.user.id, zoneId }, 'Failed to send generate-code zone-not-found reply');
			});
			return true;
		}

		const guild = interaction.guild ?? (await this.client.guilds.fetch(zone.guild_id).catch(() => null));
		const actorMember =
			interaction.member ?? (guild ? await guild.members.fetch(interaction.user.id).catch(() => null) : null);

		if (!(await this._canModerateRequests(zone, interaction.user.id, actorMember))) {
			await interaction.reply({
				content: 'Tu ne peux pas générer de codes pour cette zone.',
				flags: MessageFlags.Ephemeral
			}).catch((err) => {
				if (err?.code === 10062 || err?.rawError?.code === 10062) return;
				this.logger?.warn({ err, userId: interaction.user.id, zoneId }, 'Failed to send cannot-generate-code reply');
			});
			return true;
		}

		try {
			const { code } = await this.createInviteCode(zone.id, interaction.user.id);

			await interaction.reply({
				content: `Code généré : \`${code}\` — valide 24h, usage unique.`,
				flags: MessageFlags.Ephemeral
			});
		} catch (err) {
			this.logger?.warn({ err, zoneId, actorId: interaction.user.id }, 'Failed to generate invite code');
			await interaction.reply({
				content: `Impossible de générer un code : ${err.message || err}`,
				flags: MessageFlags.Ephemeral
			}).catch((err) => {
				if (err?.code === 10062 || err?.rawError?.code === 10062) return;
				this.logger?.warn({ err, userId: interaction.user.id, zoneId }, 'Failed to send code generation error');
			});
		}

		return true;
	},

	// PUBLIC: Create an invite code for a zone
	async createInviteCode(zoneId, actorId, _options = {}) {
		await this.ensureSchema();
		const zone = await this._getZone(zoneId);
		if (!zone) throw new Error('Zone introuvable');

		const maxAttempts = 5;
		let code = null;
		for (let i = 0; i < maxAttempts; i += 1) {
			code = _generateCode();
			try {
				await this.db.query(
					'INSERT INTO zone_invite_codes (zone_id, code, created_by, expires_at, max_uses, uses) VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL 24 HOUR), 1, 0)',
					[zoneId, code, actorId]
				);
				break;
			} catch (err) {
				if (i === maxAttempts - 1) throw err;
			}
		}

		if (!code) throw new Error('Impossible de générer un code.');

		this.logger?.info({ zoneId, actorId }, 'Zone invite code generated');

		return { code, zone };
	},

	// PUBLIC: Redeem an invite code
	async redeemInviteCode(rawCode, userId) {
		await this.ensureSchema();
		const code = String(rawCode || '').trim().toUpperCase();
		if (!/^[A-Z0-9]{6}$/.test(code)) {
			throw new Error('Code invalide.');
		}

		const [rows] = await this.db.query('SELECT * FROM zone_invite_codes WHERE code = ?', [code]);
		const entry = rows?.[0];
		if (!entry) throw new Error('Code inconnu ou expiré.');

		const zone = await this._getZone(entry.zone_id);
		if (!zone) throw new Error('Zone introuvable.');

		if (entry.expires_at && new Date(entry.expires_at) < new Date()) {
			throw new Error('Ce code a expiré.');
		}

		if (entry.max_uses != null && entry.uses >= entry.max_uses) {
			throw new Error('Ce code a atteint sa limite.');
		}

		if (await this.isUserMember(zone.id, userId)) {
			return { status: 'already-member', zone };
		}

		await this.db.query('UPDATE zone_invite_codes SET uses = uses + 1 WHERE id = ?', [entry.id]);

		await this.db.query('DELETE FROM zone_invite_codes WHERE id = ?', [entry.id]).catch((err) => {
			this.logger?.warn({ err, codeId: entry.id, zoneId: zone.id }, 'Failed to delete used invite code');
		});

		await this._grantZoneMembership(zone, userId);

		this.logger?.info({ zoneId: zone.id, userId }, 'Invite code redeemed');

		return { status: 'joined', zone };
	},
};
