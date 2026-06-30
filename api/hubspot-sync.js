// api/hubspot-sync.js
//
// Puente HubSpot -> Firestore para NuncaTeFalla.
//
// Flujo (modelo: HubSpot Workflow con accion "Send a webhook"):
//  1. En HubSpot configuramos un Workflow que se dispara cuando cambia
//     nf_tipo_contacto (u otras propiedades NF) en un contacto, y manda un
//     POST a esta URL con las propiedades del contacto ya incluidas en el
//     body (no hace falta volver a consultar la API de HubSpot).
//  2. Esta funcion valida que el request traiga un secreto compartido
//     simple (HUBSPOT_WEBHOOK_SECRET) como query param o header, para
//     evitar que cualquiera en internet le pegue a este endpoint.
//  3. Si el contacto es un profesional (nf_tipo_contacto = "profesional"),
//     mapea sus propiedades al modelo de Firestore y lo guarda en la
//     coleccion "profesionales", resolviendo lat/lng de su ciudad.
//  4. Si no es profesional, no hace nada (ignora silenciosamente).
//
// Variables de entorno necesarias en Vercel (Project Settings -> Environment Variables):
//   HUBSPOT_WEBHOOK_SECRET      -> string simple que vos elegis, usado para validar que el request viene de tu Workflow
//   FIREBASE_SERVICE_ACCOUNT    -> el JSON completo de la service account de Firebase, como string (ver README)

const admin = require('firebase-admin');
const CITIES = require('../cities-data.js');

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}
const db = admin.firestore();

function findCityCoords(departamentoSlug, cityLabel) {
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

function isValidRequest(req) {
  const provided = req.query && req.query.secret;
  return Boolean(provided) && provided === process.env.HUBSPOT_WEBHOOK_SECRET;
}function mapToFirestoreDoc(contactId, props) {
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

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  if (!isValidRequest(req)) {
    res.status(401).json({ error: 'Secreto invalido o faltante' });
    return;
  }

  const props = req.body || {};
  const contactId = props.contactId;

  if (!contactId) {
    res.status(400).json({ error: 'Falta contactId en el body' });
    return;
  }

  try {
    if (props.nf_tipo_contacto !== 'profesional') {
      res.status(200).json({ contactId, skipped: true, reason: 'no es profesional' });
      return;
    }

    const doc = mapToFirestoreDoc(contactId, props);
    await db.collection('profesionales').doc(String(contactId)).set(doc, { merge: true });

    res.status(200).json({ contactId, synced: true });
  } catch (err) {
    res.status(500).json({ contactId, error: err.message });
  }
};
