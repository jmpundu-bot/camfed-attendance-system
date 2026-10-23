const fs = require('fs');
const path = require('path');
require('../load-env');
const { pool } = require('../database');

async function main() {
  if (!pool) throw new Error('Set DATABASE_URL or POSTGRES_URL before importing JSON records.');
  const dataPath = path.join(__dirname, '..', 'data', 'data.json');
  if (!fs.existsSync(dataPath)) throw new Error(`No JSON data file found at ${dataPath}`);
  const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  const client = await pool.connect();
  let importedEvents = 0;
  let importedAttendees = 0;
  try {
    await client.query('BEGIN');
    for (const event of data.events || []) {
      const createdAt = event.created_at || new Date().toISOString();
      const expiresAt = event.registration_expires_at || new Date(Date.parse(createdAt) + 2 * 60 * 60 * 1000).toISOString();
      const result = await client.query(
        `INSERT INTO events (id, name, date, venue, slug, created_at, registration_expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
        [event.id, event.name, event.date, event.venue, event.slug, createdAt, expiresAt]
      );
      importedEvents += result.rowCount;
    }
    for (const attendee of data.attendees || []) {
      let signature = null;
      if (attendee.signature_file) {
        const signaturePath = path.join(__dirname, '..', 'signatures', path.basename(attendee.signature_file));
        if (fs.existsSync(signaturePath)) signature = fs.readFileSync(signaturePath);
      }
      if (!signature) console.warn(`Attendee ${attendee.id} has no local signature image; importing the attendee record without one.`);
      const result = await client.query(
        `INSERT INTO attendees
          (id, full_name, gender, designation, organisation, phone_number, nrc_number, district,
           mobile_registered_name, signature_data, event_id, confirmation_token, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (id) DO NOTHING`,
        [attendee.id, attendee.full_name, attendee.gender, attendee.designation, attendee.organisation,
          attendee.phone_number, attendee.nrc_number, attendee.district, attendee.mobile_registered_name,
          signature, attendee.event_id, attendee.confirmation_token, attendee.created_at || new Date().toISOString()]
      );
      importedAttendees += result.rowCount;
    }
    await client.query("SELECT setval(pg_get_serial_sequence('events','id'), GREATEST(COALESCE((SELECT MAX(id) FROM events), 1), 1), EXISTS (SELECT 1 FROM events))");
    await client.query("SELECT setval(pg_get_serial_sequence('attendees','id'), GREATEST(COALESCE((SELECT MAX(id) FROM attendees), 1), 1), EXISTS (SELECT 1 FROM attendees))");
    await client.query('COMMIT');
    console.log(`Imported ${importedEvents} event(s) and ${importedAttendees} attendee record(s).`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(async () => { if (pool) await pool.end(); });
