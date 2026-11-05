import 'dotenv/config';
import fs from 'node:fs/promises';
import bcrypt from 'bcryptjs';
import { pathToFileURL } from 'node:url';
import { pool, transaction } from './db.js';
import { password, email } from './rules.js';

export async function runSetup(action) {
  if(action==='migrate') {
    await transaction(async db=>{
      await db.query('SELECT pg_advisory_xact_lock(7742027)');
      const found=(await db.query("SELECT to_regclass('hw2.accounts') AS accounts,to_regclass('hw2.schema_migrations') AS migrations")).rows[0];
      if(found.accounts||found.migrations){
        if(!found.accounts||!found.migrations)throw new Error('Existing hw2 tables do not match this application. No changes applied.');
        const own=(await db.query("SELECT version FROM hw2.schema_migrations WHERE version='001_himchangym'")).rows[0];
        if(!own)throw new Error('Unrecognized hw2 migration. No changes applied.');
        return;
      }
      const sql=(await fs.readFile(new URL('../db/001-init.sql',import.meta.url),'utf8')).replace(/^BEGIN;\s*$/m,'').replace(/^COMMIT;\s*$/m,'');
      for(const statement of sql.split(';').map(s=>s.trim()).filter(Boolean))await db.query(statement);
    });
    console.log('hw2 migration applied');
  } else if(action==='seed') {
    const adminPassword=password(process.env.SEED_ADMIN_PASSWORD);
    const memberPassword=password(process.env.SEED_MEMBER_PASSWORD);
    const trainerPassword=password(process.env.SEED_TRAINER_PASSWORD);
    await transaction(async db=>{
      await db.query('SELECT pg_advisory_xact_lock(7742028)');
      const count=(await db.query('SELECT count(*)::int AS n FROM hw2.accounts')).rows[0].n;
      if(count)return;
      const addAccount=async(name,address,role,pw)=>(await db.query('INSERT INTO hw2.accounts(name,email,role,password_hash) VALUES($1,$2,$3,$4) RETURNING id',
        [name,email(address),role,await bcrypt.hash(pw,12)])).rows[0].id;
      await addAccount('김관장',process.env.SEED_ADMIN_EMAIL||'admin@example.test','ADMIN',adminPassword);
      const trainerIds=[];
      for(const [i,name] of ['김하나','이도윤'].entries()){
        const a=await addAccount(name,`trainer${i+1}@example.test`,'STAFF',trainerPassword);
        const t=(await db.query('INSERT INTO hw2.trainers(account_id) VALUES($1) RETURNING id',[a])).rows[0].id;
        trainerIds.push(t);
        for(const day of [0,1,2,3,4,5,6].filter(d=>d!==(i===0?2:0))) await db.query('INSERT INTO hw2.trainer_workdays VALUES($1,$2)',[t,day]);
      }
      const types=[];
      for(const [sessions,price,days] of [[10,600000,60],[20,1100000,120],[30,1500000,180]]){
        types.push((await db.query('INSERT INTO hw2.pass_types(name,sessions,list_price,duration_days) VALUES($1,$2,$3,$4) RETURNING *',
          [`PT ${sessions}회권`,sessions,price,days])).rows[0]);
      }
      for(const [i,name] of ['정가온','윤하루','박이든'].entries()){
        const a=await addAccount(name,`member${i+1}@example.test`,'CUSTOMER',memberPassword);
        const m=(await db.query('INSERT INTO hw2.members(account_id,phone) VALUES($1,$2) RETURNING id',[a,`0100000000${i+1}`])).rows[0].id;
        const p=(await db.query(`INSERT INTO hw2.purchased_passes(member_id,pass_type_id,purchased_on,paid_amount,sessions_snapshot,list_price_snapshot,expires_on)
          VALUES($1,$2,CURRENT_DATE-20,$3,$4,$5,CURRENT_DATE+$6::int) RETURNING id`,[m,types[i].id,types[i].list_price-50000,types[i].sessions,types[i].list_price,i===0?10:60])).rows[0].id;
        await db.query(`INSERT INTO hw2.bookings(member_id,purchased_pass_id,trainer_id,starts_at,status,exercise_memo)
          SELECT $1,$2,$3,((d::date+time '10:00') AT TIME ZONE 'Asia/Seoul')+($4::int*interval '1 hour'),'COMPLETED','스쿼트와 코어 운동. 다음 수업에서는 자세를 다시 확인합니다.'
          FROM generate_series(CURRENT_DATE-7,CURRENT_DATE-1,interval '1 day') d
          WHERE extract(dow FROM d)::int IN (SELECT weekday FROM hw2.trainer_workdays WHERE trainer_id=$3)
          ORDER BY d DESC LIMIT 1`,[m,p,trainerIds[i%2],i]);
        await db.query(`INSERT INTO hw2.purchased_passes(member_id,pass_type_id,purchased_on,paid_amount,sessions_snapshot,list_price_snapshot,expires_on)
          VALUES($1,$2,CURRENT_DATE-100,$3,$4,$3,CURRENT_DATE-30)`,[m,types[0].id,types[0].list_price,types[0].sessions]);
      }
    });
    console.log('Fictional sample data created. Credentials are the configured SEED_* values.');
  } else throw new Error('Use migrate or seed');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{await runSetup(process.argv[2]);}finally{await pool.end();}
}
