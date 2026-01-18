const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const GUESTY_CLIENT_ID = process.env.GUESTY_CLIENT_ID;
const GUESTY_CLIENT_SECRET = process.env.GUESTY_CLIENT_SECRET;
const GUESTY_API_URL = 'https://open-api.guesty.com/v1';

let accessToken = null;
let tokenExpiry = null;

async function getAccessToken() {
  if (accessToken && tokenExpiry && Date.now() < tokenExpiry) {
    return accessToken;
  }
  const response = await axios.post('https://open-api.guesty.com/oauth2/token', {
    grant_type: 'client_credentials',
    scope: 'open-api',
    client_id: GUESTY_CLIENT_ID,
    client_secret: GUESTY_CLIENT_SECRET
  }, { headers: { 'Content-Type': 'application/json' } });
  accessToken = response.data.access_token;
  tokenExpiry = Date.now() + (response.data.expires_in * 1000) - 60000;
  return accessToken;
}

async function callGuesty(endpoint) {
  const token = await getAccessToken();
  const response = await axios.get(`${GUESTY_API_URL}${endpoint}`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  return response.data;
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
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
    const reservationsData = await callGuesty(`/reservations?limit=500&checkIn[$gte]=${ninetyDaysAgo.toISOString()}`);
    
    const rapport = listingsData.results.map(listing => {
      const listingReservations = reservationsData.results.filter(r => r.listingId === listing._id);
      const totalNights = listingReservations.reduce((sum, r) => sum + (r.nightsCount || 0), 0);
      const totalRevenue = listingReservations.reduce((sum, r) => sum + (r.money?.totalPrice || 0), 0);
      return {
        nom: listing.title || listing.nickname,
        adresse: listing.address?.full,
        chambres: listing.bedrooms,
        capacite: listing.accommodates,
        tauxOccupation90j: `${Math.round((totalNights / 90) * 100)}%`,
        revenu90j: `${Math.round(totalRevenue)}€`,
        prixMoyenNuit: totalNights > 0 ? `${Math.round(totalRevenue / totalNights)}€` : 'N/A'
      };
    });
    res.json({ success: true, genereLe: new Date().toISOString(), rapport });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
