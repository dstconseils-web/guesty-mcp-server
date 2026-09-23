# guesty-mcp-server

Serveur MCP qui connecte Claude à Guesty. Depuis une conversation claude.ai, Claude peut lire
l'inbox, lire l'historique d'un guest et **lui envoyer une réponse** (sur Airbnb, Booking, email…).

## Outils MCP

| Outil | Rôle |
|---|---|
| `list_conversations` | conversations récentes de l'inbox |
| `get_conversation_messages` | historique d'une conversation |
| `send_guest_message` | envoie un message au guest (canal d'origine par défaut) |
| `get_reservation` / `list_reservations` | réservations |
| `list_listings` | logements |

Les anciennes routes REST (`/api/listings`, `/api/reservations`, `/api/rapport`) sont conservées.

## Déploiement (Railway)

Variables d'environnement :

| Variable | Valeur |
|---|---|
| `GUESTY_CLIENT_ID` | client id Guesty Open API |
| `GUESTY_CLIENT_SECRET` | client secret Guesty |
| `MCP_AUTH_TOKEN` | longue chaîne aléatoire : c'est le « mot de passe » du connecteur |

## Ajouter le connecteur dans Claude

claude.ai → **Paramètres → Connecteurs → Ajouter un connecteur personnalisé** :

- Nom : `Guesty`
- URL : `https://<ton-app>.up.railway.app/mcp/<MCP_AUTH_TOKEN>`

Ensuite, le bouton **💬 Ouvrir dans Claude** envoyé par Guesty AutoBot sur Telegram/WhatsApp ouvre
une conversation où Claude peut lire l'historique et envoyer la réponse après ta validation.

⚠️ Garde l'URL secrète : toute personne qui la connaît peut écrire à tes guests.
