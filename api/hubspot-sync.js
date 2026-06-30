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

// Valida que el request traiga el secreto compartido correcto.
// El Workflow de HubSpot lo manda como query param (?secret=...) en la URL
// del webhook, configurado a mano una sola vez.
function isValidRequest(req) {
  const provided = req.query && req.query.secret;
  return Boolean(provided) && provided === process.env.HUBSPOT_WEBHOOK_SECRET;
}

// Mapea las propiedades de HubSpot al documento que guardamos en Firestore.
function mapToFirestoreDoc(contactId, props) {
  const servicios = props.nf_servicios
    ? props.nf_servicios.split(';').map((s) => s.trim()).filter(Boolean)
    : [];

  const coords = findCityCoords(props.nf_departamento, props.nf_ciudad);

  return {
    hubspotContactId: String(contactId),
    nombre:
