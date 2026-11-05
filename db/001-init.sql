-- 힘찬짐 설계 초안. Render 연결 전이며 아직 적용하지 않았습니다.
-- 기존 hw2 데이터에 영향을 주지 않도록 실제 적용 전 테이블 충돌을 확인합니다.
BEGIN;
CREATE SCHEMA IF NOT EXISTS hw2;
CREATE TABLE hw2.schema_migrations (version text PRIMARY KEY);

CREATE TABLE hw2.accounts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email text NOT NULL UNIQUE CHECK (email = lower(trim(email))),
  password_hash text NOT NULL,
  name text NOT NULL CHECK (length(trim(name)) > 0),
  role text NOT NULL CHECK (role IN ('CUSTOMER','STAFF','ADMIN')),
  active boolean NOT NULL DEFAULT true,
  must_change_password boolean NOT NULL DEFAULT false,
  token_version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE hw2.members (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id bigint NOT NULL UNIQUE REFERENCES hw2.accounts(id),
  phone text NOT NULL UNIQUE,
  joined_on date NOT NULL DEFAULT (now() AT TIME ZONE 'Asia/Seoul')::date
);

CREATE TABLE hw2.sessions (
  token_hash text PRIMARY KEY,
  account_id bigint NOT NULL REFERENCES hw2.accounts(id),
  token_version integer NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '12 hours'
);
CREATE INDEX sessions_expiry ON hw2.sessions(expires_at);

CREATE TABLE hw2.trainers (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id bigint NOT NULL UNIQUE REFERENCES hw2.accounts(id)
);

CREATE TABLE hw2.trainer_workdays (
  trainer_id bigint NOT NULL REFERENCES hw2.trainers(id),
  weekday smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  PRIMARY KEY (trainer_id, weekday)
);

CREATE TABLE hw2.pass_types (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL UNIQUE,
  sessions integer NOT NULL CHECK (sessions > 0),
  list_price integer NOT NULL CHECK (list_price >= 0),
  duration_days integer NOT NULL CHECK (duration_days > 0),
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE hw2.purchased_passes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  member_id bigint NOT NULL REFERENCES hw2.members(id),
  pass_type_id bigint NOT NULL REFERENCES hw2.pass_types(id),
  purchased_on date NOT NULL,
  paid_amount integer NOT NULL CHECK (paid_amount >= 0),
  sessions_snapshot integer NOT NULL CHECK (sessions_snapshot > 0),
  list_price_snapshot integer NOT NULL CHECK (list_price_snapshot >= 0),
  expires_on date NOT NULL CHECK (expires_on >= purchased_on),
  UNIQUE (id, member_id)
);

CREATE TABLE hw2.bookings (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  member_id bigint NOT NULL REFERENCES hw2.members(id),
  purchased_pass_id bigint NOT NULL,
  trainer_id bigint NOT NULL REFERENCES hw2.trainers(id),
  starts_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'BOOKED'
    CHECK (status IN ('BOOKED','COMPLETED','CANCELLED','NO_SHOW')),
  exercise_memo text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (purchased_pass_id, member_id)
    REFERENCES hw2.purchased_passes(id, member_id),
  CHECK (extract(minute FROM starts_at AT TIME ZONE 'Asia/Seoul') = 0
    AND extract(second FROM starts_at AT TIME ZONE 'Asia/Seoul') = 0)
);

CREATE UNIQUE INDEX bookings_trainer_slot ON hw2.bookings(trainer_id, starts_at)
  WHERE status <> 'CANCELLED';
CREATE UNIQUE INDEX bookings_member_slot ON hw2.bookings(member_id, starts_at)
  WHERE status <> 'CANCELLED';
CREATE INDEX bookings_pass_status ON hw2.bookings(purchased_pass_id, status);
CREATE INDEX bookings_date ON hw2.bookings(starts_at);

-- 잔여 횟수는 저장하지 않고 계산합니다.
-- 예약 중인 횟수도 별도로 계산하여 미리 무제한 예약하는 일을 막습니다.
CREATE VIEW hw2.pass_balances AS
SELECT p.*,
  p.sessions_snapshot - count(b.id) FILTER (
    WHERE b.status IN ('COMPLETED','NO_SHOW'))::integer AS remaining_sessions,
  count(b.id) FILTER (WHERE b.status = 'BOOKED')::integer AS reserved_sessions,
  p.sessions_snapshot - count(b.id) FILTER (
    WHERE b.status IN ('BOOKED','COMPLETED','NO_SHOW'))::integer AS available_to_book
FROM hw2.purchased_passes p
LEFT JOIN hw2.bookings b ON b.purchased_pass_id = p.id
GROUP BY p.id;
INSERT INTO hw2.schema_migrations(version) VALUES ('001_himchangym');
COMMIT;
