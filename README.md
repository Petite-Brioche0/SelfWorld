# 🌍 SelfWorld — Bot Discord de gestion de zones

> 🇬🇧 [English version available → README.en.md](README.en.md)

> Bot Discord pour créer et gérer des zones communautaires privées, avec messagerie anonyme, panneau de configuration interactif et suivi d'activité.

[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org/)
[![Discord.js](https://img.shields.io/badge/discord.js-v14-blue.svg)](https://discord.js.org/)
[![MySQL](https://img.shields.io/badge/MySQL-8.0+-orange.svg)](https://www.mysql.com/)

---

## ✨ Fonctionnalités

### 🔒 Gestion des zones
- Création de zones privées avec permissions configurables
- Création automatique des canaux (réception, général, anonyme, vocal)
- Contrôle d'accès par rôles (Owner/Membre)
- Alertes d'activité faible
- Groupes temporaires avec expiration automatique
- Canaux personnalisés configurables

### 🎭 Messagerie anonyme
- Identités anonymes persistantes par zone
- Relais de messages via webhooks
- Journal d'audit complet pour la modération
- Sanitisation des mentions (@everyone, @here)

### 🚪 Accueil et onboarding
- Wizard interactif envoyé aux nouveaux membres : navigation des zones, code d'invitation, demande de zone
- Zones découvrables avec pagination et barre d'activité
- Codes d'invitation à usage unique, valables 24 h (6 caractères A–Z0–9)

### 📋 Politique d'accès des zones
- Trois modes : **open** (accès libre), **ask** (sur demande), **closed** (fermé)
- Gestion des demandes d'adhésion avec décideur configurable (owner ou membres)
- Salle `cv-entretien` créée automatiquement en mode `ask / owner`
- Profil public de la zone (titre, description, couleur, tags)

### 📊 Activité
- Score d'activité normalisé (60 % messages, 40 % minutes vocales)
- Alertes quotidiennes pour les zones inactives
- Suivi par jour en base de données

### ⚙️ Infrastructure
- Planificateur de tâches avec protection contre l'exécution concurrente
- Rate limiting en mémoire
- Arrêt gracieux
- Logs structurés avec Pino

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Discord Gateway                        │
└─────────────┬───────────────────────────────────────────────┘
              │
┌─────────────▼───────────────────────────────────────────────┐
│                    Gestionnaires d'événements               │
│  • messageCreate  • interactionCreate  • guildMemberAdd     │
│  • guildMemberRemove                                        │
└─────────────┬───────────────────────────────────────────────┘
              │
┌─────────────▼───────────────────────────────────────────────┐
│                    Couche service                           │
│  • ZoneService       • AnonService       • HubService       │
│  • ActivityService   • TempGroupService  • EventService     │
│  • PolicyService     • PanelService      • WelcomeService   │
│  • StaffPanelService • ThrottleService                      │
└─────────────┬───────────────────────────────────────────────┘
              │
┌─────────────▼───────────────────────────────────────────────┐
│                    Base de données (MySQL)                  │
│  • Zones  • Members  • Channels  • Activity  • Logs         │
└─────────────────────────────────────────────────────────────┘
```

---

## 📋 Prérequis

- **Node.js** >= 20.0.0
- **MySQL** >= 8.0
- **Token de bot Discord** avec les intents suivants :
  - `GUILDS`
  - `GUILD_MEMBERS`
  - `GUILD_MESSAGES`
  - `MESSAGE_CONTENT`
  - `GUILD_VOICE_STATES`
  - `GUILD_MESSAGE_REACTIONS`

---

## 🚀 Installation

### 1. Cloner le dépôt

```bash
git clone https://github.com/Petite-Brioche0/SelfWorld.git
cd SelfWorld/bot
```

### 2. Installer les dépendances

```bash
npm install
```

### 3. Configurer les variables d'environnement

```bash
cp .env.example .env
```

```env
# Discord
DISCORD_TOKEN=your_discord_bot_token_here
CLIENT_ID=your_discord_client_id_here
GUILD_ID=your_discord_guild_id_here

# Propriétaire du bot
OWNER_ID=your_discord_user_id_here

# Base de données
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=selfworld
DB_PASSWORD=selfworld
DB_NAME=selfworld

# Environnement
NODE_ENV=development
```

### 4. Initialiser la base de données

```bash
mysql -u root -p
```

```sql
CREATE DATABASE selfworld;
CREATE USER 'selfworld'@'localhost' IDENTIFIED BY 'selfworld';
GRANT ALL PRIVILEGES ON selfworld.* TO 'selfworld'@'localhost';
FLUSH PRIVILEGES;
EXIT;
```

```bash
mysql -u selfworld -p selfworld < bot/schema.sql
```

### 5. Déployer les commandes slash

```bash
npm run deploy:cmd
```

### 6. Démarrer le bot

```bash
npm run dev
```

---

## 📁 Structure du projet

```
bot/
├── src/
│   ├── commands/
│   │   └── admin/                    # Commandes réservées au propriétaire
│   │       ├── zone.create.js
│   │       ├── zone.delete.js
│   │       ├── zones.list.js
│   │       └── settings.anonlog.set.js
│   ├── events/                       # Gestionnaires d'événements Discord
│   │   ├── ready.js
│   │   ├── messageCreate.js
│   │   ├── interactionCreate.js
│   │   ├── guildMemberAdd.js
│   │   └── guildMemberRemove.js
│   ├── i18n/
│   │   └── fr.js                     # Locale française (clé/valeur plat)
│   ├── services/
│   │   ├── ZoneService.js
│   │   ├── AnonService.js
│   │   ├── HubService.js             # Coordinateur (mixin)
│   │   ├── hub/
│   │   │   ├── requests.js           # Gestionnaires de modaux + cycle de vie des demandes
│   │   │   └── builders.js           # Constructeurs d'embeds, formatters
│   │   ├── ActivityService.js
│   │   ├── TempGroupService.js
│   │   ├── EventService.js
│   │   ├── PolicyService.js          # Coordinateur (mixin)
│   │   ├── policy/
│   │   │   ├── creation.js           # Demandes de création de zone
│   │   │   ├── config.js             # Politique, profil public, salle entretien
│   │   │   ├── joinRequests.js       # Cycle de vie des demandes d'adhésion
│   │   │   └── inviteCodes.js        # Génération et utilisation des codes
│   │   ├── PanelService.js           # Coordinateur (mixin)
│   │   ├── panel/
│   │   │   ├── render.js             # Rendus des panneaux (membres, rôles, canaux, politique)
│   │   │   ├── members.js            # Interactions membres
│   │   │   ├── roles.js              # Interactions rôles
│   │   │   └── channels.js           # Interactions canaux
│   │   ├── StaffPanelService.js
│   │   ├── WelcomeService.js
│   │   └── ThrottleService.js
│   └── utils/
│       ├── TaskScheduler.js
│       ├── db.js
│       ├── discord.js                # safeReply, safeDefer, fetchChannel…
│       ├── embeds.js                 # errorEmbed, successEmbed, infoEmbed + constantes couleur
│       ├── i18n.js                   # t(key, vars) — interpolation {variable}
│       ├── ids.js                    # shortId
│       ├── anonNames.js
│       ├── commandLoader.js
│       ├── permissions.js
│       ├── serviceHelpers.js         # normalizeColor, parseParticipants…
│       └── validation.js
├── tests/
│   ├── helpers/
│   │   ├── mockDb.js
│   │   ├── mockClient.js
│   │   └── mockInteraction.js
│   ├── services/
│   │   └── ActivityService.test.js
│   └── utils/
│       └── serviceHelpers.test.js
├── schema.sql
├── vitest.config.js
├── package.json
└── .env.example
```

> **Note :** Les interactions utilisateur (rejoindre une zone, codes d'invitation, événements, etc.) passent par des boutons, modaux et menus déroulants routés via `interactionCreate.js`, sans commandes slash dédiées.
>
> **Note :** Les grands services (HubService, PolicyService, PanelService) sont décomposés en sous-modules via un pattern de mixin prototypal. Le coordinateur gère le routage et l'infrastructure partagée ; les sous-modules contiennent la logique métier.

---

## 🎮 Commandes

### Commandes admin (propriétaire uniquement)

| Commande | Description |
|----------|-------------|
| `/zone-create` | Créer une zone manuellement |
| `/zone-delete <id>` | Supprimer une zone et toutes ses ressources |
| `/zones-list` | Lister toutes les zones du serveur |
| `/settings-anonlog-set` | Configurer le canal de logs anonymes |

---

## 🛠️ Description des services

### ZoneService
Gère le cycle de vie des zones : création, suppression, gestion des membres et permissions. Assure le nettoyage des ressources orphelines.

### AnonService
Messagerie anonyme avec identités persistantes par zone. Relais via webhooks, journal d'audit complet.

### HubService
Gère les canaux hub personnalisés par membre. Cycle de vie des demandes de hub (annonces, événements) avec workflow brouillon/révision/approbation.

### WelcomeService
Wizard d'onboarding interactif envoyé aux nouveaux membres. Permet de parcourir les zones avec pagination, rejoindre via code d'invitation (6 caractères, 24 h, usage unique), envoyer une demande d'adhésion à une zone, ou demander la création d'une nouvelle zone.

### PolicyService
Gère la politique d'accès des zones (open/ask/closed), les demandes d'adhésion, les codes d'invitation, le profil public (titre, description, couleur, tags) et la liste des zones découvrables. Crée/supprime automatiquement le salon `cv-entretien` selon le mode de décision.

### PanelService
Panneau d'administration interactif au sein de chaque zone : configuration de la politique et du profil public, gestion des membres, des rôles personnalisés et des canaux.

### StaffPanelService
Panneaux de planification d'annonces et d'événements avec workflow prévisualisation/approbation.

### ActivityService
Suivi de l'activité des zones. Score normalisé (60 % messages, 40 % minutes vocales). Alertes quotidiennes pour les zones inactives.

### TempGroupService
Groupes temporaires dans les zones, avec expiration automatique et structure de canaux isolée.

### EventService
Gestion du cycle de vie des événements : planification, suivi des participants, groupes temporaires associés.

### ThrottleService
Rate limiting en mémoire pour prévenir le spam sur tous les types d'interactions.

---

## 🧪 Tests

Le projet utilise [Vitest](https://vitest.dev/).

```bash
# Exécuter tous les tests
npm test

# Mode watch
npm run test:watch
```

Les tests couvrent la logique métier critique (calcul de score d'activité, fonctions utilitaires) via des mocks légers — aucune connexion réelle à Discord ou MySQL requise.

---

## 🔄 Planificateur de tâches

Le bot inclut un planificateur qui gère les opérations périodiques :

- **Sweep des groupes expirés** : nettoyage horaire
- **Alertes d'activité faible** : vérification quotidienne
- **Traitement des tâches planifiées** : annonces et événements, toutes les minutes

Toutes les tâches bénéficient de :
- Protection contre les exécutions simultanées
- Timeout configurable
- Comptage des erreurs et logs
- Arrêt gracieux

---

## 🔐 Sécurité

- **Sanitisation des mentions** : protection contre @everyone / @here dans les canaux anonymes
- **Rate limiting** : prévention du spam
- **Vérification des permissions** : contrôles stricts sur toutes les commandes
- **Sécurité webhook** : identités anonymes uniques par zone
- **Requêtes paramétrées** : prévention des injections SQL avec liste blanche des colonnes
- **Journal d'audit** : logs complets pour la modération
- **Vérification de connexion** : la base de données est testée au démarrage

---

## 📊 Schéma de base de données

MySQL normalisé avec clés étrangères et suppressions en cascade :

- **zones** — configuration principale et IDs Discord
- **zone_members** — appartenance aux zones
- **zone_member_roles** — rôles personnalisés par membre
- **zone_roles** — définitions des rôles de zone
- **zone_invite_codes** — codes d'invitation
- **zone_join_requests** — demandes d'adhésion
- **zone_creation_requests** — demandes de création de zone
- **temp_groups** — groupes temporaires
- **temp_group_members** — membres des groupes temporaires
- **temp_group_channels** — canaux des groupes temporaires
- **events** — définitions et planification
- **event_participants** — participants aux événements
- **anon_channels** — configuration des canaux anonymes
- **anon_logs** — logs d'audit des messages anonymes
- **zone_activity** — données d'activité
- **hub_channels** — canaux hub par membre
- **hub_requests** — workflows des demandes hub
- **staff_announcements** — planification des annonces staff
- **panel_messages** — état des panneaux interactifs
- **panel_message_registry** — suivi des messages de panneau
- **settings** — configuration au niveau du serveur

---

## 🐛 Débogage

- Passer `NODE_ENV=development` pour des logs lisibles avec traces complètes.
- Le planificateur de tâches loggue les compteurs d'exécution, d'erreurs et le timestamp du dernier succès.
- Le bot valide la connexion MySQL au démarrage et quitte avec un message clair si elle échoue.

---

## 🤝 Contribuer

1. Forker le dépôt
2. Créer une branche (`git checkout -b feature/ma-fonctionnalite`)
3. Commiter les changements
4. Ouvrir une Pull Request

### Style de code
- ESLint strict — toujours lancer `npm run lint` après modification
- Suivre les conventions de nommage existantes

---

## 📝 Licence

MIT — voir le fichier LICENSE.

---

## 🙏 Remerciements

- [Discord.js](https://discord.js.org/) — wrapper Discord API
- [Pino](https://getpino.io/) — logger JSON ultra-rapide
- [MySQL2](https://github.com/sidorares/node-mysql2) — driver MySQL

---

<div align="center">

[Signaler un bug](https://github.com/Petite-Brioche0/SelfWorld/issues) · [Demander une fonctionnalité](https://github.com/Petite-Brioche0/SelfWorld/issues)

</div>
