// api/hubspot-sync.js
//
// Puente HubSpot -> Firestore para NuncaTeFalla.
//
// Flujo:
//  1. HubSpot manda un webhook (POST) cada vez que se crea/actualiza un contacto.
//     El payload de HubSpot solo trae el contactId y que propiedad cambio, NO
//     todas las propiedades del contacto.
//  2. Esta funcion valida la firma del webhook (seguridad: confirma que el
//     request realmente viene de HubSpot y no de un tercero).
//  3. Vuelve a consultar la API de HubSpot para traer el contacto completo.
//  4. Si el contacto es un profesional (nf_tipo_contacto = "profesional"),
//     mapea sus propiedades al modelo de Firestore y lo guarda en la
//     coleccion "profesionales", resolviendo lat/lng de su ciudad.
//  5. Si no es profesional, no hace nada (ignora silenciosamente).
//
// Variables de entorno necesarias en Vercel (Project Settings -> Environment Variables):
//   HUBSPOT_PRIVATE_APP_TOKEN   -> token de una Private App de HubSpot con scope crm.objects.contacts.read
//   HUBSPOT_CLIENT_SECRET       -> client secret de la app de HubSpot, usado para validar la firma del webhook
//   FIREBASE_SERVICE_ACCOUNT    -> el JSON completo de la service account de Firebase, como string (ver README)

const crypto = require('crypto');
const admin = require('firebase-admin');
const CITIES = require('../cities-data.js');

// --- Inicializacion de Firebase Admin (una sola vez, reutilizada entre invocaciones) ---
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}
const db = admin.firestore();

// --- Helpers ---

// Busca una ciudad dentro de un departamento y devuelve {lat, lng} o null.
// Hace match case-insensitive e ignorando tildes, para tolerar pequenas
// diferencias entre como HubSpot guarda el label y como esta en CITIES.
function findCityCoords(departamentoSlug, cityLabel) {
  if (!departamentoSlug || !cityLabel) return null;
  const list = CITIES[departamentoSlug];
  if (!list) return null;

  const normalize = (s) =>
    s
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s*\([^)]*\)\s*/g, '') // quita el "(Durazno)" / "(Rocha)" de desambiguacion
      .trim();

  const target = normalize(cityLabel);
  const found = list.find((c) => normalize(c.n) === target);
  return found ? { lat: found.lat, lng: found.lng } : null;
}

// Valida que el request efectivamente venga de HubSpot.
// HubSpot firma cada webhook con HMAC-SHA256 usando el client secret de la app.
// Doc: https://developers.hubspot.com/docs/api/webhooks/validating-requests
function isValidHubspotSignature(req, rawBody) {
  const signature = req.headers['x-hubspot-signature-v3'];
  const timestamp = req.headers['x-hubspot-request-timestamp'];
  if (!signature || !timestamp) return false;

  // Proteccion contra replay attacks: rechaza requests con mas de 5 minutos
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
    // Buffers de distinto largo -> timingSafeEqual tira error -> firma invalida
    return false;
  }
}

// Trae el contacto completo desde la API de HubSpot (el webhook solo da el ID).
async function fetchHubspotContact(contactId) {
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

// Mapea las propiedades de HubSpot al documento que guardamos en Firestore.
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
}

// --- Handler principal ---
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // Vercel ya parsea el body como objeto, pero para validar la firma
  // necesitamos el string RAW exacto que mando HubSpot.
  const rawBody = JSON.stringify(req.body);

  if (!isValidHubspotSignature(req, rawBody)) {
    res.status(401).json({ error: 'Firma invalida' });
    return;
  }

  // HubSpot puede mandar un array de eventos en un solo POST
  const events = Array.isArray(req.body) ? req.body : [req.body];

  const results = [];

  for (const event of events) {
    const contactId = event.objectId;
    if (!contactId) continue;

    try {
      const props = await fetchHubspotContact(contactId);

      // Solo nos interesan los contactos marcados como profesional.
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
