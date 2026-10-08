USE school_app;

CREATE TABLE IF NOT EXISTS programmes (
  code VARCHAR(10)  PRIMARY KEY,
  name VARCHAR(100) NOT NULL
) ENGINE=InnoDB;

INSERT IGNORE INTO programmes (code, name) VALUES
  ('CS', 'Computer Science'),
  ('IT', 'Information Technology'),
  ('DS', 'Data Science');

DELETE FROM student_groups WHERE group_name = 'Group A';
INSERT IGNORE INTO student_groups (group_name, capacity) VALUES
  ('G01', 15), ('G02', 15), ('G03', 15), ('G04', 15);

ALTER TABLE student_groups ADD CONSTRAINT chk_capacity_max CHECK (capacity <= 15);

ALTER TABLE studentREG
  ADD COLUMN version    INT         NOT NULL DEFAULT 1,
  ADD COLUMN deleted_at DATETIME(3) NULL,
  ADD COLUMN deleted_by CHAR(36)    NULL,
  ADD CONSTRAINT fk_student_program FOREIGN KEY (program) REFERENCES programmes(code);