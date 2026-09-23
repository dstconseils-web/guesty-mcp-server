const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');

const app = express();
app.use(cors());
app.use(express.json());

const GUESTY_CLIENT_ID = process.env.GUESTY_CLIENT_ID;
const GUESTY_CLIENT_SECRET = process.env.GUESTY_CLIENT_SECRET;
// Secret dans l'URL du connecteur Claude : https://<app>/mcp/<MCP_AUTH_TOKEN>
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;

let accessToken = null;
let tokenExpiry = null;

async function getAccessToken() {
  if (accessToken && tokenExpiry && Date.now() < tokenExpiry) {
    return accessToken;
  }
  
  const params = new URLSearchParams();
  params.append('grant_type', 'client_credentials');
  params.append('scope', 'open-api');
  params.append('client_id', GUESTY_CLIENT_ID);
  params.append('client_secret', GUESTY_CLIENT_SECRET);
  
  const response = await axios.post('https://open-api.guesty.com/oauth2/token', params, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });
  
  accessToken = response.data.access_token;
  tokenExpiry = Date.now() + (response.data.expires_in * 1000) - 60000;
  return accessToken;
}

async function callGuesty(endpoint, { method = 'GET', data, params } = {}) {
  const token = await getAccessToken();
  const response = await axios({
    method,
    url: `https://open-api.guesty.com/v1${endpoint}`,
    headers: { 'Authorization': `Bearer ${token}` },
    data,
    params
  });
  return response.data;
}

// Les réponses Guesty varient : { data: { conversations: [] } }, { results: [] }, []
function unwrapList(data, key) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return [];
  for (const k of [key, 'results', 'data']) {
    const v = data[k];
    if (Array.isArray(v)) return v;
    if (v && typeof v === 'object') {
      const nested = unwrapList(v, key);
      if (nested.length) return nested;
    }
  }
  return [];
}

function postSender(p) {
  return (p.sentBy || p.author?.type || p.type || '').toLowerCase();
}

function postModule(p) {
  return typeof p.module === 'object' ? p.module?.type : p.module;
}

async function getPosts(conversationId, limit = 30) {
  const data = await callGuesty(`/communication/conversations/${conversationId}/posts`, { params: { limit } });
  return unwrapList(data, 'posts')
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
}

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Guesty MCP Server' });
});

app.get('/api/listings', async (req, res) => {
  try {
    const data = await callGuesty('/listings?limit=100');
    const listings = data.results.map(l => ({
      id: l._id,
      name: l.title || l.nickname,
      address: l.address?.full,
      bedrooms: l.bedrooms,
      maxGuests: l.accommodates
    }));
    res.json({ success: true, count: listings.length, listings });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/reservations', async (req, res) => {
  try {
    const data = await callGuesty('/reservations?limit=100&sort=-checkIn');
    const reservations = data.results.map(r => ({
      id: r._id,
      listingName: r.listing?.title || r.listing?.nickname,
      guestName: r.guest?.fullName,
      checkIn: r.checkIn,
      checkOut: r.checkOut,
      status: r.status,
      totalPrice: r.money?.totalPrice
    }));
    res.json({ success: true, count: reservations.length, reservations });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/rapport', async (req, res) => {
  try {
    const listingsData = await callGuesty('/listings?limit=100');
    const rapport = listingsData.results.map(listing => ({
      nom: listing.title || listing.nickname,
      adresse: listing.address?.full,
      chambres: listing.bedrooms,
      capacite: listing.accommodates
    }));
    res.json({ success: true, genereLe: new Date().toISOString(), rapport });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ---------------------------------------------------------------------------
// MCP (Streamable HTTP) — connecteur personnalisé pour claude.ai
// ---------------------------------------------------------------------------

const text = (value) => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
});

function buildMcpServer() {
  const server = new McpServer({ name: 'guesty', version: '1.1.0' });

  server.registerTool('list_conversations', {
    title: 'Lister les conversations Guesty',
    description: "Conversations récentes de l'inbox Guesty (guest, logement, dernier message).",
    inputSchema: { limit: z.number().int().min(1).max(100).optional() }
  }, async ({ limit = 20 }) => {
    const data = await callGuesty('/communication/conversations', { params: { limit } });
    return text(unwrapList(data, 'conversations').map(c => ({
      conversationId: c._id,
      guestName: c.meta?.guestName || c.guest?.fullName,
      reservations: (c.meta?.reservations || []).map(r => ({
        id: r._id, checkIn: r.checkIn, checkOut: r.checkOut, confirmationCode: r.confirmationCode
      })),
      channel: c.integration?.platform,
      read: c.state?.read,
      lastMessage: c.lastMessage?.body || c.state?.lastMessage?.body
    })));
  });

  server.registerTool('get_conversation_messages', {
    title: "Lire les messages d'une conversation",
    description: "Historique des messages d'une conversation Guesty, du plus ancien au plus récent.",
    inputSchema: {
      conversationId: z.string(),
      limit: z.number().int().min(1).max(100).optional()
    }
  }, async ({ conversationId, limit = 30 }) => {
    const posts = await getPosts(conversationId, limit);
    return text(posts.map(p => ({
      id: p._id,
      from: postSender(p),
      channel: postModule(p),
      at: p.createdAt,
      body: p.body
    })));
  });

  server.registerTool('send_guest_message', {
    title: 'Envoyer un message au guest',
    description: "Envoie un message au guest dans une conversation Guesty, sur le canal d'origine " +
      "(Airbnb, Booking, email...). Toujours faire valider le texte par David avant d'appeler cet outil.",
    inputSchema: {
      conversationId: z.string(),
      body: z.string().min(1),
      moduleType: z.string().optional()
        .describe('Canal (airbnb2, bookingCom, email, sms, whatsapp...). Par défaut : canal du dernier message du guest.')
    },
    annotations: { destructiveHint: false, idempotentHint: false }
  }, async ({ conversationId, body, moduleType }) => {
    let type = moduleType;
    if (!type) {
      const posts = await getPosts(conversationId, 30);
      const lastGuest = [...posts].reverse().find(p => ['guest', 'traveler'].includes(postSender(p)));
      type = (lastGuest && postModule(lastGuest)) || 'platform';
    }
    await callGuesty(`/communication/conversations/${conversationId}/send-message`, {
      method: 'POST',
      data: { body, module: { type } }
    });
    return text(`Message envoyé (canal ${type}).`);
  });

  server.registerTool('get_reservation', {
    title: 'Détails d\'une réservation',
    description: 'Détails d\'une réservation Guesty (guest, logement, dates, statut, montant).',
    inputSchema: { reservationId: z.string() }
  }, async ({ reservationId }) => {
    const r = await callGuesty(`/reservations/${reservationId}`);
    return text({
      id: r._id,
      status: r.status,
      source: r.source,
      listing: r.listing?.nickname || r.listing?.title,
      guest: r.guest?.fullName,
      phone: r.guest?.phone,
      checkIn: r.checkIn,
      checkOut: r.checkOut,
      guestsCount: r.guestsCount,
      totalPrice: r.money?.totalPrice,
      confirmationCode: r.confirmationCode
    });
  });

  server.registerTool('list_reservations', {
    title: 'Lister les réservations',
    description: 'Réservations Guesty, les plus récentes (par date de check-in) en premier.',
    inputSchema: { limit: z.number().int().min(1).max(100).optional() }
  }, async ({ limit = 30 }) => {
    const data = await callGuesty('/reservations', { params: { limit, sort: '-checkIn' } });
    return text((data.results || []).map(r => ({
      id: r._id,
      listing: r.listing?.nickname || r.listing?.title,
      guest: r.guest?.fullName,
      checkIn: r.checkIn,
      checkOut: r.checkOut,
      status: r.status
    })));
  });

  server.registerTool('list_listings', {
    title: 'Lister les logements',
    description: 'Logements Guesty (nom, adresse, capacité).',
    inputSchema: {}
  }, async () => {
    const data = await callGuesty('/listings', { params: { limit: 100 } });
    return text((data.results || []).map(l => ({
      id: l._id, name: l.nickname || l.title, address: l.address?.full, maxGuests: l.accommodates
    })));
  });

  return server;
}

async function handleMcp(req, res) {
  if (!MCP_AUTH_TOKEN || req.params.token !== MCP_AUTH_TOKEN) {
    return res.status(403).json({ error: 'forbidden' });
  }
  // Mode sans état : un serveur + transport par requête
  const server = buildMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('MCP error:', error);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  }
}

app.post('/mcp/:token', handleMcp);
app.get('/mcp/:token', (req, res) => res.status(405).set('Allow', 'POST').end());
app.delete('/mcp/:token', (req, res) => res.status(405).set('Allow', 'POST').end());

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
