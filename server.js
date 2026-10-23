const express = require('express');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('./load-env');
const { pool, enabled: usePostgres } = require('./database');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const IS_VERCEL = process.env.VERCEL === '1';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ChangeThisPassword123!';
const SESSION_SECRET = process.env.SESSION_SECRET || 'camfed-local-session-secret-change-me';

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
// Vercel's deployed application directory is read-only. Use /tmp for runtime
// files there; local development keeps the existing project directories.
const RUNTIME_DIR = IS_VERCEL ? path.join('/tmp', 'camfed-attendance-system') : ROOT;
const DATA_DIR = path.join(RUNTIME_DIR, 'data');
const SIG_DIR = path.join(RUNTIME_DIR, 'signatures');
const PDF_DIR = path.join(RUNTIME_DIR, 'pdfs');
const DATA_FILE = path.join(DATA_DIR, 'data.json');
[DATA_DIR, SIG_DIR, PDF_DIR].forEach(dir => fs.mkdirSync(dir, { recursive: true }));

function loadData() {
  if (!fs.existsSync(DATA_FILE)) return { nextEventId: 1, nextAttendeeId: 1, events: [], attendees: [] };
  try {
    const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return { nextEventId: d.nextEventId || 1, nextAttendeeId: d.nextAttendeeId || 1, events: d.events || [], attendees: d.attendees || [] };
  } catch (e) {
    console.error('Could not read data.json:', e.message);
    return { nextEventId: 1, nextAttendeeId: 1, events: [], attendees: [] };
  }
}
let data = loadData();
if (IS_VERCEL && !usePostgres) console.warn('DATABASE_URL is not configured. Vercel is using temporary local JSON storage.');
function saveData() {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, DATA_FILE);
}

function slugify(value) { return String(value).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70); }
function uniqueSlug(name) {
  const base = slugify(name) || 'event'; let slug = base; let n = 2;
  while (data.events.some(e => e.slug === slug)) slug = `${base}-${n++}`;
  return slug;
}
function slugBase(name) { return slugify(name) || 'event'; }
async function findEventBySlug(slug) {
  if (!usePostgres) return data.events.find(e => e.slug === slug);
  const result = await pool.query("SELECT id,name,TO_CHAR(date,'YYYY-MM-DD') AS date,venue,slug,created_at,registration_expires_at FROM events WHERE slug=$1", [slug]);
  return result.rows[0];
}
async function findEventById(id) {
  if (!usePostgres) return data.events.find(e => e.id === Number(id));
  const result = await pool.query("SELECT id,name,TO_CHAR(date,'YYYY-MM-DD') AS date,venue,slug,created_at,registration_expires_at FROM events WHERE id=$1", [id]);
  return result.rows[0];
}
async function latestEvent() {
  if (!usePostgres) return [...data.events].sort((a,b) => b.id-a.id)[0];
  const result = await pool.query("SELECT id,name,TO_CHAR(date,'YYYY-MM-DD') AS date,venue,slug,created_at,registration_expires_at FROM events ORDER BY id DESC LIMIT 1");
  return result.rows[0];
}
async function listEvents() {
  if (!usePostgres) return [...data.events].sort((a,b)=>b.id-a.id).map(e => ({...e, attendee_count:attendeesForEvent(e.id).length}));
  const result = await pool.query("SELECT e.id,e.name,TO_CHAR(e.date,'YYYY-MM-DD') AS date,e.venue,e.slug,e.created_at,e.registration_expires_at,COUNT(a.id)::int AS attendee_count FROM events e LEFT JOIN attendees a ON a.event_id=e.id GROUP BY e.id ORDER BY e.id DESC");
  return result.rows;
}
async function listEventAttendees(eventId, includeSignature = false) {
  if (!usePostgres) return attendeesForEvent(eventId);
  const signatureColumn = includeSignature ? ',signature_data' : '';
  const result = await pool.query(`SELECT id,full_name,gender,designation,organisation,phone_number,nrc_number,district,mobile_registered_name,event_id,confirmation_token,created_at${signatureColumn} FROM attendees WHERE event_id=$1 ORDER BY id`, [eventId]);
  return result.rows;
}
async function findRegistrationDetails(token) {
  if (!usePostgres) {
    const attendee = data.attendees.find(a => a.confirmation_token === token);
    if (!attendee) return null;
    const event = data.events.find(e => e.id === attendee.event_id);
    return { attendee, event };
  }
  const result = await pool.query("SELECT a.full_name,a.gender,a.designation,a.organisation,a.phone_number,a.nrc_number,a.district,a.mobile_registered_name,a.created_at,TO_CHAR(e.date,'YYYY-MM-DD') AS event_date,e.name AS event_name,e.venue FROM attendees a LEFT JOIN events e ON e.id=a.event_id WHERE a.confirmation_token=$1", [token]);
  const row = result.rows[0];
  if (!row) return null;
  return { attendee:row, event: {name:row.event_name,date:row.event_date,venue:row.venue} };
}
async function createEventRecord(name, date, venue, createdAt) {
  if (!usePostgres) {
    const event = {id:data.nextEventId++,name,date,venue,slug:uniqueSlug(name),created_at:createdAt.toISOString(),registration_expires_at:new Date(createdAt.getTime()+REGISTRATION_WINDOW_MS).toISOString()};
    data.events.push(event); saveData(); return event;
  }
  const base = slugBase(name);
  for (let suffix = 1; suffix < 1000; suffix++) {
    const slug = suffix === 1 ? base : `${base}-${suffix}`;
    try {
      const result = await pool.query("INSERT INTO events (name,date,venue,slug,created_at,registration_expires_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,name,TO_CHAR(date,'YYYY-MM-DD') AS date,venue,slug,created_at,registration_expires_at", [name,date,venue,slug,createdAt.toISOString(),new Date(createdAt.getTime()+REGISTRATION_WINDOW_MS).toISOString()]);
      return result.rows[0];
    } catch (error) { if (error.code !== '23505') throw error; }
  }
  throw new Error('Could not create a unique event link.');
}
async function hasDuplicateAttendee(eventId, phone, nrc) {
  if (!usePostgres) {
    const existing = attendeesForEvent(eventId);
    return { phone:existing.some(a=>String(a.phone_number).trim()===phone), nrc:existing.some(a=>String(a.nrc_number).trim().toLowerCase()===nrc.toLowerCase()) };
  }
  const result = await pool.query('SELECT EXISTS(SELECT 1 FROM attendees WHERE event_id=$1 AND phone_number=$2) AS phone, EXISTS(SELECT 1 FROM attendees WHERE event_id=$1 AND LOWER(nrc_number)=LOWER($3)) AS nrc', [eventId,phone,nrc]);
  return result.rows[0];
}
async function createAttendeeRecord(fields, signatureBuffer) {
  if (!usePostgres) {
    const id = data.nextAttendeeId++;
    const signatureFile = saveSignatureBuffer(signatureBuffer,id);
    const attendee = {...fields,id,signature_file:signatureFile};
    data.attendees.push(attendee); saveData(); return attendee;
  }
  const result = await pool.query(`INSERT INTO attendees (full_name,gender,designation,organisation,phone_number,nrc_number,district,mobile_registered_name,signature_data,event_id,confirmation_token,created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`, [fields.full_name,fields.gender,fields.designation,fields.organisation,fields.phone_number,fields.nrc_number,fields.district,fields.mobile_registered_name,signatureBuffer,fields.event_id,fields.confirmation_token,fields.created_at]);
  return {...fields,id:result.rows[0].id};
}
async function deleteEventRecord(eventId) {
  if (!usePostgres) {
    const eventIndex = data.events.findIndex(e => e.id === Number(eventId));
    if (eventIndex < 0) return null;
    const removedAttendees = data.attendees.filter(a => a.event_id === Number(eventId));
    for (const attendee of removedAttendees) {
      if (attendee.signature_file) { const signaturePath=path.join(SIG_DIR,path.basename(attendee.signature_file)); if(fs.existsSync(signaturePath))fs.unlinkSync(signaturePath); }
    }
    data.attendees=data.attendees.filter(a=>a.event_id!==Number(eventId));
    const [removedEvent]=data.events.splice(eventIndex,1); saveData();
    return {event:removedEvent,attendeeCount:removedAttendees.length};
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const event = await client.query("SELECT id,name,TO_CHAR(date,'YYYY-MM-DD') AS date,venue,slug,created_at,registration_expires_at FROM events WHERE id=$1 FOR UPDATE",[eventId]);
    if (!event.rows[0]) { await client.query('ROLLBACK'); return null; }
    const count = await client.query('SELECT COUNT(*)::int AS count FROM attendees WHERE event_id=$1',[eventId]);
    await client.query('DELETE FROM events WHERE id=$1',[eventId]);
    await client.query('COMMIT');
    return {event:event.rows[0],attendeeCount:count.rows[0].count};
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
async function deleteAttendeeRecord(id) {
  if (!usePostgres) {
    const index=data.attendees.findIndex(a=>a.id===Number(id)); if(index<0)return null;
    const [attendee]=data.attendees.splice(index,1); saveData();
    if(attendee.signature_file){const p=path.join(SIG_DIR,path.basename(attendee.signature_file));if(fs.existsSync(p))fs.unlinkSync(p);}
    return attendee;
  }
  const result=await pool.query('DELETE FROM attendees WHERE id=$1 RETURNING id,event_id',[id]);
  return result.rows[0] || null;
}
function signSession(username) {
  const payload = Buffer.from(JSON.stringify({ username, exp: Date.now() + 8 * 60 * 60 * 1000 })).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
function verifySession(token) {
  try {
    if (!token || !token.includes('.')) return false;
    const [payload, sig] = token.split('.');
    const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
    const d = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return d.username === ADMIN_USERNAME && d.exp > Date.now();
  } catch { return false; }
}
function getCookie(req, name) {
  const raw = req.headers.cookie || '';
  const match = raw.split(';').map(s => s.trim()).find(s => s.startsWith(name + '='));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : '';
}
function requireAdmin(req, res, next) {
  if (!verifySession(getCookie(req, 'camfed_session'))) return res.status(401).json({ error: 'Admin login required.' });
  next();
}
function parseSignature(dataUrl) {
  if (!/^data:image\/png;base64,/.test(dataUrl || '')) throw new Error('Invalid signature image.');
  const buffer = Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64');
  if (buffer.length < 100 || buffer.length > 2 * 1024 * 1024) throw new Error('Signature image size is invalid.');
  return buffer;
}
function saveSignatureBuffer(buffer, attendeeId) {
  const filename = `signature-${attendeeId}-${Date.now()}.png`;
  fs.writeFileSync(path.join(SIG_DIR, filename), buffer);
  return filename;
}
const REGISTRATION_WINDOW_MS = 2 * 60 * 60 * 1000;
function eventExpiryMs(event) {
  const storedExpiry = Date.parse(event.registration_expires_at || '');
  if (Number.isFinite(storedExpiry)) return storedExpiry;
  const created = Date.parse(event.created_at || '');
  // Older records without a valid creation timestamp are closed safely rather than left open indefinitely.
  return Number.isFinite(created) ? created + REGISTRATION_WINDOW_MS : 0;
}
function isRegistrationExpired(event) { return Date.now() >= eventExpiryMs(event); }
function attendeesForEvent(eventId) { return data.attendees.filter(a => a.event_id === Number(eventId)).sort((a,b) => a.id-b.id); }
function publicBaseUrl(req) {
  return String(process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}
function buildCsv(event, attendees) {
  const rows = [
    ['Provider Id*', 'Reciever Msisdn*', 'Amount*', 'Remarks', 'Payer Wallet Type Id*(N-Normal/S-Salary)'],
    ...attendees.map(a => ['', a.phone_number, '', '', ''])
  ];
  return '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n');
}
async function makeQrPdfBuffer(event, link) {
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=600x600&format=png&data=${encodeURIComponent(link)}`;
  const response = await fetch(qrUrl);
  if (!response.ok) throw new Error('Could not retrieve the QR code image. Check the server internet connection and try again.');
  const qrBuffer = Buffer.from(await response.arrayBuffer());
  const doc = new PDFDocument({ size: 'A4', margins: { top: 40, bottom: 40, left: 40, right: 40 } });
  const chunks = [];
  doc.on('data', chunk => chunks.push(chunk));
  const finished = new Promise((resolve, reject) => { doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });
  doc.font('Helvetica-Bold').fontSize(20).text('CAMFED Event Registration', { align: 'center' });
  doc.moveDown(0.8).font('Helvetica-Bold').fontSize(15).text(event.name, { align: 'center' });
  doc.moveDown(0.5).font('Helvetica').fontSize(11).text(`Date: ${event.date}\nVenue: ${event.venue}`, { align: 'center' });
  doc.image(qrBuffer, 170, 175, { fit: [270, 270], align: 'center' });
  doc.fontSize(11).text('Scan this QR code to register for the event', 50, 465, { align: 'center', width: 495 });
  doc.fontSize(9).text(link, 50, 490, { align: 'center', width: 495 });
  doc.end();
  return finished;
}

app.use(express.json({ limit: '3mb' }));
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));
app.get('/registration-success', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'success.html')));
app.get('/registration-details', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'attendee-details.html')));
app.get('/api/registration-details/:token', async (req, res) => {
  const token = String(req.params.token || '');
  if (!/^[a-f0-9]{64}$/.test(token)) return res.status(404).json({ error: 'Registration details could not be found.' });
  const record = await findRegistrationDetails(token);
  if (!record) return res.status(404).json({ error: 'Registration details could not be found.' });
  const {attendee,event} = record;
  res.json({ fullName: attendee.full_name, gender: attendee.gender, designation: attendee.designation, organisation: attendee.organisation, phoneNumber: attendee.phone_number, nrcNumber: attendee.nrc_number, district: attendee.district, mobileRegisteredName: attendee.mobile_registered_name, registeredAt: attendee.created_at, eventName: event ? event.name : 'CAMFED event', eventDate: event ? event.date : '', venue: event ? event.venue : '' });
});
app.get('/admin.html', (req, res) => res.redirect('/admin'));
app.get('/register', async (req, res) => {
  const event = await latestEvent();
  return event ? res.redirect(`/register/${encodeURIComponent(event.slug)}`) : res.sendFile(path.join(PUBLIC_DIR, 'register.html'));
});
app.get('/register/:slug', async (req, res) => {
  if (!await findEventBySlug(req.params.slug)) return res.status(404).sendFile(path.join(PUBLIC_DIR, '404.html'));
  res.sendFile(path.join(PUBLIC_DIR, 'register.html'));
});
app.use(express.static(PUBLIC_DIR));

app.get('/api/event/:slug', async (req, res) => {
  const e = await findEventBySlug(req.params.slug);
  if (!e) return res.status(404).json({ error: 'Event not found.' });
  res.json({ id:e.id, name:e.name, date:e.date, venue:e.venue, slug:e.slug, expiresAt:new Date(eventExpiryMs(e)).toISOString(), expired:isRegistrationExpired(e) });
});
app.get('/api/event', async (req, res) => {
  const e = await latestEvent();
  if (!e) return res.status(404).json({ error: 'No event has been created yet.' });
  res.json({ id:e.id, name:e.name, date:e.date, venue:e.venue, slug:e.slug, expiresAt:new Date(eventExpiryMs(e)).toISOString(), expired:isRegistrationExpired(e) });
});

app.post('/api/attendees', async (req, res) => {
  const b = req.body;
  const required = ['fullName','gender','designation','organisation','phoneNumber','nrcNumber','district','mobileRegisteredName','signature'];
  if (required.some(k => !String(b[k] || '').trim())) return res.status(400).json({ error: 'Please complete all required fields.' });
  const event = b.eventSlug ? await findEventBySlug(b.eventSlug) : await latestEvent();
  if (!event) return res.status(400).json({ error: 'No event is available for registration.' });
  if (isRegistrationExpired(event)) return res.status(410).json({ error: 'Registration for this event has expired. The registration link was valid for two hours after the event was created. Please contact the event administrator.' });
  const phone = String(b.phoneNumber).trim();
  const nrc = String(b.nrcNumber).trim();
  if (!/^(09|07)[0-9]{8}$/.test(phone)) return res.status(400).json({ error: 'Enter a valid Zambian mobile number, e.g. 0971234567.' });
  if (!/^[0-9]{6}\/[0-9]{2}\/[0-9]$/.test(nrc)) return res.status(400).json({ error: 'Enter NRC in the format 123456/12/1.' });
  // Prevent duplicate registrations for the same event. Phone and NRC are unique identifiers.
  const duplicate = await hasDuplicateAttendee(event.id,phone,nrc);
  if (duplicate.phone) {
    return res.status(409).json({ error: 'This phone number is already registered for this event. Please check the details or contact the event administrator.' });
  }
  if (duplicate.nrc) {
    return res.status(409).json({ error: 'This NRC number is already registered for this event. Please check the details or contact the event administrator.' });
  }
  const confirmationToken = crypto.randomBytes(32).toString('hex');
  let signatureBuffer;
  try { signatureBuffer = parseSignature(String(b.signature)); } catch (e) { return res.status(400).json({ error: e.message }); }
  const fields = {full_name:String(b.fullName).trim(),gender:String(b.gender).trim(),designation:String(b.designation).trim(),organisation:String(b.organisation).trim(),phone_number:phone,nrc_number:nrc,district:String(b.district).trim(),mobile_registered_name:String(b.mobileRegisteredName).trim(),event_id:event.id,confirmation_token:confirmationToken,created_at:new Date().toISOString()};
  try {
    const attendee = await createAttendeeRecord(fields,signatureBuffer);
    res.status(201).json({ message:'Registration successful.', id:attendee.id, confirmationToken });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'This phone number or NRC number is already registered for this event.' });
    throw error;
  }
});

app.post('/api/admin/login', (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Invalid username or password.' });
  res.setHeader('Set-Cookie', `camfed_session=${encodeURIComponent(signSession(username))}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800`);
  res.json({ message:'Login successful.' });
});
app.post('/api/admin/logout', (req,res) => { res.setHeader('Set-Cookie','camfed_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'); res.json({message:'Logged out.'}); });
app.get('/api/admin/me', requireAdmin, (req,res) => res.json({ username:ADMIN_USERNAME }));
app.get('/api/admin/events', requireAdmin, async (req,res) => res.json(await listEvents()));
app.post('/api/admin/events', requireAdmin, async (req,res) => {
  const {name,date,venue}=req.body;
  if (!String(name||'').trim() || !String(date||'').trim() || !String(venue||'').trim()) return res.status(400).json({error:'Event name, date and venue are required.'});
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date)) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) return res.status(400).json({error:'Enter a valid event date.'});
  const createdAt = new Date();
  const e=await createEventRecord(String(name).trim(),String(date).trim(),String(venue).trim(),createdAt);
  const link = `${publicBaseUrl(req)}/register/${e.slug}`;
  res.status(201).json({id:e.id,slug:e.slug,link,expiresAt:e.registration_expires_at,message:'Event created. Share the registration link or download the QR-code PDF from the event card.'});
});
app.delete('/api/admin/events/:id', requireAdmin, async (req,res) => {
  const eventId = Number(req.params.id);
  const removed=await deleteEventRecord(eventId);
  if (!removed) return res.status(404).json({ error: 'Event not found.' });

  // Remove this event's generated attendance PDF, if one exists.
  const safeSlug = String(removed.event.slug || '').replace(/[^a-z0-9-]/gi, '_');
  const pdfPath = path.join(PDF_DIR, `${safeSlug}-attendance.pdf`);
  if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath);

  res.json({ message: 'Event and its attendee records deleted.', deletedAttendees: removed.attendeeCount });
});
app.get('/api/admin/events/:id/attendees', requireAdmin, async (req,res) => {
  const e=await findEventById(req.params.id); if(!e)return res.status(404).json({error:'Event not found.'});
  const attendees=await listEventAttendees(e.id);
  res.json({event:e,attendees});
});
function csvCell(value) {
  // Quote every cell and escape embedded quotes. Keep phone numbers as text in the CSV.
  return '"' + String(value ?? '').replace(/"/g, '""') + '"';
}
app.get('/api/admin/events/:id/csv', requireAdmin, async (req,res) => {
  const e = await findEventById(req.params.id);
  if (!e) return res.status(404).json({ error: 'Event not found.' });
  const attendees=await listEventAttendees(e.id);
  const safe = e.slug.replace(/[^a-z0-9-]/gi, '_');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${safe}-attendees.csv"`);
  res.send(buildCsv(e,attendees));
});
app.delete('/api/admin/attendees/:id', requireAdmin, async (req,res) => {
  const a=await deleteAttendeeRecord(req.params.id); if(!a)return res.status(404).json({error:'Attendee not found.'});
  res.json({message:'Attendee deleted.'});
});

function fitText(doc,text,x,y,width,options={}){
  const size=options.size||7;
  doc.font(options.font||'Helvetica').fontSize(size);
  doc.text(String(text??''),x,y,{width,height:options.height||20,ellipsis:true,align:options.align||'left',lineBreak:false,continued:false});
}
function makePdf(event,attendees,filePath){
  const doc=new PDFDocument({size:'A4',layout:'landscape',margins:{top:28,bottom:28,left:28,right:28},bufferPages:true});
  const stream=fs.createWriteStream(filePath);doc.pipe(stream);
  const logoPath=path.join(PUBLIC_DIR,'images','camfed-logo.png');

  // A4 landscape printable width = 842 - 56 = 786 points.
  // Every field is represented in one compact row per person.
  const cols=[24,100,48,80,105,70,65,68,90,136];
  const headers=['No.','Full Name','Gender','Designation','Organisation','Phone','NRC Number','District','Mobile Name','Signature'];
  const tableX=28, pageBottom=535, headerH=20, rowH=21, rowsPerPage=20;

  function pageWatermark(){
    if(!fs.existsSync(logoPath)) return;
    doc.save();
    doc.opacity(0.08);
    doc.image(logoPath,170,180,{fit:[650,325],align:'center',valign:'center'});
    doc.restore();
  }
  function pageHeader(){
    pageWatermark();
    if(fs.existsSync(logoPath)) doc.image(logoPath,28,22,{fit:[115,45]});
    doc.font('Helvetica-Bold').fontSize(16).text('CAMFED ATTENDANCE REGISTER',155,28,{width:600,align:'center'});
    doc.font('Helvetica').fontSize(9).text(event.name,155,49,{width:600,align:'center'});
    doc.fontSize(8).text(`Date: ${event.date}    Venue: ${event.venue}    Total: ${attendees.length}`,155,64,{width:600,align:'center'});
    let x=tableX;
    headers.forEach((h,i)=>{
      doc.rect(x,82,cols[i],headerH).stroke();
      fitText(doc,h,x+2,87,cols[i]-4,{font:'Helvetica-Bold',size:5.8,height:10,align:'center'});
      x+=cols[i];
    });
  }

  let y=102;
  let rowOnPage=0;
  pageHeader();
  attendees.forEach((a,index)=>{
    if(rowOnPage >= rowsPerPage || y+rowH>pageBottom){doc.addPage();pageHeader();y=102;rowOnPage=0;}
    // All registered details are kept on ONE horizontal row for each person.
    const vals=[
      index+1,
      a.full_name,
      a.gender,
      a.designation,
      a.organisation,
      a.phone_number,
      a.nrc_number,
      a.district,
      a.mobile_registered_name,
      ''
    ];
    let x=tableX;
    vals.forEach((v,i)=>{
      doc.rect(x,y,cols[i],rowH).stroke();
      if(i===9){
        const sig=a.signature_data || (a.signature_file && path.join(SIG_DIR,a.signature_file));
        if(sig && (Buffer.isBuffer(sig) || fs.existsSync(sig))) doc.image(sig,x+4,y+4,{fit:[cols[i]-8,rowH-8],align:'center',valign:'center'});
      } else {
        fitText(doc,v,x+2,y+5,cols[i]-4,{size:i===1?5.7:5.5,height:11,align:i===0?'center':'left'});
      }
      x+=cols[i];
    });
    y+=rowH;
    rowOnPage++;
  });

  const range=doc.bufferedPageRange();
  for(let i=range.start;i<range.start+range.count;i++){
    doc.switchToPage(i);
    doc.font('Helvetica').fontSize(7).text(`CAMFED Attendance Register  |  Page ${i+1} of ${range.count}`,28,570,{width:785,align:'center'});
  }
  doc.end();
  return new Promise((resolve,reject)=>{stream.on('finish',()=>resolve(filePath));stream.on('error',reject);});
}
app.get('/api/admin/events/:id/pdf',requireAdmin,async(req,res)=>{const e=await findEventById(req.params.id);if(!e)return res.status(404).json({error:'Event not found.'});const a=await listEventAttendees(e.id,true);if(!a.length)return res.status(400).json({error:'No attendee details are available yet, so an attendance PDF cannot be generated.'});const safe=e.slug.replace(/[^a-z0-9-]/gi,'_');const filePath=path.join(PDF_DIR,`${safe}-attendance.pdf`);try{await makePdf(e,a,filePath);res.download(filePath,`${safe}-attendance.pdf`);}catch(err){console.error(err);res.status(500).json({error:'PDF generation failed.'});}});

app.use((req,res,next)=>{if(req.method==='GET'&&req.accepts('html'))return res.status(404).sendFile(path.join(PUBLIC_DIR,'404.html'));next();});
app.use((err,req,res,next)=>{console.error(err);res.status(500).json({error:'Internal server error.'});});

if (require.main === module) {
  const server = app.listen(PORT, () => {
    console.log(`CAMFED Attendance System running at http://localhost:${PORT}`);
    console.log(`Admin: http://localhost:${PORT}/admin`);
    console.log(`Login username: ${ADMIN_USERNAME}`);
    console.log(`Login password: ${ADMIN_PASSWORD}`);
  });
  function shutdown() { server.close(() => process.exit(0)); }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = app;
