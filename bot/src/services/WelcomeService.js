const {
ActionRowBuilder,
ButtonBuilder,
ButtonStyle,
        EmbedBuilder,
        MessageFlags,
ModalBuilder,
TextInputBuilder,
TextInputStyle
} = require('discord.js');
const { parseId, makeId } = require('../utils/ids');
const { ensureFallback } = require('../utils/channels');

class WelcomeService {
        constructor(client, db, logger, services = {}) {
                this.client = client;
                this.db = db;
                this.logger = logger;
                this.services = services;
                this.pageSize = 3;
        }

        async sendWizardToUser(target, options = {}) {
                const payload = this.#buildWizardPayload();
                if (options.mentionId) {
                        payload.content = `<@${options.mentionId}>`;
                }

                if (typeof target?.send === 'function') {
                        return target.send(payload);
                }

                if (target?.user && typeof target.user.send === 'function') {
                        return target.user.send(payload);
                }

                throw new Error('Invalid welcome target');
        }

async handleButton(interaction) {
const id = interaction.customId || '';
const parsed = parseId(id);
if (!parsed || parsed.namespace !== 'welcome') return false;

const action = parsed.parts[0];
if (action === 'browse' && parsed.parts.length === 1) {
return this.#handleBrowse(interaction, 0, { update: false });
}

if (action === 'browse' && ['prev', 'next'].includes(parsed.parts[1])) {
const page = Number(parsed.parts.at(-1));
const targetPage = Number.isFinite(page) ? page : 0;
return this.#handleBrowse(interaction, targetPage, { update: true });
}

if (action === 'zone' && parsed.parts[1] === 'join') {
const zoneId = Number(parsed.parts[2]);
return this.#handleZoneJoin(interaction, zoneId);
}

if (action === 'joincode') {
return this.#showJoinCodeModal(interaction);
}

if (action === 'request') {
return this.#showZoneRequestModal(interaction);
}

return false;
}

async handleModal(interaction) {
const id = interaction.customId || '';
const parsed = parseId(id);
if (!parsed || parsed.namespace !== 'welcome') return false;

if (parsed.parts[0] === 'joincode' && parsed.parts[1] === 'modal') {
return this.#handleJoinCodeModal(interaction);
}

if (parsed.parts[0] === 'request' && parsed.parts[1] === 'modal') {
return this.#handleZoneRequestModal(interaction);
}

return false;
}

        #buildWizardPayload() {
                const intro = new EmbedBuilder()
                        .setTitle('Bienvenue !')
                        .setColor(0x5865f2)
                        .setDescription(
                                [
                                        '• Les zones sont des espaces isolés : seuls leurs membres voient les discussions.',
                                        '• Pas de liste globale des membres, tu restes discret tant que tu n’entres pas.',
                                        '• Pour rejoindre : découvre les zones ouvertes, demande l’accès ou saisis un code reçu.',
                                        '• Pour créer ta zone, utilise « Demander une zone » et remplis la demande.',
                                        '• Reste respectueux : pas de doxx, pas de harcèlement, respecte les règles du serveur.'
                                ].join('\n')
                        );

                const assistant = new EmbedBuilder()
                        .setTitle('Assistant de zones')
                        .setDescription('Choisis une option ci-dessous pour commencer.')
                        .setColor(0x5865f2);

const row = new ActionRowBuilder().addComponents(
new ButtonBuilder().setCustomId(makeId('welcome', 'browse')).setLabel('Découvrir les zones').setStyle(ButtonStyle.Primary),
new ButtonBuilder()
.setCustomId(makeId('welcome', 'joincode'))
.setLabel('Rejoindre via un code')
.setStyle(ButtonStyle.Secondary),
new ButtonBuilder().setCustomId(makeId('welcome', 'request')).setLabel('Demander une zone').setStyle(ButtonStyle.Secondary)
);

                return { embeds: [intro, assistant], components: [row] };
        }

        async #handleBrowse(interaction, page, { update }) {
                try {
                        const payload = await this.#buildBrowsePayload(page);

                        if (update) {
                                return interaction.update(payload);
                        }

                        const response = { ...payload };
                        const flags = this.#resolveEphemeralFlag(interaction);
                        if (flags) {
                                response.flags = flags;
                        }
                        return interaction.reply(response);
                } catch (err) {
                        this.logger?.warn({ err, userId: interaction.user.id }, 'Failed to display zone browser');
                        const message = {
                                content: 'Impossible de charger les zones actuellement.'
                        };
                        const fallbackFlags = this.#resolveEphemeralFlag(interaction);
                        if (fallbackFlags) {
                                message.flags = fallbackFlags;
                        }
                        if (interaction.deferred || interaction.replied || update) {
                                return interaction.followUp(message).catch(() => {});
                        }
                        return interaction.reply(message).catch(() => {});
                }
        }

        async #buildBrowsePayload(page) {
                const policyService = this.services.policy;
                if (!policyService?.listDiscoverableZones) {
                        throw new Error('Policy service indisponible');
                }

                const desiredPage = Math.max(0, Number.isFinite(page) ? page : 0);
                const initial = await policyService.listDiscoverableZones({
                        limit: this.pageSize,
                        offset: desiredPage * this.pageSize
                });

                const total = initial.total || 0;
                const totalPages = Math.max(1, Math.ceil(total / this.pageSize));
                const safePage = Math.min(desiredPage, totalPages - 1);

                let zones = initial.zones || [];
                if (safePage !== desiredPage) {
                        const fallback = await policyService.listDiscoverableZones({
                                limit: this.pageSize,
                                offset: safePage * this.pageSize
                        });
                        zones = fallback.zones || [];
                }

                const embeds = [];
                const components = [];

                if (!zones.length) {
                        embeds.push(
                                new EmbedBuilder()
                                        .setTitle('Aucune zone ouverte')
                                        .setDescription('Reviens plus tard, de nouvelles zones arriveront bientôt !')
                                        .setColor(0x5865f2)
                        );
                } else {
                        for (const zone of zones) {
                                const activity = await this.#fetchActivitySummary(zone.id);
                                const memberCount = await this.#fetchZoneMemberCount(zone.id);
                                const embed = this.#buildZoneEmbed(zone, activity, memberCount);

                                const activityService = this.services?.activity;
                                if (activityService?.getZoneActivityScore && activityService?.buildProgressBar) {
                                        try {
                                                const score = await activityService.getZoneActivityScore(zone.id, 14);
                                                const bar = activityService.buildProgressBar(score);
                                                const pct = (score * 100) | 0;
                                                embed.addFields({ name: 'Activité', value: `${bar}  ${pct}%`, inline: false });
                                        } catch (err) {
                                                this.logger?.warn({ err, zoneId: zone.id }, 'Failed to compute activity score for browse card');
                                        }
                                }

                                embeds.push(embed);
                                components.push(this.#buildZoneActionRow(zone));
                        }
                }

                const paginationRow = this.#buildPaginationRow(safePage, totalPages);
                if (paginationRow) components.push(paginationRow);

                return { embeds, components };
        }

        #buildZoneEmbed(zone, activity, memberCount) {
                const embed = new EmbedBuilder()
                        .setTitle(zone.profile_title || zone.name)
                        .setColor(this.#parseColor(zone.profile_color))
                        .setDescription(this.#truncate(zone.profile_desc || 'Pas encore de description.', 300));

                const tags = Array.isArray(zone.profile_tags) ? zone.profile_tags.slice(0, 5) : [];
                if (tags.length) {
                        embed.addFields({ name: 'Tags', value: tags.map((tag) => `#${tag}`).join(' '), inline: false });
                }

                embed.addFields({
                        name: 'Activité (14 jours)',
                        value: `💬 ${activity.msgs} msgs • 🔊 ${activity.voice} min voix`,
                        inline: false
                });

                embed.addFields({ name: 'Membres', value: `${memberCount}`, inline: true });

                if (zone.policy === 'ask') {
                        embed.setFooter({ text: 'Admission sur demande' });
                }

                return embed;
        }

        #buildZoneActionRow(zone) {
                const joinLabel = zone.policy === 'open' ? 'Rejoindre' : 'Demander à rejoindre';
                return new ActionRowBuilder().addComponents(
                        new ButtonBuilder()
                                .setCustomId(`welcome:zone:join:${zone.id}`)
                                .setLabel(joinLabel)
                                .setStyle(ButtonStyle.Success)
                );
        }

        #buildPaginationRow(page, totalPages) {
                if (totalPages <= 1) return null;
                const prevTarget = Math.max(0, page - 1);
                const nextTarget = Math.min(totalPages - 1, page + 1);

                return new ActionRowBuilder().addComponents(
                        new ButtonBuilder()
                                .setCustomId(`welcome:browse:prev:${prevTarget}`)
                                .setLabel('◀︎ Précédent')
                                .setStyle(ButtonStyle.Secondary)
                                .setDisabled(page === 0),
                        new ButtonBuilder()
                                .setCustomId('welcome:browse:status')
                                .setLabel(`Page ${page + 1}/${totalPages}`)
                                .setStyle(ButtonStyle.Secondary)
                                .setDisabled(true),
                        new ButtonBuilder()
                                .setCustomId(`welcome:browse:next:${nextTarget}`)
                                .setLabel('Suivant ▶︎')
                                .setStyle(ButtonStyle.Secondary)
                                .setDisabled(page >= totalPages - 1)
                );
        }

        async #handleZoneJoin(interaction, zoneId) {
                if (!zoneId) {
                        return this.#sendReply(interaction, { content: 'Zone invalide.' });
                }

                try {
                        const policyService = this.services.policy;
                        const zone = await policyService.getZone(zoneId);
                        if (!zone) {
                                return this.#sendReply(interaction, { content: 'Zone introuvable.' });
                        }

                        if (await policyService.isUserMember(zone.id, interaction.user.id)) {
                                return this.#sendReply(interaction, { content: 'Tu fais déjà partie de cette zone.' });
                        }

                        if (zone.policy === 'open') {
                                await policyService.grantMembership(zone.id, interaction.user.id);
                                return this.#sendReply(interaction, {
                                        content: `Bienvenue dans **${zone.name}** ! Tu as maintenant accès aux canaux.`
                                });
                        }

                        if (zone.policy === 'ask') {
                                const joinMode = zone.ask_join_mode || 'request';
                                if (!['request', 'both'].includes(joinMode)) {
                                        return this.#sendReply(interaction, {
                                                content: 'Cette zone nécessite un code. Utilise le bouton « Rejoindre via un code ». '
                                        });
                                }

                                const result = await policyService.createJoinRequest(zone.id, interaction.user.id, {
                                        note: null
                                });

                                if (result.status === 'already-member') {
                                        return this.#sendReply(interaction, { content: 'Tu fais déjà partie de cette zone.' });
                                }

                                if (result.status === 'already-requested') {
                                        return this.#sendReply(interaction, {
                                                content: 'Ta demande est déjà en cours de traitement.'
                                        });
                                }

                                const guild = await this.client.guilds.fetch(zone.guild_id);
                                const applicant = await guild.members.fetch(interaction.user.id).catch(() => null);
                                await policyService.postJoinRequestCard(zone, result.request, applicant, {
                                        source: 'Assistant de bienvenue'
                                });

                                await this.#sendReply(interaction, {
                                        content: '✅ Ta demande a été envoyée aux responsables de la zone.'
                                });

                                await this.#notifyUser(interaction.user.id, {
                                        content: `Ta demande pour **${zone.name}** a bien été transmise. Tu seras notifié(e) dès qu’elle sera traitée.`
                                });

                                return true;
                        }

                        return this.#sendReply(interaction, { content: 'La zone n’est pas disponible pour le moment.' });
                } catch (err) {
                        this.logger?.warn({ err, zoneId, userId: interaction.user.id }, 'Failed to process zone join');
                        return this.#sendReply(interaction, {
                                content: 'Impossible de rejoindre la zone pour le moment. Réessaie plus tard.'
                        });
                }
        }

        async #showJoinCodeModal(interaction) {
                const modal = new ModalBuilder().setCustomId('welcome:joincode:modal').setTitle('Rejoindre une zone avec un code');

                const codeInput = new TextInputBuilder()
                        .setCustomId('welcomeJoinCodeInput')
                        .setLabel('Code d’invitation')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true)
                        .setMaxLength(6)
                        .setMinLength(6)
                        .setPlaceholder('ABC123');

                modal.addComponents(new ActionRowBuilder().addComponents(codeInput));

                return interaction.showModal(modal);
        }

        async #showZoneRequestModal(interaction) {
                const modal = new ModalBuilder().setCustomId('welcome:request:modal').setTitle('Demander une nouvelle zone');

                modal.addComponents(
                        new ActionRowBuilder().addComponents(
                                new TextInputBuilder()
                                        .setCustomId('welcomeRequestName')
                                        .setLabel('Nom de la zone')
                                        .setStyle(TextInputStyle.Short)
                                        .setRequired(true)
                                        .setMaxLength(64)
                        ),
                        new ActionRowBuilder().addComponents(
                                new TextInputBuilder()
                                        .setCustomId('welcomeRequestPitch')
                                        .setLabel('Description / objectif')
                                        .setStyle(TextInputStyle.Paragraph)
                                        .setRequired(true)
                                        .setMaxLength(500)
                        ),
                        new ActionRowBuilder().addComponents(
                                new TextInputBuilder()
                                        .setCustomId('welcomeRequestTags')
                                        .setLabel('Tags (facultatif)')
                                        .setStyle(TextInputStyle.Short)
                                        .setRequired(false)
                                        .setMaxLength(120)
                        )
                );

                return interaction.showModal(modal);
        }

        async #handleJoinCodeModal(interaction) {
                const code = interaction.fields.getTextInputValue('welcomeJoinCodeInput')?.trim().toUpperCase();

                try {
                        const result = await this.services.policy.redeemInviteCode(code, interaction.user.id);
                        if (result.status === 'already-member') {
                                return this.#sendReply(interaction, {
                                        content: 'Tu es déjà membre de cette zone — aucun code nécessaire.'
                                });
                        }

                        await this.#sendReply(interaction, {
                                content: `✅ Bienvenue dans **${result.zone.name}** !`
                        });

                        await this.#notifyUser(interaction.user.id, {
                                content: `Ton code a été validé et tu rejoins **${result.zone.name}**.`
                        });

                        return true;
                } catch (err) {
                        this.logger?.warn({ err, code, userId: interaction.user.id }, 'Invite code redemption failed');
                        return this.#sendReply(interaction, {
                                content: err?.message ? `❌ ${err.message}` : 'Code invalide ou expiré.'
                        });
                }
        }

        async #handleZoneRequestModal(interaction) {
                const name = interaction.fields.getTextInputValue('welcomeRequestName')?.trim().slice(0, 64) || 'Sans nom';
                const pitch = interaction.fields.getTextInputValue('welcomeRequestPitch')?.trim().slice(0, 500) || '—';
                const tags = interaction.fields
                        .getTextInputValue('welcomeRequestTags')
                        ?.split(',')
                        .map((entry) => entry.trim())
                        .filter((entry) => entry.length)
                        .slice(0, 8);

                const embed = new EmbedBuilder()
                        .setTitle('Nouvelle demande de zone')
                        .setDescription(pitch)
                        .addFields(
                                { name: 'Proposée par', value: `<@${interaction.user.id}> (${interaction.user.id})`, inline: false },
                                { name: 'Nom suggéré', value: name, inline: false },
                                { name: 'Tags', value: tags?.length ? tags.join(', ') : '—', inline: false }
                        )
                        .setTimestamp(new Date())
                        .setColor(0x5865f2);

let delivered = false;
const ownerId = this.client?.context?.config?.ownerUserId || process.env.OWNER_ID || process.env.OWNER_USER_ID;
if (ownerId) {
try {
const ownerUser = await this.client.users.fetch(ownerId);
await ownerUser.send({ embeds: [embed] });
delivered = true;
} catch (err) {
this.logger?.warn({ err, ownerId }, 'Failed to DM owner with zone request');
}
}

if (!delivered) {
this.logger?.info({ name, userId: interaction.user.id }, 'Zone request could not be delivered directly');
try {
const guild = await this.client.guilds.fetch(interaction.guildId);
const fallback = await ensureFallback(guild, 'requests');
if (fallback) {
await fallback
.send({ content: ownerId ? `<@${ownerId}>` : undefined, embeds: [embed] })
.catch((err) => this.logger?.warn({ err }, 'Failed to send zone request to fallback'));
if (!delivered) delivered = true;
}
} catch (err) {
this.logger?.warn({ err, guildId: interaction.guildId }, 'Failed to route zone request fallback');
}
}

                return this.#sendReply(interaction, {
                        content: 'Merci ! Ta demande a été transmise à l’équipe.'
                });
        }

        #buildZoneDetailsEmbed(zone, activity, memberCount) {
                const embed = this.#buildZoneEmbed(zone, activity, memberCount);
                embed.setDescription(this.#truncate(zone.profile_desc || 'Pas encore de description.', 1000));
                embed.addFields({ name: 'Politique', value: zone.policy === 'open' ? 'Ouverte' : 'Sur demande', inline: true });
                return embed;
        }

        async #fetchActivitySummary(zoneId) {
                try {
                        const [rows] = await this.db.query(
                                `SELECT COALESCE(SUM(msgs),0) AS msgs, COALESCE(SUM(reacts),0) AS reacts, COALESCE(SUM(voice_minutes),0) AS voice
                                FROM zone_activity
                                WHERE zone_id = ? AND day >= DATE_SUB(CURRENT_DATE(), INTERVAL 14 DAY)`,
                                [zoneId]
                        );
                        const row = rows?.[0] || {};
                        return {
                                msgs: Number(row.msgs) || 0,
                                reacts: Number(row.reacts) || 0,
                                voice: Number(row.voice) || 0
                        };
                } catch (err) {
                        this.logger?.warn({ err, zoneId }, 'Failed to fetch activity summary');
                        return { msgs: 0, reacts: 0, voice: 0 };
                }
        }

        async #fetchZoneMemberCount(zoneId) {
                try {
                        const [rows] = await this.db.query('SELECT COUNT(*) AS total FROM zone_members WHERE zone_id = ?', [zoneId]);
                        return Number(rows?.[0]?.total) || 0;
                } catch (err) {
                        this.logger?.warn({ err, zoneId }, 'Failed to fetch zone member count');
                        return 0;
                }
        }

        async #sendReply(interaction, payload) {
                const response = { ...payload };
                const flags = this.#resolveEphemeralFlag(interaction);
                if (flags) {
                        response.flags = flags;
                }

                if (interaction.deferred || interaction.replied) {
                        return interaction.followUp(response).catch(() => {});
                }

                return interaction.reply(response).catch(() => {});
        }

        #resolveEphemeralFlag(interaction) {
                if (interaction?.forceWelcomeEphemeral) return MessageFlags.Ephemeral;
                if (interaction?.inGuild?.()) return MessageFlags.Ephemeral;
                return null;
        }

        async #notifyUser(userId, payload) {
                if (!payload) return;
                try {
                        const user = await this.client.users.fetch(userId);
                        await user.send(payload).catch(() => {});
                } catch {}
        }

        async closeOnboardingChannelForUser(guildId, userId) {
                try {
                        const guild = await this.client.guilds.fetch(guildId);
                        const chans = await guild.channels.fetch();
                        for (const ch of chans.values()) {
                                if (ch?.type === 0 && ch?.parent?.name?.toLowerCase() === 'onboarding') {
                                        const topic = (ch.topic || '').toLowerCase();
                                        if (topic.includes(`onboarding:user:${userId}`)) {
                                                await ch.delete('User joined a zone — onboarding done').catch(() => {});
                                        }
                                }
                        }
                } catch (err) {
                        this.logger?.warn({ err, guildId, userId }, 'Failed to cleanup onboarding channel');
                }
        }

        #parseColor(color) {
                if (typeof color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(color)) {
                        return 0x5865f2;
                }
                return parseInt(color.replace('#', ''), 16);
        }

        #truncate(text, limit) {
                const value = String(text || '');
                if (value.length <= limit) return value;
                return `${value.slice(0, limit - 1)}…`;
        }
}

module.exports = { WelcomeService };
