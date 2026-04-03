
'use strict';

function parseCron(expr) {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('Cron must have 5 fields: min hour day month weekday');
  return parts.map(p => parseField(p));
}

function parseField(field) {
  if (field === '*') return null; 
  if (field.includes('/')) {
    const [, step] = field.split('/');
    return { step: parseInt(step) };
  }
  if (field.includes(',')) return { set: new Set(field.split(',').map(Number)) };
  if (field.includes('-')) {
    const [a, b] = field.split('-').map(Number);
    const set = new Set();
    for (let i=a;i<=b;i++) set.add(i);
    return { set };
  }
  return { set: new Set([parseInt(field)]) };
}

function matches(value, field) {
  if (field === null) return true;
  if (field.step) return value % field.step === 0;
  if (field.set) return field.set.has(value);
  return false;
}

function shouldRun(expr, date) {
  try {
    const [min, hour, day, month, weekday] = parseCron(expr);
    return matches(date.getMinutes(), min) &&
           matches(date.getHours(), hour) &&
           matches(date.getDate(), day) &&
           matches(date.getMonth()+1, month) &&
           matches(date.getDay(), weekday);
  } catch { return false; }
}

function validate(expr) {
  try { parseCron(expr); return true; } catch { return false; }
}

class CronTask {
  constructor(expr, fn) {
    this.expr = expr; this.fn = fn; this._handle = null; this.scheduled = false;
  }
  start() {
    if (this.scheduled) return;
    this.scheduled = true;
    
    this._handle = setInterval(() => {
      if (shouldRun(this.expr, new Date())) this.fn().catch(()=>{});
    }, 30000);
  }
  destroy() { if (this._handle) { clearInterval(this._handle); this._handle = null; this.scheduled = false; } }
}

function schedule(expr, fn, opts={}) {
  const task = new CronTask(expr, fn);
  if (opts.scheduled !== false) task.start();
  return task;
}

module.exports = { schedule, validate };
