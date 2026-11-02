DROP TRIGGER reminder_deliver_notification;
CREATE TRIGGER reminder_deliver_notification AFTER UPDATE OF state ON reminders
WHEN NEW.state='delivered' AND OLD.state='scheduled'
  AND EXISTS(SELECT 1 FROM properties p WHERE p.id=NEW.property_id
    AND (p.owner_id=NEW.owner_id OR EXISTS(
      SELECT 1 FROM property_members m WHERE m.property_id=p.id AND m.user_id=NEW.owner_id)))
BEGIN
  INSERT OR IGNORE INTO notifications(id,owner_id,property_id,reminder_id,title)
  VALUES(lower(hex(randomblob(16))),NEW.owner_id,NEW.property_id,NEW.id,NEW.title);
END;
