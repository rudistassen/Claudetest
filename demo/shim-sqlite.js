// Browser stand-in for node:sqlite's DatabaseSync, backed by sql.js (SQLite compiled to JavaScript).
// The demo entry sets globalThis.__SQL after initialising sql.js, before any database is opened.

const toParams = (args) => args.map((v) => (v === undefined ? null : typeof v === 'boolean' ? Number(v) : v));

class StatementSync {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
  }

  run(...args) {
    const stmt = this.db.prepare(this.sql);
    try {
      stmt.run(toParams(args));
    } finally {
      stmt.free();
    }
    return {
      changes: this.db.getRowsModified(),
      lastInsertRowid: this.db.exec('SELECT last_insert_rowid()')[0].values[0][0],
    };
  }

  get(...args) {
    const stmt = this.db.prepare(this.sql);
    try {
      stmt.bind(toParams(args));
      return stmt.step() ? stmt.getAsObject() : undefined;
    } finally {
      stmt.free();
    }
  }

  all(...args) {
    const stmt = this.db.prepare(this.sql);
    const rows = [];
    try {
      stmt.bind(toParams(args));
      while (stmt.step()) rows.push(stmt.getAsObject());
    } finally {
      stmt.free();
    }
    return rows;
  }
}

export class DatabaseSync {
  constructor() {
    this.db = new globalThis.__SQL.Database();
  }

  exec(sql) {
    this.db.exec(sql);
  }

  prepare(sql) {
    return new StatementSync(this.db, sql);
  }
}
