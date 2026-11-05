ALTER TABLE properties ADD COLUMN create_key TEXT;
ALTER TABLE properties ADD COLUMN create_hash TEXT;
CREATE UNIQUE INDEX properties_create_key ON properties(owner_id,create_key);

ALTER TABLE property_gps ADD COLUMN components TEXT CHECK(components IS NULL OR json_valid(components));

INSERT OR IGNORE INTO users(id,name,stamp) VALUES('system:enricher','Public Data Enrichment','SYSTEM-ENRICHER');

CREATE TABLE property_identity (
  property_id TEXT NOT NULL REFERENCES properties(id),
  jurisdiction TEXT NOT NULL,
  identifier_type TEXT NOT NULL,
  identifier_value TEXT NOT NULL,
  source_id TEXT NOT NULL,
  matched_address TEXT NOT NULL,
  verified_at TEXT NOT NULL,
  PRIMARY KEY(property_id,jurisdiction,identifier_type,identifier_value,matched_address)
);
CREATE INDEX property_identity_lookup ON property_identity(jurisdiction,identifier_type,identifier_value);

CREATE TABLE property_enrichment_jobs (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL REFERENCES properties(id),
  owner_id TEXT NOT NULL REFERENCES users(id),
  source_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','complete','manual_review','unavailable','failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
  next_attempt_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  lease_token TEXT,
  lease_until TEXT,
  event_key TEXT NOT NULL UNIQUE,
  matched_address TEXT,
  requested_by TEXT NOT NULL REFERENCES users(id)
);
CREATE INDEX enrichment_due ON property_enrichment_jobs(status,next_attempt_at,lease_until);
CREATE INDEX enrichment_property ON property_enrichment_jobs(property_id,created_at);

CREATE TABLE property_source_records (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL REFERENCES properties(id),
  source_id TEXT NOT NULL,
  source_record_id TEXT NOT NULL,
  matched_address TEXT NOT NULL,
  match_method TEXT NOT NULL CHECK(match_method IN ('parcel_id','exact_address')),
  match_confidence TEXT NOT NULL CHECK(match_confidence IN ('exact_parcel','strong_address')),
  raw_json TEXT NOT NULL CHECK(json_valid(raw_json)),
  content_hash TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  source_updated_at TEXT,
  superseded_at TEXT,
  UNIQUE(property_id,source_id,source_record_id,matched_address,content_hash)
);
CREATE INDEX source_records_current ON property_source_records(property_id,source_id,superseded_at);

CREATE TABLE property_attributes (
  property_id TEXT NOT NULL REFERENCES properties(id),
  source_id TEXT NOT NULL,
  attribute_key TEXT NOT NULL,
  value_json TEXT NOT NULL CHECK(json_valid(value_json)),
  source_record_id TEXT NOT NULL REFERENCES property_source_records(id),
  observed_at TEXT NOT NULL,
  PRIMARY KEY(property_id,source_id,attribute_key)
);

CREATE TRIGGER enrichment_job_created_history AFTER INSERT ON property_enrichment_jobs BEGIN
  INSERT INTO property_history(property_id,actor_id,actor_name,actor_stamp,action,after_data)
  SELECT NEW.property_id,u.id,u.name,u.stamp,'enrichment_requested',
    json_object('jobId',NEW.id,'source',NEW.source_id,'status',NEW.status)
  FROM users u WHERE u.id=NEW.requested_by;
END;
CREATE TRIGGER enrichment_job_updated_history AFTER UPDATE OF status ON property_enrichment_jobs
WHEN NEW.status IS NOT OLD.status BEGIN
  INSERT INTO property_history(property_id,actor_id,actor_name,actor_stamp,action,before_data,after_data)
  SELECT NEW.property_id,u.id,u.name,u.stamp,'enrichment_updated',
    json_object('jobId',OLD.id,'status',OLD.status),
    json_object('jobId',NEW.id,'source',NEW.source_id,'status',NEW.status,'attempts',NEW.attempts,'error',NEW.last_error)
  FROM users u WHERE u.id='system:enricher';
END;
