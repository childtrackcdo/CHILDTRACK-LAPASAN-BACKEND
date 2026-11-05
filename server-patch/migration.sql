-- 1) Idempotent uploads from the Pi
ALTER TABLE in_out_campus
  ADD COLUMN client_uuid VARCHAR(40) NULL,
  ADD UNIQUE INDEX uq_in_out_campus_client_uuid (client_uuid);

ALTER TABLE sms_queue
  ADD COLUMN client_uuid VARCHAR(40) NULL,
  ADD UNIQUE INDEX uq_sms_queue_client_uuid (client_uuid);

-- 2) Speed (skip any line that says "Duplicate key name")
ALTER TABLE in_out_campus ADD INDEX idx_lrn_date_status (lrn, date, status);
ALTER TABLE attendance    ADD INDEX idx_lrn_date_subject (lrn, date, subject);

-- 3) Kiosk sync account (skipped automatically if the username already exists)
INSERT INTO teachers
  (name, username, employee_id, password, age, gender, section, grade_level,
   strand, track, advisory_subject, specialization, contact, address,
   photo_base64, created_at)
SELECT
  'Kiosk Sync Account', 'kiosk_admin', NULL, '$2b$12$qVX2H1jm.eTyRr2o/FwQbukeWC1ujArFk/k1xJ7JqhJkyBp03edTy', 0, 'Male',
  'Kiosk', '11', NULL, NULL, NULL, NULL, '00000000000', 'Kiosk device',
  NULL, NOW()
WHERE NOT EXISTS (SELECT 1 FROM teachers WHERE username = 'kiosk_admin');