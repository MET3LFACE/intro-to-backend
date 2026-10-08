USE school_app;

CREATE TABLE IF NOT EXISTS operations (
  op_id        CHAR(36)    PRIMARY KEY,
  account_id   CHAR(36)    NOT NULL,
  op_type      VARCHAR(10) NOT NULL,
  payload_hash CHAR(64)    NOT NULL,
  result       JSON        NOT NULL,
  created_at   DATETIME(3) NOT NULL,
  CONSTRAINT fk_op_account FOREIGN KEY (account_id) REFERENCES users(id)
) ENGINE=InnoDB;