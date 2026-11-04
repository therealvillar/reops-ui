CREATE TABLE property_gps (
  normalized_query TEXT NOT NULL,
  matched_address TEXT NOT NULL CHECK(length(trim(matched_address)) BETWEEN 1 AND 1000),
  latitude REAL NOT NULL CHECK(latitude BETWEEN -90 AND 90),
  longitude REAL NOT NULL CHECK(longitude BETWEEN -180 AND 180),
  provider TEXT NOT NULL,
  benchmark TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  match_order INTEGER NOT NULL,
  PRIMARY KEY(normalized_query, matched_address, latitude, longitude)
);
