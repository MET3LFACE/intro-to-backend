USE school_app;

CREATE TABLE IF NOT EXISTS group_change_requests (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  student_id      INT          NOT NULL,
  requested_group INT          NOT NULL,
  status          ENUM('pending','approved','rejected','cancelled') NOT NULL DEFAULT 'pending',
  note            VARCHAR(255) NULL,
  created_at      DATETIME(3)  NOT NULL,
  decided_at      DATETIME(3)  NULL,
  decided_by      CHAR(36)     NULL,
  pending_key     TINYINT GENERATED ALWAYS AS (IF(status = 'pending', 1, NULL)) STORED,
  CONSTRAINT fk_gcr_student FOREIGN KEY (student_id) REFERENCES studentREG(student_id),
  CONSTRAINT fk_gcr_group FOREIGN KEY (requested_group) REFERENCES student_groups(group_id),
  CONSTRAINT uq_gcr_one_pending UNIQUE (student_id, pending_key)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS number_correction_requests (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  student_id       INT          NOT NULL,
  requested_number CHAR(9)      NOT NULL,
  status           ENUM('pending','approved','rejected','cancelled') NOT NULL DEFAULT 'pending',
  note             VARCHAR(255) NULL,
  created_at       DATETIME(3)  NOT NULL,
  decided_at       DATETIME(3)  NULL,
  decided_by       CHAR(36)     NULL,
  pending_key      TINYINT GENERATED ALWAYS AS (IF(status = 'pending', 1, NULL)) STORED,
  CONSTRAINT fk_ncr_student FOREIGN KEY (student_id) REFERENCES studentREG(student_id),
  CONSTRAINT uq_ncr_one_pending UNIQUE (student_id, pending_key)
) ENGINE=InnoDB;