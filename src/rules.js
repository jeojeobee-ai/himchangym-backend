export class RuleError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export function requireRule(condition, message, status = 400) {
  if (!condition) throw new RuleError(message, status);
}
export function text(value, label, max = 200) {
  requireRule(typeof value === 'string' && value.trim().length > 0 && value.length <= max, `${label}을(를) 확인해 주세요.`);
  return value.trim();
}
export function id(value) {
  requireRule(/^\d+$/.test(String(value)) && BigInt(String(value)) > 0n, '대상을 확인해 주세요.');
  return String(value);
}
export function password(value) {
  requireRule(typeof value === 'string' && value.length >= 10 && Buffer.byteLength(value) <= 72, '비밀번호는 10자 이상, 72바이트 이하로 입력해 주세요.');
  return value;
}
export function email(value) {
  const result = text(value, '이메일', 254).toLowerCase();
  requireRule(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result), '이메일 형식을 확인해 주세요.');
  return result;
}
export function phone(value) {
  const result = text(value, '연락처', 20).replace(/[- ]/g, '');
  requireRule(/^0\d{9,10}$/.test(result), '연락처를 숫자 10~11자리로 입력해 주세요.');
  return result;
}
export function integer(value, label, min = 0) {
  requireRule(Number.isSafeInteger(value) && value >= min, `${label}을(를) 확인해 주세요.`);
  return value;
}
export function date(value) {
  requireRule(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value), '날짜 형식을 확인해 주세요.');
  const parsed = new Date(value + 'T00:00:00Z');
  requireRule(!isNaN(parsed.getTime()) && parsed.toISOString().slice(0,10) === value, '유효한 날짜를 입력해 주세요.');
  return value;
}
export function bookingTime(value, now = new Date()) {
  requireRule(typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value), '예약 시각에 시간대를 포함해 주세요.');
  const time = new Date(value);
  requireRule(!isNaN(time.getTime()) && time > now, '지금 이후의 수업을 선택해 주세요.');
  requireRule(time.getUTCMinutes() === 0 && time.getUTCSeconds() === 0 && time.getUTCMilliseconds() === 0, '수업은 정각부터 1시간 단위로 예약할 수 있어요.');
  const korea = new Date(time.getTime() + 9 * 3600000);
  const weekday = korea.getUTCDay();
  const hour = korea.getUTCHours();
  const weekend = [0, 6].includes(weekday);
  requireRule(weekend ? hour >= 9 && hour < 18 : hour >= 6 && hour < 23, '헬스장 운영 시간 안에서 예약해 주세요.');
  return { time, weekday, day: korea.toISOString().slice(0,10) };
}
