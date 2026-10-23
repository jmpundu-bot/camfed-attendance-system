const express = require('express');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Load .env without requiring a native module or an extra dependency.
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ChangeThisPassword123!';
const SESSION_SECRET = process.env.SESSION_SECRET || 'camfed-local-session-secret-change-me';

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const SIG_DIR = path.join(ROOT, 'signatures');
const PDF_DIR = path.join(ROOT, 'pdfs');
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
function saveSignature(dataUrl, attendeeId) {
  if (!/^data:image\/png;base64,/.test(dataUrl || '')) throw new Error('Invalid signature image.');
  const buffer = Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64');
  if (buffer.length < 100 || buffer.length > 2 * 1024 * 1024) throw new Error('Signature image size is invalid.');
  const filename = `signature-${attendeeId}-${Date.now()}.png`;
  fs.writeFileSync(path.join(SIG_DIR, filename), buffer);
  return filename;
}
function findEventBySlug(slug) { return data.events.find(e => e.slug === slug); }
const REGISTRATION_WINDOW_MS = 2 * 60 * 60 * 1000;
function eventExpiryMs(event) {
  const created = Date.parse(event.created_at || '');
  // Older records without a valid creation timestamp are closed safely rather than left open indefinitely.
  return Number.isFinite(created) ? created + REGISTRATION_WINDOW_MS : 0;
}
function isRegistrationExpired(event) { return Date.now() >= eventExpiryMs(event); }
function attendeesForEvent(eventId) { return data.attendees.filter(a => a.event_id === Number(eventId)).sort((a,b) => a.id-b.id); }
function publicBaseUrl(req) {
  return String(process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}
function buildCsv(event) {
  const rows = [
    ['Provider Id*', 'Reciever Msisdn*', 'Amount*', 'Remarks', 'Payer Wallet Type Id*(N-Normal/S-Salary)'],
    ...attendeesForEvent(event.id).map(a => ['', a.phone_number, '', '', ''])
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
app.get('/api/registration-details/:token', (req, res) => {
  const token = String(req.params.token || '');
  if (!/^[a-f0-9]{64}$/.test(token)) return res.status(404).json({ error: 'Registration details could not be found.' });
  const attendee = data.attendees.find(a => a.confirmation_token === token);
  if (!attendee) return res.status(404).json({ error: 'Registration details could not be found.' });
  const event = data.events.find(e => e.id === attendee.event_id);
  res.json({ fullName: attendee.full_name, gender: attendee.gender, designation: attendee.designation, organisation: attendee.organisation, phoneNumber: attendee.phone_number, nrcNumber: attendee.nrc_number, district: attendee.district, mobileRegisteredName: attendee.mobile_registered_name, registeredAt: attendee.created_at, eventName: event ? event.name : 'CAMFED event', eventDate: event ? event.date : '', venue: event ? event.venue : '' });
});
app.get('/admin.html', (req, res) => res.redirect('/admin'));
app.get('/register', (req, res) => {
  const event = [...data.events].sort((a,b) => b.id-a.id)[0];
  return event ? res.redirect(`/register/${encodeURIComponent(event.slug)}`) : res.sendFile(path.join(PUBLIC_DIR, 'register.html'));
});
app.get('/register/:slug', (req, res) => {
  if (!findEventBySlug(req.params.slug)) return res.status(404).sendFile(path.join(PUBLIC_DIR, '404.html'));
  res.sendFile(path.join(PUBLIC_DIR, 'register.html'));
});
app.use(express.static(PUBLIC_DIR));

app.get('/api/event/:slug', (req, res) => {
  const e = findEventBySlug(req.params.slug);
  if (!e) return res.status(404).json({ error: 'Event not found.' });
  res.json({ id:e.id, name:e.name, date:e.date, venue:e.venue, slug:e.slug, expiresAt:new Date(eventExpiryMs(e)).toISOString(), expired:isRegistrationExpired(e) });
});
app.get('/api/event', (req, res) => {
  const e = [...data.events].sort((a,b) => b.id-a.id)[0];
  if (!e) return res.status(404).json({ error: 'No event has been created yet.' });
  res.json({ id:e.id, name:e.name, date:e.date, venue:e.venue, slug:e.slug, expiresAt:new Date(eventExpiryMs(e)).toISOString(), expired:isRegistrationExpired(e) });
});

app.post('/api/attendees', (req, res) => {
  const b = req.body;
  const required = ['fullName','gender','designation','organisation','phoneNumber','nrcNumber','district','mobileRegisteredName','signature'];
  if (required.some(k => !String(b[k] || '').trim())) return res.status(400).json({ error: 'Please complete all required fields.' });
  const event = b.eventSlug ? findEventBySlug(b.eventSlug) : [...data.events].sort((a,b) => b.id-a.id)[0];
  if (!event) return res.status(400).json({ error: 'No event is available for registration.' });
  if (isRegistrationExpired(event)) return res.status(410).json({ error: 'Registration for this event has expired. The registration link was valid for two hours after the event was created. Please contact the event administrator.' });
  const phone = String(b.phoneNumber).trim();
  const nrc = String(b.nrcNumber).trim();
  if (!/^(09|07)[0-9]{8}$/.test(phone)) return res.status(400).json({ error: 'Enter a valid Zambian mobile number, e.g. 0971234567.' });
  if (!/^[0-9]{6}\/[0-9]{2}\/[0-9]$/.test(nrc)) return res.status(400).json({ error: 'Enter NRC in the format 123456/12/1.' });
  // Prevent duplicate registrations for the same event. Phone and NRC are unique identifiers.
  const eventAttendees = attendeesForEvent(event.id);
  if (eventAttendees.some(a => String(a.phone_number).trim() === phone)) {
    return res.status(409).json({ error: 'This phone number is already registered for this event. Please check the details or contact the event administrator.' });
  }
  if (eventAttendees.some(a => String(a.nrc_number).trim().toLowerCase() === nrc.toLowerCase())) {
    return res.status(409).json({ error: 'This NRC number is already registered for this event. Please check the details or contact the event administrator.' });
  }
  const id = data.nextAttendeeId++;
  const confirmationToken = crypto.randomBytes(32).toString('hex');
  let signatureFile;
  try { signatureFile = saveSignature(String(b.signature), id); } catch (e) { return res.status(400).json({ error: e.message }); }
  data.attendees.push({ id, full_name:String(b.fullName).trim(), gender:String(b.gender).trim(), designation:String(b.designation).trim(), organisation:String(b.organisation).trim(), phone_number:phone, nrc_number:nrc, district:String(b.district).trim(), mobile_registered_name:String(b.mobileRegisteredName).trim(), signature_file:signatureFile, event_id:event.id, confirmation_token:confirmationToken, created_at:new Date().toISOString() });
  saveData();
  res.status(201).json({ message:'Registration successful.', id, confirmationToken });
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
app.get('/api/admin/events', requireAdmin, (req,res) => res.json([...data.events].sort((a,b)=>b.id-a.id).map(e => ({...e, attendee_count:attendeesForEvent(e.id).length}))));
app.post('/api/admin/events', requireAdmin, (req,res) => {
  const {name,date,venue}=req.body;
  if (!String(name||'').trim() || !String(date||'').trim() || !String(venue||'').trim()) return res.status(400).json({error:'Event name, date and venue are required.'});
  const createdAt = new Date();
  const e={id:data.nextEventId++,name:String(name).trim(),date:String(date).trim(),venue:String(venue).trim(),slug:uniqueSlug(name),created_at:createdAt.toISOString(),registration_expires_at:new Date(createdAt.getTime()+REGISTRATION_WINDOW_MS).toISOString()};
  data.events.push(e); saveData();
  const link = `${publicBaseUrl(req)}/register/${e.slug}`;
  res.status(201).json({id:e.id,slug:e.slug,link,expiresAt:e.registration_expires_at,message:'Event created. Share the registration link or download the QR-code PDF from the event card.'});
});
app.delete('/api/admin/events/:id', requireAdmin, (req,res) => {
  const eventId = Number(req.params.id);
  const eventIndex = data.events.findIndex(e => e.id === eventId);
  if (eventIndex < 0) return res.status(404).json({ error: 'Event not found.' });

  // Remove attendee records and their signature images together with the event.
  const removedAttendees = data.attendees.filter(a => a.event_id === eventId);
  for (const attendee of removedAttendees) {
    if (attendee.signature_file) {
      const signaturePath = path.join(SIG_DIR, path.basename(attendee.signature_file));
      if (fs.existsSync(signaturePath)) fs.unlinkSync(signaturePath);
    }
  }
  data.attendees = data.attendees.filter(a => a.event_id !== eventId);
  const [removedEvent] = data.events.splice(eventIndex, 1);
  saveData();

  // Remove this event's generated attendance PDF, if one exists.
  const safeSlug = String(removedEvent.slug || '').replace(/[^a-z0-9-]/gi, '_');
  const pdfPath = path.join(PDF_DIR, `${safeSlug}-attendance.pdf`);
  if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath);

  res.json({ message: 'Event and its attendee records deleted.', deletedAttendees: removedAttendees.length });
});
app.get('/api/admin/events/:id/attendees', requireAdmin, (req,res) => {
  const e=data.events.find(x=>x.id===Number(req.params.id)); if(!e)return res.status(404).json({error:'Event not found.'});
  res.json({event:e,attendees:attendeesForEvent(e.id)});
});
function csvCell(value) {
  // Quote every cell and escape embedded quotes. Keep phone numbers as text in the CSV.
  return '"' + String(value ?? '').replace(/"/g, '""') + '"';
}
app.get('/api/admin/events/:id/csv', requireAdmin, (req,res) => {
  const e = data.events.find(x => x.id === Number(req.params.id));
  if (!e) return res.status(404).json({ error: 'Event not found.' });
  const safe = e.slug.replace(/[^a-z0-9-]/gi, '_');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${safe}-attendees.csv"`);
  res.send(buildCsv(e));
});
app.delete('/api/admin/attendees/:id', requireAdmin, (req,res) => {
  const i=data.attendees.findIndex(a=>a.id===Number(req.params.id)); if(i<0)return res.status(404).json({error:'Attendee not found.'});
  const a=data.attendees[i]; data.attendees.splice(i,1); saveData();
  if(a.signature_file){const p=path.join(SIG_DIR,a.signature_file);if(fs.existsSync(p))fs.unlinkSync(p);}
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
        const sig=path.join(SIG_DIR,a.signature_file);
        if(fs.existsSync(sig)) doc.image(sig,x+4,y+4,{fit:[cols[i]-8,rowH-8],align:'center',valign:'center'});
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
app.get('/api/admin/events/:id/pdf',requireAdmin,async(req,res)=>{const e=data.events.find(x=>x.id===Number(req.params.id));if(!e)return res.status(404).json({error:'Event not found.'});const a=attendeesForEvent(e.id);if(!a.length)return res.status(400).json({error:'No attendee details are available yet, so an attendance PDF cannot be generated.'});const safe=e.slug.replace(/[^a-z0-9-]/gi,'_');const filePath=path.join(PDF_DIR,`${safe}-attendance.pdf`);try{await makePdf(e,a,filePath);res.download(filePath,`${safe}-attendance.pdf`);}catch(err){console.error(err);res.status(500).json({error:'PDF generation failed.'});}});

app.use((req,res,next)=>{if(req.method==='GET'&&req.accepts('html'))return res.status(404).sendFile(path.join(PUBLIC_DIR,'404.html'));next();});
app.use((err,req,res,next)=>{console.error(err);res.status(500).json({error:'Internal server error.'});});

const server=app.listen(PORT,()=>{console.log(`CAMFED Attendance System running at http://localhost:${PORT}`);console.log(`Admin: http://localhost:${PORT}/admin`);console.log(`Login username: ${ADMIN_USERNAME}`);console.log(`Login password: ${ADMIN_PASSWORD}`);});
function shutdown(){server.close(()=>process.exit(0));}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
