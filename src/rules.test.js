import test from 'node:test';
import assert from 'node:assert/strict';
import { bookingTime, password, date, email, phone } from './rules.js';
test('예약은 한국 시각의 정시 및 운영 시간을 검사한다',()=>{
  const now=new Date('2026-11-01T00:00:00Z');
  assert.equal(bookingTime('2026-11-06T10:00:00+09:00',now).day,'2026-11-06');
  assert.throws(()=>bookingTime('2026-11-06T10:30:00+09:00',now));
  assert.throws(()=>bookingTime('2026-11-07T08:00:00+09:00',now));
  assert.throws(()=>bookingTime('2026-11-07T18:00:00+09:00',now));
  assert.throws(()=>bookingTime('2026-11-06T10:00:00',now));
  assert.throws(()=>bookingTime('2026-11-06T10:00:00.001+09:00',now));
});
test('날짜와 비밀번호의 실제 길이를 검사한다',()=>{
  assert.throws(()=>date('2026-02-30'));
  assert.throws(()=>password('가'.repeat(30)));
  assert.throws(()=>password('short'));
  assert.equal(email('  USER@example.test '),'user@example.test');
  assert.equal(phone('010-0000-0000'),'01000000000');
});
