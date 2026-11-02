CREATE TABLE property_members (
  property_id TEXT NOT NULL REFERENCES properties(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK(role IN ('viewer','editor')),
  PRIMARY KEY(property_id,user_id)
);
CREATE INDEX property_members_user ON property_members(user_id,property_id);
CREATE TRIGGER members_created_history AFTER INSERT ON property_members BEGIN
  INSERT INTO property_history(property_id,actor_id,actor_name,actor_stamp,action,after_data)
  SELECT NEW.property_id,u.id,u.name,u.stamp,'member_granted',
    json_object('userId',NEW.user_id,'role',NEW.role)
  FROM properties p JOIN users u ON u.id=p.owner_id WHERE p.id=NEW.property_id;
END;
CREATE TRIGGER members_updated_history AFTER UPDATE ON property_members BEGIN
  INSERT INTO property_history(property_id,actor_id,actor_name,actor_stamp,action,before_data,after_data)
  SELECT NEW.property_id,u.id,u.name,u.stamp,'member_changed',
    json_object('userId',OLD.user_id,'role',OLD.role),json_object('userId',NEW.user_id,'role',NEW.role)
  FROM properties p JOIN users u ON u.id=p.owner_id WHERE p.id=NEW.property_id;
END;
CREATE TRIGGER members_deleted_history AFTER DELETE ON property_members BEGIN
  INSERT INTO property_history(property_id,actor_id,actor_name,actor_stamp,action,before_data,after_data)
  SELECT OLD.property_id,u.id,u.name,u.stamp,'member_removed',
    json_object('userId',OLD.user_id,'role',OLD.role),'null'
  FROM properties p JOIN users u ON u.id=p.owner_id WHERE p.id=OLD.property_id;
END;
