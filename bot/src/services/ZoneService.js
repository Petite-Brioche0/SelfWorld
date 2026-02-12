const crypto = require('node:crypto');
const {
        ActionRowBuilder,
        ChannelType,
        EmbedBuilder,
        MessageFlags,
        ModalBuilder,
        TextInputBuilder,
        TextInputStyle
} = require('discord.js');
const { applyZoneOverwrites } = require('../utils/permissions');

class ZoneService {
        constructor(client, db, ownerId, logger, panelService = null) {
                this.client = client;
                this.db = db;
                this.ownerId = ownerId;
                this.logger = logger;
                this.panelService = panelService;
                this._receptionSet = new Set();
                this.#warmReceptionCache().catch((err) => {
                        this.logger?.warn({ err }, 'Failed to warm reception cache');
                });
        }

        setPanelService(panelService) {
                this.panelService = panelService;
        }

        isReceptionChannel(channelId) {
                if (!channelId) return false;
                return this._receptionSet.has(String(channelId));
        }

        #slugify(name) {
                return String(name).toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 32);
        }

        async #getZone(zoneId) {
                const [rows] = await this.db.query('SELECT * FROM zones WHERE id = ?', [zoneId]);
                const zone = rows?.[0] || null;
                if (zone?.text_reception_id) {
                        this.#indexReception(zone.text_reception_id);
                }
                return zone;
        }

        async #getZoneByCategory(categoryId) {
                if (!categoryId) return null;
                const [rows] = await this.db.query('SELECT * FROM zones WHERE category_id = ?', [categoryId]);
                const zone = rows?.[0] || null;
                if (zone?.text_reception_id) {
                        this.#indexReception(zone.text_reception_id);
                }
                return zone;
        }

        async #getRequestsChannelId(guildId) {
                const [rows] = await this.db.query('SELECT requests_channel_id FROM settings WHERE guild_id = ?', [guildId]);
                const dbValue = rows?.[0]?.requests_channel_id;
                return dbValue || process.env.ZONE_REQUESTS_CHANNEL_ID || null;
        }

        async #safeFetchChannel(guild, channelId) {
                if (!channelId) return null;
                try {
                        return await guild.channels.fetch(channelId);
                } catch {
                        return null;
                }
        }

        async #safeFetchRole(guild, roleId) {
                if (!roleId) return null;
                try {
                        return await guild.roles.fetch(roleId);
                } catch {
                        return null;
                }
        }

        async #fetchGuild(zoneRow) {
                if (!zoneRow) return null;
                try {
                        return await this.client.guilds.fetch(zoneRow.guild_id);
                } catch {
                        return null;
                }
        }

        #isOwnerOverride(userId) {
                return this.ownerId && String(userId) === String(this.ownerId);
        }

        async #refreshPanel(zoneId, sections) {
                if (!this.panelService || !zoneId) return;
                try {
                        await this.panelService.refresh(zoneId, sections);
                } catch (err) {
                        this.logger?.warn({ err, zoneId }, 'Failed to refresh panel');
                }
        }

        buildRequestModal() {
                const modal = new ModalBuilder()
                        .setCustomId('zone:request:create')
                        .setTitle('Demander une nouvelle zone');

                const nameInput = new TextInputBuilder()
                        .setCustomId('zoneName')
                        .setLabel('Nom souhaité')
                        .setMinLength(3)
                        .setMaxLength(64)
                        .setPlaceholder('Ex. Quartier créatif')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true);

                const policyInput = new TextInputBuilder()
                        .setCustomId('zonePolicy')
                        .setLabel('Politique souhaitée (ouvert / sur demande / fermé)')
                        .setMinLength(3)
                        .setMaxLength(20)
                        .setPlaceholder('Ex. open, ask, closed')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true);

                const pitchInput = new TextInputBuilder()
                        .setCustomId('zonePitch')
                        .setLabel('But de la zone')
                        .setStyle(TextInputStyle.Paragraph)
                        .setMaxLength(500)
                        .setRequired(true);

                const needsInput = new TextInputBuilder()
                        .setCustomId('zoneNeeds')
                        .setLabel('Membres pressentis / besoins spécifiques')
                        .setStyle(TextInputStyle.Paragraph)
                        .setMaxLength(500)
                        .setRequired(false);

                modal.addComponents(
                        new ActionRowBuilder().addComponents(nameInput),
                        new ActionRowBuilder().addComponents(policyInput),
                        new ActionRowBuilder().addComponents(pitchInput),
                        new ActionRowBuilder().addComponents(needsInput)
                );

                return modal;
        }

        async handleZoneRequestModal(interaction) {
                const name = interaction.fields.getTextInputValue('zoneName')?.trim().slice(0, 64) || 'Zone sans nom';
                const rawPolicy = interaction.fields.getTextInputValue('zonePolicy')?.trim().toLowerCase() || 'ask';
                const pitch = interaction.fields.getTextInputValue('zonePitch')?.trim().slice(0, 500) || '—';
                const needs = interaction.fields.getTextInputValue('zoneNeeds')?.trim().slice(0, 500) || '—';

                const sanitizedPolicy = rawPolicy
                        .normalize('NFD')
                        .replace(/\p{Diacritic}/gu, '')
                        .replace(/[\s_-]+/g, ' ')
                        .trim();

                const normalizedPolicyKey = (() => {
                        if (!sanitizedPolicy) return 'ask';
                        if (sanitizedPolicy.startsWith('open') || sanitizedPolicy.startsWith('ouver')) return 'open';
                        if (sanitizedPolicy.startsWith('clos') || sanitizedPolicy.startsWith('ferm')) return 'closed';
                        if (sanitizedPolicy.includes('demande') || sanitizedPolicy.startsWith('ask')) return 'ask';
                        return 'ask';
                })();

                const policyDisplay =
                        normalizedPolicyKey === 'open'
                                ? 'Ouvert'
                                : normalizedPolicyKey === 'closed'
                                ? 'Fermé'
                                : 'Sur demande';

                const requestsChannelId = await this.#getRequestsChannelId(interaction.guildId);
                const embed = new EmbedBuilder()
                        .setTitle('Nouvelle demande de zone')
                        .setDescription(pitch || '—')
                        .addFields(
                                { name: 'Nom proposé', value: name, inline: false },
                                { name: 'Politique souhaitée', value: policyDisplay, inline: false },
                                { name: 'Demandeur', value: `<@${interaction.user.id}> (${interaction.user.id})`, inline: false },
                                { name: 'Besoins / membres pressentis', value: needs || '—', inline: false }
                        )
                        .setTimestamp(new Date());

                if (requestsChannelId) {
                        try {
                                const channel = await interaction.client.channels.fetch(requestsChannelId);
                                await channel.send({ embeds: [embed] });
                        } catch (err) {
                                this.logger?.warn({ err, channelId: requestsChannelId }, 'Failed to deliver zone request');
                        }
                } else {
                        this.logger?.warn({ guildId: interaction.guildId }, 'Missing requests channel for zone request');
                }

                await interaction.reply({
                        content: '✅ Merci ! Ta demande a bien été transmise aux modérateurs.',
                        flags: MessageFlags.Ephemeral
                });
        }

        async createZone(guild, { name, ownerUserId, policy }) {
                const slug = this.#slugify(name);

                const createdChannels = [];
                const createdRoles = [];
                const conn = await this.db.getConnection();

                try {
                        await conn.beginTransaction();

                        const roleOwner = await guild.roles.create({
                                name: `O-${slug}`,
                                mentionable: false,
                                permissions: []
                        });
                        createdRoles.push(roleOwner);

                        const roleMember = await guild.roles.create({
                                name: `M-${slug}`,
                                mentionable: false,
                                permissions: []
                        });
                        createdRoles.push(roleMember);

                        const category = await guild.channels.create({
                                name: `z-${slug}`,
                                type: ChannelType.GuildCategory,
                                reason: 'Zone creation'
                        });
                        createdChannels.push(category);

                        const panel = await guild.channels.create({
                                name: 'panel',
                                type: ChannelType.GuildText,
                                parent: category.id,
                                reason: 'Zone creation'
                        });
                        createdChannels.push(panel);

                        const reception = await guild.channels.create({
                                name: 'reception',
                                type: ChannelType.GuildText,
                                parent: category.id,
                                reason: 'Zone creation'
                        });
                        createdChannels.push(reception);

                        const anon = await guild.channels.create({
                                name: 'chuchotement',
                                type: ChannelType.GuildText,
                                parent: category.id,
                                reason: 'Zone creation'
                        });
                        createdChannels.push(anon);

                        const general = await guild.channels.create({
                                name: 'general',
                                type: ChannelType.GuildText,
                                parent: category.id,
                                reason: 'Zone creation'
                        });
                        createdChannels.push(general);

                        const voice = await guild.channels.create({
                                name: 'vocal',
                                type: ChannelType.GuildVoice,
                                parent: category.id,
                                reason: 'Zone creation'
                        });
                        createdChannels.push(voice);

                        const botMember = guild.members.me || await guild.members.fetch(this.client.user.id).catch(() => null);
                        const botRole = botMember?.roles?.highest || null;
                        await applyZoneOverwrites(
                                category,
                                {
                                        everyoneRole: guild.roles.everyone,
                                        zoneMemberRole: roleMember,
                                        zoneOwnerRole: roleOwner
                                },
                                botRole,
                                { panel, reception, general, chuchotement: anon, voice }
                        );

                        const [res] = await conn.query(
                                `INSERT INTO zones (guild_id, name, slug, owner_user_id, category_id, text_panel_id, text_reception_id,
                                text_general_id, text_anon_id, voice_id, role_owner_id, role_member_id, role_muted_id, policy, created_at)
                                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
                                [
                                        guild.id,
                                        name,
                                        slug,
                                        ownerUserId,
                                        category.id,
                                        panel.id,
                                        reception.id,
                                        general.id,
                                        anon.id,
                                        voice.id,
                                        roleOwner.id,
                                        roleMember.id,
                                        null,
                                        policy
                                ]
                        );
                        const zoneId = res.insertId;

                        await conn.query(
                                'INSERT INTO anon_channels (zone_id, source_channel_id, webhook_id, webhook_token) VALUES (?, ?, ?, ?)',
                                [zoneId, anon.id, '', '']
                        );

                        await conn.commit();

                        const member = await guild.members.fetch(ownerUserId).catch(() => null);
                        if (member) await member.roles.add([roleOwner, roleMember]).catch((err) => {
                                this.logger?.warn({ err, userId: ownerUserId, zoneId }, 'Failed to assign zone roles to owner');
                        });

                        const embed = new EmbedBuilder()
                                .setTitle(`Panneau de la zone ${name}`)
                                .setDescription('Configure la politique, gère les membres, rôles et salons via le bot.')
                                .addFields(
                                        { name: 'Politique', value: policy, inline: true },
                                        { name: 'Owner', value: `<@${ownerUserId}>`, inline: true }
                                )
                                .setTimestamp();
                        await panel.send({ content: `<@${ownerUserId}>`, embeds: [embed] }).catch((err) => {
                                this.logger?.warn({ err, zoneId, channelId: panel.id }, 'Failed to send initial panel message');
                        });

                        if (this.panelService) {
                                await this.panelService
                                        .renderInitialPanel({
                                                guild,
                                                zone: {
                                                        id: zoneId,
                                                        name,
                                                        slug,
                                                        policy,
                                                        ownerUserId,
                                                        roleOwnerId: roleOwner.id,
                                                        roleMemberId: roleMember.id,
                                                        categoryId: category.id,
                                                        panelChannelId: panel.id,
                                                        receptionChannelId: reception.id,
                                                        generalChannelId: general.id,
                                                        chuchotementChannelId: anon.id,
                                                        voiceChannelId: voice.id
                                                },
                                                roles: { owner: roleOwner, member: roleMember },
                                                channels: { panel, reception, general, chuchotement: anon, voice, category }
                                        })
                                        .catch((err) => {
                                                this.logger?.warn({ err, zoneId }, 'Failed to render full panel');
                                        });
                                await this.panelService
                                        .removeReceptionWelcome({
                                                id: zoneId,
                                                guild_id: guild.id,
                                                text_reception_id: reception.id,
                                                text_panel_id: panel.id,
                                                role_owner_id: roleOwner.id,
                                                role_member_id: roleMember.id,
                                                name,
                                                policy,
                                                ask_join_mode: null,
                                                ask_approver_mode: null,
                                                profile_color: null
                                        })
                                        .catch((err) => {
                                                this.logger?.warn({ err, zoneId }, 'Failed to remove reception welcome message');
                                        });
                        }

                        this.#indexReception(reception.id);

                        return { zoneId, slug };
                } catch (err) {
                        await conn.rollback().catch((rollbackErr) => {
                                this.logger?.warn({ err: rollbackErr }, 'Failed to rollback zone creation transaction');
                        });

                        for (const channel of createdChannels) {
                                await channel.delete('Zone creation rollback').catch((deleteErr) => {
                                        if (deleteErr?.code === 10003) return; // Unknown channel
                                        this.logger?.warn({ err: deleteErr, channelId: channel?.id }, 'Failed to delete channel during rollback');
                                });
                        }
                        for (const role of createdRoles) {
                                await role.delete('Zone creation rollback').catch((deleteErr) => {
                                        if (deleteErr?.code === 10011) return; // Unknown role
                                        this.logger?.warn({ err: deleteErr, roleId: role?.id }, 'Failed to delete role during rollback');
                                });
                        }

                        throw err;
                } finally {
                        conn.release();
                }
        }

        async listZones(guildId) {
                const [rows] = await this.db.query(
                        `SELECT id, name, slug, owner_user_id, policy, created_at
                         FROM zones
                         WHERE guild_id = ?
                         ORDER BY created_at DESC, id DESC`,
                        [guildId]
                );
                return rows;
        }

        async #safeDeleteChannel(guild, channelId, reason) {
                if (!channelId) return;
                const channel = await guild.channels.fetch(channelId).catch(() => null);
                if (!channel) return;
                await channel.delete(reason).catch((err) => {
                        this.logger?.warn({ err, channelId }, 'Failed to delete zone channel');
                });
        }

        async #safeDeleteRole(guild, roleId, reason) {
                if (!roleId) return;
                const role = await guild.roles.fetch(roleId).catch(() => null);
                if (!role) return;
                await role.delete(reason).catch((err) => {
                        this.logger?.warn({ err, roleId }, 'Failed to delete zone role');
                });
        }

        async #safeQuery(sql, params) {
                try {
                        await this.db.query(sql, params);
                } catch (err) {
                        if (err?.code === 'ER_NO_SUCH_TABLE') return;
                        throw err;
                }
        }

        async #deleteZoneRecords(zoneId) {
                const queries = [
                        ['DELETE FROM panel_messages WHERE zone_id = ?', [zoneId]],
                        ['DELETE FROM panel_message_registry WHERE zone_id = ?', [zoneId]],
                        ['DELETE FROM anon_channels WHERE zone_id = ?', [zoneId]],
                        ['DELETE FROM anon_logs WHERE source_zone_id = ?', [zoneId]],
                        ['DELETE FROM zone_members WHERE zone_id = ?', [zoneId]],
                        ['DELETE FROM join_codes WHERE zone_id = ?', [zoneId]],
                        ['DELETE FROM join_requests WHERE zone_id = ?', [zoneId]],
                        ['DELETE FROM zone_activity WHERE zone_id = ?', [zoneId]],
                        ['DELETE FROM zone_roles WHERE zone_id = ?', [zoneId]],
                        ['DELETE FROM zone_channels WHERE zone_id = ?', [zoneId]],
                        ['DELETE FROM zone_invite_codes WHERE zone_id = ?', [zoneId]],
                        ['DELETE FROM zone_join_requests WHERE zone_id = ?', [zoneId]],
                        [
                                'DELETE FROM temp_group_members WHERE group_id IN (SELECT id FROM temp_groups WHERE zone_id = ?)',
                                [zoneId]
                        ],
                        ['DELETE FROM temp_groups WHERE zone_id = ?', [zoneId]],
                        ['DELETE FROM zones WHERE id = ?', [zoneId]]
                ];

                for (const [sql, params] of queries) {
                        await this.#safeQuery(sql, params);
                }
        }

        async deleteZone(guild, zoneId) {
                const [rows] = await this.db.query('SELECT * FROM zones WHERE id = ? AND guild_id = ?', [zoneId, guild.id]);
                const zone = rows?.[0];
                if (!zone) {
                        return { success: false, reason: '❌ **Zone introuvable**\n\nCette zone n\'existe plus ou tu n\'y as pas accès.' };
                }

                const reason = `Zone #${zoneId} deletion requested by owner.`;

                const fetchedChannels = await guild.channels.fetch().catch(() => null);
                const categoryId = zone.category_id;
                const processed = new Set();

                if (fetchedChannels) {
                        for (const channel of fetchedChannels.values()) {
                                if (!channel) continue;
                                if (channel.parentId && channel.parentId === categoryId) {
                                        processed.add(channel.id);
                                        await channel
                                                .delete(reason)
                                                .catch((err) => this.logger?.warn({ err, channelId: channel.id }, 'Failed to delete zone child channel'));
                                }
                        }
                }

                const additionalIds = [
                        zone.text_panel_id,
                        zone.text_reception_id,
                        zone.text_general_id,
                        zone.text_anon_id,
                        zone.voice_id
                ];

                for (const channelId of additionalIds) {
                        if (!channelId || processed.has(channelId)) continue;
                        await this.#safeDeleteChannel(guild, channelId, reason);
                }

                if (categoryId && !processed.has(categoryId)) {
                        const category = await guild.channels.fetch(categoryId).catch(() => null);
                        if (category) {
                                await category.delete(reason).catch((err) => {
                                        this.logger?.warn({ err, categoryId }, 'Failed to delete zone category');
                                });
                        }
                }

                await this.#safeDeleteRole(guild, zone.role_owner_id, reason);
                await this.#safeDeleteRole(guild, zone.role_member_id, reason);

                await this.#deleteZoneRecords(zoneId);

                this.logger?.info({ zoneId }, 'Zone deleted');

                this.#removeReception(zone.text_reception_id);

                return { success: true, zone };
        }

        async cleanupOrphans() {
                const [rows] = await this.db.query('SELECT id, guild_id, category_id FROM zones');
                for (const zone of rows) {
                        const guild = await this.client.guilds.fetch(zone.guild_id).catch(() => null);
                        if (!guild) {
                                await this.#deleteZoneRecords(zone.id);
                                this.logger?.warn({ zoneId: zone.id, guildId: zone.guild_id }, 'Cleaned zone for missing guild');
                                continue;
                        }

                        const category = await guild.channels.fetch(zone.category_id).catch(() => null);
                        if (!category) {
                                const res = await this.deleteZone(guild, zone.id);
                                if (!res.success) {
                                        await this.#deleteZoneRecords(zone.id);
                                }
                                this.logger?.warn({ zoneId: zone.id }, 'Cleaned orphan zone (missing category)');
                        }
                }
        }

        async getZoneBySlug(guildId, slug) {
                const [rows] = await this.db.query('SELECT * FROM zones WHERE guild_id = ? AND slug = ?', [guildId, slug]);
                return rows?.[0] || null;
        }

        async ensureZoneOwner(zoneId, userId, zone = null) {
                const zoneRow = zone || await this.#getZone(zoneId);
                if (!zoneRow) return false;
                if (this.#isOwnerOverride(userId)) return true;
                if (String(zoneRow.owner_user_id) === String(userId)) return true;
                const [rows] = await this.db.query(
                        'SELECT role FROM zone_members WHERE zone_id = ? AND user_id = ? LIMIT 1',
                        [zoneRow.id, userId]
                );
                return rows?.[0]?.role === 'owner';
        }

        async ensureZoneMember(zoneId, userId, zone = null) {
                const zoneRow = zone || await this.#getZone(zoneId);
                if (!zoneRow) return false;
                if (this.#isOwnerOverride(userId)) return true;
                if (String(zoneRow.owner_user_id) === String(userId)) return true;
                const [rows] = await this.db.query(
                        'SELECT 1 FROM zone_members WHERE zone_id = ? AND user_id = ? LIMIT 1',
                        [zoneRow.id, userId]
                );
                return Boolean(rows?.length);
        }

        async createChannel(zoneId, type, name) {
                const zone = await this.#getZone(zoneId);
                if (!zone) throw new Error('❌ Zone introuvable — Cette zone n\'existe plus ou tu n\'y as pas accès.');
                const guild = await this.#fetchGuild(zone);
                if (!guild) throw new Error('❌ Guilde introuvable — Le serveur Discord n\'est plus accessible.');

                const typeMap = {
                        text: ChannelType.GuildText,
                        voice: ChannelType.GuildVoice
                };
                const discordType = typeMap[type];
                if (!discordType) throw new Error('Type de canal invalide');

                const channel = await guild.channels.create({
                        name: name.slice(0, 90),
                        type: discordType,
                        parent: zone.category_id,
                        reason: `Zone #${zoneId} channel create`
                });

                const category = await this.#safeFetchChannel(guild, zone.category_id);
                if (category) {
                        const memberRole = await this.#safeFetchRole(guild, zone.role_member_id);
                        const ownerRole = await this.#safeFetchRole(guild, zone.role_owner_id);
                        if (memberRole && ownerRole) {
                                const botMember = guild.members.me || await guild.members.fetch(this.client.user.id).catch(() => null);
                                const botRole = botMember?.roles?.highest || null;
                                await applyZoneOverwrites(
                                        category,
                                        {
                                                everyoneRole: guild.roles.everyone,
                                                zoneMemberRole: memberRole,
                                                zoneOwnerRole: ownerRole
                                        },
                                        botRole,
                                        {
                                                panel: await this.#safeFetchChannel(guild, zone.text_panel_id),
                                                reception: await this.#safeFetchChannel(guild, zone.text_reception_id),
                                                general: await this.#safeFetchChannel(guild, zone.text_general_id),
                                                chuchotement: await this.#safeFetchChannel(guild, zone.text_anon_id),
                                                voice: await this.#safeFetchChannel(guild, zone.voice_id)
                                        }
                                ).catch((err) => {
                                        this.logger?.warn({ err, zoneId }, 'Failed to apply zone overwrites after channel creation');
                                });
                        } else {
                                this.logger?.warn({ zoneId: zone.id }, 'Skipping permission sync due to missing core roles');
                        }
                }

                await this.#refreshPanel(zoneId, ['channels']);
                return `<#${channel.id}>`;
        }

        async deleteChannel(channelId) {
                const channel = await this.client.channels.fetch(channelId).catch(() => null);
                if (!channel || !channel.guild) throw new Error('❌ Canal introuvable — Ce canal a été supprimé ou n\'existe pas.');
                const zone = await this.#getZoneByCategory(channel.parentId);
                if (!zone) throw new Error('⚠️ Ce canal ne fait pas partie d\'une zone gérée — Tu ne peux effectuer cette action que sur les canaux de zones.');
                await channel.delete('Zone channel delete').catch((err) => {
                        if (err?.code === 10003) return; // Unknown channel
                        this.logger?.warn({ err, channelId }, 'Failed to delete zone channel');
                });
                await this.#refreshPanel(zone.id, ['channels']);
        }

        async renameChannel(channelId, name) {
                const channel = await this.client.channels.fetch(channelId).catch(() => null);
                if (!channel || !channel.guild) throw new Error('❌ Canal introuvable — Ce canal a été supprimé ou n\'existe pas.');
                const zone = await this.#getZoneByCategory(channel.parentId);
                if (!zone) throw new Error('⚠️ Ce canal ne fait pas partie d\'une zone gérée — Tu ne peux effectuer cette action que sur les canaux de zones.');
                await channel.setName(name.slice(0, 90), 'Zone channel rename').catch((err) => {
                        this.logger?.warn({ err, channelId }, 'Failed to rename zone channel');
                });
                await this.#refreshPanel(zone.id, ['channels']);
        }

        async createRole(zoneId, name) {
                const zone = await this.#getZone(zoneId);
                if (!zone) throw new Error('❌ Zone introuvable — Cette zone n\'existe plus ou tu n\'y as pas accès.');
                const guild = await this.#fetchGuild(zone);
                if (!guild) throw new Error('❌ Guilde introuvable — Le serveur Discord n\'est plus accessible.');

                const role = await guild.roles.create({
                        name: name.slice(0, 100),
                        permissions: [],
                        mentionable: false,
                        reason: `Zone #${zoneId} role create`
                });

                await this.db.query(
                        'INSERT INTO zone_roles (zone_id, role_id, name) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)',
                        [zone.id, role.id, name.slice(0, 100)]
                );
                await this.#refreshPanel(zone.id, ['roles']);
                return `<@&${role.id}>`;
        }

        async deleteRole(zoneId, roleId) {
                const zone = await this.#getZone(zoneId);
                if (!zone) throw new Error('❌ Zone introuvable — Cette zone n\'existe plus ou tu n\'y as pas accès.');
                const guild = await this.#fetchGuild(zone);
                if (!guild) throw new Error('❌ Guilde introuvable — Le serveur Discord n\'est plus accessible.');
                const role = await guild.roles.fetch(roleId).catch(() => null);
                if (role) await role.delete('Zone role delete').catch((err) => {
                        if (err?.code === 10011) return; // Unknown role
                        this.logger?.warn({ err, roleId, zoneId }, 'Failed to delete zone role');
                });
                await this.db.query('DELETE FROM zone_roles WHERE zone_id = ? AND role_id = ?', [zone.id, roleId]);
                await this.db.query('DELETE FROM zone_member_roles WHERE zone_id = ? AND role_id = ?', [zone.id, roleId]);
                await this.#refreshPanel(zone.id, ['roles']);
        }

        async renameRole(zoneId, roleId, name) {
                const zone = await this.#getZone(zoneId);
                if (!zone) throw new Error('❌ Zone introuvable — Cette zone n\'existe plus ou tu n\'y as pas accès.');
                const guild = await this.#fetchGuild(zone);
                if (!guild) throw new Error('❌ Guilde introuvable — Le serveur Discord n\'est plus accessible.');
                const role = await guild.roles.fetch(roleId).catch(() => null);
                if (!role) throw new Error('❌ Rôle introuvable — Ce rôle a été supprimé ou n\'existe pas.');
                await role.setName(name.slice(0, 100), 'Zone role rename').catch((err) => {
                        this.logger?.warn({ err, roleId, zoneId }, 'Failed to rename zone role');
                });
                await this.db.query('UPDATE zone_roles SET name = ? WHERE zone_id = ? AND role_id = ?', [name.slice(0, 100), zone.id, roleId]);
                await this.#refreshPanel(zone.id, ['roles']);
        }

        async addMember(zoneId, userId) {
                const zone = await this.#getZone(zoneId);
                if (!zone) throw new Error('❌ Zone introuvable — Cette zone n\'existe plus ou tu n\'y as pas accès.');
                const guild = await this.#fetchGuild(zone);
                if (!guild) throw new Error('❌ Guilde introuvable — Le serveur Discord n\'est plus accessible.');
                const member = await guild.members.fetch(userId).catch(() => null);
                if (!member) throw new Error('❌ Membre introuvable — Ce membre a quitté le serveur ou n\'existe pas.');
                const roleMember = await this.#safeFetchRole(guild, zone.role_member_id);
                if (!roleMember) throw new Error('⚠️ Rôle membre manquant — Le rôle de membre pour cette zone n\'existe plus. Contacte un administrateur.');
                await member.roles.add(roleMember).catch((err) => {
                        this.logger?.warn({ err, userId, zoneId }, 'Failed to add zone member role');
                });
                await this.db.query(
                        'INSERT INTO zone_members (zone_id, user_id, role) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE role = VALUES(role)',
                        [zone.id, userId, 'member']
                );
                await this.#refreshPanel(zone.id, ['members']);
        }

        async resolveZoneContextForChannel(channel) {
                if (!channel || !channel.guild) return null;

                const categoryId = channel.parentId || (channel.type === ChannelType.GuildCategory ? channel.id : null);
                if (!categoryId) return null;

                const zone = await this.#getZoneByCategory(categoryId);
                if (!zone) return null;

                const kind =
                        channel.id === zone.text_panel_id
                                ? 'panel'
                                : channel.id === zone.text_reception_id
                                ? 'reception'
                                : channel.id === zone.text_general_id
                                ? 'general'
                                : channel.id === zone.text_anon_id
                                ? 'anon'
                                : channel.id === zone.voice_id
                                ? 'voice'
                                : 'other';

                return { zone, kind };
        }

        async removeMember(zoneId, userId) {
                const zone = await this.#getZone(zoneId);
                if (!zone) throw new Error('❌ Zone introuvable — Cette zone n\'existe plus ou tu n\'y as pas accès.');
                const guild = await this.#fetchGuild(zone);
                if (!guild) throw new Error('❌ Guilde introuvable — Le serveur Discord n\'est plus accessible.');
                const member = await guild.members.fetch(userId).catch(() => null);
                const roleMember = await this.#safeFetchRole(guild, zone.role_member_id);
                const roleOwner = await this.#safeFetchRole(guild, zone.role_owner_id);
                if (member) {
                        if (roleMember) await member.roles.remove(roleMember).catch((err) => {
                                this.logger?.warn({ err, userId, zoneId }, 'Failed to remove zone member role');
                        });
                        if (roleOwner) await member.roles.remove(roleOwner).catch((err) => {
                                this.logger?.warn({ err, userId, zoneId }, 'Failed to remove zone owner role');
                        });
                }
                await this.db.query('DELETE FROM zone_members WHERE zone_id = ? AND user_id = ?', [zone.id, userId]);
                await this.db.query('DELETE FROM zone_member_roles WHERE zone_id = ? AND user_id = ?', [zone.id, userId]);
                await this.#refreshPanel(zone.id, ['members']);
        }

        async generateJoinCode(zoneId, userId, ttlMinutes) {
                const zone = await this.#getZone(zoneId);
                if (!zone) throw new Error('❌ Zone introuvable — Cette zone n\'existe plus ou tu n\'y as pas accès.');
                const code = crypto.randomBytes(4).toString('hex').toUpperCase();
                const expiresAt = new Date(Date.now() + Math.max(5, ttlMinutes) * 60 * 1000);
                await this.db.query(
                        'INSERT INTO join_codes (zone_id, issued_to_user_id, code, expires_at, used) VALUES (?, ?, ?, ?, 0)',
                        [zone.id, userId, code, expiresAt]
                );
                return { code, expiresAt };
        }

        async #warmReceptionCache() {
                const [rows] = await this.db.query(
                        'SELECT text_reception_id FROM zones WHERE text_reception_id IS NOT NULL'
                );
                for (const entry of rows || []) {
                        this.#indexReception(entry.text_reception_id);
                }
        }

        #indexReception(channelId) {
                if (!channelId) return;
                this._receptionSet.add(String(channelId));
        }

        #removeReception(channelId) {
                if (!channelId) return;
                this._receptionSet.delete(String(channelId));
        }
}

module.exports = { ZoneService };
