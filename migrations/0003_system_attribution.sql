INSERT OR IGNORE INTO users(id,name,stamp) VALUES('system:scheduler','Reminder Scheduler','SYSTEM-SCHEDULER');
INSERT OR IGNORE INTO users(id,name,stamp) VALUES('system:ai-executor','AI Executor','SYSTEM-AI');

DROP TRIGGER reminder_updated_history;
CREATE TRIGGER reminder_updated_history AFTER UPDATE ON reminders BEGIN
  INSERT INTO property_history(property_id,actor_id,actor_name,actor_stamp,action,before_data,after_data)
  SELECT NEW.property_id,u.id,u.name,u.stamp,
    CASE WHEN NEW.state='delivered' AND OLD.state='scheduled' THEN 'reminder_delivered' ELSE 'reminder_updated' END,
    json_object('id',OLD.id,'title',OLD.title,'dueAt',OLD.due_at,'timeZone',OLD.time_zone,'state',OLD.state),
    json_object('id',NEW.id,'title',NEW.title,'dueAt',NEW.due_at,'timeZone',NEW.time_zone,'state',NEW.state)
  FROM users u WHERE u.id=NEW.updated_by;
END;

ALTER TABLE ai_rules ADD COLUMN updated_by TEXT REFERENCES users(id);
ALTER TABLE ai_jobs ADD COLUMN requested_by TEXT REFERENCES users(id);
ALTER TABLE ai_jobs ADD COLUMN updated_by TEXT REFERENCES users(id);
UPDATE ai_rules SET updated_by=owner_id;
UPDATE ai_jobs SET requested_by=owner_id,updated_by=CASE WHEN state='pending' THEN owner_id ELSE 'system:ai-executor' END;

DROP TRIGGER ai_creation_rule;
CREATE TRIGGER ai_creation_rule AFTER INSERT ON properties BEGIN
  INSERT INTO ai_rules(property_id,owner_id,rule_json,updated_by)
  SELECT NEW.id,NEW.owner_id,p.default_ai_rule,NEW.creator_id FROM preferences p
  WHERE p.owner_id=NEW.owner_id AND p.default_ai_rule IS NOT NULL;
  INSERT OR IGNORE INTO ai_jobs(id,property_id,owner_id,fields,payload,trigger,event_key,requested_by,updated_by)
  SELECT lower(hex(randomblob(16))),NEW.id,NEW.owner_id,json_extract(p.default_ai_rule,'$.fields'),NEW.data,
    'creation','creation:' || NEW.id,NEW.creator_id,NEW.creator_id
  FROM preferences p WHERE p.owner_id=NEW.owner_id AND json_extract(p.default_ai_rule,'$.enabled')=1
    AND EXISTS(SELECT 1 FROM json_each(p.default_ai_rule,'$.triggers') WHERE value='creation');
END;
DROP TRIGGER ai_property_change;
CREATE TRIGGER ai_property_change AFTER UPDATE ON properties BEGIN
  INSERT OR IGNORE INTO ai_jobs(id,property_id,owner_id,fields,payload,trigger,event_key,requested_by,updated_by)
  SELECT lower(hex(randomblob(16))),NEW.id,NEW.owner_id,json_extract(r.rule_json,'$.fields'),NEW.data,
    'field_change','change:' || NEW.id || ':' || NEW.version,NEW.updated_by,NEW.updated_by
  FROM ai_rules r WHERE r.property_id=NEW.id AND json_extract(r.rule_json,'$.enabled')=1
    AND EXISTS(SELECT 1 FROM json_each(r.rule_json,'$.triggers') WHERE value='field_change')
    AND EXISTS(SELECT 1 FROM json_each(r.rule_json,'$.watchedFields') f
      WHERE json_extract(OLD.data,'$.' || f.value) IS NOT json_extract(NEW.data,'$.' || f.value));
END;
DROP TRIGGER ai_reminder_delivery;
CREATE TRIGGER ai_reminder_delivery AFTER UPDATE OF state ON reminders
WHEN NEW.state='delivered' AND OLD.state='scheduled' BEGIN
  INSERT OR IGNORE INTO ai_jobs(id,property_id,owner_id,fields,payload,trigger,event_key,requested_by,updated_by)
  SELECT lower(hex(randomblob(16))),NEW.property_id,NEW.owner_id,json_extract(r.rule_json,'$.fields'),p.data,
    'reminder','reminder:' || NEW.id,NEW.updated_by,NEW.updated_by
  FROM ai_rules r JOIN properties p ON p.id=r.property_id
  WHERE r.property_id=NEW.property_id AND json_extract(r.rule_json,'$.enabled')=1
    AND EXISTS(SELECT 1 FROM json_each(r.rule_json,'$.triggers') WHERE value='reminder');
END;

CREATE TRIGGER ai_rule_created_history AFTER INSERT ON ai_rules BEGIN
  INSERT INTO property_history(property_id,actor_id,actor_name,actor_stamp,action,after_data)
  SELECT NEW.property_id,u.id,u.name,u.stamp,'ai_rule_initialized',NEW.rule_json
  FROM users u WHERE u.id=COALESCE(NEW.updated_by,NEW.owner_id);
END;
CREATE TRIGGER ai_rule_updated_history AFTER UPDATE ON ai_rules BEGIN
  INSERT INTO property_history(property_id,actor_id,actor_name,actor_stamp,action,before_data,after_data)
  SELECT NEW.property_id,u.id,u.name,u.stamp,'ai_rule_updated',OLD.rule_json,NEW.rule_json
  FROM users u WHERE u.id=COALESCE(NEW.updated_by,NEW.owner_id);
END;
CREATE TRIGGER ai_job_requested_history AFTER INSERT ON ai_jobs BEGIN
  INSERT INTO property_history(property_id,actor_id,actor_name,actor_stamp,action,after_data)
  SELECT NEW.property_id,u.id,u.name,u.stamp,'ai_job_requested',
    json_object('id',NEW.id,'trigger',NEW.trigger,'fields',json(NEW.fields),'state',NEW.state)
  FROM users u WHERE u.id=COALESCE(NEW.requested_by,NEW.owner_id);
END;
CREATE TRIGGER ai_job_updated_history AFTER UPDATE ON ai_jobs
WHEN NEW.state IS NOT OLD.state OR NEW.attempts IS NOT OLD.attempts OR NEW.result IS NOT OLD.result OR NEW.error IS NOT OLD.error BEGIN
  INSERT INTO property_history(property_id,actor_id,actor_name,actor_stamp,action,before_data,after_data)
  SELECT NEW.property_id,u.id,u.name,u.stamp,'ai_job_updated',
    json_object('id',OLD.id,'state',OLD.state,'attempts',OLD.attempts,'error',OLD.error),
    json_object('id',NEW.id,'state',NEW.state,'attempts',NEW.attempts,'error',NEW.error,'hasResult',NEW.result IS NOT NULL)
  FROM users u WHERE u.id=COALESCE(NEW.updated_by,'system:ai-executor');
END;

CREATE TABLE user_history (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  owner_id TEXT NOT NULL REFERENCES users(id),
  actor_id TEXT NOT NULL REFERENCES users(id),
  actor_name TEXT NOT NULL,
  actor_stamp TEXT NOT NULL,
  action TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  before_data TEXT,
  after_data TEXT NOT NULL
);
CREATE TRIGGER user_history_no_update BEFORE UPDATE ON user_history BEGIN SELECT RAISE(ABORT,'append-only user history'); END;
CREATE TRIGGER user_history_no_delete BEFORE DELETE ON user_history BEGIN SELECT RAISE(ABORT,'append-only user history'); END;
CREATE TRIGGER default_ai_rule_created_history AFTER INSERT ON preferences
WHEN NEW.default_ai_rule IS NOT NULL BEGIN
  INSERT INTO user_history(owner_id,actor_id,actor_name,actor_stamp,action,after_data)
  SELECT NEW.owner_id,u.id,u.name,u.stamp,'default_ai_rule_updated',NEW.default_ai_rule FROM users u WHERE u.id=NEW.owner_id;
END;
CREATE TRIGGER default_ai_rule_updated_history AFTER UPDATE OF default_ai_rule ON preferences
WHEN NEW.default_ai_rule IS NOT OLD.default_ai_rule BEGIN
  INSERT INTO user_history(owner_id,actor_id,actor_name,actor_stamp,action,before_data,after_data)
  SELECT NEW.owner_id,u.id,u.name,u.stamp,'default_ai_rule_updated',OLD.default_ai_rule,NEW.default_ai_rule FROM users u WHERE u.id=NEW.owner_id;
END;
