const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

// Maps each setting key to its display label and description
const SETUP_STEPS = [
	{
		key: 'anon_admin_channel_id',
		configId: 'setup:configure:anon',
		label: 'Logs anonymes',
		description: 'Salon staff où le bot enregistre chaque message anonyme avec l\'identité réelle de son auteur.'
	},
	{
		key: 'requests_channel_id',
		configId: 'setup:configure:requests',
		label: 'Demandes de zones',
		description: 'Salon où le bot poste les demandes de création de zones soumises par les membres.'
	},
	{
		key: 'events_admin_channel_id',
		configId: 'setup:configure:events',
		label: 'Tableau des événements',
		description: 'Salon staff où le bot maintient automatiquement un tableau de bord des événements actifs.'
	},
	{
		key: 'journal_channel_id',
		configId: 'setup:configure:journal',
		label: 'Journal du serveur',
		description: 'Salon où le bot consigne les actions importantes : arrivées, départs, modifications de zones, actions admin.'
	}
];

/**
 * Returns the static explanation message payloads to send once on guild join.
 * These messages are never edited — they serve as a permanent reference.
 * @returns {Array<{ embeds: EmbedBuilder[] }>}
 */
function buildExplanationPayloads() {
	// ── Message 1 — Présentation générale ──────────────────────────────────────
	const embedPresentation = new EmbedBuilder()
		.setTitle('🌐 Bienvenue — SelfWorld')
		.setColor(0x5865f2)
		.setDescription(
			'Ce salon est réservé à l\'administration du serveur. ' +
			'Il peut être **archivé ou supprimé** une fois la configuration terminée.\n\u200b'
		)
		.addFields(
			{
				name: '📖 Qu\'est-ce que SelfWorld ?',
				value:
					'SelfWorld organise votre serveur autour d\'un concept de **zones** — des espaces ' +
					'privés et autonomes. Chaque zone possède ses propres salons, ses propres membres, et ' +
					'sa propre politique d\'accès.\n' +
					'Les membres **ne voient que les zones dont ils font partie**. ' +
					'Le reste du serveur leur est invisible.',
				inline: false
			},
			{
				name: '⚙️ Comment ça marche ?',
				value:
					'• Le bot crée, gère et synchronise **automatiquement** les salons, catégories, rôles et permissions de chaque zone — vous n\'avez rien à toucher manuellement.\n' +
					'• Un membre peut **découvrir** les zones ouvertes, **demander de créer** une zone privée, ou en rejoindre une via un **code d\'invitation**.\n' +
					'• Chaque propriétaire de zone gère son espace via un **panel interactif** : membres, rôles, salons, politique d\'accès (ouvert / sur demande / fermé).\n' +
					'• Le staff dispose de ses propres outils : annonces, événements planifiés, logs, tableau de bord.',
				inline: false
			}
		);

	// ── Message 2 — Points critiques à respecter ───────────────────────────────
	const embedCritique = new EmbedBuilder()
		.setTitle('⚠️ Règles critiques — À lire avant tout')
		.setColor(0xed4245)
		.addFields(
			{
				name: '❌ Ne créez jamais de salons, catégories ou rôles manuellement',
				value:
					'Le bot maintient une **architecture interne précise** pour chaque zone. ' +
					'Si vous créez ou supprimez des éléments manuellement :\n' +
					'→ La synchronisation interne sera cassée\n' +
					'→ Les zones peuvent devenir inaccessibles à leurs membres\n' +
					'→ Les permissions risquent d\'entrer en conflit\n' +
					'→ Le bot peut perdre la référence des salons qu\'il gère\n\n' +
					'**Utilisez uniquement les commandes et panels fournis par le bot** pour créer, modifier ou supprimer des zones et des salons.',
				inline: false
			},
			{
				name: '✅ Le système d\'anonymat est déjà actif',
				value:
					'Le bot intègre nativement un système de **messages anonymes**. ' +
					'Les membres peuvent envoyer un message de façon anonyme dans un salon public dédié — ' +
					'leur identité n\'est pas visible par les autres.\n\n' +
					'En revanche, **vous et votre staff voyez qui a envoyé quoi** grâce au salon de logs anonymes ' +
					'que vous allez configurer ci-dessous. Cela permet de modérer sans compromettre l\'anonymat.\n\n' +
					'> ⚠️ Le salon de logs anonymes doit rester **strictement privé** (visible uniquement par les admins). ' +
					'Si ce salon devenait public, tout le système d\'anonymat serait compromis.',
				inline: false
			},
			{
				name: '🤖 Ne touchez pas aux messages du bot',
				value:
					'Certains salons contiendront des **messages gérés automatiquement** par le bot ' +
					'(tableau de bord des événements, panels de zones, etc.). ' +
					'Supprimer ces messages forcera le bot à les recréer, mais peut provoquer des doublons ou des désynchronisations. ' +
					'Laissez le bot gérer ses propres messages.',
				inline: false
			}
		);

	// ── Message 3 — Préparer les salons ────────────────────────────────────────
	const embedPreparation = new EmbedBuilder()
		.setTitle('📋 Que préparer avant de configurer ?')
		.setColor(0xfee75c)
		.setDescription(
			'Vous avez besoin de **4 salons staff** sur votre serveur, visibles uniquement par vous et votre équipe.\n' +
			'Créez-les maintenant si ce n\'est pas encore fait, puis revenez configurer chacun ci-dessous.\n\u200b'
		)
		.addFields(
			{
				name: '1️⃣ Salon de logs anonymes',
				value:
					'**Rôle :** Reçoit en temps réel l\'identité réelle de chaque auteur de message anonyme.\n' +
					'**Accès :** Admins uniquement — ne jamais le rendre visible aux membres.\n' +
					'**Exemple de nom :** `#admin-logs-anon` ou `#staff-anonymat`',
				inline: false
			},
			{
				name: '2️⃣ Salon des demandes de zones',
				value:
					'**Rôle :** Le bot y poste une carte pour chaque demande de création de zone soumise par un membre. ' +
					'Le staff peut accepter ou refuser directement depuis ce salon via des boutons.\n' +
					'**Accès :** Admins ou staff de modération.\n' +
					'**Exemple de nom :** `#admin-demandes` ou `#staff-zones`',
				inline: false
			},
			{
				name: '3️⃣ Salon du tableau des événements',
				value:
					'**Rôle :** Le bot y maintient automatiquement un message vivant listant tous les événements actifs du serveur. ' +
					'Ne supprimez pas ce message — le bot le gère lui-même.\n' +
					'**Accès :** Staff uniquement, ou semi-public selon votre organisation.\n' +
					'**Exemple de nom :** `#admin-events` ou `#tableau-evenements`',
				inline: false
			},
			{
				name: '4️⃣ Salon journal du serveur',
				value:
					'**Rôle :** Le bot y consigne les actions importantes : arrivées et départs de membres, ' +
					'création/suppression de zones, changements de permissions, actions administratives.\n' +
					'**Accès :** Staff uniquement — utile pour l\'audit et la modération.\n' +
					'**Exemple de nom :** `#admin-journal` ou `#staff-logs`',
				inline: false
			}
		);

	// ── Message 4 — Comment commencer ──────────────────────────────────────────
	const embedDebut = new EmbedBuilder()
		.setTitle('🚀 Comment commencer ?')
		.setColor(0x57f287)
		.addFields(
			{
				name: 'Étape par étape',
				value:
					'Une fois vos 4 salons staff créés, utilisez les boutons dans **le panel ci-dessous** pour les configurer un par un :\n\n' +
					'**1.** Cliquez sur le bouton d\'une étape\n' +
					'**2.** Un menu déroulant apparaît — sélectionnez le bon salon\n' +
					'**3.** Le panel se met à jour avec ✅ une fois le salon enregistré\n' +
					'**4.** Répétez pour chaque étape',
				inline: false
			},
			{
				name: 'Une fois tout configuré',
				value:
					'→ Utilisez `/zone-create` pour créer la première zone du serveur\n' +
					'→ Les membres pourront rejoindre via l\'assistant de bienvenue automatique\n' +
					'→ Consultez le panel staff pour gérer les annonces et événements\n' +
					'→ Ce salon peut être **archivé ou supprimé** — il n\'est plus nécessaire',
				inline: false
			},
			{
				name: '💡 Bon à savoir',
				value:
					'Si vous avez déjà utilisé la commande `/settings-anonlog-set` par le passé, ' +
					'le salon correspondant sera déjà détecté et marqué comme configuré dans le panel. ' +
					'Les autres étapes restent à compléter.\n\n' +
					'Vous pouvez reconfigurer n\'importe quelle étape à tout moment en recliquant sur son bouton.',
				inline: false
			}
		);

	return [
		{ embeds: [embedPresentation] },
		{ embeds: [embedCritique] },
		{ embeds: [embedPreparation] },
		{ embeds: [embedDebut] }
	];
}

/**
 * Builds the interactive setup panel embed + action rows from the current guild settings.
 * This message is edited in place as settings are configured.
 * @param {object|null} settings - Row from the `settings` table
 * @returns {{ embeds: EmbedBuilder[], components: ActionRowBuilder[] }}
 */
function buildSetupPanel(settings) {
	const s = settings || {};

	const allDone = SETUP_STEPS.every((step) => Boolean(s[step.key]));

	let description =
		'Configurez chaque étape en cliquant sur les boutons ci-dessous.\n' +
		'Le panel se met à jour automatiquement après chaque configuration.\n\u200b';

	if (allDone) {
		description =
			'**Toute la configuration est terminée !**\n' +
			'Le bot est prêt à fonctionner sur ce serveur.\n' +
			'Ce salon peut désormais être **archivé ou supprimé**.\n\u200b';
	}

	const embed = new EmbedBuilder()
		.setTitle(allDone ? '✅ Configuration complète' : '🛠️ Panel de configuration')
		.setColor(allDone ? 0x57f287 : 0x5865f2)
		.setDescription(description);

	for (let i = 0; i < SETUP_STEPS.length; i++) {
		const step = SETUP_STEPS[i];
		const channelId = s[step.key];
		const status = channelId ? `✅  <#${channelId}>` : '❌  Non configuré';

		embed.addFields({
			name: `Étape ${i + 1} — ${step.label}`,
			value: `${step.description}\n${status}`,
			inline: false
		});
	}

	const row1 = new ActionRowBuilder().addComponents(
		_configButton(SETUP_STEPS[0], s),
		_configButton(SETUP_STEPS[1], s)
	);
	const row2 = new ActionRowBuilder().addComponents(
		_configButton(SETUP_STEPS[2], s),
		_configButton(SETUP_STEPS[3], s)
	);

	return { embeds: [embed], components: [row1, row2] };
}

function _configButton(step, settings) {
	const done = Boolean(settings[step.key]);
	return new ButtonBuilder()
		.setCustomId(step.configId)
		.setLabel(done ? `✏️ ${step.label}` : `⚙️ ${step.label}`)
		.setStyle(done ? ButtonStyle.Secondary : ButtonStyle.Primary);
}

module.exports = { buildSetupPanel, buildExplanationPayloads, SETUP_STEPS };
