CREATE DATABASE IF NOT EXISTS school_app
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE school_app;

CREATE TABLE IF NOT EXISTS users (
  id            CHAR(36)     PRIMARY KEY,
  email         VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(100) NOT NULL,
  created_at    DATETIME(3)  NOT NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS student_groups (
  group_id   INT AUTO_INCREMENT PRIMARY KEY,
  group_name VARCHAR(100) NOT NULL,
  capacity   INT UNSIGNED NOT NULL DEFAULT 5,
  CONSTRAINT uq_group_name UNIQUE (group_name),
  CONSTRAINT chk_capacity_positive CHECK (capacity >= 1)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS studentREG (
  student_id    INT AUTO_INCREMENT PRIMARY KEY,
  student_no    CHAR(9)      NOT NULL,
  student_name  VARCHAR(100) NOT NULL,
  student_email VARCHAR(255) NULL,
  course        VARCHAR(100) NULL,
  year_of_study TINYINT UNSIGNED NULL,
  group_id      INT          NULL,
  deleted       TINYINT(1)   NOT NULL DEFAULT 0,
  updated_at    DATETIME(3)  NOT NULL,
  CONSTRAINT uq_student_no UNIQUE (student_no),
  CONSTRAINT fk_student_group FOREIGN KEY (group_id)
    REFERENCES student_groups(group_id) ON DELETE SET NULL,
  INDEX idx_course (course),
  INDEX idx_group (group_id),
  INDEX idx_updated (updated_at)
) ENGINE=InnoDB;