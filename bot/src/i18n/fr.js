'use strict';

// French locale strings — flat key/value store.
// Variables use {name} syntax. Add new keys here; use t(key, { name: value }) to format.

module.exports = {
	// ===== Generic errors =====
	'error.generic': '❌ Une erreur est survenue. Réessaye dans quelques instants.',
	'error.invalid_action': '❌ **Action invalide**\n\nCette action n\'est pas reconnue ou n\'est plus disponible.',
	'error.not_found': '❌ **Introuvable**\n\nCet élément n\'existe plus ou a été supprimé.',
	'error.unauthorized': '🚫 **Action non autorisée**\n\nTu n\'as pas la permission d\'effectuer cette action.',
	'error.already_processed': '⚠️ **Déjà traité**\n\nCette demande a déjà été traitée.',

	// ===== Hub — general =====
	'hub.request.not_found': '❌ **Demande introuvable**\n\nCette demande n\'existe plus ou a été supprimée.',
	'hub.request.not_owner': '🚫 **Action non autorisée**\n\nTu ne peux modifier que tes propres demandes.',
	'hub.request.already_submitted': '⚠️ **Demande déjà envoyée**\n\nCette demande a déjà été soumise à la modération et ne peut plus être modifiée.',
	'hub.request.already_pending': '⚠️ **Demande déjà envoyée**\n\nCette demande a déjà été transmise à la modération.',
	'hub.request.moderation_only': '👑 **Modération uniquement**\n\nCette action est réservée à l\'équipe de modération.',
	'hub.request.submitted': '✅ **Demande envoyée !**\n\nTa demande a été transmise à l\'équipe de modération. Tu recevras une notification dès qu\'elle sera examinée.\n\n> 💡 *La validation peut prendre quelques heures.*',
	'hub.request.accepted': '✅ **Demande acceptée**\n\nLa demande a été acceptée et publiée. L\'utilisateur a été notifié.',
	'hub.request.denied': '❌ **Demande refusée**\n\nLa demande a été refusée et l\'utilisateur a été notifié.',
	'hub.image.invalid': '❌ **Fichier non valide**\n\nMerci d\'envoyer une **image** (formats acceptés : PNG, JPG, GIF, WEBP).',
	'hub.image.added': '✅ **Image ajoutée avec succès !**\n\nTon aperçu a été mis à jour avec l\'image. Tu peux maintenant envoyer ta demande.',
	'hub.image.error': '❌ **Erreur**\n\nImpossible de récupérer cette image pour le moment. Réessaye avec une autre image.',

	// ===== Panel — general =====
	'panel.zone.invalid': '❌ **Zone invalide**\n\nCette zone n\'existe pas ou son identifiant est incorrect.',
	'panel.zone.not_found': '❌ **Zone introuvable**\n\nCette zone a été supprimée ou n\'existe plus.',
	'panel.zone.no_permission': '🔒 **Accès refusé**\n\nTu n\'as pas la permission de gérer cette zone.',
	'panel.zone.no_panel': '❌ **Panneau introuvable**\n\nLe panneau de cette zone n\'existe plus.',

	// ===== Panel — roles =====
	'panel.role.invalid': '❌ **Rôle invalide**\n\nCe rôle est introuvable ou n\'existe plus dans cette zone.',
	'panel.role.protected': '🔒 **Rôle protégé**\n\nCe rôle est introuvable ou ne peut pas être modifié car il est protégé par le système.',
	'panel.role.created': '✅ **Rôle créé**\n\nLe rôle <@&{roleId}> a été créé avec succès dans cette zone.',
	'panel.role.updated': '✅ **Rôle mis à jour**\n\nLes modifications du rôle ont été appliquées avec succès.',
	'panel.role.deleted': '✅ **Rôle supprimé**\n\nLe rôle a été supprimé avec succès de cette zone.',
	'panel.role.create_error': '❌ **Création impossible**\n\nImpossible de créer ce rôle pour le moment. Réessaye dans quelques instants.',
	'panel.role.update_error': '❌ **Modification impossible**\n\nImpossible de modifier ce rôle. Vérifie qu\'il existe toujours et réessaye.',
	'panel.role.delete_error': '❌ **Suppression impossible**\n\nCe rôle ne peut pas être supprimé pour le moment. Vérifie qu\'il existe toujours.',
	'panel.role.limit': '⚠️ **Limite atteinte**\n\nTu as déjà créé le maximum de rôles personnalisés autorisés (10) pour cette zone.',
	'panel.role.name_required': '⚠️ **Nom requis**\n\nTu dois fournir un nom pour créer ce rôle.',
	'panel.role.color_invalid': '❌ **Couleur invalide**\n\nUtilise le format hexadécimal : `#RRGGBB` (ex: `#5865F2` pour bleu Discord).',
	'panel.role.members_error': '❌ **Erreur de mise à jour**\n\nImpossible de mettre à jour les membres du rôle. Vérifie que le rôle existe toujours.',

	// ===== Panel — channels =====
	'panel.channel.invalid': '❌ **Salon invalide**\n\nCe salon est introuvable ou n\'existe plus dans cette zone.',
	'panel.channel.not_found': '❌ **Salon introuvable**\n\nCe salon n\'existe plus ou a été supprimé de cette zone.',
	'panel.channel.protected': '🔒 **Salon protégé**\n\nCe salon est protégé par le système et ne peut pas être modifié.',
	'panel.channel.created_text': '✅ **Salon créé**\n\nLe salon textuel a été créé avec succès dans cette zone.',
	'panel.channel.created_voice': '✅ **Salon créé**\n\nLe salon vocal a été créé avec succès dans cette zone.',
	'panel.channel.updated': '✅ **Salon mis à jour**\n\nLes modifications du salon ont été appliquées avec succès.',
	'panel.channel.deleted': '✅ **Salon supprimé**\n\nLe salon a été supprimé avec succès de cette zone.',
	'panel.channel.create_error': '❌ **Création impossible**\n\nImpossible de créer ce salon pour le moment. Réessaye dans quelques instants.',
	'panel.channel.update_error': '❌ **Modification impossible**\n\nImpossible de modifier ce salon. Vérifie qu\'il existe toujours et réessaye.',
	'panel.channel.delete_error': '❌ **Suppression impossible**\n\nCe salon ne peut pas être supprimé pour le moment. Vérifie qu\'il existe toujours.',
	'panel.channel.name_required': '⚠️ **Nom requis**\n\nTu dois fournir un nom pour créer ce salon.',
	'panel.channel.type_invalid': '❌ **Type invalide**\n\nUtilise `texte` pour un salon textuel ou `vocal` pour un salon vocal.',
	'panel.channel.roles_error': '❌ **Erreur de mise à jour**\n\nImpossible de mettre à jour les permissions du salon. Vérifie qu\'il existe toujours.',
};
