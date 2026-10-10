// A supplier's delivery days and order cut-offs: [{ day, cutoff_day, cutoff_time }], days 1 = Monday … 7 = Sunday.

export const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const short = (d) => DAY_NAMES[d - 1].slice(0, 3);
const isoDay = (date) => ((date.getDay() + 6) % 7) + 1;
const ymd = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

/** e.g. "Mon–Sat · order by 22:00 the day before". */
export function scheduleSummary(schedule) {
  if (!schedule?.length) return 'No delivery days set';
  const days = schedule.map((s) => s.day);
  const run = days.length > 2 && days.every((d, i) => i === 0 || d === days[i - 1] + 1);
  const dayText = run ? `${short(days[0])}–${short(days.at(-1))}` : days.map(short).join(', ');
  const dayBefore = schedule.every((s) => s.cutoff_day === (s.day === 1 ? 7 : s.day - 1));
  const sameTime = schedule.every((s) => s.cutoff_time === schedule[0].cutoff_time);
  if (dayBefore && sameTime) return `${dayText} · order by ${schedule[0].cutoff_time} the day before`;
  return `${dayText} · cut-offs vary`;
}

/** The next delivery that can still be ordered for: { date: 'YYYY-MM-DD', cutoff: Date } or null. */
export function nextDelivery(schedule, now = new Date()) {
  if (!schedule?.length) return null;
  for (let k = 0; k < 15; k++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + k);
    const s = schedule.find((x) => x.day === isoDay(day));
    if (!s) continue;
    const [h, m] = s.cutoff_time.split(':').map(Number);
    const back = (s.day - s.cutoff_day + 7) % 7;
    const cutoff = new Date(day.getFullYear(), day.getMonth(), day.getDate() - back, h, m);
    if (now < cutoff) return { date: ymd(day), cutoff };
  }
  return null;
}
