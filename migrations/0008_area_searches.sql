CREATE TABLE area_searches (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL REFERENCES properties(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  county TEXT NOT NULL,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  radius_meters REAL NOT NULL,
  cutoff TEXT,
  fetched_at TEXT NOT NULL
);
CREATE INDEX area_searches_property ON area_searches(property_id, fetched_at);
CREATE TABLE area_search_sources (
  search_id TEXT NOT NULL REFERENCES area_searches(id),
  source_index INTEGER NOT NULL,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  status TEXT NOT NULL,
  message TEXT NOT NULL,
  limited INTEGER NOT NULL,
  date_field TEXT,
  date_meaning TEXT,
  PRIMARY KEY(search_id, source_index)
);
CREATE TABLE area_record_content (
  hash TEXT PRIMARY KEY,
  data TEXT NOT NULL CHECK(json_valid(data))
);
CREATE TABLE area_search_records (
  search_id TEXT NOT NULL,
  source_index INTEGER NOT NULL,
  position INTEGER NOT NULL,
  content_hash TEXT NOT NULL REFERENCES area_record_content(hash),
  PRIMARY KEY(search_id, source_index, position),
  FOREIGN KEY(search_id, source_index) REFERENCES area_search_sources(search_id, source_index)
);
