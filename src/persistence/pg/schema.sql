-- Audita — Postgres schema (append-only, audit-first).
-- Money is stored as BIGINT centavos. Immutability of posted entries and the
-- audit trail is enforced at the DATABASE layer via triggers, so it holds even
-- if application code has a bug. This is a compliance control, not a nicety.

CREATE TABLE IF NOT EXISTS journal_entry (
  id              TEXT PRIMARY KEY,
  entry_date      DATE        NOT NULL,
  memo            TEXT        NOT NULL,
  source          TEXT        NOT NULL,
  app_user        TEXT        NOT NULL,
  source_document TEXT,
  reversed        BOOLEAN     NOT NULL DEFAULT FALSE,
  recorded_at     TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS journal_line (
  entry_id     TEXT   NOT NULL REFERENCES journal_entry(id),
  line_no      INT    NOT NULL,
  account_code TEXT   NOT NULL,
  debit        BIGINT NOT NULL DEFAULT 0 CHECK (debit  >= 0),
  credit       BIGINT NOT NULL DEFAULT 0 CHECK (credit >= 0),
  CHECK (NOT (debit > 0 AND credit > 0)),
  CHECK (debit > 0 OR credit > 0),
  PRIMARY KEY (entry_id, line_no)
);

-- Enforce double-entry at commit: sum(debit) = sum(credit) per entry.
CREATE OR REPLACE FUNCTION assert_entry_balances() RETURNS trigger AS $$
DECLARE d BIGINT; c BIGINT;
BEGIN
  SELECT COALESCE(SUM(debit),0), COALESCE(SUM(credit),0) INTO d, c
    FROM journal_line WHERE entry_id = NEW.entry_id;
  IF d <> c THEN
    RAISE EXCEPTION 'Asiento % descuadrado: debitos=% creditos=%', NEW.entry_id, d, c;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_entry_balances
  AFTER INSERT OR UPDATE ON journal_line
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_entry_balances();

-- Immutability: journal lines can never be updated or deleted; entries may only
-- flip `reversed` from FALSE to TRUE. Nothing else may change.
CREATE OR REPLACE FUNCTION block_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Registro inmutable: no se permite % en %', TG_OP, TG_TABLE_NAME;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_line_immutable
  BEFORE UPDATE OR DELETE ON journal_line
  FOR EACH ROW EXECUTE FUNCTION block_mutation();

CREATE OR REPLACE FUNCTION entry_only_reverse() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Los asientos no se eliminan; use reversión.';
  END IF;
  IF (OLD.id, OLD.entry_date, OLD.memo, OLD.source, OLD.app_user, OLD.recorded_at)
     IS DISTINCT FROM
     (NEW.id, NEW.entry_date, NEW.memo, NEW.source, NEW.app_user, NEW.recorded_at) THEN
    RAISE EXCEPTION 'Asiento inmutable: solo se permite marcar reversado.';
  END IF;
  IF OLD.reversed = TRUE AND NEW.reversed = FALSE THEN
    RAISE EXCEPTION 'No se puede des-reversar un asiento.';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_entry_only_reverse
  BEFORE UPDATE OR DELETE ON journal_entry
  FOR EACH ROW EXECUTE FUNCTION entry_only_reverse();

-- Hash-chained audit trail.
CREATE TABLE IF NOT EXISTS audit_event (
  seq        INT PRIMARY KEY,
  action     TEXT        NOT NULL,
  ref        TEXT        NOT NULL,
  detail     JSONB       NOT NULL,
  app_user   TEXT        NOT NULL,
  ts         TIMESTAMPTZ NOT NULL,
  prev_hash  TEXT        NOT NULL,
  hash       TEXT        NOT NULL
);
CREATE TRIGGER trg_audit_immutable
  BEFORE UPDATE OR DELETE ON audit_event
  FOR EACH ROW EXECUTE FUNCTION block_mutation();

CREATE TABLE IF NOT EXISTS finding (
  id             TEXT PRIMARY KEY,
  rule           TEXT NOT NULL,
  severity       TEXT NOT NULL CHECK (severity IN ('low','medium','high')),
  entry_id       TEXT NOT NULL,
  message        TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('open','reviewed','cleared','escalated')),
  raised_at      TIMESTAMPTZ NOT NULL,
  resolved_by    TEXT,
  resolution_note TEXT
);

CREATE TABLE IF NOT EXISTS einvoice (
  number    TEXT PRIMARY KEY,
  client    TEXT NOT NULL,
  inv_date  DATE NOT NULL,
  cufe      TEXT NOT NULL,
  status    TEXT NOT NULL,
  entry_id  TEXT NOT NULL REFERENCES journal_entry(id)
);

CREATE TABLE IF NOT EXISTS working_paper (
  id             TEXT PRIMARY KEY,
  account_code   TEXT NOT NULL,
  period         TEXT NOT NULL,
  booked_balance BIGINT NOT NULL,
  support_balance BIGINT NOT NULL,
  difference     BIGINT NOT NULL,
  status         TEXT NOT NULL,
  prepared_by    TEXT,
  reviewed_by    TEXT,
  notes          TEXT NOT NULL DEFAULT '',
  created_at     TIMESTAMPTZ NOT NULL
);
