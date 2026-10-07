USE school_app;

CREATE TABLE IF NOT EXISTS claim_codes (
  code       VARCHAR(20) PRIMARY KEY,
  student_no CHAR(9)     NOT NULL,
  used_by    CHAR(36)    NULL,
  used_at    DATETIME(3) NULL,
  CONSTRAINT uq_claim_student UNIQUE (student_no),
  CONSTRAINT fk_claim_user FOREIGN KEY (used_by) REFERENCES users(id)
) ENGINE=InnoDB;

-- Fictitious codes, as the brief requires. 202400002 is Mary, who the lecturer already added.
INSERT IGNORE INTO claim_codes (code, student_no) VALUES
  ('CLAIM-0002', '202400002'),
  ('CLAIM-0020', '202400020'),
  ('CLAIM-0021', '202400021');