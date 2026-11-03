PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  stamp TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE bins (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  UNIQUE(owner_id, name)
);
CREATE TABLE properties (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  bin_id TEXT NOT NULL REFERENCES bins(id),
  creator_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_by TEXT NOT NULL REFERENCES users(id),
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  data TEXT NOT NULL CHECK(json_valid(data))
);
CREATE INDEX properties_owner ON properties(owner_id);
CREATE TABLE property_history (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  property_id TEXT NOT NULL REFERENCES properties(id),
  actor_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  actor_stamp TEXT NOT NULL,
  action TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  before_data TEXT,
  after_data TEXT NOT NULL
);
CREATE TRIGGER properties_owner_immutable BEFORE UPDATE ON properties
WHEN NEW.owner_id != OLD.owner_id OR NEW.creator_id != OLD.creator_id OR NEW.created_at != OLD.created_at
BEGIN SELECT RAISE(ABORT, 'immutable property attribution'); END;
CREATE TRIGGER properties_insert_history AFTER INSERT ON properties BEGIN
  INSERT INTO property_history(property_id,actor_id,actor_name,actor_stamp,action,after_data)
  SELECT NEW.id,u.id,u.name,u.stamp,'created',NEW.data FROM users u WHERE u.id=NEW.creator_id;
END;
CREATE TRIGGER properties_update_history AFTER UPDATE ON properties BEGIN
  INSERT INTO property_history(property_id,actor_id,actor_name,actor_stamp,action,before_data,after_data)
  SELECT NEW.id,u.id,u.name,u.stamp,'updated',OLD.data,NEW.data FROM users u WHERE u.id=NEW.updated_by;
END;
CREATE TRIGGER history_no_update BEFORE UPDATE ON property_history BEGIN SELECT RAISE(ABORT,'append-only history'); END;
CREATE TRIGGER history_no_delete BEFORE DELETE ON property_history BEGIN SELECT RAISE(ABORT,'append-only history'); END;
CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL REFERENCES properties(id),
  body TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES users(id),
  actor_name TEXT NOT NULL,
  actor_stamp TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TRIGGER notes_no_update BEFORE UPDATE ON notes BEGIN SELECT RAISE(ABORT,'append-only notes'); END;
CREATE TRIGGER notes_no_delete BEFORE DELETE ON notes BEGIN SELECT RAISE(ABORT,'append-only notes'); END;
CREATE TRIGGER notes_history AFTER INSERT ON notes BEGIN
  INSERT INTO property_history(property_id,actor_id,actor_name,actor_stamp,action,after_data)
  VALUES(NEW.property_id,NEW.actor_id,NEW.actor_name,NEW.actor_stamp,'note_added',json_object('id',NEW.id,'body',NEW.body));
END;
CREATE TABLE reminders (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL REFERENCES properties(id),
  owner_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  due_at TEXT NOT NULL,
  time_zone TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'scheduled' CHECK(state IN ('scheduled','delivered','completed','cancelled','failed')),
  error TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  updated_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX reminders_due ON reminders(state,due_at);
CREATE TRIGGER reminders_author_immutable BEFORE UPDATE ON reminders
WHEN NEW.created_by != OLD.created_by OR NEW.created_at != OLD.created_at OR NEW.owner_id != OLD.owner_id OR NEW.property_id != OLD.property_id
BEGIN SELECT RAISE(ABORT,'immutable reminder attribution'); END;
CREATE TRIGGER reminder_created_history AFTER INSERT ON reminders BEGIN
  INSERT INTO property_history(property_id,actor_id,actor_name,actor_stamp,action,after_data)
  SELECT NEW.property_id,u.id,u.name,u.stamp,'reminder_created',
    json_object('id',NEW.id,'title',NEW.title,'dueAt',NEW.due_at,'timeZone',NEW.time_zone,'state',NEW.state)
  FROM users u WHERE u.id=NEW.created_by;
END;
CREATE TRIGGER reminder_updated_history AFTER UPDATE ON reminders BEGIN
  INSERT INTO property_history(property_id,actor_id,actor_name,actor_stamp,action,before_data,after_data)
  SELECT NEW.property_id,u.id,u.name,u.stamp,'reminder_updated',
    json_object('id',OLD.id,'title',OLD.title,'dueAt',OLD.due_at,'timeZone',OLD.time_zone,'state',OLD.state),
    json_object('id',NEW.id,'title',NEW.title,'dueAt',NEW.due_at,'timeZone',NEW.time_zone,'state',NEW.state)
  FROM users u WHERE u.id=NEW.updated_by;
END;
CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  property_id TEXT NOT NULL REFERENCES properties(id),
  reminder_id TEXT NOT NULL UNIQUE REFERENCES reminders(id),
  title TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  read_at TEXT
);
CREATE TRIGGER reminder_deliver_notification AFTER UPDATE OF state ON reminders
WHEN NEW.state='delivered' AND OLD.state='scheduled' BEGIN
  INSERT OR IGNORE INTO notifications(id,owner_id,property_id,reminder_id,title)
  VALUES(lower(hex(randomblob(16))),NEW.owner_id,NEW.property_id,NEW.id,NEW.title);
END;
CREATE TABLE preferences (
  owner_id TEXT PRIMARY KEY REFERENCES users(id),
  view_json TEXT,
  default_ai_rule TEXT
);
CREATE TABLE layers (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source='layer_points'),
  latitude_field TEXT NOT NULL CHECK(latitude_field='latitude'),
  longitude_field TEXT NOT NULL CHECK(longitude_field='longitude'),
  label_field TEXT NOT NULL CHECK(label_field='label'),
  filterable_attributes TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE layer_points (
  id TEXT PRIMARY KEY,
  layer_id TEXT NOT NULL REFERENCES layers(id),
  owner_id TEXT NOT NULL REFERENCES users(id),
  latitude REAL NOT NULL CHECK(latitude BETWEEN -90 AND 90),
  longitude REAL NOT NULL CHECK(longitude BETWEEN -180 AND 180),
  label TEXT NOT NULL,
  category TEXT,
  status TEXT
);
CREATE INDEX layer_points_owner ON layer_points(owner_id,layer_id);
CREATE TABLE ai_rules (
  property_id TEXT PRIMARY KEY REFERENCES properties(id),
  owner_id TEXT NOT NULL REFERENCES users(id),
  rule_json TEXT NOT NULL CHECK(json_valid(rule_json))
);
CREATE TABLE ai_jobs (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL REFERENCES properties(id),
  owner_id TEXT NOT NULL REFERENCES users(id),
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','successful','failed')),
  fields TEXT NOT NULL CHECK(json_valid(fields)),
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  attempts INTEGER NOT NULL DEFAULT 0,
  result TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  trigger TEXT NOT NULL,
  event_key TEXT NOT NULL UNIQUE,
  lease_token TEXT,
  lease_until TEXT,
  next_attempt_at TEXT
);
CREATE INDEX ai_jobs_pending ON ai_jobs(state,next_attempt_at,lease_until);
CREATE TRIGGER ai_creation_rule AFTER INSERT ON properties BEGIN
  INSERT INTO ai_rules(property_id,owner_id,rule_json)
  SELECT NEW.id,NEW.owner_id,p.default_ai_rule FROM preferences p
  WHERE p.owner_id=NEW.owner_id AND p.default_ai_rule IS NOT NULL;
  INSERT OR IGNORE INTO ai_jobs(id,property_id,owner_id,fields,payload,trigger,event_key)
  SELECT lower(hex(randomblob(16))),NEW.id,NEW.owner_id,json_extract(p.default_ai_rule,'$.fields'),NEW.data,
    'creation','creation:' || NEW.id
  FROM preferences p WHERE p.owner_id=NEW.owner_id AND json_extract(p.default_ai_rule,'$.enabled')=1
    AND EXISTS(SELECT 1 FROM json_each(p.default_ai_rule,'$.triggers') WHERE value='creation');
END;
CREATE TRIGGER ai_property_change AFTER UPDATE ON properties BEGIN
  INSERT OR IGNORE INTO ai_jobs(id,property_id,owner_id,fields,payload,trigger,event_key)
  SELECT lower(hex(randomblob(16))),NEW.id,NEW.owner_id,json_extract(r.rule_json,'$.fields'),NEW.data,
    'field_change','change:' || NEW.id || ':' || NEW.version
  FROM ai_rules r WHERE r.property_id=NEW.id AND json_extract(r.rule_json,'$.enabled')=1
    AND EXISTS(SELECT 1 FROM json_each(r.rule_json,'$.triggers') WHERE value='field_change')
    AND EXISTS(SELECT 1 FROM json_each(r.rule_json,'$.watchedFields') f
      WHERE json_extract(OLD.data,'$.' || f.value) IS NOT json_extract(NEW.data,'$.' || f.value));
END;
CREATE TRIGGER ai_reminder_delivery AFTER UPDATE OF state ON reminders
WHEN NEW.state='delivered' AND OLD.state='scheduled' BEGIN
  INSERT OR IGNORE INTO ai_jobs(id,property_id,owner_id,fields,payload,trigger,event_key)
  SELECT lower(hex(randomblob(16))),NEW.property_id,NEW.owner_id,json_extract(r.rule_json,'$.fields'),p.data,
    'reminder','reminder:' || NEW.id
  FROM ai_rules r JOIN properties p ON p.id=r.property_id
  WHERE r.property_id=NEW.property_id AND json_extract(r.rule_json,'$.enabled')=1
    AND EXISTS(SELECT 1 FROM json_each(r.rule_json,'$.triggers') WHERE value='reminder');
END;
