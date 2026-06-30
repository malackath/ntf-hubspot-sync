// api/hubspot-sync.js
//
// Puente HubSpot -> Firestore para NuncaTeFalla.
//
// Flujo (modelo: Legacy Private App con webhook nativo):
//  1. HubSpot manda un webhook (POST) cada vez que cambia una propiedad
//     suscrita (ej: nf_tipo_contacto) en un contacto. El payload solo trae
//     el objectId del contacto, NO sus propiedades completas.
//  2. Esta funcion valida la firma del webhook (HMAC-SHA256 con el Client
//     Secret de la app), para confirmar que el request viene de HubSpot.
//  3. Vuelve a consultar la API de HubSpot para traer el contacto completo,
//     usando el token de la Private App.
//  4. Si el contacto es un profesional, mapea sus propiedades al modelo
//     de Firestore y lo guarda, resolviendo lat/lng de su ciudad.
//  5. Si no es profesional, no hace nada.
//
// Variables de entorno necesarias en Vercel:
//   HUBSPOT_PRIVATE_APP_TOKEN   -> token de la Legacy Private App
//   HUBSPOT_CLIENT_SECRET       -> Client Secret de la misma app
//   FIREBASE_SERVICE_ACCOUNT    -> JSON de la service account de Firebase

const crypto = require('crypto');
const admin = require('firebase-admin');
const CITIES = require('../cities-data.js');

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}
const db = admin.firestore();function findCityCoords(departamentoSlug, cityLabel) {
  if (!departamentoSlug || !cityLabel) return null;
  const list = CITIES[departamentoSlug];
  if (!list) return null;

  const normalize = (s) =>
    s
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s*\([^)]*\)\s*/g, '')
      .trim();

  const target = normalize(cityLabel);
  const found = list.find((c) => normalize(c.n) === target);
  return found ? { lat: found.lat, lng: found.lng } : null;
}

function isValidHubspotSignature(req, rawBody) {
  const signature = req.headers['x-hubspot-signature-v3'];
  const timestamp = req.headers['x-hubspot-request-timestamp'];
  if (!signature || !timestamp) return false;

  const fiveMinutes = 5 * 60 * 1000;
  if (Math.abs(Date.now() - Number(timestamp)) > fiveMinutes) return false;

  const method = 'POST';
  const url = `https://${req.headers.host}${req.url}`;
  const sourceString = method + url + rawBody + timestamp;

  const expected = crypto
    .createHmac('sha256', process.env.HUBSPOT_CLIENT_SECRET)
    .update(sourceString)
    .digest('base64');

  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}async function fetchHubspotContact(contactId) {
  const properties = [
    'firstname',
    'lastname',
    'email',
    'phone',
    'address',
    'nf_tipo_contacto',
    'nf_servicios',
    'nf_departamento',
    'nf_ciudad',
    'nf_radio_cobertura',
  ];

  const url = `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}?properties=${properties.join(',')}`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${process.env.HUBSPOT_PRIVATE_APP_TOKEN}`,
    },
  });

  if (!res.ok) {
    throw new Error(`HubSpot API respondio ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();
  return data.properties;
}

function mapToFirestoreDoc(contactId, props) {
  const servicios = props.nf_servicios
    ? props.nf_servicios.split(';').map((s) => s.trim()).filter(Boolean)
    : [];

  const coords = findCityCoords(props.nf_departamento, props.nf_ciudad);

  return {
    hubspotContactId: String(contactId),
    nombre: [props.firstname, props.lastname].filter(Boolean).join(' ') || null,
    email: props.email || null,
    telefono: props.phone || null,
    direccion: props.address || null,
    tipoContacto: props.nf_tipo_contacto || null,
    servicios,
    departamento: props.nf_departamento || null,
    ciudad: props.nf_ciudad || null,
    ciudadLat: coords ? coords.lat : null,
    ciudadLng: coords ? coords.lng : null,
    radioCobertura: props.nf_radio_cobertura || null,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
}module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const rawBody = JSON.stringify(req.body);

  if (!isValidHubspotSignature(req, rawBody)) {
    res.status(401).json({ error: 'Firma invalida' });
    return;
  }

  const events = Array.isArray(req.body) ? req.body : [req.body];
  const results = [];

  for (const event of events) {
    const contactId = event.objectId;
    if (!contactId) continue;

    try {
      const props = await fetchHubspotContact(contactId);

      if (props.nf_tipo_contacto !== 'profesional') {
        results.push({ contactId, skipped: true, reason: 'no es profesional' });
        continue;
      }

      const doc = mapToFirestoreDoc(contactId, props);
      await db.collection('profesionales').doc(String(contactId)).set(doc, { merge: true });

      results.push({ contactId, synced: true });
    } catch (err) {
      results.push({ contactId, error: err.message });
    }
  }

  res.status(200).json({ ok: true, results });
};
