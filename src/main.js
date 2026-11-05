import 'reflect-metadata';
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { Module, Controller, All, Req, Res } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { randomBytes, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { pool, transaction } from './db.js';
import { RuleError, requireRule, text, id, password, email, phone, integer, date, bookingTime } from './rules.js';

const hashToken = token => createHash('sha256').update(token).digest('hex');
const publicAccount = a => ({ id:a.id, name:a.name, email:a.email, role:a.role, must_change_password:a.must_change_password });
async function issueSession(db, a) {
  const token = randomBytes(32).toString('base64url');
  await db.query('INSERT INTO hw2.sessions(token_hash,account_id,token_version) VALUES($1,$2,$3)', [hashToken(token),a.id,a.token_version]);
  return { token, account: publicAccount(a) };
}
async function account(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  requireRule(token.length > 20 && token.length < 200, '로그인이 필요해요.', 401);
  const {rows} = await pool.query(`SELECT a.* FROM hw2.accounts a JOIN hw2.sessions s ON s.account_id=a.id
    WHERE s.token_hash=$1 AND s.expires_at > now() AND s.token_version=a.token_version AND a.active`, [hashToken(token)]);
  requireRule(rows[0], '로그인이 만료됐거나 사용이 중지된 계정이에요.', 401);
  return rows[0];
}
const staff = a => requireRule(['ADMIN','STAFF'].includes(a.role), '직원만 사용할 수 있어요.',403);
const admin = a => requireRule(a.role === 'ADMIN', '관리자만 사용할 수 있어요.',403);
async function member(db,a) {
  requireRule(a.role === 'CUSTOMER','회원 계정으로 이용해 주세요.',403);
  const {rows} = await db.query('SELECT * FROM hw2.members WHERE account_id=$1',[a.id]);
  requireRule(rows[0], '회원 정보를 찾을 수 없어요.',404);
  return rows[0];
}
export async function route(req) {
  const path = req.path.replace(/\/$/,'') || '/';
  const method = req.method;
  const b = req.body || {};
  if (path === '/health' && method === 'GET') {
    await pool.query('SELECT 1'); return {ok:true,service:'himchangym-backend'};
  }
  if (path === '/auth/signup' && method === 'POST') {
    const values = {email:email(b.email),name:text(b.name,'이름',60),phone:phone(b.phone),password:password(b.password)};
    const result = await transaction(async db => {
      const {rows} = await db.query(`INSERT INTO hw2.accounts(email,name,password_hash,role)
        VALUES($1,$2,$3,'CUSTOMER') RETURNING *`,[values.email,values.name,await bcrypt.hash(values.password,12)]);
      await db.query('INSERT INTO hw2.members(account_id,phone) VALUES($1,$2)',[rows[0].id,values.phone]);
      return issueSession(db,rows[0]);
    });
    return result;
  }
  if (path === '/auth/login' && method === 'POST') {
    const {rows} = await pool.query('SELECT * FROM hw2.accounts WHERE email=$1',[email(b.email)]);
    const a = rows[0];
    const ok = a && await bcrypt.compare(typeof b.password === 'string' ? b.password : '', a.password_hash);
    requireRule(ok && a.active,'이메일과 비밀번호를 확인해 주세요. 중지된 계정은 로그인할 수 없어요.',401);
    // 로그인 검증 이후 중지/리셋과 경합하더라도 세션 버전 확인에서 차단됩니다.
    return issueSession(pool,a);
  }
  const a = await account(req);
  if (path === '/auth/me' && method === 'GET') return publicAccount(a);
  if (path === '/auth/logout' && method === 'POST') {
    await pool.query('DELETE FROM hw2.sessions WHERE token_hash=$1',[hashToken(req.headers.authorization.slice(7))]);
    return {ok:true};
  }
  if (path === '/auth/password' && method === 'POST') {
    password(b.newPassword);
    return transaction(async db => {
      const current = (await db.query('SELECT * FROM hw2.accounts WHERE id=$1 FOR UPDATE',[a.id])).rows[0];
      requireRule(await bcrypt.compare(typeof b.currentPassword === 'string' ? b.currentPassword : '',current.password_hash),'현재 비밀번호를 확인해 주세요.',401);
      requireRule(b.newPassword !== b.currentPassword,'기존과 다른 비밀번호를 입력해 주세요.');
      const updated = (await db.query(`UPDATE hw2.accounts SET password_hash=$1,must_change_password=false,
        token_version=token_version+1 WHERE id=$2 RETURNING *`,[await bcrypt.hash(b.newPassword,12),a.id])).rows[0];
      await db.query('DELETE FROM hw2.sessions WHERE account_id=$1',[a.id]);
      return issueSession(db,updated);
    });
  }
  requireRule(!a.must_change_password,'임시 비밀번호를 새 비밀번호로 먼저 바꿔 주세요.',403);

  if (path === '/staff' && method === 'GET') {
    admin(a); return (await pool.query(`SELECT id,email,name,role,active,must_change_password FROM hw2.accounts
      WHERE role IN ('ADMIN','STAFF') ORDER BY id`)).rows;
  }
  if (path === '/staff' && method === 'POST') {
    admin(a);
    const role = b.role || 'STAFF';
    requireRule(['ADMIN','STAFF'].includes(role),'직원 역할을 확인해 주세요.');
    const temporaryPassword = randomBytes(12).toString('base64url');
    const {rows} = await pool.query(`INSERT INTO hw2.accounts(email,name,role,password_hash,must_change_password)
      VALUES($1,$2,$3,$4,true) RETURNING id,email,name,role,active,must_change_password`,
    [email(b.email),text(b.name,'이름',60),role,await bcrypt.hash(temporaryPassword,12)]);
    return {account:rows[0],temporaryPassword};
  }
  let match = path.match(/^\/staff\/(\d+)(\/reset-password)?$/);
  if (match && ['PATCH','POST'].includes(method)) {
    admin(a); const targetId = id(match[1]);
    return transaction(async db => {
      // 마지막 관리자 중지를 동시 요청까지 포함해 방지합니다.
      await db.query('SELECT pg_advisory_xact_lock(7742026)');
      const target = (await db.query("SELECT * FROM hw2.accounts WHERE id=$1 AND role IN ('ADMIN','STAFF') FOR UPDATE",[targetId])).rows[0];
      requireRule(target,'직원을 찾을 수 없어요.',404);
      if (match[2]) {
        requireRule(method === 'POST','허용되지 않은 요청이에요.',405);
        const temporaryPassword = randomBytes(12).toString('base64url');
        await db.query(`UPDATE hw2.accounts SET password_hash=$1,must_change_password=true,
          token_version=token_version+1 WHERE id=$2`,[await bcrypt.hash(temporaryPassword,12),targetId]);
        return {temporaryPassword};
      }
      requireRule(method === 'PATCH','허용되지 않은 요청이에요.',405);
      const role = b.role ?? target.role;
      const active = b.active ?? target.active;
      requireRule(['ADMIN','STAFF'].includes(role) && typeof active === 'boolean','역할과 활성 상태를 확인해 주세요.');
      if (target.role === 'ADMIN' && target.active && (role !== 'ADMIN' || !active)) {
        const count = (await db.query("SELECT count(*)::int AS n FROM hw2.accounts WHERE role='ADMIN' AND active")).rows[0].n;
        requireRule(count > 1,'마지막 관리자는 중지하거나 일반 직원으로 바꿀 수 없어요.');
      }
      await db.query(`UPDATE hw2.accounts SET name=$1,email=$2,role=$3,active=$4,token_version=token_version+1 WHERE id=$5`,
        [b.name === undefined ? target.name : text(b.name,'이름',60),b.email === undefined ? target.email : email(b.email),role,active,targetId]);
      return {ok:true};
    });
  }

  if (path === '/members' && method === 'GET') {
    staff(a); const q = String(req.query.q || '').slice(0,60);
    return (await pool.query(`SELECT m.id,a.name,m.phone,m.joined_on FROM hw2.members m JOIN hw2.accounts a ON a.id=m.account_id
      WHERE $1='' OR strpos(a.name,$1)>0 OR right(m.phone,4)=$1 ORDER BY m.id DESC`,[q])).rows;
  }
  if (path === '/members/me' && method === 'PATCH') {
    const m = await member(pool,a);
    return transaction(async db => {
      await db.query('UPDATE hw2.accounts SET name=$1 WHERE id=$2',[text(b.name,'이름',60),a.id]);
      await db.query('UPDATE hw2.members SET phone=$1 WHERE id=$2',[phone(b.phone),m.id]);
      return {ok:true};
    });
  }
  match = path.match(/^\/members\/(\d+)$/);
  if (match && method === 'PATCH') {
    staff(a);
    return transaction(async db=>{
      const m=(await db.query('SELECT * FROM hw2.members WHERE id=$1 FOR UPDATE',[id(match[1])])).rows[0];
      requireRule(m,'회원을 찾을 수 없어요.',404);
      await db.query('UPDATE hw2.accounts SET name=$1 WHERE id=$2',[text(b.name,'이름',60),m.account_id]);
      await db.query('UPDATE hw2.members SET phone=$1 WHERE id=$2',[phone(b.phone),m.id]);
      return {ok:true};
    });
  }
  if (path === '/trainers' && method === 'GET') {
    return (await pool.query(`SELECT t.id,a.name,coalesce(array_agg(w.weekday ORDER BY w.weekday)
      FILTER(WHERE w.weekday IS NOT NULL),'{}') AS weekdays FROM hw2.trainers t
      JOIN hw2.accounts a ON a.id=t.account_id LEFT JOIN hw2.trainer_workdays w ON w.trainer_id=t.id
      WHERE a.active GROUP BY t.id,a.name ORDER BY t.id`)).rows;
  }
  if (path === '/trainers' && method === 'POST') {
    admin(a); const accountId = id(b.accountId);
    requireRule(Array.isArray(b.weekdays) && b.weekdays.length>0 && b.weekdays.every(n=>Number.isInteger(n)&&n>=0&&n<=6),'근무 요일을 선택해 주세요.');
    return transaction(async db => {
      const target = (await db.query("SELECT id FROM hw2.accounts WHERE id=$1 AND role IN ('STAFF','ADMIN') AND active",[accountId])).rows[0];
      requireRule(target,'활성 직원 계정을 선택해 주세요.');
      const t = (await db.query('INSERT INTO hw2.trainers(account_id) VALUES($1) ON CONFLICT(account_id) DO UPDATE SET account_id=EXCLUDED.account_id RETURNING id',[accountId])).rows[0];
      // 향후 예약이 있는 요일은 제거하지 않습니다.
      const conflicts = (await db.query(`SELECT id FROM hw2.bookings WHERE trainer_id=$1 AND status='BOOKED'
        AND starts_at>now() AND NOT (extract(dow FROM starts_at AT TIME ZONE 'Asia/Seoul')::int = ANY($2::int[])) LIMIT 1`,[t.id,b.weekdays])).rows;
      requireRule(!conflicts.length,'빠지는 요일에 예정된 수업이 있어요. 예약부터 정리해 주세요.');
      await db.query('DELETE FROM hw2.trainer_workdays WHERE trainer_id=$1',[t.id]);
      for(const day of new Set(b.weekdays)) await db.query('INSERT INTO hw2.trainer_workdays VALUES($1,$2)',[t.id,day]);
      return {id:t.id};
    });
  }
  if (path === '/pass-types' && method === 'GET') return (await pool.query('SELECT * FROM hw2.pass_types ORDER BY sessions')).rows;
  if (path === '/pass-types' && method === 'POST') {
    admin(a);
    return (await pool.query(`INSERT INTO hw2.pass_types(name,sessions,list_price,duration_days) VALUES($1,$2,$3,$4) RETURNING *`,
      [text(b.name,'이용권 이름',60),integer(b.sessions,'횟수',1),integer(b.listPrice,'정가'),integer(b.durationDays,'사용 기간',1)])).rows[0];
  }
  if (path === '/passes' && method === 'GET') {
    const m = a.role === 'CUSTOMER' ? await member(pool,a) : null;
    return (await pool.query(`SELECT p.*,pt.name AS pass_name,a.name AS member_name,
      (p.purchased_on<=CURRENT_DATE AND p.expires_on>=CURRENT_DATE AND p.remaining_sessions>0) AS usable
      FROM hw2.pass_balances p JOIN hw2.pass_types pt ON pt.id=p.pass_type_id
      JOIN hw2.members m ON m.id=p.member_id JOIN hw2.accounts a ON a.id=m.account_id
      WHERE ($1::bigint IS NULL OR p.member_id=$1) ORDER BY p.id DESC`,[m?.id ?? null])).rows;
  }
  if (path === '/passes' && method === 'POST') {
    staff(a); const memberId = id(b.memberId), typeId=id(b.passTypeId), purchasedOn=date(b.purchasedOn);
    const price = integer(b.paidAmount,'실제 판매 금액');
    return transaction(async db => {
      const pt = (await db.query('SELECT * FROM hw2.pass_types WHERE id=$1 AND active',[typeId])).rows[0];
      requireRule(pt,'이용권 종류를 확인해 주세요.');
      const expiresOn = b.expiresOn ? date(b.expiresOn) : null;
      return (await db.query(`INSERT INTO hw2.purchased_passes(member_id,pass_type_id,purchased_on,paid_amount,
        sessions_snapshot,list_price_snapshot,expires_on) VALUES($1,$2,$3,$4,$5,$6,COALESCE($7::date,$3::date+($8::int-1))) RETURNING *`,
      [memberId,typeId,purchasedOn,price,pt.sessions,pt.list_price,expiresOn,pt.duration_days])).rows[0];
    });
  }
  if (path === '/bookings' && method === 'GET') {
    const m = a.role === 'CUSTOMER' ? await member(pool,a) : null;
    const day = req.query.day ? date(req.query.day) : null;
    return (await pool.query(`SELECT b.*,a.name AS member_name,ta.name AS trainer_name,pt.name AS pass_name
      FROM hw2.bookings b JOIN hw2.members m ON m.id=b.member_id JOIN hw2.accounts a ON a.id=m.account_id
      JOIN hw2.trainers t ON t.id=b.trainer_id JOIN hw2.accounts ta ON ta.id=t.account_id
      JOIN hw2.purchased_passes p ON p.id=b.purchased_pass_id JOIN hw2.pass_types pt ON pt.id=p.pass_type_id
      WHERE ($1::bigint IS NULL OR b.member_id=$1) AND ($2::date IS NULL OR (b.starts_at AT TIME ZONE 'Asia/Seoul')::date=$2)
      ORDER BY b.starts_at DESC LIMIT 500`,[m?.id ?? null,day])).rows;
  }
  if (path === '/bookings' && method === 'POST') {
    const m = await member(pool,a), passId=id(b.passId), trainerId=id(b.trainerId), slot=bookingTime(b.startsAt);
    return transaction(async db => {
      const p = (await db.query('SELECT * FROM hw2.purchased_passes WHERE id=$1 AND member_id=$2 FOR UPDATE',[passId,m.id])).rows[0];
      requireRule(p,'내 이용권을 선택해 주세요.',403);
      const balance = (await db.query('SELECT *,purchased_on::text AS start_day,expires_on::text AS end_day FROM hw2.pass_balances WHERE id=$1',[passId])).rows[0];
      const today = new Date(Date.now()+9*3600000).toISOString().slice(0,10);
      requireRule(balance.end_day >= today && balance.start_day <= slot.day && balance.end_day >= slot.day,'이용권 유효기간 안의 날짜를 선택해 주세요.');
      requireRule(balance.available_to_book > 0,'예약 가능한 횟수가 없어요. 남은 횟수와 예약 중인 수업을 확인해 주세요.');
      const work = (await db.query(`SELECT t.id FROM hw2.trainers t JOIN hw2.accounts a ON a.id=t.account_id
        JOIN hw2.trainer_workdays w ON w.trainer_id=t.id WHERE t.id=$1 AND a.active AND w.weekday=$2`,[trainerId,slot.weekday])).rows[0];
      requireRule(work,'선택한 트레이너의 근무 요일이 아니에요.');
      return (await db.query('INSERT INTO hw2.bookings(member_id,purchased_pass_id,trainer_id,starts_at) VALUES($1,$2,$3,$4) RETURNING *',
        [m.id,passId,trainerId,slot.time])).rows[0];
    });
  }
  match = path.match(/^\/bookings\/(\d+)$/);
  if (match && method === 'PATCH') {
    const bookingId=id(match[1]);
    return transaction(async db => {
      // 모든 예약 쓰기는 이용권 -> 예약 순서로 잠가 교착 위험을 줄입니다.
      const ref = (await db.query('SELECT purchased_pass_id FROM hw2.bookings WHERE id=$1',[bookingId])).rows[0];
      requireRule(ref,'예약을 찾을 수 없어요.',404);
      await db.query('SELECT id FROM hw2.purchased_passes WHERE id=$1 FOR UPDATE',[ref.purchased_pass_id]);
      const booking = (await db.query('SELECT * FROM hw2.bookings WHERE id=$1 FOR UPDATE',[bookingId])).rows[0];
      if (a.role === 'CUSTOMER') {
        const m=await member(db,a);
        requireRule(m.id === booking.member_id,'내 예약만 취소할 수 있어요.',403);
        requireRule(b.status==='CANCELLED' && b.exerciseMemo===undefined,'회원은 예약 취소만 할 수 있어요.',403);
        requireRule(new Date(booking.starts_at)>new Date(),'이미 시작한 수업은 데스크에 문의해 주세요.');
      } else staff(a);
      if (b.status !== undefined) {
        requireRule(['COMPLETED','CANCELLED','NO_SHOW'].includes(b.status),'변경할 상태를 확인해 주세요.');
        requireRule(booking.status==='BOOKED','이미 처리한 예약은 다시 변경할 수 없어요.');
        if (['COMPLETED','NO_SHOW'].includes(b.status)) requireRule(new Date(booking.starts_at)<=new Date(),'수업 시작 이후에 완료 또는 노쇼로 처리할 수 있어요.');
      }
      const nextStatus=b.status ?? booking.status;
      if (b.exerciseMemo !== undefined) {
        requireRule(nextStatus==='COMPLETED','완료한 수업에만 운동 메모를 남길 수 있어요.');
        const t=(await db.query('SELECT id FROM hw2.trainers WHERE account_id=$1',[a.id])).rows[0];
        requireRule(a.role==='ADMIN'||t?.id===booking.trainer_id,'담당 트레이너 또는 관리자만 메모를 남길 수 있어요.',403);
        requireRule(typeof b.exerciseMemo==='string'&&b.exerciseMemo.length<=2000,'메모는 2,000자 이하로 입력해 주세요.');
      }
      return (await db.query('UPDATE hw2.bookings SET status=$1,exercise_memo=$2 WHERE id=$3 RETURNING *',
        [nextStatus,b.exerciseMemo ?? booking.exercise_memo,bookingId])).rows[0];
    });
  }
  if (path === '/dashboard' && method === 'GET') {
    staff(a);
    const expiring=(await pool.query(`SELECT p.id,a.name,p.expires_on,p.remaining_sessions FROM hw2.pass_balances p
      JOIN hw2.members m ON m.id=p.member_id JOIN hw2.accounts a ON a.id=m.account_id
      WHERE p.expires_on BETWEEN CURRENT_DATE AND CURRENT_DATE+14 AND p.remaining_sessions>0 ORDER BY p.expires_on`)).rows;
    const completed=(await pool.query(`SELECT t.id,a.name,count(b.id)::int AS completed FROM hw2.trainers t
      JOIN hw2.accounts a ON a.id=t.account_id LEFT JOIN hw2.bookings b ON b.trainer_id=t.id
      AND b.status='COMPLETED' AND b.starts_at>=date_trunc('month',now()) AND b.starts_at<date_trunc('month',now())+interval '1 month'
      GROUP BY t.id,a.name ORDER BY a.name`)).rows;
    const counts=(await pool.query(`SELECT
      (SELECT count(*) FROM hw2.members)::int AS members,
      (SELECT count(*) FROM hw2.bookings WHERE status='BOOKED' AND (starts_at AT TIME ZONE 'Asia/Seoul')::date=CURRENT_DATE)::int AS today_bookings,
      (SELECT count(*) FROM hw2.pass_balances WHERE remaining_sessions>0 AND expires_on>=CURRENT_DATE)::int AS active_passes`)).rows[0];
    return {expiring,completed,counts};
  }
  throw new RuleError('요청한 기능을 찾을 수 없어요.',404);
}

class ApiController {
  async handle(req,res) {
    res.setHeader('Cache-Control','no-store');
    try { res.status(200).json(await route(req)); }
    catch(error) {
      if (error instanceof RuleError) return res.status(error.status).json({message:error.message});
      if(error.code==='23505') {
        const message = error.constraint?.startsWith('bookings_') ? '회원 또는 트레이너에게 같은 시각의 수업이 이미 있어요.' : '이미 등록된 이메일, 연락처 또는 항목이에요.';
        return res.status(409).json({message});
      }
      if(['23503','23514','22P02','22007','22008'].includes(error.code)) return res.status(400).json({message:'입력한 정보와 연결된 데이터, 날짜, 금액을 확인해 주세요.'});
      console.error('Request failed', {code:error.code || error.name});
      return res.status(500).json({message:'처리 중 문제가 생겼어요. 잠시 후 다시 시도해 주세요.'});
    }
  }
}
Controller()(ApiController);
All('{*path}')(ApiController.prototype,'handle',Object.getOwnPropertyDescriptor(ApiController.prototype,'handle'));
Req()(ApiController.prototype,'handle',0); Res()(ApiController.prototype,'handle',1);
class AppModule {}
Module({controllers:[ApiController]})(AppModule);
export async function bootstrap(){
  const app = await NestFactory.create(AppModule);
  if(process.env.RENDER==='true')app.getHttpAdapter().getInstance().set('trust proxy',1);
  app.use(helmet());
  app.use('/auth',rateLimit({windowMs:15*60*1000,limit:100,standardHeaders:'draft-8',legacyHeaders:false,message:{message:'요청이 많아요. 잠시 후 다시 시도해 주세요.'}}));
  app.enableCors({origin:(process.env.ALLOWED_ORIGINS||'http://localhost:3000,http://localhost:3001').split(',').map(x=>x.trim()),methods:['GET','POST','PATCH','OPTIONS']});
  if(process.env.AUTO_SETUP==='true'){
    const {runSetup}=await import('./setup.js');
    await runSetup('migrate');
    await runSetup('seed');
  }
  await pool.query('SELECT 1');
  await app.listen(Number(process.env.PORT||4000),'0.0.0.0');
  return app;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await bootstrap();
