CREATE TABLE IF NOT EXISTS events (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  date DATE NOT NULL,
  venue TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  registration_expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS attendees (
  id SERIAL PRIMARY KEY,
  full_name TEXT NOT NULL,
  gender TEXT NOT NULL,
  designation TEXT NOT NULL,
  organisation TEXT NOT NULL,
  phone_number VARCHAR(10) NOT NULL,
  nrc_number VARCHAR(11) NOT NULL,
  district TEXT NOT NULL,
  mobile_registered_name TEXT NOT NULL,
  signature_data BYTEA,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  confirmation_token CHAR(64) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT attendees_event_phone_unique UNIQUE (event_id, phone_number)
);

CREATE UNIQUE INDEX IF NOT EXISTS attendees_event_nrc_unique
  ON attendees (event_id, LOWER(nrc_number));

CREATE INDEX IF NOT EXISTS attendees_event_id_idx ON attendees (event_id);
CREATE INDEX IF NOT EXISTS attendees_created_at_idx ON attendees (created_at DESC);
