-- DBeaver에서 한 문장씩 실행합니다. 접속 정보와 비밀번호는 캡처에서 가립니다.
SELECT table_name FROM information_schema.tables WHERE table_schema='hw2' ORDER BY table_name;

SELECT id,email,role,left(password_hash,7)||'...' AS hash_prefix,active,must_change_password
FROM hw2.accounts ORDER BY id;

SELECT id,member_id,remaining_sessions,reserved_sessions,available_to_book,expires_on
FROM hw2.pass_balances ORDER BY id;

-- 아래는 일부러 중복 이메일을 넣는 검사입니다. 거절돼야 정상입니다.
-- 실제 해시를 복사하지 않고 기존 행을 기준으로 중복 제약만 확인합니다.
INSERT INTO hw2.accounts(email,name,password_hash,role)
SELECT email,'중복 검사',password_hash,'CUSTOMER' FROM hw2.accounts LIMIT 1;

-- 아래도 일부러 정시가 아닌 시간을 넣는 검사입니다. 거절돼야 정상입니다.
INSERT INTO hw2.bookings(member_id,purchased_pass_id,trainer_id,starts_at)
SELECT member_id,purchased_pass_id,trainer_id,date_trunc('hour',now())+interval '31 minutes'
FROM hw2.bookings LIMIT 1;
